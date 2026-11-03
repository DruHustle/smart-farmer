import { createServer, request } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Only a test harness. This process and these credentials are never bundled into the app.
const origin = 'http://127.0.0.1:3000';
const credentials = { username: 'native_owner', password: 'NativeAcceptanceOnly!2026' };
async function api(path, body, token) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
  return value;
}
if (process.argv[2] === 'seed') {
  await api('/v1/register', { ...credentials, farmName: 'Native acceptance farm', language: 'sn' });
  const session = await api('/v1/sessions', credentials);
  const { items: farms } = await api('/v1/farms', null, session.token);
  await api(`/v1/farms/${farms[0].id}/projects`, { id: randomUUID(), name: 'Native acceptance maize', enterpriseType: 'crop', crop: 'maize', irrigation: true }, session.token);
  writeFileSync(process.env.NATIVE_FIXTURE_PATH, JSON.stringify({ farmId: farms[0].id }), { mode: 0o600 });
  console.log('Native fixture seeded through authenticated API.');
} else if (process.argv[2] === 'verify') {
  const session = await api('/v1/sessions', credentials);
  const { items: farms } = await api('/v1/farms', null, session.token);
  const { items } = await api(`/v1/farms/${farms[0].id}/activities`, null, session.token);
  assert.equal(items.filter(item => item.note === 'Native durable offline observation').length, 1, 'Offline record must reach the server exactly once after restart');
  console.log('Verified exactly one offline record after native restart and reconciliation.');
} else if (process.argv[2] === 'proxy') {
  createServer((incoming, outgoing) => {
    if (existsSync(process.env.NATIVE_OFFLINE_FLAG)) { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end('{"error":"network_error"}'); return; }
    const upstream = request(origin + incoming.url, { method: incoming.method, headers: incoming.headers }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
    upstream.on('error', () => { outgoing.writeHead(503); outgoing.end(); });
    incoming.pipe(upstream);
  }).listen(3001, '127.0.0.1', () => console.log('Native acceptance network proxy ready.'));
}
