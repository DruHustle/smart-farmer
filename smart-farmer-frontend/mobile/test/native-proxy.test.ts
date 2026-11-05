import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const acceptance = join(dirname(fileURLToPath(import.meta.url)), '../acceptance');
const canary = 'native-diagnostic-secret-must-not-appear';
type Observed = { method?: string; path?: string; authorization?: string; contentType?: string; body: string };
type Event = { event: string; sequence?: number; route?: string; status?: number; duration_ms?: number; at?: string; connecting?: boolean };

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Fixture event must arrive within five seconds');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const tls of [false, true]) test(`native ${tls ? 'TLS' : 'HTTP'} proxy preserves requests and emits bounded secret-free diagnostics`, { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-proxy-'));
  const offline = join(directory, 'offline');
  const tlsDirectory = join(directory, 'tls');
  const requests: Observed[] = [];
  const stalled: ServerResponse[] = [];
  let readinessStatus = 200;
  let backendClosed = false;
  const backend = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => {
      requests.push({ method: incoming.method, path: incoming.url, authorization: incoming.headers.authorization, contentType: incoming.headers['content-type'], body: Buffer.concat(chunks).toString() });
      if (incoming.url?.startsWith('/v1/stall/')) { stalled.push(outgoing); return; }
      if (incoming.method === 'DELETE') { outgoing.writeHead(204); outgoing.end(); return; }
      outgoing.writeHead(incoming.url === '/ready' ? readinessStatus : incoming.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ token: canary }));
    });
  });
  const backendPort = await listen(backend);
  const reservation = createServer();
  const proxyPort = await listen(reservation);
  await close(reservation);
  const env = { ...process.env, NATIVE_API_ORIGIN: `http://127.0.0.1:${backendPort}`, NATIVE_PROXY_PORT: String(proxyPort), NATIVE_OFFLINE_FLAG: offline, EXPO_PUBLIC_API_URL: `https://127.0.0.1:${proxyPort}`, NATIVE_TLS_DIR: tlsDirectory };
  let ca: Buffer | undefined;
  if (tls) {
    await run(process.execPath, [join(acceptance, 'simulator-tls.mjs'), 'prepare'], { env });
    ca = await readFile(join(tlsDirectory, 'ca.pem'));
  }
  const proxyEnv: NodeJS.ProcessEnv = { ...env };
  if (!tls) delete proxyEnv.NATIVE_TLS_DIR;
  const proxy = spawn(process.execPath, [join(acceptance, 'fixture.mjs'), 'proxy'], { env: proxyEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  proxy.stdout.on('data', chunk => { output += chunk.toString(); });
  proxy.stderr.on('data', chunk => { errors += chunk.toString(); });
  const exit = once(proxy, 'exit');
  const events = () => output.split('\n').slice(0, -1).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Event);
  const send = (method: string, path: string, body?: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)(`${tls ? 'https' : 'http'}://127.0.0.1:${proxyPort}${path}`, {
      method, ca, agent: false,
      headers: { authorization: `Bearer ${canary}`, cookie: `session=${canary}`, 'x-canary': canary, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.once('error', reject);
    req.end(body);
  });
  try {
    await waitFor(() => output.includes('Native acceptance network proxy ready.'));
    const body = JSON.stringify({ password: canary, deviceName: 'Smart Farmer · ios' });
    const login = await send('POST', `/v1/sessions?token=${canary}`, body);
    assert.equal(login.status, 201);
    assert.deepEqual(JSON.parse(login.body), { token: canary });
    assert.deepEqual(requests[0], { method: 'POST', path: `/v1/sessions?token=${canary}`, authorization: `Bearer ${canary}`, contentType: 'application/json', body });
    assert.deepEqual(await send('DELETE', '/v1/sessions/current'), { status: 204, body: '' });
    assert.deepEqual(requests[1], { method: 'DELETE', path: '/v1/sessions/current', authorization: `Bearer ${canary}`, contentType: undefined, body: '' });
    await send('GET', `/v1/opaque/${canary}?credential=${canary}`);

    const beforeOffline = requests.length;
    await writeFile(offline, '');
    assert.deepEqual(await send('POST', '/v1/sessions', body), { status: 503, body: '{"error":"network_error"}' });
    assert.equal(requests.length, beforeOffline, 'Offline requests must not reach the API');
    await rm(offline);
    assert.equal((await send('GET', '/health')).status, 200);

    if (tls) {
      const verified = await run(process.execPath, [join(acceptance, 'simulator-tls.mjs'), 'verify'], { env });
      assert.match(verified.stdout, /untrusted CA rejection and wrong-host rejection/);
      const beforeReady = requests.length;
      const ready = await run(process.execPath, [join(acceptance, 'simulator-tls.mjs'), 'ready'], { env });
      assert.deepEqual(requests.slice(beforeReady).map(item => [item.method, item.path, item.body]), [['GET', '/health', ''], ['GET', '/ready', '']]);
      const readyEvents = ready.stdout.trim().split('\n').map(line => JSON.parse(line) as Event);
      assert.deepEqual(readyEvents.map(event => [event.route, event.status]), [['health', 200], ['ready', 200]]);
      assert.ok(!ready.stdout.includes(canary));
      readinessStatus = 503;
      const beforeUnready = requests.length;
      await assert.rejects(run(process.execPath, [join(acceptance, 'simulator-tls.mjs'), 'ready'], { env }));
      assert.deepEqual(requests.slice(beforeUnready).map(item => [item.method, item.path]), [['GET', '/health'], ['GET', '/ready']], 'A failed readiness check must not retry or create a session');
    }

    const abortPath = `/v1/stall/${canary}`;
    const aborted = (tls ? httpsRequest : httpRequest)(`${tls ? 'https' : 'http'}://127.0.0.1:${proxyPort}${abortPath}`, { ca, agent: false });
    aborted.on('error', () => {});
    aborted.end();
    await waitFor(() => stalled.length === 1);
    aborted.destroy();
    await waitFor(() => events().some(event => event.event === 'native_proxy_response_aborted'));
    stalled[0]!.end();
    assert.equal(requests.filter(item => item.path === abortPath).length, 1, 'Diagnostics must not replay an aborted request');

    await close(backend); backendClosed = true;
    assert.equal((await send('GET', '/health')).status, 503);
    await waitFor(() => events().some(event => event.event === 'native_proxy_upstream_error'));
    const observed = events();
    assert.ok(observed.some(event => event.event === 'native_proxy_request' && event.route === 'sessions'));
    assert.ok(observed.some(event => event.event === 'native_proxy_upstream_socket' && typeof event.connecting === 'boolean'));
    assert.ok(observed.some(event => event.event === 'native_proxy_upstream_connected'));
    assert.ok(observed.some(event => event.event === 'native_proxy_upstream_finish'));
    assert.ok(observed.some(event => event.event === 'native_proxy_upstream_response' && event.status === 201));
    assert.ok(observed.some(event => event.event === 'native_proxy_response_finish' && event.status === 204));
    assert.ok(observed.some(event => event.event === 'native_proxy_offline' && event.status === 503));
    if (tls) {
      assert.ok(observed.some(event => event.event === 'native_proxy_tls_secure'));
      assert.ok(observed.some(event => event.event === 'native_proxy_tls_error'));
    }
    assert.ok(observed.every(event => typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))));
    assert.ok(observed.filter(event => event.sequence !== undefined).every(event => Number.isInteger(event.sequence) && Number.isInteger(event.duration_ms) && event.duration_ms! >= 0));
    for (const event of observed) for (const [key, value] of Object.entries(event)) {
      if (key === 'event') assert.match(value as string, /^native_proxy_[a-z_]+$/);
      else if (key === 'at') assert.match(value as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      else if (key === 'route') assert.ok(['health', 'ready', 'sessions', 'session_current', 'farm', 'api', 'other'].includes(value as string));
      else if (key === 'method') assert.ok(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'].includes(value as string));
      else if (key === 'connecting') assert.equal(typeof value, 'boolean');
      else { assert.ok(['sequence', 'connection', 'duration_ms', 'status'].includes(key)); assert.ok(Number.isInteger(value)); }
    }
    assert.ok(!output.includes(canary) && !errors.includes(canary), 'Credentials, headers, body, response and raw-path canaries must stay out of logs');
    assert.ok(output.split('\n').every(line => line.length < 256), 'Every diagnostic line must be bounded');
    assert.equal(errors, '');
  } finally {
    proxy.kill('SIGTERM');
    await exit;
    if (!backendClosed) await close(backend);
    await rm(directory, { recursive: true, force: true });
  }
});
