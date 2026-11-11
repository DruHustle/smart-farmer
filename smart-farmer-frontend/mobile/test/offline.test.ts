import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError, type ApiClient } from '../src/api';
import { LocalRepository } from '../src/repository';
import { mutationRequest, Synchronizer } from '../src/sync';
import type { FarmSnapshot, Mutation, RecordDraft } from '../src/types';
import { activity, attachment, TestDatabase } from './helpers';

function api(handler: (path: string, method: string, body: unknown) => Promise<unknown>, media?: (path: string, body: unknown) => Promise<unknown>): ApiClient {
  return { request: <T>(path: string, method = 'GET', body?: unknown) => handler(path, method, body) as Promise<T>, upload: <T>(path: string, body: unknown) => (media ? media(path, body) : Promise.resolve({ id: (body as { id: string }).id, status: 'stored' })) as Promise<T> };
}

test('SQLite restart keeps one exact field payload; a lost acknowledgement retries its ID and uploads media only after acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-farmer-native-'));
  const filename = join(directory, 'account-a.db');
  let repository = new LocalRepository(new TestDatabase(filename));
  try {
    await repository.initialize();
    const mutation = activity();
    const file = attachment(mutation);
    await repository.saveDraft(mutation.farmId, { id: mutation.id, projectId: String(mutation.body.projectId), kind: 'input_use', observedLocal: '2026-11-03T11:00', note: String(mutation.body.note), quantity: '5', unit: 'kg', stockItemId: String(mutation.body.stockItemId), amount: '', currency: '', taskId: '' });
    await repository.attach(file); await repository.enqueue(mutation, true);
    const accepted = new Map<string, unknown>(); let stockEffects = 0; let costEffects = 0; let calls = 0; let mediaCalls = 0;
    const transport = api(async (_path, _method, body) => {
      calls++; const item = body as { id: string };
      if (!accepted.has(item.id)) { accepted.set(item.id, body); stockEffects++; costEffects++; throw new ApiError(0, 'network_error'); }
      assert.deepEqual(accepted.get(item.id), body); return { id: item.id };
    }, async (_path, body) => { mediaCalls++; assert.equal((body as { activityId: string }).activityId, mutation.id); return { id: file.id, status: 'stored' }; });
    await new Synchronizer(repository, transport).flush(mutation.farmId, { media: true });
    assert.equal(mediaCalls, 0); assert.equal((await repository.mutations(mutation.farmId))[0]!.attempts, 1);
    await repository.close();
    repository = new LocalRepository(new TestDatabase(filename)); await repository.initialize();
    assert.equal(await repository.draft(mutation.farmId), null);
    assert.deepEqual((await repository.mutations(mutation.farmId))[0]!.body, mutation.body);
    const result = await new Synchronizer(repository, transport).flush(mutation.farmId, { media: true });
    assert.equal(result.accepted, 1); assert.equal(calls, 2); assert.equal(stockEffects, 1); assert.equal(costEffects, 1); assert.equal(mediaCalls, 1);
    assert.deepEqual(await repository.mutations(mutation.farmId), []);
    assert.equal((await repository.attachments(mutation.farmId))[0]!.state, 'synced');
    assert.equal((await repository.attachments(mutation.farmId))[0]!.dataBase64, '');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('media failures retain the photograph without repeating accepted metadata', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const mutation = activity(); const file = attachment(mutation);
    await repository.attach(file); await repository.enqueue(mutation);
    let activities = 0; let uploads = 0;
    const transport = api(async () => { activities++; return {}; }, async () => { uploads++; if (uploads === 1) throw new ApiError(503, 'unavailable'); return { id: file.id, status: 'stored' }; });
    const sync = new Synchronizer(repository, transport);
    await sync.flush(mutation.farmId, { media: true });
    assert.equal(activities, 1); assert.equal((await repository.attachments(mutation.farmId))[0]!.dataBase64, file.dataBase64);
    await sync.flush(mutation.farmId, { media: true }); assert.equal(activities, 1); assert.equal(uploads, 2);
  } finally { await repository.close(); }
});

test('an idempotency conflict retains the original payload and prevents dependent media upload', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const mutation = activity(); await repository.attach(attachment(mutation)); await repository.enqueue(mutation);
    let calls = 0; let uploads = 0;
    const sync = new Synchronizer(repository, api(async () => { calls++; throw new ApiError(409, 'idempotency_conflict'); }, async () => { uploads++; return {}; }));
    await sync.flush(mutation.farmId, { media: true }); await sync.flush(mutation.farmId, { media: true });
    const retained = (await repository.mutations(mutation.farmId))[0]!;
    assert.equal(retained.state, 'conflict'); assert.deepEqual(retained.body, mutation.body); assert.equal(calls, 1); assert.equal(uploads, 0);
    await assert.rejects(repository.enqueue({ ...mutation, body: { ...mutation.body, quantity: 9 } }), /idempotency_conflict/);
  } finally { await repository.close(); }
});

test('expired access stops synchronisation and leaves the record recoverable', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const first = activity(); const second = activity(first.farmId); await repository.enqueue(first); await repository.enqueue(second);
    let calls = 0;
    const result = await new Synchronizer(repository, api(async () => { calls++; throw new ApiError(401, 'unauthorized'); })).flush(first.farmId, { media: true });
    assert.equal(result.unauthorized, true); assert.equal(calls, 1);
    const records = await repository.mutations(first.farmId); assert.equal(records.length, 2); assert.equal(records[0]!.state, 'blocked'); assert.equal(records[1]!.attempts, 0);
  } finally { await repository.close(); }
});

test('concurrent flushes coalesce and an entry added during upload is not lost', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const first = activity(); const second = activity(first.farmId); await repository.enqueue(first);
    let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const sync = new Synchronizer(repository, api(async () => { calls++; await gate; return {}; }));
    const one = sync.flush(first.farmId); const two = sync.flush(first.farmId); assert.equal(one, two);
    await repository.enqueue(second); release(); await Promise.all([one, two]);
    assert.equal(calls, 1); assert.equal((await repository.mutations(first.farmId))[0]!.id, second.id);
    await sync.flush(first.farmId); assert.equal(calls, 2); assert.equal((await repository.mutations(first.farmId)).length, 0);
  } finally { await repository.close(); }
});

test('farm/account caches are isolated; revoked membership clears cached reads but retains blocked drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-farmer-native-'));
  const a = new LocalRepository(new TestDatabase(join(directory, 'user-a.db'))); const b = new LocalRepository(new TestDatabase(join(directory, 'user-b.db')));
  await a.initialize(); await b.initialize();
  try {
    const first = activity(); const other = activity();
    const snapshot: FarmSnapshot = { farm: { id: first.farmId, name: 'Isolated fixture farm', role: 'owner', timezone: 'Africa/Harare' }, projects: [], tasks: [], activities: [], stock: [], members: [], assets: [], syncedAt: first.createdAt };
    await a.saveSnapshot(snapshot); await a.enqueue(first); await a.enqueue(other); await a.setPreference(`farm:${first.farmId}:project:test`, { confidential: true });
    assert.equal(await b.snapshot(first.farmId), null); assert.deepEqual(await b.mutations(first.farmId), []);
    await a.revokeFarm(first.farmId);
    assert.equal(await a.snapshot(first.farmId), null); assert.equal(await a.preference(`farm:${first.farmId}:project:test`), null);
    assert.equal((await a.mutations(first.farmId))[0]!.lastError, 'access_revoked'); assert.equal((await a.mutations(other.farmId))[0]!.state, 'pending');
  } finally { await a.close(); await b.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a local transaction failure keeps the draft and media without creating a partial outbox entry', async () => {
  const db = new TestDatabase(':memory:'); const repository = new LocalRepository(db); await repository.initialize();
  try {
    const mutation = activity(); const file = attachment(mutation); await repository.attach(file);
    const draft: RecordDraft = { id: mutation.id, projectId: String(mutation.body.projectId), kind: 'input_use', observedLocal: '2026-11-03T11:00', note: 'Draft', quantity: '5', unit: 'kg', stockItemId: String(mutation.body.stockItemId), amount: '', currency: '', taskId: '' };
    await repository.saveDraft(mutation.farmId, draft);
    await db.execAsync("CREATE TRIGGER fail_attachment BEFORE UPDATE ON attachments BEGIN SELECT RAISE(FAIL, 'test disk failure'); END;");
    await assert.rejects(repository.enqueue(mutation, true), /test disk failure/);
    assert.deepEqual(await repository.mutations(mutation.farmId), []); assert.deepEqual(await repository.draft(mutation.farmId), draft); assert.equal((await repository.attachments(mutation.farmId))[0]!.state, 'draft');
  } finally { await repository.close(); }
});

test('five failed attempts stop automatic retries; explicit retry preserves the same client ID', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const mutation = activity(); await repository.enqueue(mutation); let calls = 0;
    const sync = new Synchronizer(repository, api(async () => { calls++; throw new ApiError(503, 'unavailable'); }));
    for (let attempt = 0; attempt < 7; attempt++) await sync.flush(mutation.farmId);
    assert.equal(calls, 5); const blocked = (await repository.mutations(mutation.farmId))[0]!; assert.equal(blocked.state, 'blocked');
    await repository.updateMutation({ ...blocked, state: 'pending', attempts: 0 });
    await new Synchronizer(repository, api(async (_path, _method, body) => { assert.equal((body as { id: string }).id, mutation.id); return {}; })).flush(mutation.farmId);
    assert.deepEqual(await repository.mutations(mutation.farmId), []);
  } finally { await repository.close(); }
});

test('the offline path cannot queue delayed actuator commands or inject a resource path', () => {
  const mutation = activity();
  assert.throws(() => mutationRequest({ ...mutation, kind: 'equipment-command' } as unknown as Mutation), /unsafe_offline_action/);
  assert.throws(() => mutationRequest({ ...mutation, kind: 'task-status', resourceId: '../assets/pump/commands' }), /invalid_record/);
  assert.match(mutationRequest(mutation).path, /\/activities$/);
});

test('restart resumes legacy pending records and photos interrupted on their fifth attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-farmer-interrupted-'));
  const filename = join(directory, 'account.db');
  let repository = new LocalRepository(new TestDatabase(filename)); await repository.initialize();
  try {
    const record = activity(); const photo = attachment(record);
    await repository.attach(photo); await repository.enqueue(record);
    await repository.updateMutation({ ...record, attempts: 5 });
    await repository.updateAttachment({ ...photo, state: 'pending', attempts: 5 });
    await repository.close();
    repository = new LocalRepository(new TestDatabase(filename)); await repository.initialize();
    const sync = new Synchronizer(repository, api(async (_path, _method, body) => {
      assert.deepEqual(body, record.body); return {};
    }, async (_path, body) => {
      const payload = body as { id: string; dataBase64: string };
      assert.equal(payload.id, photo.id); assert.equal(payload.dataBase64, photo.dataBase64);
      return { id: photo.id, status: 'stored' };
    }));
    const result = await sync.flush(record.farmId, { media: true });
    assert.equal(result.accepted, 1); assert.equal(result.mediaUploaded, 1);
    assert.deepEqual(await repository.mutations(record.farmId), []);
    assert.equal((await repository.attachments(record.farmId))[0]!.state, 'synced');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a late response cannot reopen a revoked queue or send later work under an old role', async () => {
  for (const during of ['record', 'photo'] as const) {
    const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
    try {
      const first = activity(); const second = activity(first.farmId);
      for (const record of [first, second]) {
        await repository.attach(attachment(record)); await repository.enqueue(record);
      }
      let calls = 0;
      const lateFailure = async () => {
        calls++; await repository.revokeFarm(first.farmId); throw new ApiError(503, 'unavailable');
      };
      const sync = new Synchronizer(repository, api(during === 'record' ? lateFailure : async () => ({}), lateFailure));
      await sync.flush(first.farmId, { media: true });
      assert.equal(calls, 1);
      const pending = await repository.mutations(first.farmId);
      assert.equal(pending.length, during === 'record' ? 2 : 0);
      for (const item of [...pending, ...await repository.attachments(first.farmId)]) {
        assert.equal(item.state, 'blocked'); assert.equal(item.lastError, 'access_revoked');
      }
      await sync.flush(first.farmId, { media: true }); assert.equal(calls, 1);
    } finally { await repository.close(); }
  }
});

test('submitting a recovered field draft does not requeue a previously revoked photograph', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const record = activity(); const photo = attachment(record);
    await repository.attach(photo);
    await repository.revokeFarm(record.farmId);
    await repository.enqueue(record);
    assert.equal((await repository.attachments(record.farmId))[0]!.state, 'blocked');
    const sync = new Synchronizer(repository, api(async () => ({}), async () => assert.fail('revoked photo was sent')));
    const result = await sync.flush(record.farmId, { media: true });
    assert.equal(result.accepted, 1); assert.equal(result.mediaUploaded, 0); assert.equal(result.failed, 0);
  } finally { await repository.close(); }
});

test('a photo stays queued until the API confirms that its exact ID was stored', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const record = activity(); const photo = attachment(record);
    await repository.attach(photo); await repository.enqueue(record);
    const receipts = [null, { id: record.id, status: 'stored' }, { id: photo.id, status: 'pending' }, { id: photo.id, status: 'stored' }];
    const sync = new Synchronizer(repository, api(async () => ({ id: record.id }), async () => receipts.shift()));
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sync.flush(record.farmId, { media: true });
      assert.equal(result.failed, 1);
      const retained = (await repository.attachments(record.farmId))[0]!;
      assert.equal(retained.state, 'pending'); assert.equal(retained.lastError, 'invalid_response');
      assert.equal(retained.dataBase64, photo.dataBase64);
    }
    const result = await sync.flush(record.farmId, { media: true }); assert.equal(result.mediaUploaded, 1);
    assert.equal((await repository.attachments(record.farmId))[0]!.dataBase64, '');
  } finally { await repository.close(); }
});
