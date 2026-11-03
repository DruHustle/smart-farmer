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
    const mutations = await this.repository.mutations(farmId);
    for (const original of mutations) {
      if (original.state !== 'pending' || original.attempts >= 5) continue;
      const mutation = { ...original, attempts: original.attempts + 1 };
      await this.repository.updateMutation(mutation);
      try {
        const { path, method } = mutationRequest(mutation);
        await this.api.request(path, method, mutation.body);
        await this.repository.accept(mutation);
        result.accepted++;
      } catch (error) {
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
      if (original.state !== 'pending' || original.attempts >= 5 || !await this.repository.accepted(farmId, original.activityId)) continue;
      const attachment = { ...original, attempts: original.attempts + 1 };
      await this.repository.updateAttachment(attachment);
      try {
        await this.api.upload(`/v1/farms/${farmId}/media`, {
          id: attachment.id, activityId: attachment.activityId, mimeType: attachment.mimeType,
          filename: attachment.filename, dataBase64: attachment.dataBase64,
        }, percent => options.onProgress?.(attachment.id, percent));
        await this.repository.updateAttachment({ ...attachment, state: 'synced', dataBase64: '', lastError: null });
        result.mediaUploaded++;
      } catch (error) {
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
