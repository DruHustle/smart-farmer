import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLocalSession, createSessionGate, type SessionTrace } from '../src/session-transition';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('local sign-out waits for cleanup and keeps unlock and repeated sign-out blocked until auth commits', async () => {
  const deleted = deferred(); const notifications = deferred(); const notificationStarted = deferred();
  const calls: string[] = []; const busy: boolean[] = []; const trace: SessionTrace = (stage, phase) => calls.push(`${stage}:${phase}`);
  const gate = createSessionGate(value => busy.push(value), trace);
  const first = gate.run('sign_out', () => clearLocalSession({
    forgetSession: () => { calls.push('delete'); return deleted.promise; },
    clearNotifications: () => { calls.push('notifications'); notificationStarted.resolve(); return notifications.promise; },
    clearState: () => calls.push('clear'),
  }, trace));
  assert.equal(gate.busy, true); assert.deepEqual(busy, [true]);
  for (const action of ['unlock', 'sign_out'] as const) assert.equal(await gate.run(action, async () => { assert.fail('Concurrent local authentication must be blocked'); }), false);
  assert.ok(!calls.includes('notifications')); assert.ok(!calls.includes('clear'));
  deleted.resolve(); await notificationStarted.promise;
  assert.ok(calls.includes('notifications')); assert.ok(!calls.includes('clear'), 'A pending notification/channel write cannot expose a new login');
  notifications.resolve(); assert.equal(await first, true);
  assert.ok(calls.indexOf('delete') < calls.indexOf('notifications')); assert.ok(calls.indexOf('notifications') < calls.indexOf('clear'));
  assert.equal(gate.busy, true, 'React state setters do not constitute a committed auth screen');
  assert.equal(await gate.run('unlock', async () => assert.fail('Stale unlock must remain blocked before commit')), false);
  gate.authScreenCommitted(); assert.equal(gate.busy, false); assert.deepEqual(busy, [true, false]);
  assert.ok(calls.indexOf('local_session_clear:queued') < calls.indexOf('auth_screen:committed'));
});

test('pending unlock excludes sign-out and releases its gate on completion or rejection', async () => {
  const prompt = deferred(); const gate = createSessionGate(() => undefined, () => undefined);
  const unlocking = gate.run('unlock', () => prompt.promise);
  assert.equal(await gate.run('sign_out', async () => assert.fail('Cleanup must not overlap local unlock')), false);
  prompt.resolve(); await unlocking; assert.equal(gate.busy, false);
  const nativeError = new Error('synthetic-private-native-error');
  await assert.rejects(gate.run('unlock', async () => { throw nativeError; }), error => error === nativeError);
  assert.equal(gate.busy, false);
});

test('session deletion failure preserves the locked session while notification rejection retains existing best-effort semantics', async () => {
  const calls: string[] = []; const trace: SessionTrace = (stage, phase) => calls.push(`${stage}:${phase}`);
  const gate = createSessionGate(() => undefined, trace); const failure = new Error('synthetic-private-native-error');
  await assert.rejects(gate.run('sign_out', () => clearLocalSession({
    forgetSession: async () => { throw failure; },
    clearNotifications: async () => assert.fail('Deletion failure must stop notification cleanup'),
    clearState: () => assert.fail('Deletion failure must retain the locked session'),
  }, trace)), error => error === failure);
  assert.equal(gate.busy, false); assert.ok(calls.includes('session_delete:failed'));
  await gate.run('sign_out', () => clearLocalSession({
    forgetSession: async () => undefined,
    clearNotifications: async () => { throw failure; },
    clearState: () => calls.push('clear'),
  }, trace));
  assert.ok(calls.includes('notifications_cleanup:failed')); assert.ok(calls.includes('clear'));
  assert.equal(gate.busy, true); gate.authScreenCommitted(); assert.equal(gate.busy, false);
});
