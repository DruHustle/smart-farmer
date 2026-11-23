import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const api = 'https://farmer-api.onesa.eu';

test('the hosted site sends exactly the API-owned paths to the Farmer API origin', () => {
  const external = config.rewrites.filter(rule => /^https?:/.test(rule.destination));
  assert.deepEqual(external, [
    {source:'/v1/:path*', destination:`${api}/v1/:path*`},
    {source:'/health', destination:`${api}/health`},
    {source:'/ready', destination:`${api}/ready`},
    {source:'/version', destination:`${api}/version`},
  ]);
  // The site's own release marker and application routes stay on the static deployment.
  for (const path of ['/release.json', '/healthz', '/auth/onesa/callback', '/auth/registration/complete', '/account-deletion'])
    assert.ok(!external.some(rule => rule.source === path), path);
  for (const path of ['/auth/onesa/callback', '/auth/registration/complete', '/account-deletion'])
    assert.deepEqual(config.rewrites.find(rule => rule.source === path), {source:path, destination:'/index.html'});
});

test('the hosted site never caches proxied API responses', () => {
  const off = source => config.headers.find(rule => rule.source === source)?.headers
    .some(h => h.key === 'x-vercel-enable-rewrite-caching' && h.value === '0');
  assert.ok(off('/v1/:path*'));
  assert.ok(off('/(health|ready|version)'));
});
