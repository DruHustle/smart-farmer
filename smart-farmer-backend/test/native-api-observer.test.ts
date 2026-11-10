import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const observer = fileURLToPath(new URL('../../smart-farmer-frontend/mobile/acceptance/api-request-observer.cjs', import.meta.url));
const backend = fileURLToPath(new URL('../', import.meta.url));
const sentinels = ['body-secret-sentinel', 'header-secret-sentinel', 'query-secret-sentinel', 'error-secret-sentinel'];

// A separate real HTTP process also proves the unref'd observer permits natural
// exit. Only response hashes leave the child; no application credentials are used.
const fixture = String.raw`
const Fastify = require('fastify');
const { request } = require('node:http');
const { createHash } = require('node:crypto');
if (process.env.OBSERVER_TEST_FAIL_LOGGING === '1') {
  const { closeSync, openSync } = require('node:fs');
  closeSync(2);
  // Retain fd2 as a genuinely unwritable descriptor so later HTTP sockets
  // cannot reuse its number. Observer writes must fail without an error event.
  if (openSync('/dev/null', 'r') !== 2) throw new Error('diagnostic-descriptor-not-reserved');
}
const app = Fastify({ logger: false });
const digest = value => createHash('sha256').update(value).digest('hex');
let abortEntered, abortClosed, releaseAbort;
const entered = new Promise(resolve => { abortEntered = resolve; });
const closed = new Promise(resolve => { abortClosed = resolve; });
const heldAbort = new Promise(resolve => { releaseAbort = resolve; });
app.addHook('onSend', async (_req, reply, body) => {
  reply.header('x-observer-fixture', 'header-secret-sentinel');
  return body;
});
app.setErrorHandler((_error, _request, reply) => reply.code(418).send({ error: 'fixed-fixture-refusal' }));
app.post('/v1/sessions', async (req, reply) => {
  if (req.body.kind === 'reject') throw new Error('error-secret-sentinel');
  if (req.body.kind === 'abort') {
    reply.raw.once('close', abortClosed);
    abortEntered();
    await heldAbort;
  }
  if (req.body.kind === 'held') await new Promise(resolve => setTimeout(resolve, 5300));
  return { ok: true, echoed: req.body.secret };
});
app.get('/other', async () => ({ ignored: true }));
function send(kind, onRequest, other = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ kind, secret: 'body-secret-sentinel' });
    const req = request({ host: '127.0.0.1', port: 3000, agent: false,
      path: (other ? '/other' : '/v1/sessions') + '?private=query-secret-sentinel',
      method: other ? 'GET' : 'POST',
      headers: { authorization: 'Bearer header-secret-sentinel', cookie: 'header-secret-sentinel',
        'x-request-id': 'header-secret-sentinel', ...(other ? {} : {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: digest(Buffer.concat(chunks)), headers: digest(JSON.stringify({
          contentType: response.headers['content-type'], fixture: response.headers['x-observer-fixture'],
        })) }));
    });
    req.once('error', reject);
    if (onRequest) onRequest(req);
    req.end(other ? undefined : body);
  });
}
(async () => {
  await app.listen({ host: '127.0.0.1', port: 3000 });
  try {
    const results = [await send('ok'), await send('reject')];
    let cancel;
    const aborted = send('abort', req => { cancel = () => req.destroy(); })
      .then(() => ({ aborted: false }), error => ({ aborted: true, code: error.code }));
    await entered;
    cancel();
    results.push(await aborted);
    await closed;
    releaseAbort();
    results.push(await send('held'));
    const ignored = await send('ignored', undefined, true);
    for (let index = 0; index < 70; index++) {
      const value = await send('ok');
      if (JSON.stringify(value) !== JSON.stringify(results[0])) throw new Error('response-changed');
    }
    console.log(JSON.stringify({ results, ignored, extraRequests: 70 }));
  } finally {
    releaseAbort();
    await app.close();
  }
})().catch(() => { process.stderr.write('Fixture execution failed.\n'); process.exitCode = 1; });
`;

function run(enabled: boolean, failLogging = false) {
  const child = spawnSync(process.execPath, ['--require', observer, '--input-type=commonjs', '--eval', fixture], {
    cwd: backend,
    env: { ...process.env, CI: enabled ? 'true' : 'false', NODE_ENV: 'test', OBSERVER_TEST_FAIL_LOGGING: failLogging ? '1' : '0' },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, 'observer must permit natural service exit');
  assert.equal(child.status, 0, 'HTTP fixture must complete successfully');
  return { result: JSON.parse(child.stdout), log: child.stderr };
}

test('iOS API diagnostics preserve real HTTP behavior and expose only bounded phase metadata', () => {
  const baseline = run(false);
  const observed = run(true);
  const brokenLogger = run(true, true);
  assert.deepEqual(observed.result, baseline.result);
  assert.deepEqual(brokenLogger.result, baseline.result, 'an unwritable diagnostic descriptor must not alter responses');
  assert.deepEqual(observed.result.results.map((value: { status?: number; aborted?: boolean }) => value.status ?? value.aborted), [200, 418, true, 200]);
  assert.equal(observed.result.results[2].code, 'ECONNRESET');
  assert.equal(baseline.log, '', 'preload stays inactive outside CI');
  for (const secret of sentinels) assert.equal(observed.log.includes(secret), false, 'private sentinel must not enter diagnostics');
  const events = observed.log.trim().split('\n').map(line => {
    assert.ok(line.startsWith('[native-api] '));
    return JSON.parse(line.slice('[native-api] '.length));
  });
  assert.ok(Buffer.byteLength(observed.log) <= 256 * 1024);
  assert.ok(events.length <= 2048);
  const starts = events.filter(event => event.event === 'request.start');
  assert.equal(starts.length, 64, 'later requests still succeed after the observation request budget');
  assert.ok(starts.every(event => event.method === 'POST' && event.path === '/v1/sessions'));
  const names = (id: number) => events.filter(event => event.id === id).map(event => event.event);
  const successful = names(1);
  for (const name of ['request.start', 'request.end', 'handler.enter', 'handler.sync_return', 'handler.promise_settled', 'handler.reply_dispatch_return', 'response.finish']) assert.ok(successful.includes(name), name);
  assert.ok(successful.indexOf('handler.sync_return') < successful.indexOf('handler.promise_settled'));
  assert.ok(events.some(event => event.id === 2 && event.event === 'handler.error'));
  assert.ok(events.some(event => event.id === 2 && event.event === 'handler.promise_settled' && event.errorObserved === true));
  assert.ok(events.some(event => event.id === 3 && event.event === 'response.close' && event.finished === false && event.status === null));
  assert.ok(events.some(event => event.event === 'heartbeat' && event.pending.includes(4) && event.delayMs >= 0));
  const allowed = new Set(['event', 'time', 'id', 'method', 'path', 'complete', 'elapsedMs', 'status', 'headersSent', 'ended', 'finished', 'destroyed', 'errored', 'async', 'errorObserved', 'requestLimit', 'eventLimit', 'byteLimit', 'pending', 'delayMs']);
  assert.ok(events.every(event => Object.keys(event).every(key => allowed.has(key))));
});
