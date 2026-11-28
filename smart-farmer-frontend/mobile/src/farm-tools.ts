import type { ApiClient } from './api';
import { rows, type Row } from './product';
import type { Activity, Language, Role } from './types';

export const canRecordFarmObservation = (role?: Role): boolean => role !== undefined && ['owner', 'manager', 'worker', 'adviser'].includes(role);
export const canLinkBasicPhone = (role?: Role): boolean => role !== undefined && ['owner', 'manager', 'worker'].includes(role);

/** A consumed code expires independently of the linked phone's session access. */
export function phoneLinkState(link: Row | null | undefined, now = Date.now()): 'none' | 'pending' | 'linked' | 'expired' | 'revoked' {
  if (!link?.id) return 'none';
  if (link.revokedAt) return 'revoked';
  const expiry = Date.parse(String(link.linkedAt ? link.accessExpiresAt : link.expiresAt));
  if (!Number.isFinite(expiry) || expiry <= now) return 'expired';
  return link.linkedAt ? 'linked' : 'pending';
}

/** The server flag also excludes receipts linked to accounting after upload. */
export function eligibleTrialEvidence(media: Row[], activities: Activity[], projectId: unknown): Row[] {
  const eligibleActivities = new Set(activities.filter(activity => activity.project_id === projectId && activity.kind !== 'cost').map(activity => activity.id));
  return media.filter(item => item.trial_eligible === true && !item.financial && !item.asset_id &&
    ['image/jpeg', 'image/png', 'image/webp'].includes(String(item.mime_type)) && eligibleActivities.has(String(item.activity_id)));
}

export function marketPriceText(value: unknown, language: Language): string {
  if (value === null || value === undefined || value === '') return '—';
  const price = Number(value);
  return Number.isFinite(price) ? new Intl.NumberFormat(`${language}-ZW`, { maximumFractionDigits: 6 }).format(price) : String(value);
}

/** Detail endpoints page their history separately from the current summary. */
export async function readDetailHistory(api: ApiClient, path: string, history: 'observations' | 'logs'): Promise<Row> {
  const entries: Row[] = [], seen = new Set<string>();
  let cursor: string | undefined, result: Row = {};
  do {
    const page = await api.request<Row>(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(page[history])) throw new Error('invalid_response');
    entries.push(...rows(page[history])); result = page;
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error('request_failed');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { ...result, [history]: entries, nextCursor: null };
}
