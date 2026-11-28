import { object, string, type Row } from './product';

/** Cached telemetry cannot stay "live" after its own observation expires. */
export function sensorIsStale(sensor: Row, online: boolean, now = Date.now()): boolean {
  const observed = Date.parse(string(sensor.observedAt));
  const seconds = Number(sensor.staleAfterSeconds);
  return !online || sensor.stale === true || !Number.isFinite(observed)
    || !Number.isFinite(seconds) || seconds <= 0 || observed > now + 60_000
    || now - observed > seconds * 1000;
}

export function sensorRuleTarget(sensor: Row): Row {
  if (sensor.source === 'asset' && typeof sensor.assetId === 'string' && sensor.assetId) {
    return { source: 'asset', assetId: sensor.assetId, metric: sensor.metric, unit: sensor.unit };
  }
  if (sensor.source === 'edge' && [sensor.gatewayId, sensor.sourceId, sensor.edgeAssetId].every(value => typeof value === 'string' && value)) {
    return { source: 'edge', gatewayId: sensor.gatewayId, sourceId: sensor.sourceId, edgeAssetId: sensor.edgeAssetId, metric: sensor.metric, unit: sensor.unit };
  }
  throw new Error('invalid_input');
}

export function forecastIsStale(weather: Row, online: boolean, now = Date.now()): boolean {
  const forecast = object(weather.forecast);
  const fetched = Date.parse(string(forecast.fetchedAt));
  const until = Date.parse(string(forecast.validUntil));
  return !online || weather.stale === true || weather.locationMatched === false
    || !Number.isFinite(fetched) || fetched > now + 60_000 || now - fetched > 6 * 60 * 60 * 1000
    || Number.isFinite(until) && until < now;
}

export const weatherMetrics = [
  { value: 'temperature_2m', unit: 'C' },
  { value: 'precipitation', unit: 'mm' },
  { value: 'wind_speed_10m', unit: 'km/h' },
  { value: 'relative_humidity_2m', unit: '%' },
] as const;
