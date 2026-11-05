import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { clearLocalSession, createSessionGate, createSessionTrace, SESSION_TRACE_LIMIT, SESSION_TRACE_PREFIX, sessionStep, type SessionTrace } from '../src/session-transition';

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

test('session diagnostics are opt-in, bounded fixed categories and cannot emit private errors or alter cleanup', async () => {
  const lines: string[] = []; const canary = 'private-token-user-origin-error-must-not-appear';
  const disabled = createSessionTrace({ enabled: false, sink: line => lines.push(line) }); disabled('trace', 'ready'); assert.equal(lines.length, 0);
  const trace = createSessionTrace({ enabled: true, sink: line => lines.push(line), now: () => Date.parse('2026-11-05T16:00:00Z') });
  trace('trace', 'ready');
  // Even accidental runtime casts cannot turn the category API into a free-form logger.
  (trace as (stage: string, phase: string) => void)(canary, 'start');
  (trace as (stage: string, phase: string) => void)('session_delete', canary);
  const error = new Error(canary);
  await assert.rejects(sessionStep('session_delete', async () => { throw error; }, trace), value => value === error);
  for (let i = 0; i < SESSION_TRACE_LIMIT * 2; i++) trace('sign_out_press', 'received');
  assert.equal(lines.length, SESSION_TRACE_LIMIT); assert.ok(lines.every(line => line.length < 256));
  assert.ok(lines.every(line => line.startsWith(SESSION_TRACE_PREFIX))); assert.ok(!lines.join('\n').includes(canary));
  const entries = lines.map(line => JSON.parse(line.slice(SESSION_TRACE_PREFIX.length)));
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'elapsed_ms', 'phase', 'sequence', 'stage']);
  assert.equal(entries[0].phase, 'ready'); assert.equal(entries.at(-1).phase, 'limit');
  assert.ok(entries.some(entry => entry.stage === 'session_delete' && entry.phase === 'failed'));
  const brokenSink = createSessionTrace({ enabled: true, sink: () => { throw error; } });
  assert.equal(await sessionStep('session_delete', async () => 'unchanged', brokenSink), 'unchanged');
});

test('iOS live capture rejects unrelated or private fields and caps its artifact independently of the app', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./session-trace-capture.test.py', import.meta.url))], { stdio: 'pipe' });
});
