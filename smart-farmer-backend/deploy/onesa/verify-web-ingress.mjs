// Read-only endpoint checks for the deployed web and API on the same origin.
import assert from 'node:assert/strict';
const [origin, revision, expectedIssuer = 'https://portal.onesa.eu/api/v1/identity'] = process.argv.slice(2);
if (!origin || !/^[0-9a-f]{40}$/.test(revision ?? '')) {
  throw new Error('Usage: node verify-web-ingress.mjs <public-origin> <full-reviewed-git-sha> [expected-portal-issuer]');
}
const base = new URL(origin);
assert.equal(base.origin, origin, 'use an origin without credentials or a path');
assert.ok(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)), 'use HTTPS for a hosted origin');

async function json(path) {
  const result = await fetch(new URL(path, base), {
    headers: {Accept: 'application/json'}, cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(result.status, 200, path + ' returned HTTP ' + result.status);
  assert.match(result.headers.get('content-type') ?? '', /^application\/json(?:\s*;|$)/i, path + ' must serve JSON');
  return result.json();
}
for (const path of ['/health', '/ready']) {
  assert.equal((await json(path)).status, 'ok', path + ' did not report ok');
  console.log(path + ' reported ok');
}
for (const path of ['/version', '/release.json']) {
  assert.equal((await json(path)).revision, revision, path + ' did not identify the reviewed revision');
  console.log(path + ' matched ' + revision);
}
const identity = await json('/v1/onesa/config');
assert.ok(typeof identity.clientId === 'string' && identity.clientId.length > 0, 'Farmer Portal client is unavailable');
assert.equal(identity.issuer, expectedIssuer, 'Farmer reported an unexpected Portal issuer');
assert.equal(identity.callback, new URL('/auth/onesa/callback', base).href, 'Farmer Portal callback differs from this origin');
console.log('Farmer reported its Portal client and the callback on this origin');
