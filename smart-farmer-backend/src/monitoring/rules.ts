import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { settings } from '../operations/common.js';
import { farmEdgeGateways } from '../edge.js';
import { forecastIsStale } from './weather.js';

type Match = {value: number; observedAt: string; key: string; evidence: Record<string, unknown>};
const instant = (v: any) => new Date(v).toISOString();
const matches = (r: any, value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
  (r.operator === 'above' ? value > Number(r.threshold) : value < Number(r.threshold));
const fresh = (v: unknown, seconds: number, now: number) => {
  const at = new Date(v as string).getTime();
  return Number.isFinite(at) && at >= now - seconds * 1000 && at <= now + 5000;
};
async function ruleMatch(c: PoolClient, rule: any, now: number): Promise<Match | null> {
  if (rule.source === 'weather') {
    const farm = (await c.query('SELECT timezone,operations_settings FROM farms WHERE id=$1', [rule.farm_id])).rows[0];
    const s = settings(farm);
    if (!s.weatherEnabled) return null;
    const forecast = (await c.query('SELECT * FROM weather_forecasts WHERE farm_id=$1', [rule.farm_id])).rows[0];
    if (forecastIsStale(forecast, s, now)) return null;
    const h = forecast.data.hourly;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h[rule.metric]) || forecast.data.units?.[rule.metric] !== rule.unit) return null;
    const index = h.time.findIndex((t: string, i: number) => {
      const at = Date.parse(t);
      return Number.isFinite(at) && at >= now && at <= now + rule.lookahead_hours * 3_600_000 && matches(rule, h[rule.metric][i]);
    });
    if (index < 0) return null;
    return {value: h[rule.metric][index], observedAt: h.time[index], key: `${rule.version}:${h.time[index]}:${h[rule.metric][index]}`,
      evidence: {kind: 'forecast', provider: forecast.provider, sourceUrl: forecast.source_url, fetchedAt: forecast.fetched_at,
        latitude: s.latitude, longitude: s.longitude, validFrom: forecast.data.validFrom, validUntil: forecast.data.validUntil,
        threshold: Number(rule.threshold), operator: rule.operator, lookaheadHours: rule.lookahead_hours}};
  }
  if (rule.source === 'asset') {
    const row = (await c.query(`SELECT o.*,a.protocol,a.integration_state FROM asset_observations o JOIN assets a ON a.farm_id=o.farm_id AND a.id=o.asset_id
      WHERE o.farm_id=$1 AND o.asset_id=$2 AND o.measurement=$3 ORDER BY o.observed_at DESC,o.received_at DESC,o.id DESC LIMIT 1`, [rule.farm_id, rule.asset_id, rule.metric])).rows[0];
    if (!row || row.unit !== rule.unit || row.quality !== 'good' || row.source !== 'gateway' || row.protocol === 'simulator' ||
        !row.integration_state.startsWith('verified-') || !fresh(row.observed_at, rule.stale_after_seconds, now) || !matches(rule, row.value)) return null;
    return {value: row.value, observedAt: instant(row.observed_at), key: `${rule.version}:${row.id}`, evidence: {kind: 'observation', source: 'gateway',
      assetId: rule.asset_id, quality: row.quality, commissioned: true, receivedAt: row.received_at, threshold: Number(rule.threshold), operator: rule.operator}};
  }
  const gateway = farmEdgeGateways()[rule.gateway_id];
  if (!gateway || gateway.farmId !== rule.farm_id || !gateway.sources.includes(rule.source_id)) return null;
  const row = (await c.query(`SELECT * FROM farm_edge_observations WHERE farm_id=$1 AND gateway_id=$2 AND source_id=$3 AND kind='measurement'
    AND payload->'data'->>'assetId'=$4 AND payload->'data'->>'metric'=$5 ORDER BY observed_at DESC,received_at DESC,event_id DESC LIMIT 1`,
    [rule.farm_id, rule.gateway_id, rule.source_id, rule.edge_asset_id, rule.metric])).rows[0];
  if (!row || row.payload.data.unit !== rule.unit || !fresh(row.observed_at, rule.stale_after_seconds, now) || !matches(rule, row.payload.data.value)) return null;
  return {value: row.payload.data.value, observedAt: instant(row.observed_at), key: `${rule.version}:${row.event_id}`,
    evidence: {kind: 'observation', source: 'edge', gatewayId: rule.gateway_id, sourceId: rule.source_id, assetId: rule.edge_asset_id,
      commissioned: false, quality: 'unverified', receivedAt: row.received_at, threshold: Number(rule.threshold), operator: rule.operator}};
}
/** Called inside the maintenance transaction before the existing delivery queue. */
export async function evaluateMonitoringRules(c: PoolClient, now = Date.now()) {
  const rules = (await c.query('SELECT * FROM monitoring_rules WHERE enabled ORDER BY last_evaluated_at NULLS FIRST,id FOR UPDATE SKIP LOCKED LIMIT 100')).rows;
  let created = 0;
  for (const rule of rules) {
    await c.query('UPDATE monitoring_rules SET last_evaluated_at=$2 WHERE id=$1', [rule.id, new Date(now)]);
    if (rule.last_triggered_at && new Date(rule.last_triggered_at).getTime() + rule.cooldown_minutes * 60_000 > now) continue;
    const hit = await ruleMatch(c, rule, now);
    if (!hit) continue;
    const eventKey = createHash('sha256').update(hit.key).digest('hex');
    if (rule.last_event_key === eventKey) continue;
    const alert = (await c.query(`INSERT INTO monitoring_alerts(farm_id,rule_id,rule_name,source,metric,value,unit,observed_at,evidence,event_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(rule_id,event_key) DO NOTHING RETURNING id`,
      [rule.farm_id, rule.id, rule.name, rule.source, rule.metric, hit.value, rule.unit, hit.observedAt, hit.evidence, eventKey])).rows[0];
    if (!alert) continue;
    await c.query('UPDATE monitoring_rules SET last_triggered_at=$2,last_event_key=$3 WHERE id=$1', [rule.id, new Date(now), eventKey]);
    // Numeric evidence is kept in the inbox. Existing delivery code applies
    // verified recipients, explicit opt-ins, quiet hours and current membership.
    await c.query(`INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key)
      SELECT m.farm_id,m.user_id,'monitoring',$2,$3,'monitoring_alert',$4,$5 FROM memberships m WHERE m.farm_id=$1
      AND m.role IN ('owner','manager') ON CONFLICT DO NOTHING`,
      [rule.farm_id, rule.source === 'weather' ? 'forecast_threshold' : 'sensor_threshold',
        {title: rule.name, note: `${hit.value} ${rule.unit} · ${hit.observedAt}`, metric: rule.metric, source: rule.source, evidence: hit.evidence}, alert.id, 'monitoring:' + alert.id]);
    created++;
  }
  return {evaluated: rules.length, alertsCreated: created};
}
