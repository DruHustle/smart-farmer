import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request, ApiError} from '../src/lib/api.ts';

test('the API rejects malformed successful JSON without losing valid null or empty 204 responses', async t => {
  const responses = [
    new Response('<html>interrupted upstream</html>', {status: 200}),
    new Response(null, {status: 204}),
    new Response('null', {status: 200}),
    new Response('{"accepted":true}', {status: 200}),
    new Response('temporarily unavailable', {status: 503}),
    new Response('{"error":"retry_transaction"}', {status: 409}),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(request('/fixture'), error => error instanceof ApiError && error.message === 'invalid_response' && error.status === 200);
  assert.equal(await request('/fixture'), undefined);
  assert.equal(await request('/fixture'), null);
  assert.deepEqual(await request('/fixture'), {accepted: true});
  await assert.rejects(request('/fixture'), error => error instanceof ApiError && error.status === 503);
  await assert.rejects(request('/fixture'), error => error instanceof ApiError && error.message === 'retry_transaction' && error.status === 409);
});
