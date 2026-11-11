import type {OutboxItem} from '../types';
import type {Vault} from './vault';
/** Field records only. Purchases, bookings, permissions and actuator commands never queue. */
export function isQueueable(path: string, method: string): boolean {
  return method === 'POST' && /^\/v1\/farms\/[^/]+\/(activities|projects\/[^/]+\/(events|records)|weather\/observations|assets\/[^/]+\/usage|incidents|media)$/.test(path)
    || method === 'PATCH' && /^\/v1\/farms\/[^/]+\/tasks\/[^/]+$/.test(path);
}
export type PendingRecord = Omit<OutboxItem, 'status' | 'attempts' | 'createdAt'>;
/** Save one user action and all its media references in one encrypted transaction. */
export async function queueRecords(vault: Vault, entries: PendingRecord[]): Promise<void> {
  if (!entries.length || entries.some(entry => !isQueueable(entry.path, entry.method))) throw new Error('unsafe_outbox_route');
  await vault.mutate(next => {const createdAt = new Date().toISOString(); next.outbox.push(...entries.map(entry => ({...entry, status: 'pending' as const, attempts: 0, createdAt})));});
}
export type Send = (entry: OutboxItem, payload: Record<string, unknown>) => Promise<unknown>;
export async function drainOutbox(vault: Vault, send: Send, includeMedia: boolean, now = () => Date.now()): Promise<void> {
  for (const entry of vault.snapshot().outbox) {
    if (vault.snapshot().requiresAuth) return;
    if (entry.status !== 'pending' || entry.mediaId && !includeMedia) continue;
    if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now()) continue;
    if (!isQueueable(entry.path, entry.method)) throw new Error('unsafe_outbox_route');
    if (entry.mediaId && vault.snapshot().outbox.some(e => !e.mediaId && e.payload.id === entry.payload.activityId)) continue;
    try {
      const payload = entry.mediaId ? {...entry.payload, ...await vault.readAttachment(entry.mediaId)} : entry.payload;
      await send(entry, payload);
      await vault.mutate(next => {next.outbox = next.outbox.filter(e => e.id !== entry.id);});
      if (entry.mediaId) await vault.removeAttachment(entry.mediaId);
    } catch (error) {
      const status = Number((error as {status?: number}).status ?? 0);
      const code = error instanceof Error ? error.message : 'network_error';
      await vault.mutate(next => {
        const live = next.outbox.find(e => e.id === entry.id);
        if (!live) return;
        live.error = code;
        if (status === 401) {
          next.requiresAuth = true;
          delete live.nextAttemptAt;
          return;
        }
        live.attempts += 1;
        live.status = status === 409 && code !== 'retry_transaction' ? 'conflict' : status >= 400 && status < 500 && status !== 429 && code !== 'retry_transaction' || live.attempts >= 5 ? 'failed' : 'pending';
        const current = (error as {details?: {current?: Record<string, unknown>}}).details?.current; if (current && live.status === 'conflict') live.conflictCurrent = current;
        live.nextAttemptAt = new Date(now() + Math.min(300_000, 5_000 * 2 ** live.attempts)).toISOString();
      });
      if (status === 401 || status === 429 || status === 0) break;
    }
  }
}
