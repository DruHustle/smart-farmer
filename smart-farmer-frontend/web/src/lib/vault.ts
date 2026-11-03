import type {Snapshot} from '../types';

export type CipherRecord = {version: 1; salt: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; bytes: ArrayBuffer};
export type Sealed = CipherRecord & {archives?: Array<{id: string; record: CipherRecord}>};
export interface VaultStorage {get(key: string): Promise<Sealed | undefined>; set(key: string, value: Sealed): Promise<void>; remove(key: string): Promise<void>}
const utf8 = new TextEncoder();
export const browserStorage: VaultStorage = {
  async get(key) {const db = await openDatabase(); return new Promise((resolve, reject) => {const tx = db.transaction('encrypted', 'readonly'); const req = tx.objectStore('encrypted').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); tx.oncomplete = () => db.close();});},
  async set(key, value) {const db = await openDatabase(); return new Promise((resolve, reject) => {const tx = db.transaction('encrypted', 'readwrite'); tx.objectStore('encrypted').put(value, key); tx.oncomplete = () => {db.close(); resolve();}; tx.onerror = () => {db.close(); reject(tx.error);}; tx.onabort = () => {db.close(); reject(tx.error ?? new Error('storage_failed'));};});},
  async remove(key) {const db = await openDatabase(); return new Promise((resolve, reject) => {const tx = db.transaction('encrypted', 'readwrite'); tx.objectStore('encrypted').delete(key); tx.oncomplete = () => {db.close(); resolve();}; tx.onerror = () => {db.close(); reject(tx.error);};});}
};
function openDatabase(): Promise<IDBDatabase> {return new Promise((resolve, reject) => {const req = indexedDB.open('smart-farmer-private-v1', 1); req.onupgradeneeded = () => req.result.createObjectStore('encrypted'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);});}
async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('secure_context_required');
  const material = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
export async function seal(value: unknown, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, context: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: utf8.encode(context)}, key, utf8.encode(JSON.stringify(value)));
  return {version: 1, salt, iv, bytes};
}
export async function openSealed<T>(record: Sealed, key: CryptoKey, context: string): Promise<T> {
  if (record.version !== 1) throw new Error('storage_version');
  const value = await crypto.subtle.decrypt({name: 'AES-GCM', iv: record.iv, additionalData: utf8.encode(context)}, key, record.bytes);
  return JSON.parse(new TextDecoder().decode(value)) as T;
}
async function openRecord<T>(record: Sealed, key: CryptoKey, context: string): Promise<T> {
  for (const candidate of [record, ...(record.archives ?? []).map(a => a.record)]) {
    try {return await openSealed<T>(candidate, key, context);} catch { /* Preserve both keys across an interrupted password change. */ }
  }
  throw new Error('saved_data_locked');
}
function withPreviousRecord(next: Sealed, previous: Sealed): Sealed {
  const {archives, ...record} = previous;
  return {...next, archives: [...(archives ?? []), {id: crypto.randomUUID(), record}]};
}
/** A password unlocks this account only. The key and plaintext never enter browser storage. */
export class Vault {
  private key: CryptoKey;
  private salt: Uint8Array<ArrayBuffer>;
  private storage: VaultStorage;
  private keyId: string;
  private current: Snapshot;
  private archives: Array<{id: string; record: CipherRecord}>;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private constructor(id: string, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, storage: VaultStorage, data: Snapshot, archives: Array<{id: string; record: CipherRecord}> = []) {this.keyId = id; this.key = key; this.salt = salt; this.storage = storage; this.current = data; this.archives = archives;}
  static async unlock(origin: string, username: string, password: string, initial?: Snapshot, storage: VaultStorage = browserStorage): Promise<Vault> {
    const id = `${origin}|${username.trim().toLowerCase()}`;
    const saved = await storage.get(id);
    const salt = saved?.salt ?? crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(password, salt);
    let data: Snapshot;
    if (saved) {
      try {data = await openSealed<Snapshot>(saved, key, id);} catch {throw new Error('saved_data_locked');}
      if (initial && data.identity.userId !== initial.identity.userId) throw new Error('account_mismatch');
      if (initial) {data.identity = initial.identity; data.language = initial.language; data.requiresAuth = false;}
    } else {if (!initial) throw new Error('no_saved_data'); data = initial;}
    const vault = new Vault(id, key, salt, storage, data, saved?.archives ?? []);
    await vault.mutate(() => {});
    return vault;
  }
  /** Only call after successful server authentication and an explicit choice in the recovery UI. */
  static async recover(origin: string, username: string, newPassword: string, initial: Snapshot, previousPassword?: string, storage: VaultStorage = browserStorage): Promise<Vault> {
    const id = `${origin}|${username.trim().toLowerCase()}`;
    const saved = await storage.get(id);
    let data = initial;
    const archives = [...(saved?.archives ?? [])];
    if (saved) {
      if (previousPassword) {
        try {const oldKey = await derive(previousPassword, saved.salt); data = await openSealed<Snapshot>(saved, oldKey, id);} catch {throw new Error('saved_data_locked');}
        if (data.identity.userId !== initial.identity.userId) throw new Error('account_mismatch');
        data.identity = initial.identity; data.language = initial.language; data.requiresAuth = false;
        // Re-encrypt media with the new key below; metadata alone must never claim media was recovered.
      } else {
        const {archives: _oldArchives, ...record} = saved;
        archives.push({id: crypto.randomUUID(), record});
      }
    }
    const salt = crypto.getRandomValues(new Uint8Array(16)); const key = await derive(newPassword, salt);
    const vault = new Vault(id, key, salt, storage, data, archives);
    if (saved && previousPassword) {
      const oldKey = await derive(previousPassword, saved.salt);
      for (const entry of data.outbox) if (entry.mediaId) {
        const context = `${id}|media|${entry.mediaId}`; const attachment = await storage.get(context);
        if (attachment) {
          const content = await openRecord(attachment, oldKey, context);
          await storage.set(context, withPreviousRecord(await seal(content, key, salt, context), attachment));
        }
      }
    }
    await vault.mutate(() => {});
    return vault;
  }
  archiveCount = (): number => this.archives.length;
  async restoreArchivedDrafts(previousPassword: string): Promise<number> {
    for (const archive of this.archives) {
      let old: Snapshot; let oldKey: CryptoKey;
      try {oldKey = await derive(previousPassword, archive.record.salt); old = await openSealed<Snapshot>(archive.record, oldKey, this.keyId);} catch {continue;}
      if (old.identity.userId !== this.current.identity.userId) throw new Error('account_mismatch');
      const recovered = old.outbox.filter(entry => !this.current.outbox.some(live => live.id === entry.id));
      for (const entry of recovered) if (entry.mediaId) {
        const context = `${this.keyId}|media|${entry.mediaId}`, attachment = await this.storage.get(context);
        if (attachment) await this.storage.set(context, withPreviousRecord(await seal(await openRecord(attachment, oldKey, context), this.key, this.salt, context), attachment));
      }
      await this.mutate(next => {next.outbox.push(...recovered);});
      return recovered.length;
    }
    throw new Error('saved_data_locked');
  }
  snapshot = (): Snapshot => this.current;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  async mutate(change: (next: Snapshot) => void): Promise<void> {
    const work = this.writes.then(async () => {const next = structuredClone(this.current); change(next); await this.storage.set(this.keyId, {...await seal(next, this.key, this.salt, this.keyId), ...(this.archives.length ? {archives: this.archives} : {})}); this.current = next; this.listeners.forEach(l => l());});
    this.writes = work.catch(() => {});
    return work;
  }
  async storeAttachment(id: string, value: {mimeType: string; dataBase64: string; filename: string}): Promise<void> {const context = `${this.keyId}|media|${id}`; await this.storage.set(context, await seal(value, this.key, this.salt, context));}
  async readAttachment(id: string): Promise<{mimeType: string; dataBase64: string; filename: string}> {const context = `${this.keyId}|media|${id}`; const record = await this.storage.get(context); if (!record) throw new Error('attachment_missing'); return openRecord(record, this.key, context);}
  async removeAttachment(id: string): Promise<void> {await this.storage.remove(`${this.keyId}|media|${id}`);}
}
