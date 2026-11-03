import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../src/repository';
import type { Attachment, Mutation } from '../src/types';

export class TestDatabase implements SqlDatabase {
  readonly database: DatabaseSync;
  constructor(filename: string) { this.database = new DatabaseSync(filename); }
  async execAsync(sql: string) { this.database.exec(sql); }
  async runAsync(sql: string, ...parameters: (string | number | null)[]) { return this.database.prepare(sql).run(...parameters); }
  async getFirstAsync<T>(sql: string, ...parameters: (string | number | null)[]): Promise<T | null> { return (this.database.prepare(sql).get(...parameters) as T | undefined) || null; }
  async getAllAsync<T>(sql: string, ...parameters: (string | number | null)[]): Promise<T[]> { return this.database.prepare(sql).all(...parameters) as T[]; }
  async closeAsync() { this.database.close(); }
}

export function activity(farmId: string = randomUUID()): Mutation {
  const id = randomUUID();
  return { id, farmId, kind: 'activity', body: { id, projectId: randomUUID(), kind: 'input_use', observedAt: '2026-11-03T09:00:00.000Z', note: 'Isolated test observation', stockItemId: randomUUID(), quantity: 5, unit: 'kg' }, state: 'pending', attempts: 0, lastError: null, createdAt: '2026-11-03T09:01:00.000Z' };
}

export function attachment(mutation: Mutation): Attachment {
  const bytes = Buffer.from('isolated-media-fixture');
  return { id: randomUUID(), farmId: mutation.farmId, activityId: mutation.id, mimeType: 'image/jpeg', filename: 'fixture.jpg', dataBase64: bytes.toString('base64'), sizeBytes: bytes.length, state: 'draft', attempts: 0, lastError: null, createdAt: mutation.createdAt };
}
