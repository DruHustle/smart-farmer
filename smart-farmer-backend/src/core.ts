import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError,audit,checkReplay,manageRoles,writeRoles,type Context} from './context.js';
import {sha256} from './security.js';

export const uuid=z.string().uuid();
export const when=z.iso.datetime({offset:true});
const params=z.object({farmId:uuid});
const projectParams=params.extend({projectId:uuid});
export const units=z.enum(['kg','g','l','ml','count','egg','bird','rabbit','fish']);
export const quantity=z.number().finite().min(0).max(1_000_000_000).multipleOf(0.000001);
export const money=z.number().finite().nonnegative().max(1_000_000_000).multipleOf(0.01);
export const currency=z.string().regex(/^[A-Z]{3}$/);
export const enterpriseTypes=z.enum(['crop','broiler','layer','breeder','hatchery','rabbit_breeding','rabbit_growout','fish','fish_nursery']);
const projectInput=z.object({
  id:uuid.optional(),
  name:z.string().trim().min(1).max(100),enterpriseType:enterpriseTypes.default('crop'),
  crop:z.string().trim().min(1).max(80).nullable().default(null),irrigation:z.boolean().default(false),
  plantingDate:z.iso.date().nullable().default(null),variety:z.string().trim().max(100).nullable().default(null),
  objective:z.string().trim().max(200).nullable().default(null),areaHa:z.number().finite().positive().max(1e8).nullable().default(null),
  stage:z.string().trim().max(100).nullable().default(null),asOfDate:z.iso.date().nullable().default(null),
  openingCount:z.number().int().min(0).max(1e9).nullable().default(null),countBasis:z.enum(['unknown','verified','estimated']).default('unknown'),
  details:z.record(z.string().max(80),z.union([z.string().max(1000),z.number().finite(),z.boolean(),z.null()])).default({})
}).strict().superRefine((p,c)=>{
  if(p.enterpriseType==='crop'&&!p.crop)c.addIssue({code:'custom',path:['crop'],message:'crop_required'});
  if(p.enterpriseType==='crop'&&(p.openingCount!==null||p.countBasis!=='unknown'))c.addIssue({code:'custom',path:['openingCount'],message:'not_an_animal_project'});
  if((p.openingCount===null)!==(p.countBasis==='unknown'))c.addIssue({code:'custom',path:['countBasis'],message:'count_basis_required'});
  if(p.openingCount!==null&&!p.asOfDate)c.addIssue({code:'custom',path:['asOfDate'],message:'opening_date_required'});
});
const activityInput=z.object({
  id:uuid,projectId:uuid,kind:z.enum(['work','rain','irrigation','observation','harvest','cost','input_use']),observedAt:when,
  note:z.string().max(4000).default(''),quantity:quantity.nullable().default(null),unit:z.string().trim().min(1).max(40).nullable().default(null),
  stockItemId:uuid.nullable().default(null),amount:money.nullable().default(null),currency:currency.nullable().default(null),
  taskId:uuid.nullable().default(null),taskVersion:z.number().int().positive().nullable().default(null)
}).strict().superRefine((a,c)=>{
  if((a.quantity===null)!==(a.unit===null))c.addIssue({code:'custom',path:['unit'],message:'quantity_unit_pair_required'});
  if((a.amount===null)!==(a.currency===null))c.addIssue({code:'custom',path:['currency'],message:'amount_currency_pair_required'});
  if(['input_use','harvest'].includes(a.kind)&&(!a.stockItemId||!a.quantity))c.addIssue({code:'custom',path:['stockItemId'],message:'stock_and_positive_quantity_required'});
  if(a.stockItemId&&!['input_use','harvest'].includes(a.kind))c.addIssue({code:'custom',path:['stockItemId'],message:'stock_not_supported_for_kind'});
  if(a.kind==='cost'&&a.amount===null)c.addIssue({code:'custom',path:['amount'],message:'cost_amount_required'});
  if(a.amount!==null&&a.kind!=='cost')c.addIssue({code:'custom',path:['amount'],message:'cost_kind_required'});
  if((a.taskId===null)!==(a.taskVersion===null))c.addIssue({code:'custom',path:['taskVersion'],message:'task_version_required'});
});

export function convertQuantity(value:number,from:string,to:string) {
  if(from===to)return value;
  const unitFamilies:Record<string,[string,number]>={kg:['mass',1000],g:['mass',1],l:['volume',1000],ml:['volume',1]};
  const a=unitFamilies[from],b=unitFamilies[to];
  if(!a||!b||a[0]!==b[0])throw new ApiError('incompatible_units',400);
  if(a[1]<b[1]&&Math.round(value*1e6)%(b[1]/a[1])!==0)throw new ApiError('unit_precision_exceeded');
  return Math.round(value*a[1]/b[1]*1e6)/1e6;
}
export async function assertReleaseAllowed(client:pg.PoolClient,farmId:string,projectId:string|null,scope:'sale'|'harvest'|'transfer'='sale') {
  if(!projectId)return;
  // NO KEY UPDATE serializes restriction changes without conflicting with FK key-share locks.
  const p=await client.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,projectId]);
  if(!p.rowCount)throw new ApiError('project_not_found',404);
  const r=await client.query("SELECT id,ends_at FROM treatment_restrictions WHERE farm_id=$1 AND project_id=$2 AND starts_at<=now() AND ends_at>now() AND (scope='all' OR scope=$3) LIMIT 1",[farmId,projectId,scope]);
  if(r.rowCount)throw new ApiError('treatment_restriction',409,{until:r.rows[0].ends_at});
}
export async function stockMovement(client:pg.PoolClient,o:{farmId:string,itemId:string,projectId:string|null,actorId:string,kind:string,quantity:number,unit:string,sourceType:string,sourceId:string,observedAt:string,note?:string,requireProject?:boolean}) {
  const r=await client.query('SELECT * FROM stock_items WHERE farm_id=$1 AND id=$2 FOR UPDATE',[o.farmId,o.itemId]);
  if(!r.rowCount)throw new ApiError('stock_not_found',404);const item=r.rows[0];
  if(o.requireProject&&item.project_id!==o.projectId)throw new ApiError('stock_project_mismatch',409);
  const delta=convertQuantity(o.quantity,o.unit,item.unit);
  if(!['kg','g','l','ml'].includes(item.unit)&&!Number.isInteger(delta))throw new ApiError('whole_count_required');
  if(delta<0&&Number(item.quantity)-Number(item.reserved_quantity)+delta < -0.0000001)throw new ApiError('insufficient_stock',409);
  await client.query('UPDATE stock_items SET quantity=quantity+$3,version=version+1 WHERE farm_id=$1 AND id=$2',[o.farmId,o.itemId,delta]);
  await client.query('INSERT INTO stock_movements(id,farm_id,stock_item_id,project_id,actor_id,kind,quantity,unit,source_type,source_id,observed_at,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),o.farmId,o.itemId,o.projectId,o.actorId,o.kind,delta,item.unit,o.sourceType,o.sourceId,o.observedAt,o.note??'']);
  return {...item,delta};
}
export async function finance(client:pg.PoolClient,o:{farmId:string,projectId:string|null,actorId:string,kind:'expense'|'input_consumption'|'revenue'|'payment',amount:number,currency:string,sourceType:string,sourceId:string,observedAt:string,note?:string}) {
  await client.query('INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[randomUUID(),o.farmId,o.projectId,o.actorId,o.kind,o.amount,o.currency,o.sourceType,o.sourceId,o.observedAt,o.note??'']);
}
const pageQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(100),cursor:uuid.optional()});
function page(rows:Record<string,unknown>[],limit:number) {const hasMore=rows.length>limit;const items=rows.slice(0,limit);return {items,nextCursor:hasMore?items.at(-1)?.id:null};}

export function registerCore(app:FastifyInstance,ctx:Context) {
  const {db,user,member,transaction}=ctx;
  app.get('/v1/farms/:farmId/projects',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);
    const q=pageQuery.parse(req.query);const r=await db.query('SELECT * FROM projects WHERE farm_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM projects WHERE farm_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT $3',[farmId,q.cursor??null,q.limit+1]);return page(r.rows,q.limit);
  });
  app.post('/v1/farms/:farmId/projects',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);const p=projectInput.parse(req.body);const id=p.id??randomUUID(),hash=sha256(JSON.stringify(p));
    const inserted=await db.query('INSERT INTO projects(id,farm_id,name,crop,irrigation,planting_date,variety,objective,area_ha,stage,enterprise_type,as_of_date,opening_count,current_count,count_basis,details,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17) ON CONFLICT(id) DO NOTHING RETURNING id,version',[id,farmId,p.name,p.crop,p.irrigation,p.plantingDate,p.variety,p.objective,p.areaHa,p.stage,p.enterpriseType,p.asOfDate,p.openingCount,p.countBasis,JSON.stringify(p.details),actor,hash]);
    if(inserted.rowCount)return reply.code(201).send(inserted.rows[0]);
    const previous=await db.query('SELECT payload_hash,created_by,version FROM projects WHERE farm_id=$1 AND id=$2',[farmId,id]);if(!previous.rowCount)throw new ApiError('idempotency_conflict',409);checkReplay(previous.rows[0],hash,actor);return {id,version:previous.rows[0].version};
  });
  app.patch('/v1/farms/:farmId/projects/:projectId',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=projectParams.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const p=z.object({version:z.number().int().positive(),reason:z.string().trim().min(1).max(1000),name:z.string().trim().min(1).max(100).optional(),crop:z.string().trim().min(1).max(80).optional(),irrigation:z.boolean().optional(),plantingDate:z.iso.date().nullable().optional(),variety:z.string().max(100).nullable().optional(),objective:z.string().max(200).nullable().optional(),areaHa:z.number().finite().positive().max(1e8).nullable().optional(),stage:z.string().max(100).nullable().optional(),status:z.enum(['active','closed']).optional()}).strict().parse(req.body);
    return transaction(async c=>{
      const r=await c.query('SELECT * FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,projectId]);if(!r.rowCount)throw new ApiError('project_not_found',404);const old=r.rows[0];
      if(old.version!==p.version)throw new ApiError('version_conflict',409,{current:old});
      if(p.status==='closed'&&old.enterprise_type!=='crop')throw new ApiError('animal_close_event_required',409);
      const mapping:Record<string,string>={name:'name',crop:'crop',irrigation:'irrigation',plantingDate:'planting_date',variety:'variety',objective:'objective',areaHa:'area_ha',stage:'stage',status:'status'};
      const values:unknown[]=[farmId,projectId];const assignments:string[]=[];
      for(const [key,col]of Object.entries(mapping))if(key in p){values.push(p[key as keyof typeof p]);assignments.push(`${col}=$${values.length}`);}
      if(!assignments.length)throw new ApiError('no_changes');
      const out=await c.query(`UPDATE projects SET ${assignments.join(',')},version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2 RETURNING *`,values);
      await audit(c,farmId,actor,'project',projectId,'updated',p.reason,old,out.rows[0]);return out.rows[0];
    });
  });
  app.get('/v1/farms/:farmId/activities',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const canFinance=await member(farmId,actor,manageRoles);
    const q=pageQuery.parse(req.query);const r=await db.query('SELECT id,project_id,actor_id,kind,observed_at,recorded_at,note,quantity,unit,stock_item_id,task_id,amount,currency FROM activities WHERE farm_id=$1 AND ($4::boolean OR kind<>\'cost\') AND ($2::uuid IS NULL OR (observed_at,id)<(SELECT observed_at,id FROM activities WHERE farm_id=$1 AND id=$2)) ORDER BY observed_at DESC,id DESC LIMIT $3',[farmId,q.cursor??null,q.limit+1,canFinance]);return page(r.rows,q.limit);
  });
  app.post('/v1/farms/:farmId/activities',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,writeRoles))throw new ApiError('not_found',404);
    const a=activityInput.parse(req.body);if(a.kind==='cost'&&!await member(farmId,actor,manageRoles))throw new ApiError('financial_permission_required',403);
    const hash=sha256(JSON.stringify(a));const outcome=await transaction(async c=>{
      const inserted=await c.query('INSERT INTO activities(id,farm_id,project_id,actor_id,kind,observed_at,note,quantity,unit,payload_hash,stock_item_id,amount,currency,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(farm_id,id) DO NOTHING RETURNING id',[a.id,farmId,a.projectId,actor,a.kind,a.observedAt,a.note,a.quantity,a.unit,hash,a.stockItemId,a.amount,a.currency,a.taskId]);
      if(!inserted.rowCount){const prev=await c.query('SELECT payload_hash,actor_id FROM activities WHERE farm_id=$1 AND id=$2',[farmId,a.id]);checkReplay(prev.rows[0],hash,actor);return false;}
      const pr=await c.query('SELECT * FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,a.projectId]);if(!pr.rowCount)throw new ApiError('project_not_found',404);if(pr.rows[0].status!=='active')throw new ApiError('project_closed',409);
      if(a.kind==='harvest'&&pr.rows[0].enterprise_type!=='crop')throw new ApiError('animal_harvest_event_required',409);
      if(['harvest','input_use'].includes(a.kind)){
        if(a.kind==='harvest')await assertReleaseAllowed(c,farmId,a.projectId,'harvest');
        const item=await stockMovement(c,{farmId,itemId:a.stockItemId!,projectId:a.projectId,actorId:actor,kind:a.kind,quantity:a.kind==='input_use'?-a.quantity!:a.quantity!,unit:a.unit!,sourceType:'activity',sourceId:a.id,observedAt:a.observedAt,requireProject:a.kind==='harvest'});
        if(a.kind==='input_use'&&item.unit_cost!==null)await finance(c,{farmId,projectId:a.projectId,actorId:actor,kind:'input_consumption',amount:Math.round(Math.abs(item.delta)*Number(item.unit_cost)*100)/100,currency:item.currency,sourceType:'activity',sourceId:a.id,observedAt:a.observedAt});
      }
      if(a.kind==='cost')await finance(c,{farmId,projectId:a.projectId,actorId:actor,kind:'expense',amount:a.amount!,currency:a.currency!,sourceType:'activity',sourceId:a.id,observedAt:a.observedAt,note:a.note});
      if(a.taskId){
        const task=await c.query('SELECT * FROM tasks WHERE farm_id=$1 AND id=$2 FOR UPDATE',[farmId,a.taskId]);const t=task.rows[0];if(!t||t.project_id!==a.projectId)throw new ApiError('task_project_mismatch',409);
        if(t.version!==a.taskVersion)throw new ApiError('version_conflict',409,{current:t});if(!await member(farmId,actor,manageRoles)&&t.assignee_id!==actor)throw new ApiError('task_permission_required',403);
        if(t.status==='cancelled'||t.status==='completed')throw new ApiError('task_already_final',409);
        await c.query("UPDATE tasks SET status='completed',evidence=$3,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2",[farmId,a.taskId,`activity:${a.id}`]);await audit(c,farmId,actor,'task',a.taskId,'completed','activity_recorded',t,{activityId:a.id});
      }
      return true;
    });return reply.code(outcome?201:200).send({id:a.id});
  });
  app.get('/v1/farms/:farmId/stock',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const financial=await member(farmId,actor,manageRoles);
    const r=await db.query(`SELECT id,project_id,name,unit,quantity,reserved_quantity,version${financial?',unit_cost,currency':''} FROM stock_items WHERE farm_id=$1 ORDER BY name,id LIMIT 500`,[farmId]);return {items:r.rows};
  });
  app.post('/v1/farms/:farmId/stock',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,name:z.string().trim().min(1).max(100),unit:units,quantity,projectId:uuid.nullable().default(null),unitCost:quantity.nullable().default(null),currency:currency.nullable().default(null)}).strict().refine(b=>(b.unitCost===null)===(b.currency===null),'amount_currency_pair_required').parse(req.body);const hash=sha256(JSON.stringify(b));
    const created=await transaction(async c=>{
      const ins=await c.query('INSERT INTO stock_items(id,farm_id,project_id,name,unit,quantity,unit_cost,currency,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING id',[b.id,farmId,b.projectId,b.name,b.unit,b.quantity,b.unitCost,b.currency,actor,hash]);
      if(!ins.rowCount){const old=await c.query('SELECT payload_hash,created_by FROM stock_items WHERE farm_id=$1 AND id=$2',[farmId,b.id]);if(!old.rowCount)throw new ApiError('idempotency_conflict',409);checkReplay(old.rows[0],hash,actor);return false;}
      await c.query("INSERT INTO stock_movements(id,farm_id,stock_item_id,project_id,actor_id,kind,quantity,unit,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,$5,'opening',$6,$7,'stock_opening',$3,now())",[randomUUID(),farmId,b.id,b.projectId,actor,b.quantity,b.unit]);return true;
    });return reply.code(created?201:200).send({id:b.id});
  });
  app.get('/v1/farms/:farmId/stock/:itemId/movements',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,itemId}=params.extend({itemId:uuid}).parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const r=await db.query('SELECT * FROM stock_movements WHERE farm_id=$1 AND stock_item_id=$2 ORDER BY recorded_at DESC LIMIT 100',[farmId,itemId]);return {items:r.rows};
  });
  app.post('/v1/farms/:farmId/stock/:itemId/movements',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,itemId}=params.extend({itemId:uuid}).parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,kind:z.enum(['purchase','loss','consumption','adjustment']),quantity:z.number().finite().min(-1e9).max(1e9).multipleOf(0.000001).refine(n=>n!==0),unit:units,observedAt:when,reason:z.string().trim().min(1).max(1000),amount:money.nullable().default(null),currency:currency.nullable().default(null)}).strict().refine(b=>(b.amount===null)===(b.currency===null),'amount_currency_pair_required').parse(req.body);
    if(b.kind!=='adjustment'&&b.quantity<0)throw new ApiError('positive_quantity_required');if(b.amount!==null&&b.kind!=='purchase')throw new ApiError('purchase_amount_only');const hash=sha256(JSON.stringify(b));
    const created=await transaction(async c=>{
      const ins=await c.query('INSERT INTO stock_record_requests(id,farm_id,stock_item_id,created_by,payload_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',[b.id,farmId,itemId,actor,hash]);
      if(!ins.rowCount){const prev=await c.query('SELECT * FROM stock_record_requests WHERE farm_id=$1 AND id=$2',[farmId,b.id]);if(!prev.rowCount||prev.rows[0].stock_item_id!==itemId)throw new ApiError('idempotency_conflict',409);checkReplay(prev.rows[0],hash,actor);return false;}
      const item=await c.query('SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2',[farmId,itemId]);if(!item.rowCount)throw new ApiError('stock_not_found',404);const projectId=item.rows[0].project_id;
      if(projectId){await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,projectId]);if(b.kind==='consumption')await assertReleaseAllowed(c,farmId,projectId,'sale');}
      const delta=['loss','consumption'].includes(b.kind)?-b.quantity:b.quantity;
      await stockMovement(c,{farmId,itemId,projectId,actorId:actor,kind:b.kind,quantity:delta,unit:b.unit,sourceType:'stock_record',sourceId:b.id,observedAt:b.observedAt,note:b.reason});
      if(b.amount!==null)await finance(c,{farmId,projectId,actorId:actor,kind:'expense',amount:b.amount,currency:b.currency!,sourceType:'stock_record',sourceId:b.id,observedAt:b.observedAt,note:b.reason});return true;
    });return reply.code(created?201:200).send({id:b.id});
  });
  app.get('/v1/farms/:farmId/tasks',async(req,reply)=>{const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const r=await db.query('SELECT * FROM tasks WHERE farm_id=$1 ORDER BY due_at ASC NULLS LAST,created_at DESC LIMIT 500',[farmId]);return {items:r.rows};});
  app.post('/v1/farms/:farmId/tasks',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,title:z.string().trim().min(1).max(200),projectId:uuid.nullable().default(null),assigneeId:uuid.nullable().default(null),dueAt:when.nullable().default(null),instructions:z.string().max(4000).default('')}).strict().parse(req.body);const hash=sha256(JSON.stringify(b));
    const r=await db.query('INSERT INTO tasks(id,farm_id,project_id,title,instructions,assignee_id,due_at,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id',[b.id,farmId,b.projectId,b.title,b.instructions,b.assigneeId,b.dueAt,actor,hash]);
    if(!r.rowCount){const p=await db.query('SELECT payload_hash,created_by FROM tasks WHERE farm_id=$1 AND id=$2',[farmId,b.id]);if(!p.rowCount)throw new ApiError('idempotency_conflict',409);checkReplay(p.rows[0],hash,actor);}return reply.code(r.rowCount?201:200).send({id:b.id,version:1});
  });
  app.patch('/v1/farms/:farmId/tasks/:taskId',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,taskId}=params.extend({taskId:uuid}).parse(req.params);if(!await member(farmId,actor,writeRoles))throw new ApiError('not_found',404);
    const b=z.object({version:z.number().int().positive(),status:z.enum(['planned','started','completed','blocked','cancelled']).optional(),evidence:z.string().max(4000).optional(),reason:z.string().max(1000).optional(),assigneeId:uuid.nullable().optional(),dueAt:when.nullable().optional(),instructions:z.string().max(4000).optional(),title:z.string().trim().min(1).max(200).optional()}).strict().parse(req.body);const manager=await member(farmId,actor,manageRoles);
    return transaction(async c=>{
      const r=await c.query('SELECT * FROM tasks WHERE farm_id=$1 AND id=$2 FOR UPDATE',[farmId,taskId]);if(!r.rowCount)throw new ApiError('not_found',404);const old=r.rows[0];if(old.version!==b.version)throw new ApiError('version_conflict',409,{current:old});
      if(!manager&&(old.assignee_id!==actor||['assigneeId','dueAt','instructions','title'].some(k=>k in b)))throw new ApiError('task_permission_required',403);
      if(b.status==='completed'&&!b.evidence?.trim())throw new ApiError('completion_evidence_required');
      if((b.status==='blocked'||b.status==='cancelled'||b.dueAt!==undefined)&&!b.reason?.trim())throw new ApiError('change_reason_required');
      if(['completed','cancelled'].includes(old.status)&&(!manager||!b.reason?.trim()))throw new ApiError('task_final',409);
      const r2=await c.query('UPDATE tasks SET status=$3,evidence=$4,reason=$5,assignee_id=$6,due_at=$7,instructions=$8,title=$9,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2 RETURNING *',[farmId,taskId,b.status??old.status,b.evidence??old.evidence,b.reason??old.reason,b.assigneeId===undefined?old.assignee_id:b.assigneeId,b.dueAt===undefined?old.due_at:b.dueAt,b.instructions??old.instructions,b.title??old.title]);
      await audit(c,farmId,actor,'task',taskId,'updated',b.reason??'task_progress',old,r2.rows[0]);return r2.rows[0];
    });
  });
  app.get('/v1/farms/:farmId/incidents',async(req,reply)=>{const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const r=await db.query('SELECT * FROM incidents WHERE farm_id=$1 ORDER BY created_at DESC LIMIT 200',[farmId]);return {items:r.rows};});
  app.post('/v1/farms/:farmId/incidents',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,writeRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,projectId:uuid.nullable().default(null),title:z.string().trim().min(1).max(200),description:z.string().max(4000).default(''),severity:z.enum(['low','medium','high','urgent']),assigneeId:uuid.nullable().default(null)}).strict().parse(req.body);if(b.assigneeId&&!await member(farmId,actor,manageRoles))throw new ApiError('assignment_permission_required',403);const hash=sha256(JSON.stringify(b));
    const r=await db.query('INSERT INTO incidents(id,farm_id,project_id,title,description,severity,assignee_id,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id',[b.id,farmId,b.projectId,b.title,b.description,b.severity,b.assigneeId,actor,hash]);
    if(!r.rowCount){const p=await db.query('SELECT payload_hash,created_by FROM incidents WHERE farm_id=$1 AND id=$2',[farmId,b.id]);if(!p.rowCount)throw new ApiError('idempotency_conflict',409);checkReplay(p.rows[0],hash,actor);}return reply.code(r.rowCount?201:200).send({id:b.id,version:1});
  });
  app.patch('/v1/farms/:farmId/incidents/:incidentId',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,incidentId}=params.extend({incidentId:uuid}).parse(req.params);if(!await member(farmId,actor,writeRoles))throw new ApiError('not_found',404);
    const b=z.object({version:z.number().int().positive(),status:z.enum(['open','acknowledged','resolved']),note:z.string().max(4000).default(''),assigneeId:uuid.nullable().optional()}).strict().parse(req.body);const manager=await member(farmId,actor,manageRoles);
    return transaction(async c=>{
      const r=await c.query('SELECT * FROM incidents WHERE farm_id=$1 AND id=$2 FOR UPDATE',[farmId,incidentId]);if(!r.rowCount)throw new ApiError('not_found',404);const old=r.rows[0];if(old.version!==b.version)throw new ApiError('version_conflict',409,{current:old});
      if(!manager&&(old.assignee_id!==actor&&old.created_by!==actor||b.assigneeId!==undefined))throw new ApiError('incident_permission_required',403);if(b.status==='resolved'&&!b.note.trim())throw new ApiError('resolution_note_required');
      const next=await c.query('UPDATE incidents SET status=$3,note=$4,assignee_id=$5,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2 RETURNING *',[farmId,incidentId,b.status,b.note,b.assigneeId===undefined?old.assignee_id:b.assigneeId]);await audit(c,farmId,actor,'incident',incidentId,b.status,b.note||'incident_progress',old,next.rows[0]);return next.rows[0];
    });
  });
  app.get('/v1/farms/:farmId/reports',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const q=z.object({projectId:uuid.optional()}).parse(req.query);
    const totals=await db.query('SELECT currency,kind,sum(amount)::text AS amount FROM financial_entries WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) GROUP BY currency,kind ORDER BY currency,kind',[farmId,q.projectId??null]);
    const stock=await db.query('SELECT id,name,quantity,reserved_quantity,unit,unit_cost,currency FROM stock_items WHERE farm_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY name',[farmId,q.projectId??null]);
    const missing=await db.query("SELECT count(*)::int AS count FROM stock_movements m JOIN stock_items s ON s.farm_id=m.farm_id AND s.id=m.stock_item_id WHERE m.farm_id=$1 AND ($2::uuid IS NULL OR m.project_id=$2) AND m.kind IN ('input_use','feed') AND s.unit_cost IS NULL",[farmId,q.projectId??null]);
    const allocations=await db.query('SELECT source_project_id,destination_project_id,currency,sum(amount)::text AS amount FROM project_cost_transfers WHERE farm_id=$1 AND ($2::uuid IS NULL OR source_project_id=$2 OR destination_project_id=$2) GROUP BY source_project_id,destination_project_id,currency',[farmId,q.projectId??null]);
    return {totals:totals.rows,stock:stock.rows,costTransfers:allocations.rows,unpricedInputMovements:missing.rows[0].count,profit:null,completeness:'not_asserted',paymentProvider:'unconfigured',generatedAt:new Date().toISOString()};
  });
  app.get('/v1/farms/:farmId/projects/:projectId/ledger',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=projectParams.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);const r=await db.query('SELECT id,kind,amount,currency,source_type,source_id,observed_at,note FROM financial_entries WHERE farm_id=$1 AND project_id=$2 ORDER BY observed_at DESC LIMIT 500',[farmId,projectId]);return {items:r.rows};
  });
  app.post('/v1/farms/:farmId/projects/:projectId/payments',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=projectParams.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,revenueId:uuid,amount:money.refine(v=>v>0),currency,observedAt:when,note:z.string().max(1000).default('')}).strict().parse(req.body);const hash=sha256(JSON.stringify(b));
    const created=await transaction(async c=>{
      const r=await c.query("SELECT * FROM financial_entries WHERE farm_id=$1 AND project_id=$2 AND id=$3 AND kind='revenue' AND source_type='animal_event' FOR UPDATE",[farmId,projectId,b.revenueId]);if(!r.rowCount)throw new ApiError('animal_revenue_not_found',404);const revenue=r.rows[0];
      const prior=await c.query('SELECT * FROM manual_payment_records WHERE id=$1',[b.id]);if(prior.rowCount){if(prior.rows[0].farm_id!==farmId||prior.rows[0].revenue_id!==b.revenueId)throw new ApiError('idempotency_conflict',409);checkReplay(prior.rows[0],hash,actor);return false;}
      if(revenue.currency!==b.currency)throw new ApiError('currency_mismatch',409);const paid=await c.query('SELECT coalesce(sum(amount),0) AS amount FROM manual_payment_records WHERE revenue_id=$1',[b.revenueId]);if(Math.round((Number(paid.rows[0].amount)+b.amount)*100)>Math.round(Number(revenue.amount)*100))throw new ApiError('payment_exceeds_balance',409);
      await c.query('INSERT INTO manual_payment_records(id,farm_id,revenue_id,created_by,amount,currency,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[b.id,farmId,b.revenueId,actor,b.amount,b.currency,hash]);await finance(c,{farmId,projectId,actorId:actor,kind:'payment',amount:b.amount,currency:b.currency,sourceType:'manual_animal_payment',sourceId:b.id,observedAt:b.observedAt,note:b.note});return true;
    });return reply.code(created?201:200).send({id:b.id,provenance:'manual',providerVerified:false});
  });
  app.get('/v1/farms/:farmId/reports.csv',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);const lang=z.object({language:z.enum(['sn','nd']).default('sn')}).parse(req.query).language;
    const r=await db.query('SELECT kind,amount,currency,observed_at,source_type FROM financial_entries WHERE farm_id=$1 ORDER BY observed_at LIMIT 10000',[farmId]);const escape=(v:unknown)=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    const headers=lang==='sn'?['Rudzi','Mari','Rudzi rwemari','Nguva yakaonekwa','Kwakabva']:['Uhlobo','Inani lemali','Uhlobo lwemali','Isikhathi sokubona','Umthombo'];
    const text=[headers.map(escape).join(','),...r.rows.map(a=>[a.kind,a.amount,a.currency,new Date(a.observed_at).toISOString(),a.source_type].map(escape).join(','))].join('\r\n');reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="smart-farmer-records.csv"').header('Cache-Control','no-store');return '\uFEFF'+text;
  });
  app.get('/v1/farms/:farmId/projects/:projectId/companion',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=projectParams.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const p=await db.query('SELECT * FROM projects WHERE farm_id=$1 AND id=$2',[farmId,projectId]);if(!p.rowCount)throw new ApiError('project_not_found',404);
    const tasks=await db.query("SELECT id,title,due_at,status FROM tasks WHERE farm_id=$1 AND project_id=$2 AND status NOT IN ('completed','cancelled') ORDER BY due_at NULLS LAST LIMIT 10",[farmId,projectId]);
    const missing=p.rows[0].enterprise_type==='crop'?['planting_date','variety','area_ha','stage'].filter(k=>p.rows[0][k]===null):['as_of_date','current_count'].filter(k=>p.rows[0][k]===null);
    return {mode:'record_based',provider:'unconfigured',projectId,missingFields:missing,nextTasks:tasks.rows,ruleVersion:'record-review-1',recommendationsAreCompletedWork:false};
  });
}
