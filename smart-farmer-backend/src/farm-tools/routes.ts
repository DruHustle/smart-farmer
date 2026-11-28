import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ApiError, audit, type Context} from '../context.js';
import {authorize, managers, uuid, instant, hash, operationLock, requireRow, lockFarmMembership} from '../integrations/common.js';
import {listQuery, paged, validateInstant, settings} from '../operations/common.js';

const label=z.string().trim().min(1).max(160), note=z.string().trim().max(3000).default('');
const source=z.string().trim().min(1).max(500);
const https=z.url().max(2000).refine(value=>{
  const url=new URL(value); return url.protocol==='https:'&&!url.username&&!url.password;
},'Use a public HTTPS source URL without credentials');
const date=z.iso.date().refine(value=>value<=new Date().toISOString().slice(0,10),'Date cannot be in the future');
const observers=['owner','manager','worker','adviser'];
const present=(row:any)=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='payload_hash'));
type Actor={farmId:string;userId:string};
type Values=Record<string,any>;
type Table='farm_market_prices'|'farm_support_centres'|'farm_training_guides'|'farm_support_visits'|'farm_trials'|'farm_trial_observations'|'farm_growing_systems'|'farm_water_logs';

// Table and column names come only from the definitions below, never requests.
function createRoute(app:FastifyInstance,ctx:Context,path:string,table:Table,schema:z.ZodType,
  columns:Record<string,string>,roles=managers,
  validate?: (c:PoolClient,b:Values,a:Actor,params:any)=>Promise<Record<string,unknown>|void>) {
  app.post('/v1/farms/:farmId'+path,async(req,reply)=>{
    const a=await authorize(ctx,req,reply,roles); if(!a)return;
    const b=schema.parse(req.body) as Values;
    const payloadHash=hash({body:b,scope:req.params});
    return ctx.transaction(async c=>{
      await lockFarmMembership(c,a.farmId,a.userId,roles);
      await operationLock(c,`farm-tools:${table}:${b.id}`);
      const previous=(await c.query(`SELECT * FROM ${table} WHERE id=$1`,[b.id])).rows[0];
      if(previous){
        if(previous.farm_id!==a.farmId||previous.created_by!==a.userId||previous.payload_hash!==payloadHash)throw new ApiError('idempotency_conflict',409);
        return present(previous);
      }
      const extra=await validate?.(c,b,a,req.params)??{};
      const values:Record<string,unknown>={id:b.id,farm_id:a.farmId,created_by:a.userId,payload_hash:payloadHash};
      for(const [input,column] of Object.entries(columns))values[column]=b[input]??null;
      Object.assign(values,extra);
      const keys=Object.keys(values);
      const row=(await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(values))).rows[0];
      await audit(c,a.farmId,a.userId,table,b.id,'created','recorded_by_member',null,present(row));
      reply.code(201); return present(row);
    });
  });
}
function listRoute(app:FastifyInstance,ctx:Context,path:string,table:Table,filters:Record<string,string>={}){
  app.get('/v1/farms/:farmId'+path,async(req,reply)=>{
    const a=await authorize(ctx,req,reply); if(!a)return;
    const q=listQuery.extend(Object.fromEntries(Object.keys(filters).map(key=>[key,label.optional()]))).parse(req.query) as Values;
    const values:unknown[]=[a.farmId,q.cursor??null,q.limit+1];
    const conditions=['farm_id=$1','($2::uuid IS NULL OR id>$2)'];
    for(const [input,column] of Object.entries(filters))if(q[input]){values.push(q[input]);conditions.push(`lower(${column})=lower($${values.length})`);}
    const rows=(await ctx.db.query(`SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT $3`,values)).rows;
    return paged(rows.map(present),q.limit);
  });
}
async function project(c:PoolClient,farmId:string,id:string){return requireRow((await c.query('SELECT id,enterprise_type FROM projects WHERE farm_id=$1 AND id=$2',[farmId,id])).rows[0]);}

export function summarizeTrial(trial:any,rows:{arm:string;value:number|string}[]){
  const arm=(name:string)=>{const values=rows.filter(row=>row.arm===name).map(row=>Number(row.value));return {count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};};
  const control=arm('control'),treatment=arm('treatment');
  const difference=control.mean!==null&&treatment.mean!==null?treatment.mean-control.mean:null;
  const percentChange=difference!==null&&control.mean!==null&&control.mean!==0?difference/Math.abs(control.mean)*100:null;
  const caution='Descriptive comparison of recorded samples. Different plots, timing and sample sizes can affect the result; this does not establish cause and effect.';
  return {control,treatment,difference,percentChange,caution,shareText:[trial.name,`${trial.metric} (${trial.unit})`,`${trial.control_label}: ${control.mean===null?'no observations':control.mean.toFixed(3)}; n=${control.count}`,`${trial.treatment_label}: ${treatment.mean===null?'no observations':treatment.mean.toFixed(3)}; n=${treatment.count}`,difference===null?'Record observations in both plots to compare.':`Difference: ${difference.toFixed(3)} ${trial.unit}${percentChange===null?'':` (${percentChange.toFixed(1)}%)`}`,caution].join('\n')};
}

export function registerFarmTools(app:FastifyInstance,ctx:Context){
  listRoute(app,ctx,'/market-prices','farm_market_prices',{commodity:'commodity',market:'market'});
  createRoute(app,ctx,'/market-prices','farm_market_prices',z.object({
    id:uuid,commodity:label,market:label,price:z.number().finite().positive().max(1e12),currency:z.string().regex(/^[A-Z]{3}$/),unit:label,
    observedAt:instant,source,sourceUrl:https.nullable().optional(),note,
  }).strict(),{commodity:'commodity',market:'market',price:'price',currency:'currency',unit:'unit',observedAt:'observed_at',source:'source',sourceUrl:'source_url',note:'note'},managers,async(_c,b)=>{validateInstant(b.observedAt);});

  app.get('/v1/farms/:farmId/support/centres',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;
    const q=listQuery.extend({latitude:z.coerce.number().min(-90).max(90).optional(),longitude:z.coerce.number().min(-180).max(180).optional()}).refine(q=>(q.latitude===undefined)===(q.longitude===undefined)).parse(req.query);
    const farm=settings(requireRow((await ctx.db.query('SELECT timezone,operations_settings FROM farms WHERE id=$1',[a.farmId])).rows[0]));
    const latitude=q.latitude??farm.latitude,longitude=q.longitude??farm.longitude;
    const rows=(await ctx.db.query(`WITH distances AS (
      SELECT *,CASE WHEN latitude IS NULL OR $2::float8 IS NULL OR $3::float8 IS NULL THEN NULL ELSE
        6371*2*asin(sqrt(least(1,greatest(0,power(sin(radians(latitude-$2)/2),2)+cos(radians($2))*cos(radians(latitude))*power(sin(radians(longitude-$3)/2),2))))) END AS "distanceKm"
      FROM farm_support_centres WHERE farm_id=$1)
      SELECT * FROM distances WHERE $4::uuid IS NULL OR (coalesce("distanceKm",1e12),id)>(SELECT coalesce("distanceKm",1e12),id FROM distances WHERE id=$4)
      ORDER BY "distanceKm" NULLS LAST,id LIMIT $5`,[a.farmId,latitude,longitude,q.cursor??null,q.limit+1])).rows;
    return {...paged(rows.map(present),q.limit),locationKnown:latitude!==null&&longitude!==null};
  });
  createRoute(app,ctx,'/support/centres','farm_support_centres',z.object({
    id:uuid,name:label,kind:z.enum(['extension_officer','support_centre']),area:label,
    latitude:z.number().finite().min(-90).max(90).nullable().optional(),longitude:z.number().finite().min(-180).max(180).nullable().optional(),
    phone:z.string().trim().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(),email:z.email().max(254).nullable().optional(),sourceUrl:https,verifiedOn:date,
  }).strict().refine(b=>(b.latitude==null)===(b.longitude==null)),{name:'name',kind:'kind',area:'area',latitude:'latitude',longitude:'longitude',phone:'phone',email:'email',sourceUrl:'source_url',verifiedOn:'verified_on'});
  listRoute(app,ctx,'/support/guides','farm_training_guides',{language:'language'});
  createRoute(app,ctx,'/support/guides','farm_training_guides',z.object({
    id:uuid,title:label,summary:z.string().trim().min(1).max(1000),content:z.string().trim().min(1).max(20000),language:z.enum(['en','sn','nd']),
    sourceUrl:https,reviewedBy:label,reviewedOn:date,videoUrl:https.nullable().optional(),videoSizeKb:z.number().int().min(1).max(2_000_000).nullable().optional(),
  }).strict().refine(b=>b.videoSizeKb==null||b.videoUrl!=null),{title:'title',summary:'summary',content:'content',language:'language',sourceUrl:'source_url',reviewedBy:'reviewed_by',reviewedOn:'reviewed_on',videoUrl:'video_url',videoSizeKb:'video_size_kb'});
  listRoute(app,ctx,'/support/visits','farm_support_visits');
  createRoute(app,ctx,'/support/visits','farm_support_visits',z.object({id:uuid,centreId:uuid,requestedFor:instant,reason:source}).strict(),{centreId:'centre_id',requestedFor:'requested_for',reason:'reason'},observers,async(c,b,a)=>{
    requireRow((await c.query('SELECT id FROM farm_support_centres WHERE farm_id=$1 AND id=$2',[a.farmId,b.centreId])).rows[0]);
    if(Date.parse(b.requestedFor)<Date.now())throw new ApiError('visit_must_be_future');
  });
  app.patch('/v1/farms/:farmId/support/visits/:id',async(req,reply)=>{
    const a=await authorize(ctx,req,reply,managers);if(!a)return;
    const {id}=z.object({id:uuid}).parse(req.params);
    const b=z.object({version:z.number().int().positive(),status:z.enum(['confirmed','completed','cancelled']),note:source}).strict().parse(req.body);
    return ctx.transaction(async c=>{
      await lockFarmMembership(c,a.farmId,a.userId,managers);
      const old=requireRow((await c.query('SELECT * FROM farm_support_visits WHERE farm_id=$1 AND id=$2 FOR UPDATE',[a.farmId,id])).rows[0]);
      if(old.version!==b.version){if(old.version===b.version+1&&old.status===b.status&&old.note===b.note)return present(old);throw new ApiError('version_conflict',409,{current:present(old)});}
      if(['cancelled','completed'].includes(old.status)||b.status==='completed'&&old.status!=='confirmed')throw new ApiError('invalid_visit_transition',409);
      const row=(await c.query('UPDATE farm_support_visits SET status=$3,note=$4,version=version+1 WHERE farm_id=$1 AND id=$2 RETURNING *',[a.farmId,id,b.status,b.note])).rows[0];
      await audit(c,a.farmId,a.userId,'support_visit',id,b.status,b.note,present(old),present(row));return present(row);
    });
  });

  listRoute(app,ctx,'/trials','farm_trials');
  createRoute(app,ctx,'/trials','farm_trials',z.object({id:uuid,name:label,projectId:uuid,controlLabel:label,treatmentLabel:label,practice:source,metric:label,unit:label,startedOn:date,note}).strict().refine(b=>b.controlLabel.toLowerCase()!==b.treatmentLabel.toLowerCase(),'Control and treatment labels must differ'),{name:'name',projectId:'project_id',controlLabel:'control_label',treatmentLabel:'treatment_label',practice:'practice',metric:'metric',unit:'unit',startedOn:'started_on',note:'note'},managers,async(c,b,a)=>{await project(c,a.farmId,b.projectId);});
  app.get('/v1/farms/:farmId/trials/:id',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;const {id}=z.object({id:uuid}).parse(req.params);const q=listQuery.parse(req.query);
    const trial=requireRow((await ctx.db.query('SELECT * FROM farm_trials WHERE farm_id=$1 AND id=$2',[a.farmId,id])).rows[0]);
    const observations=(await ctx.db.query('SELECT * FROM farm_trial_observations WHERE farm_id=$1 AND trial_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[a.farmId,id,q.cursor??null,q.limit+1])).rows;
    const aggregate=(await ctx.db.query('SELECT arm,count(*)::int AS count,avg(value) AS mean FROM farm_trial_observations WHERE farm_id=$1 AND trial_id=$2 GROUP BY arm',[a.farmId,id])).rows;
    const stats=summarizeTrial(trial,[]);for(const arm of ['control','treatment'] as const){const row=aggregate.find(row=>row.arm===arm);stats[arm]={count:row?.count??0,mean:row?.mean==null?null:Number(row.mean)};}
    stats.difference=stats.control.mean!==null&&stats.treatment.mean!==null?stats.treatment.mean-stats.control.mean:null;
    stats.percentChange=stats.difference!==null&&stats.control.mean!==null&&stats.control.mean!==0?stats.difference/Math.abs(stats.control.mean)*100:null;
    stats.shareText=[trial.name,`${trial.metric} (${trial.unit})`,`${trial.control_label}: ${stats.control.mean??'no observations'}; n=${stats.control.count}`,`${trial.treatment_label}: ${stats.treatment.mean??'no observations'}; n=${stats.treatment.count}`,`Difference: ${stats.difference??'not yet available'} ${trial.unit}`,stats.caution].join('\n');
    return {trial:present(trial),observations:observations.slice(0,q.limit).map(present),nextCursor:observations.length>q.limit?observations[q.limit-1].id:null,summary:stats};
  });
  createRoute(app,ctx,'/trials/:id/observations','farm_trial_observations',z.object({id:uuid,arm:z.enum(['control','treatment']),value:z.number().finite().min(-1e12).max(1e12),observedAt:instant,source,note,mediaIds:z.array(uuid).max(8).default([])}).strict(),{arm:'arm',value:'value',observedAt:'observed_at',source:'source',note:'note',mediaIds:'media_ids'},observers,async(c,b,a,params)=>{
    const {id}=z.object({id:uuid}).parse(params);validateInstant(b.observedAt);
    const trial=requireRow((await c.query('SELECT id,project_id,started_on FROM farm_trials WHERE farm_id=$1 AND id=$2',[a.farmId,id])).rows[0]);
    if(Date.parse(b.observedAt)<Date.parse(trial.started_on))throw new ApiError('observation_before_trial');
    if(b.mediaIds.length){const media=await c.query(`SELECT m.id FROM private_media m JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id
      WHERE m.farm_id=$1 AND m.id=ANY($2::uuid[]) AND a.project_id=$3 AND NOT m.financial AND a.kind<>'cost'
      AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=a.farm_id AND f.receipt_activity_id=a.id)
      AND m.mime_type IN ('image/jpeg','image/png','image/webp')`,[a.farmId,b.mediaIds,trial.project_id]);if(media.rowCount!==new Set(b.mediaIds).size)throw new ApiError('related_record_not_found',404);}
    return {trial_id:id};
  });

  listRoute(app,ctx,'/growing-systems','farm_growing_systems');
  createRoute(app,ctx,'/growing-systems','farm_growing_systems',z.object({id:uuid,name:label,type:z.enum(['hydroponics','aquaponics']),cropProjectId:uuid,fishProjectId:uuid.nullable().optional(),locationId:uuid.nullable().optional(),volumeLitres:z.number().finite().positive().max(1e12).nullable().optional(),notes:note}).strict().refine(b=>b.type!=='aquaponics'||Boolean(b.fishProjectId)),{name:'name',type:'type',cropProjectId:'crop_project_id',fishProjectId:'fish_project_id',locationId:'location_id',volumeLitres:'volume_litres',notes:'notes'},managers,async(c,b,a)=>{
    if((await project(c,a.farmId,b.cropProjectId)).enterprise_type!=='crop')throw new ApiError('crop_project_required');
    if(b.fishProjectId&&!(await project(c,a.farmId,b.fishProjectId)).enterprise_type.startsWith('fish'))throw new ApiError('fish_project_required');
    if(b.locationId)requireRow((await c.query('SELECT id FROM farm_locations WHERE farm_id=$1 AND id=$2',[a.farmId,b.locationId])).rows[0]);
  });
  app.get('/v1/farms/:farmId/growing-systems/:id',async(req,reply)=>{
    const a=await authorize(ctx,req,reply);if(!a)return;const {id}=z.object({id:uuid}).parse(req.params);const q=listQuery.parse(req.query);
    const system=requireRow((await ctx.db.query('SELECT * FROM farm_growing_systems WHERE farm_id=$1 AND id=$2',[a.farmId,id])).rows[0]);
    const rows=(await ctx.db.query('SELECT * FROM farm_water_logs WHERE farm_id=$1 AND system_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[a.farmId,id,q.cursor??null,q.limit+1])).rows;
    return {system:present(system),logs:rows.slice(0,q.limit).map(present),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null};
  });
  const measurement=z.number().finite();
  createRoute(app,ctx,'/growing-systems/:id/logs','farm_water_logs',z.object({id:uuid,observedAt:instant,source,ph:measurement.min(0).max(14).nullable().optional(),ecMsCm:measurement.min(0).max(200).nullable().optional(),temperatureC:measurement.min(-10).max(100).nullable().optional(),dissolvedOxygenMgL:measurement.min(0).max(100).nullable().optional(),ammoniaMgL:measurement.min(0).max(10000).nullable().optional(),nitriteMgL:measurement.min(0).max(10000).nullable().optional(),nitrateMgL:measurement.min(0).max(10000).nullable().optional(),note}).strict().refine(b=>[b.ph,b.ecMsCm,b.temperatureC,b.dissolvedOxygenMgL,b.ammoniaMgL,b.nitriteMgL,b.nitrateMgL].some(value=>value!=null),'Record at least one measurement'),{observedAt:'observed_at',source:'source',ph:'ph',ecMsCm:'ec_ms_cm',temperatureC:'temperature_c',dissolvedOxygenMgL:'dissolved_oxygen_mg_l',ammoniaMgL:'ammonia_mg_l',nitriteMgL:'nitrite_mg_l',nitrateMgL:'nitrate_mg_l',note:'note'},observers,async(c,b,a,params)=>{
    const {id}=z.object({id:uuid}).parse(params);validateInstant(b.observedAt);
    requireRow((await c.query('SELECT id FROM farm_growing_systems WHERE farm_id=$1 AND id=$2',[a.farmId,id])).rows[0]);return {system_id:id};
  });
}
