import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalog, phrases} from '../src/locales.ts';

test('Shona and Northern Ndebele catalogs cover the same complete application keys', () => {
  assert.deepEqual(Object.keys(catalog).sort(), ['nd', 'sn']);
  assert.equal(Object.keys(phrases).length > 250, true);
  assert.deepEqual(Object.keys(catalog.sn).sort(), Object.keys(catalog.nd).sort());
  for (const [key, pair] of Object.entries(phrases)) {
    assert.equal(pair.length, 2, key);
    assert.ok(pair.every(value => typeof value === 'string' && value.trim().length > 0), key);
  }
  for (const key of ['broiler', 'layer', 'hatchery', 'rabbit_breeding', 'fish_nursery', 'recoverDrafts', 'version_conflict', 'offlineUnlock', 'treatment_restriction', 'live_animal_market_not_ready']) {
    assert.ok(catalog.sn[key]); assert.ok(catalog.nd[key]);
  }
});
