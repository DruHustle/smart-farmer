import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiOrigin } from '../src/api';
import { catalogues } from '../src/i18n';
import { farmNow, farmTimeToIso, optionalNumber } from '../src/time';

test('farm observations remain in Harare time when the owner travels', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Europe/Berlin', 'Africa/Harare', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(farmTimeToIso('2026-11-03T11:00', 'Africa/Harare'), '2026-11-03T09:00:00.000Z');
      assert.equal(farmNow('Africa/Harare', new Date('2026-11-03T23:30:00Z')), '2026-11-04T01:30');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('invalid dates, missing hours and ambiguous DST observations are rejected', () => {
  assert.throws(() => farmTimeToIso('2026-02-30T11:00', 'Africa/Harare'), /invalid_date/);
  assert.throws(() => farmTimeToIso('2026-03-29T02:30', 'Europe/Berlin'), /invalid_date/);
  assert.throws(() => farmTimeToIso('2026-10-25T02:30', 'Europe/Berlin'), /ambiguous_date/);
  assert.equal(farmTimeToIso('2028-02-29T11:00', 'Africa/Harare'), '2028-02-29T09:00:00.000Z');
});

test('unknown numbers stay unknown and non-finite/negative values cannot become measurements', () => {
  assert.equal(optionalNumber(''), null); assert.equal(optionalNumber('1,25'), 1.25); assert.equal(optionalNumber('0'), 0);
  for (const invalid of ['NaN', 'Infinity', '-1', '1e10000', '3 kg']) assert.throws(() => optionalNumber(invalid), /invalid_number/);
});

test('both supported offline language catalogs have complete nonempty keys', () => {
  assert.deepEqual(Object.keys(catalogues).sort(), ['nd', 'sn']);
  assert.deepEqual(Object.keys(catalogues.sn).sort(), Object.keys(catalogues.nd).sort());
  for (const language of Object.values(catalogues)) for (const [key, value] of Object.entries(language)) assert.ok(value.trim(), key);
});

test('production API configuration requires HTTPS and refuses embedded credentials and URL paths', () => {
  assert.equal(apiOrigin('https://example.test/', false), 'https://example.test');
  assert.equal(apiOrigin('http://10.0.2.2:3000', true), 'http://10.0.2.2:3000');
  assert.throws(() => apiOrigin('http://example.test', false), /https_required/);
  assert.throws(() => apiOrigin('http://localhost:3000', false), /https_required/);
  assert.throws(() => apiOrigin('https://user:password@example.test', false), /api_unconfigured/);
  assert.throws(() => apiOrigin('https://example.test/api', false), /api_unconfigured/);
  assert.throws(() => apiOrigin(undefined, false), /api_unconfigured/);
});
