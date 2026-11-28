import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, audit, type Context } from '../context.js';
import { authorize, hash, lockFarmMembership, managers, operationLock, requireRow, uuid } from '../integrations/common.js';
import { checkVersion, listQuery, paged } from '../operations/common.js';
import { farmEdgeGateways } from '../edge.js';
import { sensorDashboard } from './sensors.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/);
const input = z.object({
  id: uuid, name: z.string().trim().min(1).max(120), source: z.enum(['weather','asset','edge']),
  assetId: uuid.nullable().default(null), gatewayId: identifier.nullable().default(null), sourceId: identifier.nullable().default(null), edgeAssetId: identifier.nullable().default(null),
  metric: identifier, operator: z.enum(['below','above']), threshold: z.number().finite().min(-1e9).max(1e9),
  unit: z.string().trim().min(1).max(32), staleAfterSeconds: z.number().int().min(10).max(86400).default(900),
  lookaheadHours: z.number().int().min(1).max(72).default(24), cooldownMinutes: z.number().int().min(1).max(10080).default(360),
  enabled: z.boolean().default(true),
}).strict().superRefine((v, c) => {
  const valid = v.source === 'weather' ? !v.assetId && !v.gatewayId && !v.sourceId && !v.edgeAssetId
    : v.source === 'asset' ? !!v.assetId && !v.gatewayId && !v.sourceId && !v.edgeAssetId
    : !v.assetId && !!v.gatewayId && !!v.sourceId && !!v.edgeAssetId;
  if (!valid) c.addIssue({code: 'custom', message: 'Choose one complete monitoring source.'});
  if (v.source === 'weather') {
    const units: Record<string,string> = {temperature_2m:'C', precipitation:'mm',relative_humidity_2m:'%',wind_speed_10m:'km/h'};
    if (units[v.metric] !== v.unit) c.addIssue({code:'custom',message:'Use the forecast metric and its exact unit.'});
  }
});
const columns = 'id,farm_id,name,source,asset_id,gateway_id,source_id,edge_asset_id,metric,operator,threshold,unit,stale_after_seconds,lookahead_hours,cooldown_minutes,enabled,version,last_triggered_at,created_at';
export function registerMonitoring(app: FastifyInstance, ctx: Context) {
  app.get('/v1/farms/:farmId/monitoring', async (req, reply) => {
    const a = await authorize(ctx,req,reply); if (!a) return;
    const sensors = await sensorDashboard(ctx.db,a.farmId);
    const rules = (await ctx.db.query(`SELECT ${columns} FROM monitoring_rules WHERE farm_id=$1 ORDER BY created_at,id LIMIT 100`, [a.farmId])).rows;
    const alerts = (await ctx.db.query('SELECT * FROM monitoring_alerts WHERE farm_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[a.farmId])).rows;
    return {...sensors,rules,alerts};
  });
  app.get('/v1/farms/:farmId/monitoring/rules', async (req,reply) => {
    const a=await authorize(ctx,req,reply); if(!a)return; const q=listQuery.parse(req.query);
    return paged((await ctx.db.query(`SELECT ${columns} FROM monitoring_rules WHERE farm_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[a.farmId,q.cursor??null,q.limit+1])).rows,q.limit);
  });
  app.get('/v1/farms/:farmId/monitoring/alerts', async (req,reply) => {
    const a=await authorize(ctx,req,reply); if(!a)return; const q=listQuery.parse(req.query);
    return paged((await ctx.db.query('SELECT * FROM monitoring_alerts WHERE farm_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[a.farmId,q.cursor??null,q.limit+1])).rows,q.limit);
  });
  app.post('/v1/farms/:farmId/monitoring/rules', async(req,reply) => {
    const a=await authorize(ctx,req,reply,managers); if(!a)return; const b=input.parse(req.body);
    return ctx.transaction(async c=>{
      await lockFarmMembership(c,a.farmId,a.userId,managers);
      await operationLock(c,'monitoring-rule:'+b.id);
      const old=(await c.query('SELECT * FROM monitoring_rules WHERE id=$1',[b.id])).rows[0];
      if(old){
        if(old.farm_id!==a.farmId||old.created_by!==a.userId||old.payload_hash!==hash(b))throw new ApiError('idempotency_conflict',409);
        return (await c.query(`SELECT ${columns} FROM monitoring_rules WHERE id=$1`,[b.id])).rows[0];
      }
      if(Number((await c.query('SELECT count(*) FROM monitoring_rules WHERE farm_id=$1',[a.farmId])).rows[0].count)>=100)throw new ApiError('monitoring_rule_limit',409);
      if(b.source==='asset'){
        const asset=requireRow((await c.query('SELECT configuration,protocol FROM assets WHERE farm_id=$1 AND id=$2',[a.farmId,b.assetId])).rows[0]);
        const mapped=asset.configuration?.telemetry?.some((m:any)=>m.name===b.metric&&m.unit===b.unit);
        const observed=(await c.query('SELECT 1 FROM asset_observations WHERE farm_id=$1 AND asset_id=$2 AND measurement=$3 AND unit=$4 LIMIT 1',[a.farmId,b.assetId,b.metric,b.unit])).rowCount;
        if(!mapped&&!observed)throw new ApiError('monitoring_source_not_found',404);
      } else if(b.source==='edge'){
        const gateway=farmEdgeGateways()[b.gatewayId!];
        if(!gateway||gateway.farmId!==a.farmId||!gateway.sources.includes(b.sourceId!))throw new ApiError('monitoring_source_not_found',404);
        if(!(await c.query("SELECT 1 FROM farm_edge_observations WHERE farm_id=$1 AND gateway_id=$2 AND source_id=$3 AND kind='measurement' AND payload->'data'->>'assetId'=$4 AND payload->'data'->>'metric'=$5 AND payload->'data'->>'unit'=$6 LIMIT 1",[a.farmId,b.gatewayId,b.sourceId,b.edgeAssetId,b.metric,b.unit])).rowCount)throw new ApiError('monitoring_source_not_found',404);
      }
      const row=(await c.query(`INSERT INTO monitoring_rules(id,farm_id,created_by,name,source,asset_id,gateway_id,source_id,edge_asset_id,metric,operator,threshold,unit,stale_after_seconds,lookahead_hours,cooldown_minutes,enabled,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING ${columns}`,
        [b.id,a.farmId,a.userId,b.name,b.source,b.assetId,b.gatewayId,b.sourceId,b.edgeAssetId,b.metric,b.operator,b.threshold,b.unit,b.staleAfterSeconds,b.lookaheadHours,b.cooldownMinutes,b.enabled,hash(b)])).rows[0];
      await audit(c,a.farmId,a.userId,'monitoring_rule',b.id,'created','user_defined_threshold',null,row);
      reply.code(201);return row;
    });
  });
  app.patch('/v1/farms/:farmId/monitoring/rules/:ruleId',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,managers);if(!a)return;
    const {ruleId}=z.object({ruleId:uuid}).parse(req.params);
    const b=z.object({version:z.number().int().positive(),enabled:z.boolean()}).strict().parse(req.body);
    return ctx.transaction(async c=>{
      await lockFarmMembership(c,a.farmId,a.userId,managers);
      const old=requireRow((await c.query(`SELECT ${columns} FROM monitoring_rules WHERE farm_id=$1 AND id=$2 FOR UPDATE`,[a.farmId,ruleId])).rows[0]);
      checkVersion(old,b.version);
      const row=(await c.query(`UPDATE monitoring_rules SET enabled=$2,version=version+1 WHERE id=$1 RETURNING ${columns}`,[ruleId,b.enabled])).rows[0];
      await audit(c,a.farmId,a.userId,'monitoring_rule',ruleId,b.enabled?'enabled':'disabled','manager_confirmation',old,row);
      return row;
    });
  });
}
