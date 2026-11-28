import type { Pool, PoolClient } from 'pg';
import { farmEdgeGateways } from '../edge.js';

type Database = Pool | PoolClient;
const fresh = (observed: Date | string, seconds: number, now: number) => {
  const at = new Date(observed).getTime();
  return Number.isFinite(at) && at <= now + 5000 && at >= now - seconds * 1000;
};
const scalar = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export async function sensorDashboard(db: Database, farmId: string, now = Date.now()) {
  const assetRows = (await db.query(`SELECT latest.*,a.name,a.protocol,a.integration_state,a.stale_after_seconds,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('value',h.value,'observedAt',h.observed_at) ORDER BY h.observed_at),'[]') FROM
        (SELECT value,observed_at FROM asset_observations o WHERE o.farm_id=$1 AND o.asset_id=latest.asset_id AND o.measurement=latest.measurement AND o.unit=latest.unit AND jsonb_typeof(o.value)='number' ORDER BY observed_at DESC,id DESC LIMIT 24) h) AS history
    FROM (SELECT DISTINCT ON(asset_id,measurement) asset_id,measurement,value,unit,quality,source,observed_at,received_at
      FROM asset_observations WHERE farm_id=$1 ORDER BY asset_id,measurement,observed_at DESC,received_at DESC,id DESC) latest
    JOIN assets a ON a.farm_id=$1 AND a.id=latest.asset_id ORDER BY a.name,latest.measurement LIMIT 501`, [farmId])).rows;
  const edgeRows = (await db.query(`SELECT latest.*,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('value',h.payload->'data'->'value','observedAt',h.observed_at) ORDER BY h.observed_at),'[]') FROM
        (SELECT payload,observed_at FROM farm_edge_observations o WHERE o.farm_id=$1 AND o.kind='measurement' AND o.gateway_id=latest.gateway_id AND o.source_id=latest.source_id AND o.payload->'data'->>'assetId'=latest.edge_asset_id AND o.payload->'data'->>'metric'=latest.metric AND o.payload->'data'->>'unit'=latest.unit ORDER BY observed_at DESC,event_id DESC LIMIT 24) h) AS history
    FROM (SELECT DISTINCT ON(gateway_id,source_id,payload->'data'->>'assetId',payload->'data'->>'metric')
      gateway_id,source_id,payload->'data'->>'assetId' AS edge_asset_id,payload->'data'->>'metric' AS metric,payload->'data'->'value' AS value,payload->'data'->>'unit' AS unit,observed_at,received_at
      FROM farm_edge_observations WHERE farm_id=$1 AND kind='measurement'
      ORDER BY gateway_id,source_id,payload->'data'->>'assetId',payload->'data'->>'metric',observed_at DESC,received_at DESC,event_id DESC) latest
    ORDER BY gateway_id,source_id,edge_asset_id,metric LIMIT 501`, [farmId])).rows;
  const sensors = [
    ...assetRows.slice(0, 500).map(r => ({key: `asset:${r.asset_id}:${r.measurement}`, source: 'asset', assetId: r.asset_id, gatewayId: null, sourceId: null, edgeAssetId: null,
      name: r.name, metric: r.measurement, value: scalar(r.value), unit: r.unit, quality: r.quality,
      simulated: r.source === 'simulator' || r.protocol === 'simulator', commissioned: r.integration_state.startsWith('verified-'),
      observedAt: r.observed_at, receivedAt: r.received_at, stale: !fresh(r.observed_at, r.stale_after_seconds, now), staleAfterSeconds: r.stale_after_seconds, history: r.history})),
    ...edgeRows.slice(0, 500).map(r => ({key: `edge:${r.gateway_id}:${r.source_id}:${r.edge_asset_id}:${r.metric}`, source: 'edge', assetId: null, gatewayId: r.gateway_id, sourceId: r.source_id, edgeAssetId: r.edge_asset_id,
      name: r.edge_asset_id, metric: r.metric, value: scalar(r.value), unit: r.unit, quality: 'uncertain', simulated: false, commissioned: false,
      observedAt: r.observed_at, receivedAt: r.received_at, stale: !fresh(r.observed_at, 900, now), staleAfterSeconds: 900, history: r.history})),
  ];
  const received = (await db.query('SELECT gateway_id,max(received_at) AS received_at,max(observed_at) AS observed_at FROM farm_edge_observations WHERE farm_id=$1 GROUP BY gateway_id', [farmId])).rows;
  const configured = Object.entries(farmEdgeGateways()).filter(([, g]) => g.farmId === farmId).map(([id]) => id);
  const gateways = [...new Set([...configured, ...received.map(r => r.gateway_id)])].sort().map(id => {
    const last = received.find(r => r.gateway_id === id);
    const metric = (name: string, unit: string) => {
      const r = edgeRows.filter(x => x.gateway_id === id && x.metric === name && x.unit === unit && fresh(x.observed_at, 900, now))
        .sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime())[0];
      return scalar(r?.value);
    };
    const battery = metric('battery_percent', '%');
    const usage = metric('data_usage_mb', 'MB');
    return {id, lastReceivedAt: last?.received_at ?? null, lastObservedAt: last?.observed_at ?? null,
      state: !last ? 'unknown' : fresh(last.received_at, 900, now) ? 'online' : 'offline',
      batteryPercent: battery !== null && battery >= 0 && battery <= 100 ? battery : null,
      dataUsageMb: usage !== null && usage >= 0 ? usage : null};
  });
  return {sensors, gateways, truncated: assetRows.length > 500 || edgeRows.length > 500, commandCapability: false};
}
