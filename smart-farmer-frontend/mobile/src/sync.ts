import { ApiError, type ApiClient } from './api';
import { LocalRepository, retryState, validateMutation } from './repository';
import type { Mutation } from './types';

export function mutationRequest(mutation: Mutation): { path: string; method: string } {
  validateMutation(mutation);
  const base = `/v1/farms/${mutation.farmId}`;
  switch (mutation.kind) {
    case 'activity': return { path: `${base}/activities`, method: 'POST' };
    case 'animal-event': return { path: `${base}/projects/${mutation.resourceId}/events`, method: 'POST' };
    case 'task-status': return { path: `${base}/tasks/${mutation.resourceId}`, method: 'PATCH' };
    case 'project-record': return { path: `${base}/projects/${mutation.resourceId}/records`, method: 'POST' };
    case 'weather-observation': return { path: `${base}/weather/observations`, method: 'POST' };
    case 'asset-usage': return { path: `${base}/assets/${mutation.resourceId}/usage`, method: 'POST' };
    case 'incident-create': return { path: `${base}/incidents`, method: 'POST' };
    default: throw new Error('unsafe_offline_action');
  }
}

export type SyncResult = { accepted: number; failed: number; unauthorized: boolean; mediaUploaded: number };
export class Synchronizer {
  private readonly running = new Map<string, Promise<SyncResult>>();
  constructor(private readonly repository: LocalRepository, private readonly api: ApiClient) {}

  flush(farmId: string, options: { media?: boolean; onProgress?: (id: string, percent: number) => void } = {}): Promise<SyncResult> {
    const current = this.running.get(farmId);
    if (current) return current;
    const work = this.run(farmId, options).finally(() => { this.running.delete(farmId); });
    this.running.set(farmId, work);
    return work;
  }

  private async run(farmId: string, options: { media?: boolean; onProgress?: (id: string, percent: number) => void }): Promise<SyncResult> {
    const result: SyncResult = { accepted: 0, failed: 0, unauthorized: false, mediaUploaded: 0 };
    const revision = this.repository.farmRevision(farmId);
    const accessChanged = () => revision !== this.repository.farmRevision(farmId);
    const mutations = await this.repository.mutations(farmId);
    for (const original of mutations) {
      if (accessChanged()) return result;
      if (original.state !== 'pending') continue;
      // Older clients persisted an attempt before sending. A pending fifth attempt
      // after a restart has an unknown outcome and must retry with its original ID.
      const mutation = { ...original, attempts: Math.min(5, original.attempts + 1) };
      try {
        const { path, method } = mutationRequest(mutation);
        await this.api.request(path, method, mutation.body);
        if (accessChanged()) return result;
        await this.repository.accept(mutation);
        result.accepted++;
      } catch (error) {
        if (accessChanged()) return result;
        const status = error instanceof ApiError ? error.status : 0;
        const code = error instanceof ApiError ? error.code : 'network_error';
        await this.repository.updateMutation({ ...mutation, state: code === 'retry_transaction' && mutation.attempts < 5 ? 'pending' : retryState(status, mutation.attempts), lastError: code });
        result.failed++;
        if (status === 401) { result.unauthorized = true; return result; }
        if (status === 0 || status === 429 || status >= 500) return result;
      }
    }
    if (!options.media) return result;
    for (const original of await this.repository.attachments(farmId)) {
      if (original.state !== 'pending' || !original.assetId && (!original.activityId || !await this.repository.accepted(farmId, original.activityId))) continue;
      if (accessChanged()) return result;
      const attachment = { ...original, attempts: Math.min(5, original.attempts + 1) };
      try {
        const uploaded = await this.api.upload<{ id?: string; status?: string }>(`/v1/farms/${farmId}/media`, {
          id: attachment.id, ...(attachment.assetId ? { assetId: attachment.assetId } : { activityId: attachment.activityId }), mimeType: attachment.mimeType,
          filename: attachment.filename, dataBase64: attachment.dataBase64, ...(attachment.financial ? { financial: true } : {}),
        }, percent => options.onProgress?.(attachment.id, percent));
        if (accessChanged()) return result;
        if (uploaded?.id !== attachment.id || uploaded.status !== 'stored') throw new ApiError(502, 'invalid_response');
        await this.repository.updateAttachment({ ...attachment, state: 'synced', dataBase64: '', lastError: null });
        result.mediaUploaded++;
      } catch (error) {
        if (accessChanged()) return result;
        const status = error instanceof ApiError ? error.status : 0;
        const state = retryState(status, attachment.attempts);
        await this.repository.updateAttachment({ ...attachment, state: state === 'resolved' ? 'blocked' : state, lastError: error instanceof ApiError ? error.code : 'network_error' });
        result.failed++;
        if (status === 401) { result.unauthorized = true; return result; }
        if (status === 0 || status === 429 || status >= 500) return result;
      }
    }
    return result;
  }
}
