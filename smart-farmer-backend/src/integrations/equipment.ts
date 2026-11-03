import {randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {ApiError} from '../context.js';
import {sha256, token} from '../security.js';
import {authorize, hash, instant, managers, operationLock, requireRow, uuid, type Context} from './common.js';

const assetInput = z.object({id: uuid, name: z.string().trim().min(1).max(100), category: z.enum(['borehole','pump','pivot','valve','tank','sensor','power','camera','other']), model: z.string().trim().min(1).max(150).nullable().default(null), protocol: z.enum(['unconfigured','simulator','mqtt','http','modbus']).default('unconfigured'), parentAssetId: uuid.nullable().default(null), staleAfterSeconds: z.number().int().min(10).max(3600).default(120)}).strict();
const simulation = z.object({running: z.boolean(), interlockOk: z.boolean()}).strict();
const commandInput = z.object({id: uuid, command: z.enum(['start','stop']), confirmed: z.literal(true), expiresAt: instant}).strict();
const telemetryInput = z.object({id: uuid, observedAt: instant, measurements: z.object({running: z.boolean(), interlock_ok: z.boolean(), flow_l_min: z.number().finite().nonnegative().max(1e7).optional(), pressure_kpa: z.number().finite().nonnegative().max(1e7).optional()}).strict()}).strict();
const resultInput = z.object({status: z.enum(['acknowledged','confirmed','rejected','failed']), feedback: z.object({running: z.boolean(), interlock_ok: z.boolean()}).strict().optional(), reason: z.string().max(300).optional()}).strict();
const assetParams = z.object({farmId: uuid, assetId: uuid});

/** Never redeliver a dispatched command. Missing acknowledgement is an unknown outcome. */
export async function expireCommands(db: Pool | PoolClient) {
  const changed = await db.query("UPDATE equipment_commands SET status=CASE WHEN status='authorized' THEN 'expired' ELSE 'outcome_unknown' END, completed_at=clock_timestamp(),reason='deadline_elapsed' WHERE expires_at<=clock_timestamp() AND status IN ('authorized','dispatched','acknowledged') RETURNING id,status");
  for (const row of changed.rows) await db.query('INSERT INTO command_audit(command_id,status,detail) VALUES($1,$2,$3)', [row.id,row.status,'deadline_elapsed']);
  return changed.rowCount ?? 0;
}

async function appendTelemetry(client: PoolClient, asset: any, data: z.infer<typeof telemetryInput>) {
  if (new Date(data.observedAt).getTime() > Date.now()+300_000) throw new ApiError('future_observation');
  await operationLock(client, `telemetry:${data.id}`);
  const prior = (await client.query('SELECT payload_hash,asset_id FROM telemetry WHERE id=$1', [data.id])).rows[0];
  const fingerprint = hash(data);
  if (prior) {
    if (prior.asset_id!==asset.id || prior.payload_hash!==fingerprint) throw new ApiError('idempotency_conflict',409);
    return;
  }
  await client.query("INSERT INTO telemetry(id,farm_id,asset_id,source,observed_at,measurements,payload_hash) VALUES($1,$2,$3,'simulator',$4,$5,$6)", [data.id,asset.farm_id,asset.id,data.observedAt,data.measurements,fingerprint]);
  await client.query('UPDATE assets SET last_observed_at=$2,latest_telemetry=$3 WHERE id=$1 AND (last_observed_at IS NULL OR last_observed_at<=$2::timestamptz)', [asset.id,data.observedAt,data.measurements]);
}

async function recordResult(client: PoolClient, asset: any, commandId: string, data: z.infer<typeof resultInput>) {
  const cmd = requireRow((await client.query('SELECT * FROM equipment_commands WHERE id=$1 AND asset_id=$2 FOR UPDATE', [commandId,asset.id])).rows[0]);
  if (!['authorized','dispatched','acknowledged'].includes(cmd.status)) {
    if (cmd.status===data.status && (data.status!=='confirmed' || JSON.stringify(cmd.feedback)===JSON.stringify(data.feedback))) return cmd;
    throw new ApiError('command_terminal',409);
  }
  if (new Date(cmd.expires_at).getTime()<=Date.now()) throw new ApiError('command_expired',409);
  if (cmd.status==='authorized') throw new ApiError('command_not_dispatched',409);
  if (data.status==='confirmed') {
    if (!data.feedback || data.feedback.running!==(cmd.command==='start')) throw new ApiError('feedback_required',409);
    if (cmd.command==='start' && !data.feedback.interlock_ok) throw new ApiError('interlock_open',409);
    await appendTelemetry(client,asset,{id:randomUUID(),observedAt:new Date().toISOString(),measurements:data.feedback});
  }
  if (data.status==='acknowledged' && cmd.status==='acknowledged') return cmd;
  const result=await client.query("UPDATE equipment_commands SET status=$2,feedback=$3,reason=$4,acknowledged_at=CASE WHEN $2='acknowledged' THEN now() ELSE acknowledged_at END,completed_at=CASE WHEN $2='acknowledged' THEN NULL ELSE now() END WHERE id=$1 RETURNING *", [cmd.id,data.status,data.feedback??null,data.reason??null]);
  await client.query('INSERT INTO command_audit(command_id,status,detail) VALUES($1,$2,$3)', [cmd.id,data.status,data.reason??null]);
  return result.rows[0];
}

export function registerEquipment(app: FastifyInstance, ctx: Context) {
  app.get('/v1/farms/:farmId/assets', async(req,reply)=>{
    const auth=await authorize(ctx,req,reply); if(!auth)return;
    const query=z.object({cursor:uuid.optional()}).parse(req.query);
    const rows=(await ctx.db.query("SELECT id,name,category,model,protocol,parent_asset_id,integration_state,capabilities,stale_after_seconds,last_observed_at,latest_telemetry,COALESCE(last_observed_at>now()-make_interval(secs=>stale_after_seconds),false) AS fresh FROM assets WHERE farm_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101",[auth.farmId,query.cursor??null])).rows;
    return {items:rows.slice(0,100),nextCursor:rows.length>100?rows[99].id:null};
  });
  app.post('/v1/farms/:farmId/assets',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const data=assetInput.parse(req.body);
    const result=await ctx.transaction(async(client)=>{
      await operationLock(client,`asset:${data.id}`);
      const existing=(await client.query('SELECT * FROM assets WHERE id=$1',[data.id])).rows[0];
      if(existing){
        if(existing.farm_id!==auth.farmId || existing.created_by!==auth.userId || existing.name!==data.name || existing.category!==data.category || existing.model!==data.model || existing.protocol!==data.protocol || existing.parent_asset_id!==data.parentAssetId || existing.stale_after_seconds!==data.staleAfterSeconds)throw new ApiError('idempotency_conflict',409);
        return {id:data.id,replayed:true};
      }
      if(data.parentAssetId)requireRow((await client.query('SELECT id FROM assets WHERE farm_id=$1 AND id=$2',[auth.farmId,data.parentAssetId])).rows[0]);
      const controls=data.protocol==='simulator'&&['pump','pivot','valve'].includes(data.category);
      const capabilities={telemetry:data.protocol==='simulator'?['running','interlock_ok','flow_l_min','pressure_kpa']:[],commands:controls?['start','stop']:[]};
      await client.query('INSERT INTO assets(id,farm_id,name,category,model,protocol,integration_state,parent_asset_id,capabilities,stale_after_seconds,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[data.id,auth.farmId,data.name,data.category,data.model,data.protocol,data.protocol==='simulator'?'simulated':'unconfigured',data.parentAssetId,capabilities,data.staleAfterSeconds,auth.userId]);
      return {id:data.id,replayed:false};
    });
    return reply.code(result.replayed?200:201).send(result);
  });
  app.post('/v1/farms/:farmId/assets/:assetId/simulate',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const {assetId}=assetParams.parse(req.params);const data=simulation.parse(req.body);
    await ctx.transaction(async(client)=>{
      const asset=requireRow((await client.query('SELECT * FROM assets WHERE id=$1 AND farm_id=$2 FOR UPDATE',[assetId,auth.farmId])).rows[0]);
      if(asset.integration_state!=='simulated')throw new ApiError('simulation_only',409);
      await appendTelemetry(client,asset,{id:randomUUID(),observedAt:new Date().toISOString(),measurements:{running:data.running,interlock_ok:data.interlockOk}});
    });
    return {status:'simulated',source:'simulator'};
  });
  app.post('/v1/farms/:farmId/assets/:assetId/gateway-token',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,['owner']);if(!auth)return;
    const {assetId}=assetParams.parse(req.params);const value=token();
    const result=await ctx.db.query("UPDATE assets SET gateway_token_hash=$3,gateway_expires_at=now()+interval '30 days' WHERE farm_id=$1 AND id=$2 AND integration_state='simulated' RETURNING gateway_expires_at",[auth.farmId,assetId,sha256(value)]);
    requireRow(result.rows[0]);
    return {token:value,expiresAt:result.rows[0].gateway_expires_at,scope:'simulation',assetId};
  });
  app.get('/v1/farms/:farmId/assets/:assetId/commands',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const {assetId}=assetParams.parse(req.params);
    await ctx.transaction(expireCommands);
    return {items:(await ctx.db.query('SELECT id,asset_id,command,status,expires_at,created_at,dispatched_at,acknowledged_at,completed_at,feedback,reason FROM equipment_commands WHERE farm_id=$1 AND asset_id=$2 ORDER BY created_at DESC LIMIT 100',[auth.farmId,assetId])).rows};
  });
  app.post('/v1/farms/:farmId/assets/:assetId/commands',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const {assetId}=assetParams.parse(req.params);const data=commandInput.parse(req.body);
    const result=await ctx.transaction(async(client)=>{
      await operationLock(client,`command:${data.id}`);
      const prior=(await client.query('SELECT * FROM equipment_commands WHERE id=$1',[data.id])).rows[0];
      if(prior){if(prior.farm_id!==auth.farmId||prior.asset_id!==assetId||prior.actor_id!==auth.userId||prior.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return {command:prior,replayed:true};}
      const deadline=new Date(data.expiresAt).getTime();if(deadline<Date.now()+1000||deadline>Date.now()+120000)throw new ApiError('invalid_command_expiry');
      const asset=requireRow((await client.query('SELECT * FROM assets WHERE farm_id=$1 AND id=$2 FOR UPDATE',[auth.farmId,assetId])).rows[0]);
      if(asset.integration_state!=='simulated'||!asset.capabilities.commands.includes(data.command))throw new ApiError('control_not_commissioned',409);
      if(!asset.last_observed_at||Date.now()-new Date(asset.last_observed_at).getTime()>asset.stale_after_seconds*1000)throw new ApiError('telemetry_stale',409);
      if(data.command==='start'&&asset.latest_telemetry.interlock_ok!==true)throw new ApiError('interlock_open',409);
      await expireCommands(client);
      if((await client.query("SELECT 1 FROM equipment_commands WHERE asset_id=$1 AND status IN ('authorized','dispatched','acknowledged')",[assetId])).rowCount)throw new ApiError('command_in_progress',409);
      if(deadline<=Date.now())throw new ApiError('command_expired',409);
      const inserted=await client.query("INSERT INTO equipment_commands(id,farm_id,asset_id,actor_id,command,status,expires_at,payload_hash) VALUES($1,$2,$3,$4,$5,'authorized',$6,$7) RETURNING *",[data.id,auth.farmId,assetId,auth.userId,data.command,data.expiresAt,hash(data)]);
      await client.query("INSERT INTO command_audit(command_id,status,detail) VALUES($1,'requested','explicit_user_confirmation'),($1,'authorized','simulator_capability_and_freshness_verified')",[data.id]);
      return {command:inserted.rows[0],replayed:false};
    });return reply.code(result.replayed?200:201).send(result.command);
  });
  app.post('/v1/farms/:farmId/assets/:assetId/commands/:commandId/simulate',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const {assetId,commandId}=assetParams.extend({commandId:uuid}).parse(req.params);const data=resultInput.parse(req.body);
    return ctx.transaction(async(client)=>{
      const asset=requireRow((await client.query("SELECT * FROM assets WHERE farm_id=$1 AND id=$2 AND integration_state='simulated' FOR UPDATE",[auth.farmId,assetId])).rows[0]);
      const cmd=requireRow((await client.query('SELECT * FROM equipment_commands WHERE id=$1 AND asset_id=$2 FOR UPDATE',[commandId,assetId])).rows[0]);
      if(cmd.status==='authorized'){
        if(new Date(cmd.expires_at).getTime()<=Date.now())throw new ApiError('command_expired',409);
        if(!asset.last_observed_at||Date.now()-new Date(asset.last_observed_at).getTime()>asset.stale_after_seconds*1000)throw new ApiError('telemetry_stale',409);
        if(cmd.command==='start'&&asset.latest_telemetry.interlock_ok!==true)throw new ApiError('interlock_open',409);
        await client.query("UPDATE equipment_commands SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=$1",[commandId]);
        await client.query("INSERT INTO command_audit(command_id,status,detail) VALUES($1,'dispatched','explicit_manager_simulation')",[commandId]);
      }
      return recordResult(client,asset,commandId,data);
    });
  });
  async function gateway(req: FastifyRequest) {
    const raw=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!raw)throw new ApiError('unauthorized',401);
    const asset=(await ctx.db.query("SELECT * FROM assets WHERE gateway_token_hash=$1 AND gateway_expires_at>now() AND integration_state='simulated'",[sha256(raw)])).rows[0];
    if(!asset)throw new ApiError('unauthorized',401);return asset;
  }
  async function lockGateway(client:PoolClient,authenticated:any){
    const current=(await client.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[authenticated.id])).rows[0];
    if(!current||current.gateway_token_hash!==authenticated.gateway_token_hash||!current.gateway_expires_at||new Date(current.gateway_expires_at).getTime()<=Date.now()||current.integration_state!=='simulated')throw new ApiError('unauthorized',401);
    return current;
  }
  app.post('/v1/edge/telemetry',async(req)=>{
    const asset=await gateway(req);const data=telemetryInput.parse(req.body);
    await ctx.transaction(async(client)=>{const current=await lockGateway(client,asset);await appendTelemetry(client,current,data);});
    return {id:data.id,status:'recorded',source:'simulator'};
  });
  app.post('/v1/edge/commands/next',async(req)=>{
    const asset=await gateway(req);
    return ctx.transaction(async(client)=>{
      const current=await lockGateway(client,asset);
      await expireCommands(client);
      const cmd=(await client.query("SELECT * FROM equipment_commands WHERE asset_id=$1 AND status='authorized' ORDER BY created_at LIMIT 1 FOR UPDATE",[asset.id])).rows[0];
      if(!cmd)return {command:null};
      if(new Date(cmd.expires_at).getTime()<=Date.now()){
        await client.query("UPDATE equipment_commands SET status='expired',completed_at=clock_timestamp(),reason='deadline_elapsed' WHERE id=$1",[cmd.id]);
        await client.query("INSERT INTO command_audit(command_id,status,detail) VALUES($1,'expired','deadline_elapsed')",[cmd.id]);return {command:null};
      }
      if(!current.last_observed_at||Date.now()-new Date(current.last_observed_at).getTime()>current.stale_after_seconds*1000||(cmd.command==='start'&&current.latest_telemetry.interlock_ok!==true)){
        await client.query("UPDATE equipment_commands SET status='rejected',completed_at=now(),reason='stale_or_interlocked_at_dispatch' WHERE id=$1",[cmd.id]);
        await client.query("INSERT INTO command_audit(command_id,status,detail) VALUES($1,'rejected','stale_or_interlocked_at_dispatch')",[cmd.id]);return {command:null};
      }
      await client.query("UPDATE equipment_commands SET status='dispatched',dispatched_at=now() WHERE id=$1",[cmd.id]);
      await client.query("INSERT INTO command_audit(command_id,status) VALUES($1,'dispatched')",[cmd.id]);
      return {command:{id:cmd.id,command:cmd.command,expiresAt:cmd.expires_at,source:'simulator'}};
    });
  });
  app.post('/v1/edge/commands/:commandId/result',async(req)=>{
    const asset=await gateway(req);const {commandId}=z.object({commandId:uuid}).parse(req.params);const data=resultInput.parse(req.body);
    return ctx.transaction(async(client)=>{const current=await lockGateway(client,asset);return recordResult(client,current,commandId,data);});
  });
  app.get('/v1/farms/:farmId/camera-events',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    return {items:(await ctx.db.query('SELECT e.id,e.asset_id,a.name,e.kind,e.source,e.observed_at,e.received_at,e.expires_at,e.acknowledged_at,(e.received_at-e.observed_at>interval \'60 seconds\') AS delayed FROM camera_events e JOIN assets a ON a.id=e.asset_id WHERE e.farm_id=$1 AND e.expires_at>now() ORDER BY e.observed_at DESC LIMIT 100',[auth.farmId])).rows};
  });
  app.post('/v1/farms/:farmId/camera-events',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;
    const data=z.object({id:uuid,assetId:uuid,kind:z.enum(['motion','person']),observedAt:instant,retentionDays:z.number().int().min(1).max(90).default(7)}).strict().parse(req.body);
    if(new Date(data.observedAt).getTime()>Date.now()+300000)throw new ApiError('future_observation');
    const outcome=await ctx.transaction(async(client)=>{
      await operationLock(client,`camera:${data.id}`);
      const prior=(await client.query('SELECT farm_id,payload_hash FROM camera_events WHERE id=$1',[data.id])).rows[0];
      if(prior){if(prior.farm_id!==auth.farmId||prior.payload_hash!==hash(data))throw new ApiError('idempotency_conflict',409);return true;}
      requireRow((await client.query("SELECT id FROM assets WHERE id=$1 AND farm_id=$2 AND category='camera' AND integration_state='simulated'",[data.assetId,auth.farmId])).rows[0]);
      await client.query("INSERT INTO camera_events(id,farm_id,asset_id,kind,source,observed_at,expires_at,payload_hash) VALUES($1,$2,$3,$4,'simulator',$5,$5::timestamptz+make_interval(days=>$6),$7)",[data.id,auth.farmId,data.assetId,data.kind,data.observedAt,data.retentionDays,hash(data)]);return false;
    });return reply.code(outcome?200:201).send({id:data.id,source:'simulator'});
  });
  app.post('/v1/farms/:farmId/camera-events/:eventId/acknowledge',async(req,reply)=>{
    const auth=await authorize(ctx,req,reply,managers);if(!auth)return;const {eventId}=z.object({eventId:uuid}).parse(req.params);
    requireRow((await ctx.db.query('UPDATE camera_events SET acknowledged_by=$3,acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1 AND farm_id=$2 AND expires_at>now() RETURNING id',[eventId,auth.farmId,auth.userId])).rows[0]);return {id:eventId,status:'acknowledged'};
  });
}
