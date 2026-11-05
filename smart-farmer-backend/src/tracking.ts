import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, audit, manageRoles, type Context } from './context.js';
import { uuid } from './core.js';
import { sha256 } from './security.js';

const params = z.object({farmId:uuid});
const trackerParams = z.object({farmId:uuid,trackerId:uuid});
const fenceParams = z.object({farmId:uuid,fenceId:uuid});
const alertParams = z.object({farmId:uuid,alertId:uuid});
const providers = z.enum(['gnss_lorawan','gnss_cellular','gnss_satellite','demo','manual_reference']);
const lat=z.number().finite().min(-90).max(90);
const lon=z.number().finite().min(-180).max(180);
const list=z.object({limit:z.coerce.number().int().min(1).max(200).default(100)});
const reading=z.object({
  id:uuid,observedAt:z.iso.datetime({offset:true}),
  latitude:lat,longitude:lon,
  accuracyMeters:z.number().finite().min(0).max(5000).nullable().default(null),
  batteryPercent:z.number().int().min(0).max(100).nullable().default(null),
  quality:z.enum(['gnss','estimated','simulated'])
}).strict();
const createTracker=z.object({
  id:uuid,projectId:uuid,animalId:uuid.nullable().default(null),
  provider:providers,label:z.string().trim().min(1).max(120),
  externalId:z.string().trim().min(1).max(120)
}).strict();
const fenceInput=z.object({
  id:uuid,name:z.string().trim().min(1).max(100),projectId:uuid.nullable().default(null),
  latitude:lat,longitude:lon,radiusMeters:z.number().int().min(30).max(50000)
}).strict();
function distanceMeters(aLat:number,aLon:number,bLat:number,bLon:number) {
  const toRadians=Math.PI/180;
  const dLat=(bLat-aLat)*toRadians,dLon=(bLon-aLon)*toRadians;
  const d=Math.sin(dLat/2)**2+Math.cos(aLat*toRadians)*Math.cos(bLat*toRadians)*Math.sin(dLon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(d),Math.sqrt(Math.max(0,1-d)));
}
async function authorize(ctx:Context,req:any,reply:any,roles:string[]=['owner','manager','worker']) {
  const actor=await ctx.user(req,reply);if(!actor)return null;
  const {farmId}=params.parse(req.params);
  if(!await ctx.member(farmId,actor,roles))throw new ApiError('not_found',404);
  return {actor,farmId};
}
async function ensureManage(c:any,farmId:string,actor:string) {
  const record=await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[farmId,actor]);
  if(!record.rowCount||!manageRoles.includes(record.rows[0].role))throw new ApiError('not_found',404);
}
function newToken() {return randomBytes(32).toString('base64url');}
export function registerLivestockTracking(app:FastifyInstance,ctx:Context) {
  app.get('/v1/farms/:farmId/trackers',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const q=list.parse(req.query);
    const result=await ctx.db.query(
      `SELECT t.id,t.project_id,t.animal_id,t.label,t.provider,t.external_id,t.status,t.created_at,
       p.name AS herd_name, ai.identifier AS animal_identifier,
       CASE WHEN t.animal_id IS NULL THEN 'herd_representative' ELSE 'individual' END AS coverage,
       r.observed_at,r.received_at,r.latitude,r.longitude,r.accuracy_m,r.battery_percent,r.quality,
       CASE WHEN r.observed_at IS NULL THEN 'no_location'
         WHEN r.observed_at < now()-interval '30 minutes' THEN 'stale'
         ELSE 'recent' END AS location_state
       FROM livestock_trackers t JOIN projects p ON p.farm_id=t.farm_id AND p.id=t.project_id
       LEFT JOIN animal_identities ai ON ai.farm_id=t.farm_id AND ai.id=t.animal_id
       LEFT JOIN LATERAL (SELECT observed_at,received_at,latitude,longitude,accuracy_m,battery_percent,quality
         FROM livestock_tracker_readings WHERE tracker_id=t.id ORDER BY observed_at DESC,id DESC LIMIT 1) r ON true
       WHERE t.farm_id=$1 ORDER BY t.created_at DESC LIMIT $2`,[a.farmId,q.limit]
    );return {items:result.rows};
  });
  app.post('/v1/farms/:farmId/trackers',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const b=createTracker.parse(req.body);
    const token=b.provider==='manual_reference'?null:newToken();
    const result=await ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      const p=await c.query('SELECT id,enterprise_type FROM projects WHERE farm_id=$1 AND id=$2',[a.farmId,b.projectId]);
      if(!p.rowCount||p.rows[0].enterprise_type==='crop')throw new ApiError('animal_project_required',400);
      if(b.animalId) {
        const animal=await c.query("SELECT id FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND id=$3 AND status='active'",[a.farmId,b.projectId,b.animalId]);
        if(!animal.rowCount)throw new ApiError('animal_not_active',409);
        const existing=await c.query("SELECT id FROM livestock_trackers WHERE farm_id=$1 AND animal_id=$2 AND status='active'",[a.farmId,b.animalId]);
        if(existing.rowCount)throw new ApiError('animal_already_tracked',409);
      }
      const added=await c.query(
        'INSERT INTO livestock_trackers(id,farm_id,project_id,animal_id,label,provider,external_id,credential_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,project_id,animal_id,label,provider,external_id,status',
        [b.id,a.farmId,b.projectId,b.animalId,b.label,b.provider,b.externalId,token?sha256(token):null,a.actor]
      );
      await audit(c,a.farmId,a.actor,'livestock_tracker',b.id,'registered','device_association');
      return added.rows[0];
    });
    reply.header('Cache-Control','no-store');
    return reply.code(201).send({...result, ...(token?{ingestToken:token}:{manualOnly:true})});
  });
  app.post('/v1/farms/:farmId/trackers/:trackerId/rotate-token',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const {trackerId}=trackerParams.parse(req.params);
    const secret=newToken();
    await ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      const r=await c.query("UPDATE livestock_trackers SET credential_hash=$3 WHERE farm_id=$1 AND id=$2 AND provider<>'manual_reference' AND status<>'revoked' RETURNING id",[a.farmId,trackerId,sha256(secret)]);
      if(!r.rowCount)throw new ApiError('tracker_unavailable',404);
      await audit(c,a.farmId,a.actor,'livestock_tracker',trackerId,'token_rotated','manual_rotation');
    });
    reply.header('Cache-Control','no-store');return {ingestToken:secret};
  });
  app.patch('/v1/farms/:farmId/trackers/:trackerId',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const {trackerId}=trackerParams.parse(req.params);
    const b=z.object({status:z.enum(['active','paused','revoked'])}).strict().parse(req.body);
    return ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      const r=await c.query("UPDATE livestock_trackers SET status=$3,credential_hash=CASE WHEN $3='revoked' THEN NULL ELSE credential_hash END WHERE farm_id=$1 AND id=$2 AND status<>'revoked' RETURNING id,status",[a.farmId,trackerId,b.status]);
      if(!r.rowCount)throw new ApiError('tracker_unavailable',404);
      await audit(c,a.farmId,a.actor,'livestock_tracker',trackerId,'status_changed',b.status);
      return r.rows[0];
    });
  });
  app.post('/v1/trackers/:trackerId/observations',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {trackerId}=z.object({trackerId:uuid}).parse(req.params);
    const secret=req.headers['x-tracker-token'];
    if(typeof secret!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(secret))
      throw new ApiError('unauthorized',401);
    const b=reading.parse(req.body),date=Date.parse(b.observedAt),now=Date.now();
    if(date>now+5*60_000 || date<now-14*86400_000)throw new ApiError('reading_outside_window',400);
    const hash=sha256(JSON.stringify(b));
    const result=await ctx.transaction(async c=>{
      const trackerResult=await c.query('SELECT * FROM livestock_trackers WHERE id=$1 FOR UPDATE',[trackerId]);
      const t=trackerResult.rows[0];
      if(!t||t.credential_hash!==sha256(secret)||t.status!=='active')throw new ApiError('unauthorized',401);
      if((t.provider==='demo')!==(b.quality==='simulated'))throw new ApiError('source_quality_mismatch');
      const previous=await c.query('SELECT tracker_id,payload_hash FROM livestock_tracker_readings WHERE id=$1',[b.id]);
      if(previous.rowCount) {
        if(previous.rows[0].tracker_id!==trackerId||previous.rows[0].payload_hash!==hash)
          throw new ApiError('reading_id_conflict',409);
        return {id:b.id,replayed:true};
      }
      const newest=await c.query('SELECT observed_at FROM livestock_tracker_readings WHERE tracker_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1',[trackerId]);
      await c.query('INSERT INTO livestock_tracker_readings(id,farm_id,tracker_id,observed_at,latitude,longitude,accuracy_m,battery_percent,quality,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [b.id,t.farm_id,trackerId,b.observedAt,b.latitude,b.longitude,b.accuracyMeters,b.batteryPercent,b.quality,hash]);
      if(!newest.rowCount||date>new Date(newest.rows[0].observed_at).getTime()) {
        if(b.batteryPercent!==null) {
          if(b.batteryPercent<=15) {
            await c.query("INSERT INTO livestock_tracker_alerts(id,farm_id,tracker_id,reading_id,kind) VALUES($1,$2,$3,$4,'low_battery') ON CONFLICT DO NOTHING",
              [randomUUID(),t.farm_id,trackerId,b.id]);
          }else{
            await c.query("UPDATE livestock_tracker_alerts SET status='resolved',resolved_at=now() WHERE tracker_id=$1 AND kind='low_battery' AND status<>'resolved'",[trackerId]);
          }
        }
        const fences=await c.query('SELECT * FROM livestock_geofences WHERE farm_id=$1 AND active AND (project_id IS NULL OR project_id=$2)',[t.farm_id,t.project_id]);
        for(const fence of fences.rows) {
          const valid=b.accuracyMeters!==null&&b.accuracyMeters<=Math.min(150,Number(fence.radius_m)/2);
          if(!valid)continue; // uncertain fixes must not generate definite border alarms
          const outside=distanceMeters(b.latitude,b.longitude,Number(fence.latitude),Number(fence.longitude))>Number(fence.radius_m)+b.accuracyMeters!;
          if(outside) {
            await c.query("INSERT INTO livestock_tracker_alerts(id,farm_id,tracker_id,geofence_id,reading_id,kind) VALUES($1,$2,$3,$4,$5,'outside_geofence') ON CONFLICT DO NOTHING",
              [randomUUID(),t.farm_id,trackerId,fence.id,b.id]);
          } else {
            await c.query("UPDATE livestock_tracker_alerts SET status='resolved',resolved_at=now() WHERE tracker_id=$1 AND geofence_id=$2 AND status<>'resolved'",[trackerId,fence.id]);
          }
        }
      }
      return {id:b.id,replayed:false};
    });
    return reply.code(result.replayed?200:201).send(result);
  });
  app.get('/v1/farms/:farmId/trackers/:trackerId/history',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const {trackerId}=trackerParams.parse(req.params);
    const q=list.parse(req.query);
    const result=await ctx.db.query('SELECT r.id,r.observed_at,r.received_at,r.latitude,r.longitude,r.accuracy_m,r.battery_percent,r.quality FROM livestock_tracker_readings r JOIN livestock_trackers t ON t.id=r.tracker_id WHERE t.farm_id=$1 AND t.id=$2 ORDER BY r.observed_at DESC,r.id DESC LIMIT $3',[a.farmId,trackerId,q.limit]);
    return {items:result.rows};
  });
  app.get('/v1/farms/:farmId/geofences',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const r=await ctx.db.query('SELECT id,name,project_id,latitude,longitude,radius_m,active,created_at FROM livestock_geofences WHERE farm_id=$1 ORDER BY name LIMIT 200',[a.farmId]);
    return {items:r.rows};
  });
  app.post('/v1/farms/:farmId/geofences',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const b=fenceInput.parse(req.body);
    return ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      if(b.projectId&&! (await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2',[a.farmId,b.projectId])).rowCount)
        throw new ApiError('project_not_found',404);
      const r=await c.query('INSERT INTO livestock_geofences(id,farm_id,name,project_id,latitude,longitude,radius_m,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,latitude,longitude,radius_m,project_id,active',[b.id,a.farmId,b.name,b.projectId,b.latitude,b.longitude,b.radiusMeters,a.actor]);
      await audit(c,a.farmId,a.actor,'livestock_geofence',b.id,'created','approved_boundary');
      return reply.code(201).send(r.rows[0]);
    });
  });
  app.patch('/v1/farms/:farmId/geofences/:fenceId',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const {fenceId}=fenceParams.parse(req.params);
    const b=z.object({active:z.boolean()}).strict().parse(req.body);
    return ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      const r=await c.query('UPDATE livestock_geofences SET active=$3 WHERE farm_id=$1 AND id=$2 RETURNING id,active',[a.farmId,fenceId,b.active]);
      if(!r.rowCount)throw new ApiError('not_found',404);
      if(!b.active)await c.query("UPDATE livestock_tracker_alerts SET status='resolved',resolved_at=now() WHERE geofence_id=$1 AND status<>'resolved'",[fenceId]);
      await audit(c,a.farmId,a.actor,'livestock_geofence',fenceId,'status_changed',b.active?'enabled':'disabled');
      return r.rows[0];
    });
  });
  app.get('/v1/farms/:farmId/tracker-alerts',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const r=await ctx.db.query('SELECT a.id,a.tracker_id,a.geofence_id,a.kind,a.status,a.opened_at,a.acknowledged_at,t.label AS tracker_label,g.name AS geofence_name FROM livestock_tracker_alerts a JOIN livestock_trackers t ON t.id=a.tracker_id LEFT JOIN livestock_geofences g ON g.id=a.geofence_id WHERE a.farm_id=$1 AND a.status<>\'resolved\' ORDER BY a.opened_at DESC LIMIT 200',[a.farmId]);
    return {items:r.rows};
  });
  app.post('/v1/farms/:farmId/tracker-alerts/:alertId/acknowledge',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,manageRoles);if(!a)return;
    const {alertId}=alertParams.parse(req.params);
    return ctx.transaction(async c=>{
      await ensureManage(c,a.farmId,a.actor);
      const r=await c.query("UPDATE livestock_tracker_alerts SET status='acknowledged',acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$3) WHERE farm_id=$1 AND id=$2 AND status<>'resolved' RETURNING id,status",[a.farmId,alertId,a.actor]);
      if(!r.rowCount)throw new ApiError('not_found',404);
      await audit(c,a.farmId,a.actor,'livestock_tracker_alert',alertId,'acknowledged','manual_review');
      return r.rows[0];
    });
  });
}
