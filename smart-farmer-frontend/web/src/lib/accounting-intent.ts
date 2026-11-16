import {emptyFarmData, type Farm, type FarmData, type Role, type Snapshot} from '../types.ts';
import type {Vault} from './vault';

export type PendingAccountingRequest = {id: string; path: string; method: 'POST' | 'PATCH' | 'PUT'; payload: unknown; createdAt: string};
const keyFor = (path: string, method: string) => `accounting-pending:${method}:${path}`;

/** Drop cached reads on a role change, retaining exact unresolved finance intent only. */
export function accountingDataAfterRoleChange(data: FarmData, previousRole: Role | undefined, nextRole: Role): FarmData | undefined {
  if (!previousRole || !['owner', 'manager'].includes(previousRole) || !['owner', 'manager'].includes(nextRole)) return undefined;
  const resources = Object.fromEntries(Object.entries(data.resources ?? {})
    .filter(([key, record]) => key.startsWith('accounting-pending:') && record.role === previousRole)
    .map(([key, record]) => [key, {...record, role: nextRole}]));
  return {...emptyFarmData(), resources};
}

export function pendingAccountingRequests(snapshot: Snapshot, farm: Farm): PendingAccountingRequest[] {
  if (!['owner', 'manager'].includes(farm.role) || snapshot.farms.find(item => item.id === farm.id)?.role !== farm.role) return [];
  return Object.entries(snapshot.data[farm.id]?.resources ?? {}).filter(([key, record]) => key.startsWith('accounting-pending:') && record.role === farm.role).map(([, record]) => record.value as PendingAccountingRequest);
}

/** Encrypted reconciliation state only: it is never submitted by offline sync. */
export async function persistAccountingRequest(vault: Vault, farm: Farm, request: PendingAccountingRequest): Promise<void> {
  await vault.mutate(next => {
    if (!['owner', 'manager'].includes(farm.role) || next.farms.find(item => item.id === farm.id)?.role !== farm.role) throw new Error('forbidden');
    const data = next.data[farm.id];
    if (!data) throw new Error('storage_failed');
    data.resources ??= {};
    const key = keyFor(request.path, request.method);
    const previous = data.resources[key];
    if (previous?.role === farm.role) {
      const pending = previous.value as PendingAccountingRequest;
      if (pending.id !== request.id || JSON.stringify(pending.payload) !== JSON.stringify(request.payload)) throw new Error('accounting_pending_intent');
      return;
    }
    data.resources[key] = {value: structuredClone(request), savedAt: request.createdAt, role: farm.role};
  });
}

export async function clearAccountingRequest(vault: Vault, farm: Farm, request: Pick<PendingAccountingRequest, 'id' | 'path' | 'method'>): Promise<void> {
  await vault.mutate(next => {
    const records = next.data[farm.id]?.resources;
    const key = keyFor(request.path, request.method);
    const current = records?.[key];
    if (records && current?.role === farm.role && (current.value as PendingAccountingRequest).id === request.id) delete records[key];
  });
}

export function definiteAccountingRejection(error: unknown): boolean {
  const status = Number((error as {status?: number}).status);
  // Authentication/rate-limit failures on a replay do not establish the outcome
  // of the earlier request. Retain those keys until an authorized retry resolves.
  return (status === 400 || status === 422 || status === 409) && !(error instanceof Error && ['idempotency_conflict', 'retry_transaction', 'invalid_response'].includes(error.message));
}

/** A lost response does not authorize a different financial intent under a new key. */
export class AccountingIntent {
  id: string;
  private uncertain: {json: string; payload: unknown} | null = null;

  constructor(pending?: Pick<PendingAccountingRequest, 'id' | 'payload'>) {
    this.id = pending?.id ?? crypto.randomUUID();
    if (pending) this.responseLost(pending.payload);
  }

  prepare(payload: unknown): unknown {
    if (this.uncertain && JSON.stringify(payload) !== this.uncertain.json) throw new Error('accounting_pending_intent');
    return this.uncertain ? structuredClone(this.uncertain.payload) : payload;
  }

  responseLost(payload: unknown): void {
    this.uncertain = {json: JSON.stringify(payload), payload: structuredClone(payload)};
  }

  retry(): unknown {
    if (!this.uncertain) throw new Error('accounting_no_pending_intent');
    return structuredClone(this.uncertain.payload);
  }

  accepted(): void {
    this.id = crypto.randomUUID();
    this.uncertain = null;
  }
}
