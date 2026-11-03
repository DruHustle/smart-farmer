import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vault} from '../src/lib/vault.ts';
import {drainOutbox, isQueueable, queueRecords} from '../src/lib/sync.ts';
const origin = 'https://api.smart-farmer.invalid';
const password = 'a-test-password-that-is-not-a-secret';
function fixture(userId = 'user-one', username = 'worker-one') {return {version: 1, identity: {token: 'private-session-token', userId, username, language: 'sn', expiresAt: '2099-01-01T00:00:00Z'}, language: 'sn', farms: [{id: 'farm-one', name: 'Private fixture farm', role: 'worker', timezone: 'Africa/Harare'}], currentFarmId: 'farm-one', data: {}, outbox: []};}
function storage() {const items = new Map(); return {items, async get(key) {return structuredClone(items.get(key));}, async set(key, value) {items.set(key, structuredClone(value));}, async remove(key) {items.delete(key);}};}
function entry(id = 'activity-one') {return {id, farmId: 'farm-one', path: '/v1/farms/farm-one/activities', method: 'POST', payload: {id, projectId: 'project-one', kind: 'observation', note: 'A private observation'}, label: 'observation', status: 'pending', attempts: 0, createdAt: '2026-11-03T10:00:00Z'};}

test('encrypted drafts survive restart; another account and wrong password cannot read them', async () => {
  const store = storage(); const vault = await Vault.unlock(origin, 'worker-one', password, fixture(), store);
  await vault.mutate(data => {data.outbox.push(entry());});
  const ciphertext = new Uint8Array(store.items.values().next().value.bytes);
  const text = new TextDecoder().decode(ciphertext);
  assert.ok(!text.includes('A private observation')); assert.ok(!text.includes('private-session-token'));
  const restored = await Vault.unlock(origin, 'worker-one', password, undefined, store);
  assert.equal(restored.snapshot().outbox[0].payload.note, 'A private observation');
  await assert.rejects(Vault.unlock(origin, 'worker-one', 'incorrect-password', undefined, store), /saved_data_locked/);
  await assert.rejects(Vault.unlock(origin, 'worker-two', password, undefined, store), /no_saved_data/);
  const other = await Vault.unlock(origin, 'worker-two', password, fixture('user-two', 'worker-two'), store);
  assert.equal(other.snapshot().outbox.length, 0);
  await Promise.all([restored.mutate(data => data.outbox.push(entry('second'))), restored.mutate(data => data.outbox.push(entry('third')))]);
  assert.equal((await Vault.unlock(origin, 'worker-one', password, undefined, store)).snapshot().outbox.length, 3);
});

test('a lost server response retries the same ID; metadata completes before independent media', async () => {
  const store = storage(); const vault = await Vault.unlock(origin, 'worker-one', password, fixture(), store);
  await vault.storeAttachment('photo', {mimeType: 'image/jpeg', dataBase64: 'ZmFrZS1waG90bw==', filename: 'evidence.jpg'});
  await vault.mutate(data => {data.outbox.push(entry(), {...entry('photo'), path: '/v1/farms/farm-one/media', payload: {id: 'photo', activityId: 'activity-one'}, mediaId: 'photo'});});
  const records = new Set(); const uploads = []; let lostResponse = true;
  const send = async (item, payload) => {
    if (!item.mediaId) {records.add(payload.id); if (lostResponse) {lostResponse = false; throw new TypeError('Failed to fetch');}}
    else {assert.equal(records.size, 1); uploads.push(payload.dataBase64);}
  };
  await drainOutbox(vault, send, true, () => 1000);
  assert.equal(vault.snapshot().outbox.length, 2);
  const restarted = await Vault.unlock(origin, 'worker-one', password, undefined, store);
  await drainOutbox(restarted, send, false, () => 999999);
  assert.equal(records.size, 1); assert.equal(restarted.snapshot().outbox.length, 1); assert.equal(uploads.length, 0);
  await drainOutbox(restarted, send, true, () => 999999);
  assert.equal(uploads.length, 1); assert.equal(restarted.snapshot().outbox.length, 0);
});

test('material conflicts stop retrying, revoked access is explicit, equipment never enters outbox', async () => {
  for (const path of ['/v1/farms/a/assets/pump/commands', '/v1/market/listings/a/orders', '/v1/services/tractor/bookings', '/v1/me']) assert.equal(isQueueable(path, 'POST'), false, path);
  const store = storage(); const vault = await Vault.unlock(origin, 'worker-one', password, fixture(), store);
  await vault.mutate(data => {data.outbox.push(entry());});
  const conflict = Object.assign(new Error('version_conflict'), {status: 409});
  await drainOutbox(vault, async () => {throw conflict;}, false);
  assert.equal(vault.snapshot().outbox[0].status, 'conflict');
  let retried = false; await drainOutbox(vault, async () => {retried = true;}, false); assert.equal(retried, false);
  await vault.mutate(data => {data.outbox[0].status = 'pending'; delete data.outbox[0].nextAttemptAt;});
  await drainOutbox(vault, async () => {throw Object.assign(new Error('unauthorized'), {status: 401});}, false);
  assert.equal(vault.snapshot().requiresAuth, true); assert.equal(vault.snapshot().outbox.length, 1);
});

test('password recovery can re-encrypt old drafts and media, or retain a recoverable encrypted archive', async () => {
  const store = storage(); const old = await Vault.unlock(origin, 'worker-one', password, fixture(), store);
  await old.storeAttachment('photo', {mimeType: 'image/jpeg', dataBase64: 'cHJpdmF0ZQ==', filename: 'evidence.jpg'});
  await old.mutate(data => {data.outbox.push(entry(), {...entry('photo'), path: '/v1/farms/farm-one/media', payload: {id: 'photo', activityId: 'activity-one'}, mediaId: 'photo'});});
  const newPassword = 'a-new-test-password-after-recovery'; const initial = fixture(); initial.identity.token = 'new-server-session';
  await assert.rejects(Vault.unlock(origin, 'worker-one', newPassword, initial, store), /saved_data_locked/);
  const rekeyed = await Vault.recover(origin, 'worker-one', newPassword, initial, password, store);
  assert.equal(rekeyed.snapshot().outbox.length, 2); assert.equal((await rekeyed.readAttachment('photo')).dataBase64, 'cHJpdmF0ZQ==');
  const another = 'a-third-password-after-another-recovery';
  const fresh = await Vault.recover(origin, 'worker-one', another, fixture(), undefined, store);
  assert.equal(fresh.snapshot().outbox.length, 0); assert.equal(fresh.archiveCount(), 1);
  const resumed = await Vault.unlock(origin, 'worker-one', another, fixture(), store);
  await assert.rejects(resumed.restoreArchivedDrafts('wrong'), /saved_data_locked/);
  assert.equal(await resumed.restoreArchivedDrafts(newPassword), 2);
  assert.equal(resumed.snapshot().outbox.length, 2); assert.equal((await resumed.readAttachment('photo')).dataBase64, 'cHJpdmF0ZQ==');
  assert.equal(await resumed.restoreArchivedDrafts(newPassword), 0);
});


test('one activity and its media queue commit together, or remain wholly unsaved on storage failure', async () => {
  const store = storage(); const vault = await Vault.unlock(origin, 'worker-one', password, fixture(), store);
  const entries = [entry(), {...entry('photo'), path: '/v1/farms/farm-one/media', payload: {id: 'photo', activityId: 'activity-one'}, mediaId: 'photo'}];
  const write = store.set; store.set = async () => {throw new Error('storage_failed');};
  await assert.rejects(queueRecords(vault, entries), /storage_failed/);
  assert.equal(vault.snapshot().outbox.length, 0);
  store.set = write;
  assert.equal((await Vault.unlock(origin, 'worker-one', password, undefined, store)).snapshot().outbox.length, 0);
  await queueRecords(vault, entries);
  assert.equal((await Vault.unlock(origin, 'worker-one', password, undefined, store)).snapshot().outbox.length, 2);
  await assert.rejects(queueRecords(vault, [{...entry('unsafe'), path: '/v1/farms/farm-one/assets/pump/commands'}]), /unsafe_outbox_route/);
  assert.equal(vault.snapshot().outbox.length, 2);
});
