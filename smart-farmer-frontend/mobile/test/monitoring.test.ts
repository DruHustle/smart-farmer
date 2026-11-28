import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sensorIsStale, sensorRuleTarget, forecastIsStale } from '../src/monitoring';

test('cached sensor readings age on the device and cannot stay live offline or with missing timestamps', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  const sensor = { stale: false, observedAt: '2026-11-28T11:59:00Z', staleAfterSeconds: 120, value: 0 };
  assert.equal(sensorIsStale(sensor, true, now), false);
  assert.equal(sensorIsStale(sensor, false, now), true);
  assert.equal(sensorIsStale(sensor, true, now + 121_000), true);
  assert.equal(sensorIsStale({ ...sensor, stale: true }, true, now), true);
  assert.equal(sensorIsStale({ ...sensor, observedAt: null }, true, now), true);
  assert.equal(sensorIsStale({ ...sensor, observedAt: '2026-11-28T13:00:00Z' }, true, now), true);
});

test('sensor alert targets preserve full source identity without sending arbitrary cached fields', () => {
  assert.deepEqual(sensorRuleTarget({ source: 'edge', gatewayId: 'gateway', sourceId: 'device', edgeAssetId: 'plot-a', metric: 'soil_moisture', unit: '%', command: 'start', value: 18 }), {
    source: 'edge', gatewayId: 'gateway', sourceId: 'device', edgeAssetId: 'plot-a', metric: 'soil_moisture', unit: '%',
  });
  assert.deepEqual(sensorRuleTarget({ source: 'asset', assetId: 'asset', metric: 'temperature', unit: 'C', command: 'stop' }), { source: 'asset', assetId: 'asset', metric: 'temperature', unit: 'C' });
  assert.throws(() => sensorRuleTarget({ source: 'edge', gatewayId: 'gateway', metric: 'water' }), /invalid_input/);
  assert.throws(() => sensorRuleTarget({ source: 'unknown', assetId: 'asset' }), /invalid_input/);
});

test('forecast cache never hides a changed location, provider stale state, expired validity or offline state', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  const weather = { stale: false, locationMatched: true, forecast: { fetchedAt: '2026-11-28T11:00:00Z', validUntil: '2026-11-30T00:00:00Z' } };
  assert.equal(forecastIsStale(weather, true, now), false);
  assert.equal(forecastIsStale(weather, false, now), true);
  assert.equal(forecastIsStale({ ...weather, locationMatched: false }, true, now), true);
  assert.equal(forecastIsStale({ ...weather, stale: true }, true, now), true);
  assert.equal(forecastIsStale(weather, true, now + 7 * 3600_000), true);
  assert.equal(forecastIsStale({ ...weather, forecast: { ...weather.forecast, validUntil: '2026-11-28T11:30:00Z' } }, true, now), true);
  assert.equal(forecastIsStale({}, true, now), true);
});
