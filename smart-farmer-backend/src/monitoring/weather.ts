import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../context.js';
import { lockFarmMembership, managers, requireRow } from '../integrations/common.js';
import { fetchJson, safeEndpoint, settings } from '../operations/common.js';

type Database = Pool | PoolClient;
const HOUR = 3_600_000;
const units = { temperature_2m: 'C', relative_humidity_2m: '%', precipitation: 'mm', wind_speed_10m: 'km/h' };
type Metric = keyof typeof units;
export type Forecast = {
  kind: 'forecast'; validFrom: string; validUntil: string;
  latitude: number; longitude: number; issuedAt?: string;
  attribution: string; licenseUrl: string;
  hourly: {time: string[]} & Record<Metric, Array<number | null>>;
  units: typeof units;
};
export function weatherProviderStatus() {
  const mode = process.env.WEATHER_PROVIDER || 'unconfigured';
  const met = mode === 'met-no';
  const identified = Boolean(process.env.MET_WEATHER_USER_AGENT?.trim() && /(?:https:\/\/|@)/.test(process.env.MET_WEATHER_USER_AGENT));
  return {
    configured: met ? identified : mode === 'open-meteo' && (process.env.NODE_ENV !== 'production' || Boolean(process.env.OPEN_METEO_API_KEY)),
    mode,
    requirements: ['confirmed_coordinates', 'farm_weather_opt_in', ...(met ? ['identifying_user_agent'] : process.env.NODE_ENV === 'production' ? ['provider_api_key'] : [])],
  };
}
const locationKey = (s: {latitude: number; longitude: number; timezone: string}) => `${s.latitude},${s.longitude},${s.timezone}`;
const iso = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time));
export function forecastMatchesLocation(data: any, s: {latitude: number | null; longitude: number | null}) {
  return !!data && s.latitude !== null && s.longitude !== null && data.latitude === s.latitude && data.longitude === s.longitude;
}
export function forecastIsStale(row: any, s: {latitude: number | null; longitude: number | null}, now = Date.now()) {
  return !row || !forecastMatchesLocation(row.data, s) || !iso(row.data?.validUntil) ||
    Date.parse(row.data.validUntil) <= now || new Date(row.fetched_at).getTime() < now - 6 * HOUR || new Date(row.fetched_at).getTime() > now + 5000;
}
export async function weatherSnapshot(db: Database, farmId: string) {
  const farm = requireRow((await db.query('SELECT timezone,operations_settings FROM farms WHERE id=$1', [farmId])).rows[0]);
  const s = settings(farm);
  const f = (await db.query('SELECT * FROM weather_forecasts WHERE farm_id=$1', [farmId])).rows[0];
  const refresh = (await db.query('SELECT next_attempt_at,last_error FROM weather_refresh_state WHERE farm_id=$1', [farmId])).rows[0];
  return {
    forecast: f ? {...f.data, provider: f.provider, sourceUrl: f.source_url, fetchedAt: f.fetched_at, timezone: farm.timezone} : null,
    observations: (await db.query('SELECT * FROM weather_observations WHERE farm_id=$1 ORDER BY observed_at DESC LIMIT 20', [farmId])).rows,
    configured: Boolean(s.weatherEnabled && s.latitude !== null && s.longitude !== null && weatherProviderStatus().configured),
    stale: forecastIsStale(f, s),
    locationMatched: forecastMatchesLocation(f?.data, s),
    nextRefreshAt: refresh?.next_attempt_at ?? null,
    lastError: refresh?.last_error ?? null,
  };
}
function validateTimes(times: string[]) {
  if (!times.length || times.some((t, i) => !iso(t) || (i > 0 && Date.parse(t) <= Date.parse(times[i - 1]))))
    throw new ApiError('invalid_provider_response', 502);
}
export function normalizeOpenMeteo(data: any, latitude: number, longitude: number): Forecast {
  const parsed = z.object({
    time: z.array(z.number().int().min(0).max(253_402_300_799)).min(1).max(100),
    temperature_2m: z.array(z.number().finite().nullable()).max(100),
    relative_humidity_2m: z.array(z.number().finite().nullable()).max(100),
    precipitation: z.array(z.number().finite().nullable()).max(100),
    wind_speed_10m: z.array(z.number().finite().nullable()).max(100),
  }).safeParse(data?.hourly);
  if (!parsed.success) throw new ApiError('invalid_provider_response', 502);
  const h = parsed.data;
  if (Object.values(h).some(v => v.length !== h.time.length)) throw new ApiError('invalid_provider_response', 502);
  const times = h.time.map(t => new Date(t * 1000).toISOString());
  validateTimes(times);
  return {kind: 'forecast', validFrom: times[0], validUntil: new Date(Date.parse(times.at(-1)!) + HOUR).toISOString(), latitude, longitude,
    attribution: 'Weather data by Open-Meteo; normalized for Smart Farmer.', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    hourly: {...h, time: times}, units};
}
export function normalizeMetNo(data: any, latitude: number, longitude: number): Forecast {
  const details = z.object({air_temperature: z.number().finite().optional(), relative_humidity: z.number().finite().optional(), wind_speed: z.number().finite().optional()});
  const parsed = z.object({properties: z.object({meta: z.object({updated_at: z.iso.datetime({offset: true})}), timeseries: z.array(z.object({
    time: z.iso.datetime({offset: true}), data: z.object({instant: z.object({details}),
      next_1_hours: z.object({details: z.object({precipitation_amount: z.number().finite().nonnegative().optional()})}).optional(),
    }),
  })).min(1).max(300)})}).safeParse(data);
  if (!parsed.success) throw new ApiError('invalid_provider_response', 502);
  const series = parsed.data.properties.timeseries;
  validateTimes(series.map(x => x.time));
  // Only a next_1_hours amount is an hourly rainfall forecast. Six-hour totals
  // remain unknown here; they must never be compared with an hourly threshold.
  const rows = series.filter(x => Date.parse(x.time) <= Date.parse(series[0].time) + 72 * HOUR);
  return {kind: 'forecast', validFrom: rows[0].time, validUntil: new Date(Date.parse(rows.at(-1)!.time) + HOUR).toISOString(),
    latitude, longitude, issuedAt: parsed.data.properties.meta.updated_at,
    attribution: 'Weather data from MET Norway, licensed under CC BY 4.0; normalized and wind converted to km/h by Smart Farmer.',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    hourly: {time: rows.map(x => x.time), temperature_2m: rows.map(x => x.data.instant.details.air_temperature ?? null),
      relative_humidity_2m: rows.map(x => x.data.instant.details.relative_humidity ?? null),
      precipitation: rows.map(x => x.data.next_1_hours?.details.precipitation_amount ?? null),
      wind_speed_10m: rows.map(x => x.data.instant.details.wind_speed === undefined ? null : x.data.instant.details.wind_speed * 3.6)}, units};
}
async function metResponse(url: URL, lastModified: string | null) {
  let response: Response;
  try { response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
    'User-Agent': process.env.MET_WEATHER_USER_AGENT!, Accept: 'application/json', ...(lastModified ? {'If-Modified-Since': lastModified} : {}),
  }}); } catch { throw new ApiError('provider_unavailable', 503); }
  if (response.status === 304) return {data: null, expires: response.headers.get('expires'), lastModified};
  if (!response.ok) throw new ApiError(response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable', 503);
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) try { while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > 2_000_000) { await reader.cancel(); throw new ApiError('invalid_provider_response', 502); }
    chunks.push(part.value);
  }} finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('invalid_provider_response', 502); }
  return {data, expires: response.headers.get('expires'), lastModified: response.headers.get('last-modified')};
}
/** One serialized refresh per farm, with the farm opt-in checked again before persistence. */
export async function refreshWeather(db: Pool, farmId: string, actorId?: string, automatic = false) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['forecast:' + farmId]);
    if (actorId) await lockFarmMembership(c, farmId, actorId, managers);
    const farm = requireRow((await c.query('SELECT timezone,operations_settings FROM farms WHERE id=$1 FOR SHARE', [farmId])).rows[0]);
    const s = settings(farm), provider = weatherProviderStatus();
    if (!s.weatherEnabled || s.latitude === null || s.longitude === null || !provider.configured) throw new ApiError('weather_unconfigured', 409);
    const key = locationKey(s);
    const prior = (await c.query('SELECT * FROM weather_refresh_state WHERE farm_id=$1', [farmId])).rows[0];
    const same = prior?.provider === provider.mode && prior?.location_key === key;
    if (same && (automatic || provider.mode === 'met-no') && new Date(prior.next_attempt_at).getTime() > Date.now()) {
      await c.query('COMMIT'); return weatherSnapshot(db, farmId);
    }
    // Outside the Nordic region MET asks for at least three hours between
    // identical requests. Apply that globally, plus a deterministic spread.
    let next = Date.now() + 3 * HOUR + (parseInt(farmId.slice(0, 4), 16) % 300) * 1000;
    let normalized: Forecast | null, modified: string | null = null, fetchedAt = new Date();
    if (provider.mode === 'met-no') {
      const url = safeEndpoint(process.env.WEATHER_API_URL || 'https://api.met.no/weatherapi/locationforecast/2.0/compact', true);
      const truncate = (n: number) => String(Math.trunc(n * 10_000) / 10_000);
      url.searchParams.set('lat', truncate(s.latitude)); url.searchParams.set('lon', truncate(s.longitude));
      const cacheKey = createHash('sha256').update(url.toString()).digest('hex');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['met-cache:' + cacheKey]);
      const cache = (await c.query('SELECT * FROM weather_provider_cache WHERE request_key=$1', [cacheKey])).rows[0];
      if (cache && new Date(cache.next_attempt_at).getTime() > Date.now()) {
        normalized = {...cache.data, latitude: s.latitude, longitude: s.longitude};
        fetchedAt = new Date(cache.fetched_at); next = new Date(cache.next_attempt_at).getTime(); modified = cache.last_modified;
      } else {
        const result = await metResponse(url, cache?.last_modified ?? null);
        const expires = result.expires ? Date.parse(result.expires) : NaN;
        if (Number.isFinite(expires)) next = Math.max(next, expires);
        modified = result.lastModified;
        if (result.data === null) {
          if (!cache) throw new ApiError('invalid_provider_response', 502);
          normalized = {...cache.data, latitude: s.latitude, longitude: s.longitude};
        } else normalized = normalizeMetNo(result.data, s.latitude, s.longitude);
        // Shared cache contains only rounded provider coordinates; the owning
        // farm's exact confirmed coordinates remain on its own forecast row.
        await c.query('INSERT INTO weather_provider_cache(request_key,data,fetched_at,next_attempt_at,last_modified) VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_key) DO UPDATE SET data=$2,fetched_at=$3,next_attempt_at=$4,last_modified=$5',
          [cacheKey, {...normalized, latitude: Number(truncate(s.latitude)), longitude: Number(truncate(s.longitude))}, fetchedAt, new Date(next), modified]);
      }
    } else {
      const url = safeEndpoint(process.env.WEATHER_API_URL || (process.env.OPEN_METEO_API_KEY ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast'), true);
      url.searchParams.set('latitude', String(s.latitude)); url.searchParams.set('longitude', String(s.longitude));
      url.searchParams.set('hourly', Object.keys(units).join(',')); url.searchParams.set('timezone', s.timezone);
      url.searchParams.set('timeformat', 'unixtime'); url.searchParams.set('forecast_days', '3');
      url.searchParams.set('temperature_unit', 'celsius'); url.searchParams.set('wind_speed_unit', 'kmh'); url.searchParams.set('precipitation_unit', 'mm');
      if (process.env.OPEN_METEO_API_KEY) url.searchParams.set('apikey', process.env.OPEN_METEO_API_KEY);
      let data;
      try { data = await fetchJson(url); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('provider_unavailable', 503); }
      normalized = normalizeOpenMeteo(data, s.latitude, s.longitude);
    }
    const source = provider.mode === 'met-no' ? 'https://api.met.no/weatherapi/locationforecast/2.0/documentation' : 'https://open-meteo.com/en/docs';
    await c.query('INSERT INTO weather_forecasts(farm_id,provider,source_url,fetched_at,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(farm_id) DO UPDATE SET provider=$2,source_url=$3,fetched_at=$4,data=$5', [farmId, provider.mode, source, fetchedAt, normalized]);
    await c.query('INSERT INTO weather_refresh_state(farm_id,provider,location_key,next_attempt_at,last_modified) VALUES($1,$2,$3,$4,$5) ON CONFLICT(farm_id) DO UPDATE SET provider=$2,location_key=$3,next_attempt_at=$4,last_attempt_at=now(),last_modified=$5,last_error=NULL', [farmId, provider.mode, key, new Date(next), modified]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    // A failed provider call preserves the last good forecast and is visible to
    // the farmer. Backoff also applies to a provider outage on a fresh farm.
    if (error instanceof ApiError && [502, 503].includes(error.status)) {
      const row = (await c.query('SELECT timezone,operations_settings FROM farms WHERE id=$1', [farmId])).rows[0];
      if (row) await c.query('INSERT INTO weather_refresh_state(farm_id,provider,location_key,next_attempt_at,last_error) VALUES($1,$2,$3,now()+interval \'3 hours\',$4) ON CONFLICT(farm_id) DO UPDATE SET provider=EXCLUDED.provider,location_key=EXCLUDED.location_key,next_attempt_at=GREATEST(weather_refresh_state.next_attempt_at,now()+interval \'3 hours\'),last_attempt_at=now(),last_error=$4', [farmId, weatherProviderStatus().mode, locationKey(settings(row)), error.code]);
    }
    throw error;
  } finally { c.release(); }
  return weatherSnapshot(db, farmId);
}
/** At most one farm each maintenance pass; no requests for farms without alert opt-in. */
export async function refreshDueWeather(db: Pool) {
  const provider = weatherProviderStatus();
  if (!provider.configured) return {refreshed: 0};
  const row = (await db.query("SELECT f.id FROM farms f LEFT JOIN weather_refresh_state s ON s.farm_id=f.id WHERE f.operations_settings->>'weatherEnabled'='true' AND f.operations_settings->>'latitude' IS NOT NULL AND f.operations_settings->>'longitude' IS NOT NULL AND EXISTS(SELECT 1 FROM monitoring_rules r WHERE r.farm_id=f.id AND r.source='weather' AND r.enabled) AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=now() OR s.provider<>$1 OR s.location_key<>concat(f.operations_settings->>'latitude',',',f.operations_settings->>'longitude',',',f.timezone)) ORDER BY s.next_attempt_at NULLS FIRST,f.id LIMIT 1", [provider.mode])).rows[0];
  if (!row) return {refreshed: 0};
  await refreshWeather(db, row.id, undefined, true);
  return {refreshed: 1};
}
