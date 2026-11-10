import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {ApiError, createApi} from '../../smart-farmer-frontend/mobile/src/api.js';

const token = 'synthetic-native-transport-session';

function server(t: TestContext) {
  // Exercise the real client and Fastify parser over HTTP. The session below is
  // a disposable transport fixture, not a replacement for database auth tests.
  const app = Fastify({logger: false});
  t.after(() => app.close());
  return app;
}

test('native bodyless GET and DELETE reach the authenticated handler and revoke its session', async t => {
  const app = server(t);
  let active = true;
  let revocations = 0;
  const received: Array<{method: string; authorization?: string; contentType?: string; body: unknown}> = [];
  app.addHook('preHandler', async request => {
    received.push({method: request.method, authorization: request.headers.authorization, contentType: request.headers['content-type'], body: request.body});
  });
  app.get('/v1/session-state', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({error: 'unauthorized'});
    return {active};
  });
  app.delete('/v1/sessions/current', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({error: 'unauthorized'});
    active = false;
    revocations++;
    return reply.code(204).send();
  });
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  const api = createApi(origin, token);
  assert.deepEqual(await api.request('/v1/session-state'), {active: true});
  assert.equal(await api.request('/v1/sessions/current', 'DELETE'), undefined);
  assert.equal(revocations, 1);
  assert.deepEqual(await api.request('/v1/session-state'), {active: false});
  assert.deepEqual(received, ['GET', 'DELETE', 'GET'].map(method => ({method, authorization: `Bearer ${token}`, contentType: undefined, body: undefined})));
});

test('native bodyless DELETE cannot revoke a session without its bearer authorization', async t => {
  const app = server(t);
  let active = true;
  let revocations = 0;
  let handlerEntries = 0;
  app.delete('/v1/sessions/current', async (request, reply) => {
    handlerEntries++;
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({error: 'unauthorized'});
    active = false;
    revocations++;
    return reply.code(204).send();
  });
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  for (const credential of [undefined, 'wrong-synthetic-session']) {
    await assert.rejects(createApi(origin, credential).request('/v1/sessions/current', 'DELETE'), error => error instanceof ApiError && error.status === 401 && error.code === 'unauthorized');
    assert.equal(active, true);
    assert.equal(revocations, 0);
  }
  assert.equal(handlerEntries, 2, 'authorization decisions must come from the handler, not a JSON parser rejection');
  assert.equal(await createApi(origin, token).request('/v1/sessions/current', 'DELETE'), undefined);
  assert.equal(active, false);
  assert.equal(revocations, 1);
});

test('native JSON POST, PATCH and DELETE preserve explicit payloads including falsy values', async t => {
  const app = server(t);
  const received: Array<{method: string; authorization?: string; contentType?: string; body: unknown}> = [];
  app.route({method: ['POST', 'PATCH', 'DELETE'], url: '/v1/echo', handler: async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({error: 'unauthorized'});
    received.push({method: request.method, authorization: request.headers.authorization, contentType: request.headers['content-type'], body: request.body});
    return {method: request.method, body: request.body};
  }});
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  const api = createApi(origin, token);
  const cases: Array<{method: string; body: unknown}> = [
    {method: 'POST', body: {note: ' Literal Mvura\ntext ', quantity: 0, confirmed: false}},
    {method: 'PATCH', body: {version: 7, note: 'Reviewed note', details: null}},
    {method: 'DELETE', body: {version: 7}},
    {method: 'POST', body: null},
    {method: 'PATCH', body: false},
    {method: 'DELETE', body: 0},
    {method: 'POST', body: ''},
    {method: 'PATCH', body: []},
  ];
  for (const value of cases) assert.deepEqual(await api.request('/v1/echo', value.method, value.body), value);
  assert.deepEqual(received, cases.map(value => ({...value, authorization: `Bearer ${token}`, contentType: 'application/json'})));
});

test('native transport retains structured errors, fallback error codes and invalid-response refusal', async t => {
  const app = server(t);
  app.get('/v1/conflict', async (_request, reply) => reply.code(409).send({error: 'version_conflict'}));
  app.get('/v1/rejected', async (_request, reply) => reply.code(422).send({message: 'Synthetic rejection without an error code'}));
  app.get('/v1/not-json', async (_request, reply) => reply.type('text/plain').send('Synthetic non-JSON response'));
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  const api = createApi(origin, token);
  for (const [path, status, code] of [['/v1/conflict', 409, 'version_conflict'], ['/v1/rejected', 422, 'request_failed'], ['/v1/not-json', 200, 'invalid_response']] as const) {
    await assert.rejects(api.request(path), error => error instanceof ApiError && error.status === status && error.code === code);
  }
});

test('native transport refuses redirects before contacting their target', async t => {
  const app = server(t);
  let targetRequests = 0;
  app.get('/v1/redirect', async (_request, reply) => reply.redirect('/v1/redirect-target'));
  app.get('/v1/redirect-target', async () => { targetRequests++; return {unexpected: true}; });
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  await assert.rejects(createApi(origin, token).request('/v1/redirect'));
  assert.equal(targetRequests, 0);
});
