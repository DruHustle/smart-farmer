import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ApiError, createApi } from '../src/api';

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"fixture_failure"}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('bodyless native sign-out reaches the session route without an empty JSON declaration', async () => {
  const requests: { method: string; path: string; contentType?: string; authorization?: string; body: string }[] = [];
  let revoked = false;
  const server = await serve(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: request.method!, path: request.url!, contentType: request.headers['content-type'], authorization: request.headers.authorization, body });
    // A JSON parser rejects an empty declared JSON document before the route.
    if (request.headers['content-type'] === 'application/json' && !body) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"empty_json_body"}');
    } else if (request.method === 'DELETE' && request.url === '/v1/sessions/current') {
      revoked = true; response.writeHead(204); response.end();
    } else {
      response.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json' });
      response.end(revoked ? '{"error":"unauthorized"}' : '{"items":[]}');
    }
  });
  try {
    const client = createApi(server.origin, 'synthetic-native-session');
    assert.equal(await client.request('/v1/sessions/current', 'DELETE'), undefined);
    assert.equal(revoked, true);
    await assert.rejects(client.request('/v1/farms'), (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === 'unauthorized');
    assert.deepEqual(requests, [
      { method: 'DELETE', path: '/v1/sessions/current', contentType: undefined, authorization: 'Bearer synthetic-native-session', body: '' },
      { method: 'GET', path: '/v1/farms', contentType: undefined, authorization: 'Bearer synthetic-native-session', body: '' },
    ]);
  } finally { await server.close(); }
});

test('JSON request bodies retain their content type and exact bytes', async () => {
  const requests: { contentType?: string; body: string }[] = [];
  const server = await serve(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true}');
  });
  try {
    const client = createApi(server.origin);
    assert.deepEqual(await client.request('/v1/sessions', 'POST', { username: 'synthetic-native-owner' }), { accepted: true });
    await client.request('/v1/nullable', 'POST', null);
    assert.deepEqual(requests, [
      { contentType: 'application/json', body: '{"username":"synthetic-native-owner"}' },
      { contentType: 'application/json', body: 'null' },
    ]);
  } finally { await server.close(); }
});
