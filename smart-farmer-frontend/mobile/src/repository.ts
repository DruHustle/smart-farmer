import type { Attachment, FarmSnapshot, Mutation, OutboxState, RecordDraft } from './types';

type Parameter = string | number | null;
export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...parameters: Parameter[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...parameters: Parameter[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...parameters: Parameter[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}
type JsonRow = { value: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateMutation(mutation: Mutation): void {
  if (!UUID.test(mutation.id) || !UUID.test(mutation.farmId)) throw new Error('invalid_record');
  if (!['activity', 'animal-event', 'task-status', 'project-record', 'weather-observation', 'asset-usage', 'incident-create'].includes(mutation.kind)) throw new Error('unsafe_offline_action');
  if (['animal-event', 'task-status', 'project-record', 'asset-usage'].includes(mutation.kind) && (!mutation.resourceId || !UUID.test(mutation.resourceId))) throw new Error('invalid_record');
  if (mutation.kind !== 'task-status' && mutation.body.id !== mutation.id) throw new Error('invalid_record');
}

/** The native adapter uses SQLCipher. This port also permits actual restart tests with SQLite. */
export class LocalRepository {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly farmRevisions = new Map<string, number>();
  constructor(private readonly db: SqlDatabase) {}

  /** Fence requests started before a membership or role change in this process. */
  farmRevision(farmId: string): number { return this.farmRevisions.get(farmId) ?? 0; }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action);
    this.serial = result.catch(() => undefined);
    return result;
  }

  initialize(): Promise<void> {
    return this.exclusive(() => this.db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (farm_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (farm_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS form_drafts (farm_id TEXT NOT NULL, form_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(farm_id,form_key));
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, farm_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_farm ON outbox(farm_id);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, farm_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, farm_id TEXT NOT NULL, activity_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_activity ON attachments(farm_id, activity_id);
    `));
  }

  preference<T>(key: string): Promise<T | null> {
    return this.exclusive(async () => {
      const row = await this.db.getFirstAsync<JsonRow>('SELECT value FROM preferences WHERE key = ?', key);
      return row ? JSON.parse(row.value) as T : null;
    });
  }

  setPreference(key: string, value: unknown): Promise<void> {
    return this.exclusive(async () => { await this.db.runAsync('INSERT INTO preferences(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)); });
  }

  formDraft<T>(farmId: string, key: string): Promise<T | null> {
    return this.exclusive(async () => { const row = await this.db.getFirstAsync<JsonRow>('SELECT value FROM form_drafts WHERE farm_id = ? AND form_key = ?', farmId, key); return row ? JSON.parse(row.value) as T : null; });
  }

  saveFormDraft(farmId: string, key: string, value: unknown): Promise<void> {
    if (!UUID.test(farmId)) throw new Error('invalid_record');
    return this.exclusive(async () => {
      if (value === null) await this.db.runAsync('DELETE FROM form_drafts WHERE farm_id = ? AND form_key = ?', farmId, key);
      else await this.db.runAsync('INSERT INTO form_drafts(farm_id, form_key, value) VALUES(?, ?, ?) ON CONFLICT(farm_id,form_key) DO UPDATE SET value=excluded.value', farmId, key, JSON.stringify(value));
    });
  }

  snapshot(farmId: string): Promise<FarmSnapshot | null> {
    return this.exclusive(async () => {
      const row = await this.db.getFirstAsync<JsonRow>('SELECT value FROM snapshots WHERE farm_id = ?', farmId);
      return row ? JSON.parse(row.value) as FarmSnapshot : null;
    });
  }

  saveSnapshot(value: FarmSnapshot): Promise<void> {
    return this.exclusive(async () => { await this.db.runAsync('INSERT INTO snapshots(farm_id, value) VALUES(?, ?) ON CONFLICT(farm_id) DO UPDATE SET value = excluded.value', value.farm.id, JSON.stringify(value)); });
  }

  /** On reconnect revoke cached reads immediately, keeping only the account's recoverable drafts. */
  revokeFarm(farmId: string): Promise<void> {
    this.farmRevisions.set(farmId, this.farmRevision(farmId) + 1);
    return this.exclusive(async () => {
      await this.db.execAsync('BEGIN IMMEDIATE');
      try {
        await this.db.runAsync('DELETE FROM snapshots WHERE farm_id = ?', farmId);
        await this.db.runAsync('DELETE FROM preferences WHERE key LIKE ?', `farm:${farmId}:%`);
        await this.db.runAsync("UPDATE attachments SET value = json_set(value, '$.state', 'blocked', '$.lastError', 'access_revoked') WHERE farm_id = ? AND json_extract(value, '$.state') <> 'synced'", farmId);
        await this.db.runAsync("UPDATE outbox SET value = json_set(value, '$.state', 'blocked', '$.lastError', 'access_revoked') WHERE farm_id = ? AND json_extract(value, '$.state') <> 'resolved'", farmId);
        await this.db.execAsync('COMMIT');
      } catch (error) { await this.db.execAsync('ROLLBACK'); throw error; }
    });
  }

  draft(farmId: string): Promise<RecordDraft | null> {
    return this.exclusive(async () => {
      const row = await this.db.getFirstAsync<JsonRow>('SELECT value FROM drafts WHERE farm_id = ?', farmId);
      return row ? JSON.parse(row.value) as RecordDraft : null;
    });
  }

  saveDraft(farmId: string, draft: RecordDraft): Promise<void> {
    return this.exclusive(async () => { await this.db.runAsync('INSERT INTO drafts(farm_id, value) VALUES(?, ?) ON CONFLICT(farm_id) DO UPDATE SET value = excluded.value', farmId, JSON.stringify(draft)); });
  }

  enqueue(mutation: Mutation, clearDraft = false): Promise<void> {
    validateMutation(mutation);
    return this.exclusive(async () => {
      const existing = await this.db.getFirstAsync<JsonRow>('SELECT value FROM outbox WHERE id = ?', mutation.id);
      if (existing) {
        const prior = JSON.parse(existing.value) as Mutation;
        if (JSON.stringify(prior.body) !== JSON.stringify(mutation.body) || prior.farmId !== mutation.farmId || prior.kind !== mutation.kind) throw new Error('idempotency_conflict');
        return;
      }
      await this.db.execAsync('BEGIN IMMEDIATE');
      try {
        await this.db.runAsync('INSERT INTO outbox(id, farm_id, value) VALUES(?, ?, ?)', mutation.id, mutation.farmId, JSON.stringify(mutation));
        const attachments = await this.db.getAllAsync<JsonRow>('SELECT value FROM attachments WHERE farm_id = ? AND activity_id = ?', mutation.farmId, mutation.id);
        for (const row of attachments) {
          const attachment = JSON.parse(row.value) as Attachment;
          if (attachment.state === 'draft') {
            attachment.state = 'pending';
            await this.db.runAsync('UPDATE attachments SET value = ? WHERE id = ?', JSON.stringify(attachment), attachment.id);
          }
        }
        if (clearDraft) await this.db.runAsync('DELETE FROM drafts WHERE farm_id = ?', mutation.farmId);
        await this.db.execAsync('COMMIT');
      } catch (error) { await this.db.execAsync('ROLLBACK'); throw error; }
    });
  }

  mutations(farmId: string): Promise<Mutation[]> {
    return this.exclusive(async () => {
      const rows = await this.db.getAllAsync<JsonRow>('SELECT value FROM outbox WHERE farm_id = ? ORDER BY rowid', farmId);
      return rows.map(row => JSON.parse(row.value) as Mutation);
    });
  }

  updateMutation(mutation: Mutation): Promise<void> {
    validateMutation(mutation);
    return this.exclusive(async () => { await this.db.runAsync('UPDATE outbox SET value = ? WHERE id = ? AND farm_id = ?', JSON.stringify(mutation), mutation.id, mutation.farmId); });
  }

  accept(mutation: Mutation): Promise<void> {
    return this.exclusive(async () => {
      await this.db.execAsync('BEGIN IMMEDIATE');
      try {
        await this.db.runAsync('INSERT INTO receipts(id, farm_id) VALUES(?, ?) ON CONFLICT(id) DO NOTHING', mutation.id, mutation.farmId);
        await this.db.runAsync('DELETE FROM outbox WHERE id = ? AND farm_id = ?', mutation.id, mutation.farmId);
        await this.db.execAsync('COMMIT');
      } catch (error) { await this.db.execAsync('ROLLBACK'); throw error; }
    });
  }

  accepted(farmId: string, id: string): Promise<boolean> {
    return this.exclusive(async () => Boolean(await this.db.getFirstAsync('SELECT id FROM receipts WHERE farm_id = ? AND id = ?', farmId, id)));
  }

  attach(attachment: Attachment): Promise<void> {
    if (!UUID.test(attachment.id) || !UUID.test(attachment.activityId || attachment.assetId || '') || Boolean(attachment.activityId) === Boolean(attachment.assetId) || !UUID.test(attachment.farmId)) throw new Error('invalid_record');
    if (attachment.sizeBytes > 5 * 1024 * 1024 || attachment.sizeBytes <= 0) throw new Error('media_too_large');
    const encodedSize = Math.floor(attachment.dataBase64.length * 3 / 4) - (attachment.dataBase64.endsWith('==') ? 2 : attachment.dataBase64.endsWith('=') ? 1 : 0);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataBase64) || encodedSize !== attachment.sizeBytes) throw new Error('invalid_record');
    return this.exclusive(async () => {
      const rows = await this.db.getAllAsync<JsonRow>('SELECT value FROM attachments');
      const used = rows.reduce((total, row) => { const prior = JSON.parse(row.value) as Attachment; return total + (prior.state === 'synced' ? 0 : prior.sizeBytes); }, 0);
      if (used + attachment.sizeBytes > 50 * 1024 * 1024) throw new Error('local_quota');
      await this.db.runAsync('INSERT INTO attachments(id, farm_id, activity_id, value) VALUES(?, ?, ?, ?)', attachment.id, attachment.farmId, attachment.assetId ? `asset:${attachment.assetId}` : attachment.activityId!, JSON.stringify(attachment));
    });
  }

  attachments(farmId: string, activityId?: string): Promise<Attachment[]> {
    return this.exclusive(async () => {
      const rows = activityId
        ? await this.db.getAllAsync<JsonRow>('SELECT value FROM attachments WHERE farm_id = ? AND activity_id = ? ORDER BY rowid', farmId, activityId)
        : await this.db.getAllAsync<JsonRow>('SELECT value FROM attachments WHERE farm_id = ? ORDER BY rowid', farmId);
      return rows.map(row => JSON.parse(row.value) as Attachment);
    });
  }

  queueAssetAttachments(farmId: string, assetId: string): Promise<void> {
    if (!UUID.test(farmId) || !UUID.test(assetId)) throw new Error('invalid_record');
    return this.exclusive(async () => {
      await this.db.execAsync('BEGIN IMMEDIATE');
      try {
        const values = await this.db.getAllAsync<JsonRow>('SELECT value FROM attachments WHERE farm_id = ? AND activity_id = ?', farmId, `asset:${assetId}`);
        for (const value of values) {
          const attachment = JSON.parse(value.value) as Attachment;
          if (attachment.assetId === assetId && attachment.state === 'draft') await this.db.runAsync('UPDATE attachments SET value = ? WHERE id = ? AND farm_id = ?', JSON.stringify({ ...attachment, state: 'pending' }), attachment.id, farmId);
        }
        await this.db.execAsync('COMMIT');
      } catch (error) { await this.db.execAsync('ROLLBACK'); throw error; }
    });
  }

  updateAttachment(attachment: Attachment): Promise<void> {
    return this.exclusive(async () => { await this.db.runAsync('UPDATE attachments SET value = ? WHERE id = ? AND farm_id = ?', JSON.stringify(attachment), attachment.id, attachment.farmId); });
  }

  removeDraftAttachment(farmId: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      const row = await this.db.getFirstAsync<JsonRow>('SELECT value FROM attachments WHERE farm_id = ? AND id = ?', farmId, id);
      if (row && (JSON.parse(row.value) as Attachment).state === 'draft') await this.db.runAsync('DELETE FROM attachments WHERE farm_id = ? AND id = ?', farmId, id);
    });
  }

  async close(): Promise<void> { await this.exclusive(() => this.db.closeAsync()); }
}

export function retryState(status: number, attempts: number): OutboxState {
  if (status === 409) return 'conflict';
  if ((status >= 400 && status < 500 && status !== 408 && status !== 429) || attempts >= 5) return 'blocked';
  return 'pending';
}
