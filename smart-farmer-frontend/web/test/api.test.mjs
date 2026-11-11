import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request, uploadRecord, ApiError} from '../src/lib/api.ts';

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

test('upload only completes after the API acknowledges storage of the same media ID', async t => {
  const previous = globalThis.XMLHttpRequest;
  t.after(() => {
    if (previous === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = previous;
  });
  const replies = [
    [200, '<html>gateway</html>'],
    [204, ''],
    [200, 'null'],
    [201, '{"id":"other","status":"stored"}'],
    [403, '{"error":"forbidden"}'],
    [200, '{"id":"photo","status":"stored"}'],
  ];
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {[this.status, this.responseText] = replies.shift(); this.onload();}
  };
  const progress = [];
  const upload = () => uploadRecord('/v1/farms/farm/media', 'test-token', {id: 'photo'}, value => progress.push(value));
  for (const status of [200, 204, 200, 201]) {
    await assert.rejects(upload(), error => error.message === 'invalid_response' && error.status === status);
  }
  await assert.rejects(upload(), error => error.message === 'forbidden' && error.status === 403);
  assert.deepEqual(progress, []);
  assert.deepEqual(await upload(), {id: 'photo', status: 'stored'});
  assert.deepEqual(progress, [100]);
});
