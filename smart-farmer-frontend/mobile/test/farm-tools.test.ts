import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLinkBasicPhone, canRecordFarmObservation, eligibleTrialEvidence, marketPriceText, phoneLinkState, readDetailHistory } from '../src/farm-tools';
import type { ApiClient } from '../src/api';
import type { Activity, Role } from '../src/types';

test('farm-tool mutation controls reflect the distinct observer and phone roles', () => {
  for (const role of ['owner', 'manager', 'worker', 'adviser', 'veterinarian', undefined] as const satisfies readonly (Role | undefined)[]) {
    assert.equal(canRecordFarmObservation(role), ['owner', 'manager', 'worker', 'adviser'].includes(role || ''));
    assert.equal(canLinkBasicPhone(role), ['owner', 'manager', 'worker'].includes(role || ''));
  }
});

test('phone code expiry does not end linked access, and revoked or expired codes stay hidden', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  const link = { id: 'phone', expiresAt: '2026-11-28T11:59:00Z', accessExpiresAt: '2026-11-28T13:00:00Z' };
  assert.equal(phoneLinkState(undefined, now), 'none');
  assert.equal(phoneLinkState({ ...link, expiresAt: '2026-11-28T12:01:00Z' }, now), 'pending');
  assert.equal(phoneLinkState(link, now), 'expired');
  assert.equal(phoneLinkState({ ...link, linkedAt: '2026-11-28T11:58:00Z' }, now), 'linked');
  assert.equal(phoneLinkState({ ...link, linkedAt: '2026-11-28T11:58:00Z' }, now + 3600000), 'expired');
  assert.equal(phoneLinkState({ ...link, linkedAt: '2026-11-28T11:58:00Z', revokedAt: '2026-11-28T11:59:00Z' }, now), 'revoked');
  assert.equal(phoneLinkState({ ...link, expiresAt: 'invalid' }, now), 'expired');
});

test('trial evidence excludes receipt-linked, unclassified, foreign-project, asset and non-image files', () => {
  const activity = (id: string, project_id: string, kind: Activity['kind'] = 'observation'): Activity => ({ id, project_id, kind, observed_at: '', recorded_at: '', note: '', quantity: null, unit: null });
  const media = { id: 'valid', trial_eligible: true, financial: false, activity_id: 'ordinary', asset_id: null, mime_type: 'image/jpeg' };
  const files = [media, { ...media, id: 'receipt', trial_eligible: false }, { ...media, id: 'old-cache', trial_eligible: undefined },
    { ...media, id: 'cost', activity_id: 'cost' }, { ...media, id: 'foreign', activity_id: 'foreign' },
    { ...media, id: 'asset', asset_id: 'pump' }, { ...media, id: 'pdf', mime_type: 'application/pdf' },
    { ...media, id: 'financial', financial: true }];
  assert.deepEqual(eligibleTrialEvidence(files, [activity('ordinary', 'trial-project'), activity('cost', 'trial-project', 'cost'), activity('foreign', 'other-project')], 'trial-project').map(item => item.id), ['valid']);
});

test('market price display preserves six decimals and distinguishes zero from missing data', () => {
  for (const language of ['sn', 'nd'] as const) {
    assert.equal(marketPriceText(0.000001, language), '0.000001');
    assert.equal(marketPriceText('1.123456', language), '1.123456');
    assert.equal(marketPriceText(0, language), '0');
    assert.equal(marketPriceText(null, language), '—');
  }
});

test('trial and water histories retain every page and reject a looping cursor', async () => {
  for (const history of ['observations', 'logs'] as const) {
    const calls: string[] = [];
    const api: ApiClient = {
      request: async <T>(path: string) => {
        calls.push(path);
        return { summary: { count: 2 }, [history]: [{ id: calls.length }], nextCursor: calls.length === 1 ? 'a/b' : null } as T;
      },
      upload: async <T>() => ({} as T),
    };
    const result = await readDetailHistory(api, '/v1/farms/f/trials/t', history);
    assert.deepEqual(result[history], [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(result.summary, { count: 2 });
    assert.match(calls[1]!, /limit=100&cursor=a%2Fb$/);
    const looping: ApiClient = { ...api, request: async <T>() => ({ [history]: [], nextCursor: 'repeat' } as T) };
    await assert.rejects(readDetailHistory(looping, '/v1/farms/f/trials/t', history), /request_failed/);
    await assert.rejects(readDetailHistory({ ...api, request: async <T>() => ({}) as T }, '/v1/farms/f/trials/t', history), /invalid_response/);
  }
});
