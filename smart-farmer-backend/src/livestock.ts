import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError,audit,checkReplay,manageRoles,writeRoles,type Context} from './context.js';
import {uuid,when,quantity,money,currency,stockMovement,finance,assertReleaseAllowed} from './core.js';
import {sha256} from './security.js';
import {propagateRestrictions} from './product/restrictions.js';
import {reconcileAnimalReservations} from './product/market-ledger.js';
import {listQuery,page} from './product/common.js';

const params=z.object({farmId:uuid,projectId:uuid});
const eventTypes=z.enum(['acquisition','mortality','transfer','sale','egg_collection','egg_consumption','egg_loss','egg_sale','incubation','hatch','mating','kindling','fostering','weaning','stocking','water_observation','growth_sample','harvest','feed','observation','care','adjustment','close','spawning','fish_hatch','egg_disposition']);
const eventInput=z.object({id:uuid,type:eventTypes,observedAt:when,historicalOnly:z.boolean().default(false),count:z.number().int().nonnegative().max(1e9).nullable().default(null),destinationProjectId:uuid.nullable().default(null),stockItemId:uuid.nullable().default(null),quantity:quantity.nullable().default(null),unit:z.string().trim().min(1).max(40).nullable().default(null),amount:money.nullable().default(null),currency:currency.nullable().default(null),note:z.string().max(4000).default(''),metadata:z.record(z.string(),z.unknown()).default({})}).strict().superRefine((e,c)=>{
  if(JSON.stringify(e.metadata).length>8192)c.addIssue({code:'custom',path:['metadata'],message:'metadata_too_large'});
  if((e.quantity===null)!==(e.unit===null))c.addIssue({code:'custom',path:['unit'],message:'quantity_unit_pair_required'});
  if((e.amount===null)!==(e.currency===null))c.addIssue({code:'custom',path:['currency'],message:'amount_currency_pair_required'});
});
type Event=z.infer<typeof eventInput>;
function requireCount(e:Event) {if(e.count===null||e.count<=0)throw new ApiError('positive_count_required');return e.count;}
function knownCount(p:Record<string,unknown>) {if(p.current_count===null)throw new ApiError('opening_count_required',409);return Number(p.current_count);}
function family(type:string) {if(['broiler','layer','breeder','hatchery'].includes(type))return 'chicken';if(type.startsWith('rabbit_'))return 'rabbit';if(type.startsWith('fish'))return 'fish';return 'crop';}


export function registerLivestock(app:FastifyInstance,ctx:Context) {
  const {db,user,member,transaction}=ctx;
  app.get('/v1/farms/:farmId/projects/:projectId/events',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);
    const p=await db.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2',[farmId,projectId]);if(!p.rowCount)throw new ApiError('project_not_found',404);
    const q=listQuery.parse(req.query);const r=await db.query('SELECT id,project_id,actor_id,type,observed_at,recorded_at,count,destination_project_id,stock_item_id,quantity,unit,note,metadata,historical_only FROM animal_events WHERE farm_id=$1 AND (project_id=$2 OR destination_project_id=$2) AND ($3::uuid IS NULL OR (observed_at,id)<(SELECT observed_at,id FROM animal_events WHERE farm_id=$1 AND id=$3)) ORDER BY observed_at DESC,id DESC LIMIT $4',[farmId,projectId,q.cursor??null,q.limit+1]);
    if(!await member(farmId,actor,manageRoles))for(const row of r.rows){delete row.metadata.costAllocations;delete row.metadata.amount;delete row.metadata.currency;}
    return page(r.rows,q.limit);
  });
  app.post('/v1/farms/:farmId/projects/:projectId/events',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor,[...writeRoles,'adviser']))throw new ApiError('not_found',404);const e=eventInput.parse(req.body);if(await member(farmId,actor,['adviser'])&&(!['observation','care','water_observation','growth_sample'].includes(e.type)||e.count!==null||e.destinationProjectId!==null||e.stockItemId!==null||e.amount!==null||e.historicalOnly||e.metadata.costAllocations!==undefined||e.metadata.identityIds!==undefined||e.metadata.followUpAt!==undefined))throw new ApiError('adviser_observation_only',403);
    if((e.historicalOnly||['sale','egg_sale','adjustment','close'].includes(e.type))&&!await member(farmId,actor,manageRoles))throw new ApiError('management_permission_required',403);
    if((e.amount!==null||e.metadata.costAllocations!==undefined)&&!await member(farmId,actor,manageRoles))throw new ApiError('financial_permission_required',403);
    if(e.destinationProjectId===projectId)throw new ApiError('same_project_transfer');
    const hash=sha256(JSON.stringify(e));const created=await transaction(async c=>{
      const inserted=await c.query('INSERT INTO animal_events(id,farm_id,project_id,actor_id,type,observed_at,count,destination_project_id,stock_item_id,quantity,unit,note,metadata,payload_hash,historical_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING RETURNING id',[e.id,farmId,projectId,actor,e.type,e.observedAt,e.count,e.destinationProjectId,e.stockItemId,e.quantity,e.unit,e.note,JSON.stringify(e.metadata),hash,e.historicalOnly]);
      if(!inserted.rowCount){const prior=await c.query('SELECT payload_hash,actor_id,project_id FROM animal_events WHERE farm_id=$1 AND id=$2',[farmId,e.id]);if(!prior.rowCount||prior.rows[0].project_id!==projectId)throw new ApiError('idempotency_conflict',409);checkReplay(prior.rows[0],hash,actor);return false;}
      const projectIds=[projectId,...(e.destinationProjectId?[e.destinationProjectId]:[])];
      let eggSourceId:string|null=null;
      if(['incubation','feed'].includes(e.type)&&e.stockItemId){const s=await c.query('SELECT project_id FROM stock_items WHERE farm_id=$1 AND id=$2',[farmId,e.stockItemId]);eggSourceId=s.rows[0]?.project_id??null;if(eggSourceId)projectIds.push(eggSourceId);}
      const projects=await c.query('SELECT * FROM projects WHERE farm_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE',[farmId,[...new Set(projectIds)]]);
      const p=projects.rows.find(x=>x.id===projectId),dest=projects.rows.find(x=>x.id===e.destinationProjectId);
      if(!p)throw new ApiError('project_not_found',404);if(p.enterprise_type==='crop')throw new ApiError('animal_project_required');
      const beforeOpening=p.as_of_date&&(await c.query('SELECT ($1::timestamptz AT TIME ZONE f.timezone)::date < $2::date AS value FROM farms f WHERE f.id=$3',[e.observedAt,p.as_of_date,farmId])).rows[0].value;
      if(e.historicalOnly){if(!beforeOpening)throw new ApiError('historical_record_requires_preopening_date');if(e.amount!==null||e.metadata.costAllocations!==undefined||e.metadata.followUpAt!==undefined)throw new ApiError('historical_record_has_no_current_effects');z.object({historySource:z.string().trim().min(1).max(2000)}).parse(e.metadata);if(e.destinationProjectId&&(!dest||family(p.enterprise_type)!==family(dest.enterprise_type)))throw new ApiError('invalid_destination',409);if(['acquisition','mortality','transfer','sale','egg_collection','egg_consumption','egg_loss','egg_sale','incubation','hatch','kindling','fostering','weaning','stocking','harvest','adjustment','spawning','fish_hatch','egg_disposition'].includes(e.type)&&e.count===null)throw new ApiError('count_required');await audit(c,farmId,actor,'animal_event',e.id,'historical_record',String(e.metadata.historySource),null,{type:e.type,observedAt:e.observedAt,count:e.count,historicalOnly:true});return true;}
      if(p.status!=='active')throw new ApiError('project_closed',409);
      if(e.destinationProjectId&&(!dest||dest.enterprise_type==='crop'||dest.status!=='active'))throw new ApiError('invalid_destination',409);
      if(dest&&family(p.enterprise_type)!==family(dest.enterprise_type))throw new ApiError('species_mismatch',409);
      if(e.destinationProjectId&&!['transfer','hatch','kindling','fostering','weaning','spawning','fish_hatch'].includes(e.type))throw new ApiError('unexpected_destination');
      const next={count:p.current_count===null?null:Number(p.current_count),basis:p.count_basis};let destDelta=0;
      const decrease=(n:number)=>{const current=knownCount(p);if(current<n)throw new ApiError('insufficient_animals',409);if(!['mortality','egg_disposition'].includes(e.type)&&current-Number(p.reserved_count??0)<n)throw new ApiError('animals_reserved',409);next.count=current-n;};
      const increase=(n:number)=>{next.count=knownCount(p)+n;};
      if(['acquisition','stocking'].includes(e.type)){
        if(e.type==='stocking'&&!p.enterprise_type.startsWith('fish'))throw new ApiError('fish_project_required');
        increase(requireCount(e));
        if(e.amount!==null)await finance(c,{farmId,projectId,actorId:actor,kind:'expense',amount:e.amount,currency:e.currency!,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt,note:e.note});
      }else if(e.type==='mortality'){decrease(requireCount(e));if(!e.note.trim())throw new ApiError('mortality_note_required');
      }else if(['transfer','fostering','weaning'].includes(e.type)){
        if(!dest)throw new ApiError('destination_required');
        if(['fostering','weaning'].includes(e.type)&&family(p.enterprise_type)!=='rabbit')throw new ApiError('rabbit_project_required');
        if(['hatchery','fish_hatchery'].includes(p.enterprise_type)||['hatchery','fish_hatchery'].includes(dest.enterprise_type))throw new ApiError('use_incubation_or_hatch');
        const n=requireCount(e);decrease(n);knownCount(dest);destDelta=n;
        await assertReleaseAllowed(c,farmId,projectId,'transfer');
      }else if(e.type==='sale'){
        await assertReleaseAllowed(c,farmId,projectId,'sale');decrease(requireCount(e));
        if(e.amount===null)throw new ApiError('sale_amount_required');await finance(c,{farmId,projectId,actorId:actor,kind:'revenue',amount:e.amount,currency:e.currency!,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt,note:e.note});
      }else if(e.type==='egg_collection'){
        if(!['layer','breeder'].includes(p.enterprise_type))throw new ApiError('egg_project_required');
        if(e.count===null)throw new ApiError('count_required');const total=e.count,rejects=z.number().int().nonnegative().max(total).parse(e.metadata.rejects??0);if(!e.stockItemId)throw new ApiError('egg_stock_required');
        const item=await stockMovement(c,{farmId,itemId:e.stockItemId,projectId,actorId:actor,kind:'egg_collection',quantity:total-rejects,unit:'egg',sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt,requireProject:true});if(item.unit!=='egg')throw new ApiError('egg_stock_required');
      }else if(['egg_consumption','egg_loss','egg_sale'].includes(e.type)){
        if(!['layer','breeder'].includes(p.enterprise_type))throw new ApiError('egg_project_required');if(!e.stockItemId)throw new ApiError('egg_stock_required');
        if(e.type!=='egg_loss')await assertReleaseAllowed(c,farmId,projectId,'sale');
        const item=await stockMovement(c,{farmId,itemId:e.stockItemId,projectId,actorId:actor,kind:e.type,quantity:-requireCount(e),unit:'egg',sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt,requireProject:true});if(item.unit!=='egg')throw new ApiError('egg_stock_required');
        if(e.type==='egg_sale'){if(e.amount===null)throw new ApiError('sale_amount_required');await finance(c,{farmId,projectId,actorId:actor,kind:'revenue',amount:e.amount,currency:e.currency!,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt});}
      }else if(e.type==='incubation'){
        if(p.enterprise_type!=='hatchery')throw new ApiError('hatchery_required');if(!e.stockItemId)throw new ApiError('egg_stock_required');
        const n=requireCount(e);increase(n);if(eggSourceId)await assertReleaseAllowed(c,farmId,eggSourceId,'transfer');
        const item=await stockMovement(c,{farmId,itemId:e.stockItemId,projectId,actorId:actor,kind:'incubation',quantity:-n,unit:'egg',sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt});if(item.unit!=='egg')throw new ApiError('egg_stock_required');
        if(eggSourceId)await propagateRestrictions(c,farmId,eggSourceId,projectId,actor);
        if(item.unit_cost!==null)await finance(c,{farmId,projectId,actorId:actor,kind:'input_consumption',amount:Math.round(n*Number(item.unit_cost)*100)/100,currency:item.currency,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt});
      }else if(e.type==='hatch'){
        if(p.enterprise_type!=='hatchery'||e.count===null)throw new ApiError('hatchery_required');
        const n=e.count;if(n>0&&(!dest||!['broiler','layer','breeder'].includes(dest.enterprise_type)))throw new ApiError('chick_destination_required');
        const processed=z.number().int().min(Math.max(1,n)).max(1e9).parse(e.metadata.eggsProcessed);decrease(processed);if(dest)knownCount(dest);destDelta=n;if(n>0)await assertReleaseAllowed(c,farmId,projectId,'transfer');
      }else if(e.type==='spawning'){
        if(p.enterprise_type!=='fish_breeder'||!dest||dest.enterprise_type!=='fish_hatchery')throw new ApiError('fish_hatchery_destination_required');
        const n=requireCount(e);knownCount(p);knownCount(dest);const m=z.object({eggCountBasis:z.enum(['verified','estimated']),source:z.string().trim().min(1).max(1000),damId:uuid.optional(),sireId:uuid.optional()}).parse(e.metadata);
        for(const [id,sex]of [[m.damId,'female'],[m.sireId,'male']])if(id){const animal=(await c.query("SELECT a.id FROM animal_identities a JOIN projects p ON p.id=a.project_id WHERE a.farm_id=$1 AND a.id=$2 AND a.sex=$3 AND a.status='active' AND p.enterprise_type='fish_breeder'",[farmId,id,sex])).rows[0];if(!animal)throw new ApiError('invalid_parents');}
        await assertReleaseAllowed(c,farmId,projectId,'transfer');destDelta=n;if(m.eggCountBasis==='estimated')await c.query("UPDATE projects SET count_basis='estimated' WHERE id=$1",[dest.id]);
      }else if(e.type==='fish_hatch'){
        if(p.enterprise_type!=='fish_hatchery'||e.count===null)throw new ApiError('fish_hatchery_required');const n=e.count;if(n>0&&(!dest||dest.enterprise_type!=='fish_nursery'))throw new ApiError('fry_destination_required');const m=z.object({eggsProcessed:z.number().int().min(Math.max(1,n)).max(1e9),source:z.string().trim().min(1).max(1000)}).parse(e.metadata);decrease(m.eggsProcessed);if(dest)knownCount(dest);destDelta=n;if(n>0)await assertReleaseAllowed(c,farmId,projectId,'transfer');
      }else if(e.type==='egg_disposition'){
        if(!['hatchery','fish_hatchery'].includes(p.enterprise_type))throw new ApiError('hatchery_required');z.object({disposition:z.enum(['loss','discard','test']),source:z.string().trim().min(1).max(1000)}).parse(e.metadata);if(!e.note.trim())throw new ApiError('egg_disposition_note_required');decrease(requireCount(e));
      }else if(e.type==='mating'){
        if(p.enterprise_type!=='rabbit_breeding')throw new ApiError('rabbit_breeding_required');
        const m=z.object({damId:uuid,sireId:uuid,followUpAt:when.optional()}).parse(e.metadata);if(m.damId===m.sireId)throw new ApiError('invalid_parents');
        const ids=await c.query('SELECT id,sex,project_id,status FROM animal_identities WHERE farm_id=$1 AND id=ANY($2::uuid[])',[farmId,[m.damId,m.sireId]]);const dam=ids.rows.find(i=>i.id===m.damId),sire=ids.rows.find(i=>i.id===m.sireId);
        if(!dam||!sire||dam.sex!=='female'||sire.sex!=='male'||dam.project_id!==projectId||dam.status!=='active'||sire.status!=='active')throw new ApiError('invalid_parents');
        if(m.followUpAt){const u=await c.query('SELECT language FROM users WHERE id=$1',[actor]);const title=u.rows[0].language==='nd'?'Ukuhlola okulandelayo konogwaja':'Kuongorora tsuro zvakare';await c.query('INSERT INTO tasks(id,farm_id,project_id,title,due_at,created_by,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),farmId,projectId,title,m.followUpAt,actor,hash]);}
      }else if(e.type==='kindling'){
        if(p.enterprise_type!=='rabbit_breeding'||e.count===null)throw new ApiError('rabbit_breeding_required');if(e.count>0&&(!dest||dest.enterprise_type!=='rabbit_growout'))throw new ApiError('litter_destination_required');
        const m=z.object({matingEventId:uuid,stillborn:z.number().int().nonnegative().default(0)}).parse(e.metadata);const mate=await c.query("SELECT id FROM animal_events WHERE farm_id=$1 AND project_id=$2 AND id=$3 AND type='mating'",[farmId,projectId,m.matingEventId]);if(!mate.rowCount)throw new ApiError('mating_record_required');
        const duplicate=await c.query("SELECT id FROM animal_events WHERE farm_id=$1 AND type='kindling' AND metadata->>'matingEventId'=$2 AND id<>$3",[farmId,m.matingEventId,e.id]);if(duplicate.rowCount)throw new ApiError('kindling_already_recorded',409);
        const n=e.count;if(n+m.stillborn===0)throw new ApiError('birth_count_required');if(dest)knownCount(dest);destDelta=n;
      }else if(e.type==='feed'){
        if(!e.stockItemId||!e.quantity||!e.unit)throw new ApiError('feed_quantity_required');if(eggSourceId&&eggSourceId!==projectId){await assertReleaseAllowed(c,farmId,eggSourceId,'transfer');await propagateRestrictions(c,farmId,eggSourceId,projectId,actor);}
        const item=await stockMovement(c,{farmId,itemId:e.stockItemId,projectId,actorId:actor,kind:'feed',quantity:-e.quantity,unit:e.unit,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt});
        if(item.unit_cost!==null)await finance(c,{farmId,projectId,actorId:actor,kind:'input_consumption',amount:Math.round(Math.abs(item.delta)*Number(item.unit_cost)*100)/100,currency:item.currency,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt});
      }else if(e.type==='harvest'){
        if(!['broiler','rabbit_growout','fish','fish_nursery'].includes(p.enterprise_type))throw new ApiError('harvest_project_required');if(!e.stockItemId||!e.quantity||!e.unit)throw new ApiError('harvest_quantity_required');
        await assertReleaseAllowed(c,farmId,projectId,'harvest');decrease(requireCount(e));await stockMovement(c,{farmId,itemId:e.stockItemId,projectId,actorId:actor,kind:'harvest',quantity:e.quantity,unit:e.unit,sourceType:'animal_event',sourceId:e.id,observedAt:e.observedAt,requireProject:true});
      }else if(e.type==='water_observation'){
        if(!p.enterprise_type.startsWith('fish'))throw new ApiError('fish_project_required');z.object({measurement:z.string().min(1).max(100),value:z.number().finite(),unit:z.string().min(1).max(40),source:z.string().min(1).max(200),testType:z.string().max(200).optional(),calibration:z.string().max(200).optional()}).parse(e.metadata);
      }else if(e.type==='growth_sample'){
        const m=z.object({sampleSize:z.number().int().positive(),measurementBasis:z.enum(['mean_weight','total_sample_weight'])}).parse(e.metadata);if(!e.quantity||!['kg','g'].includes(e.unit??''))throw new ApiError('sample_weight_required');if(p.current_count!==null&&m.sampleSize>Number(p.current_count))throw new ApiError('sample_exceeds_stock');
      }else if(e.type==='care'){
        z.object({authorizedBy:z.string().trim().min(1).max(200),administeredBy:z.string().trim().min(1).max(200),instructionsSource:z.string().trim().min(1).max(1000)}).parse(e.metadata);if(!e.note.trim())throw new ApiError('care_note_required');
      }else if(e.type==='adjustment'){
        if(e.count===null)throw new ApiError('count_required');const m=z.object({reason:z.string().trim().min(1).max(1000),countBasis:z.enum(['verified','estimated'])}).parse(e.metadata);next.count=e.count;next.basis=m.countBasis;await audit(c,farmId,actor,'project',projectId,'count_adjusted',m.reason,{count:p.current_count,countBasis:p.count_basis},{count:e.count,countBasis:m.countBasis});
      }else if(e.type==='close'){
        if(knownCount(p)!==0)throw new ApiError('remaining_animals',409);if(!e.note.trim())throw new ApiError('closure_note_required');await c.query("UPDATE projects SET status='closed' WHERE farm_id=$1 AND id=$2",[farmId,projectId]);
      }
      if(beforeOpening&&['acquisition','mortality','transfer','sale','egg_collection','egg_consumption','egg_loss','egg_sale','incubation','hatch','kindling','fostering','weaning','stocking','harvest','feed','adjustment','close','spawning','fish_hatch','egg_disposition'].includes(e.type))throw new ApiError('historical_record_required',409);
      if(e.amount!==null&&!['acquisition','stocking','sale','egg_sale'].includes(e.type))throw new ApiError('money_not_supported_for_event');
      if(next.count!==null&&next.count>1e9)throw new ApiError('count_limit');
      if(next.count!==null&&['mortality','adjustment'].includes(e.type))await reconcileAnimalReservations(c,farmId,projectId,next.count,z.array(uuid).max(500).parse(e.metadata.identityIds??[]),actor);
      await c.query('UPDATE projects SET current_count=$3,count_basis=$4,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2',[farmId,projectId,next.count,next.basis]);
      if(dest&&destDelta){if(Number(dest.current_count)+destDelta>1e9)throw new ApiError('count_limit');await c.query("UPDATE projects SET current_count=current_count+$3,count_basis=CASE WHEN $4='estimated' THEN 'estimated' ELSE count_basis END,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2",[farmId,dest.id,destDelta,p.count_basis]);await propagateRestrictions(c,farmId,projectId,dest.id,actor);
        const allocations=z.array(z.object({amount:money,currency,basis:z.string().trim().min(1).max(1000)})).max(20).parse(e.metadata.costAllocations??[]);if(new Set(allocations.map(a=>a.currency)).size!==allocations.length)throw new ApiError('duplicate_allocation_currency');
        for(const a of allocations)await c.query('INSERT INTO project_cost_transfers(id,farm_id,event_id,source_project_id,destination_project_id,amount,currency,basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),farmId,e.id,projectId,dest.id,a.amount,a.currency,a.basis]);
      }
      const versions=(await c.query('SELECT id,version FROM projects WHERE farm_id=$1 AND id=ANY($2::uuid[])',[farmId,[projectId,...(dest&&destDelta?[dest.id]:[])]] )).rows;await c.query('UPDATE animal_events SET source_project_version=$2,destination_project_version=$3 WHERE id=$1',[e.id,versions.find(x=>x.id===projectId)!.version,dest&&destDelta?versions.find(x=>x.id===dest.id)!.version:null]);
      const identityIds=z.array(uuid).max(500).parse(e.metadata.identityIds??[]);
      if(identityIds.length){
        if(!['transfer','fostering','weaning','sale','mortality','harvest'].includes(e.type)||identityIds.length!==e.count||new Set(identityIds).size!==identityIds.length)throw new ApiError('identity_count_mismatch');
        if(!['mortality'].includes(e.type)&&(await c.query('SELECT 1 FROM animal_market_reservations WHERE identity_id=ANY($1::uuid[])',[identityIds])).rowCount)throw new ApiError('animal_identity_reserved',409);
        const ids=await c.query("SELECT id FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) AND status='active' FOR UPDATE",[farmId,projectId,identityIds]);if(ids.rowCount!==identityIds.length)throw new ApiError('animal_identity_not_found',404);
        if(dest)await c.query('UPDATE animal_identities SET project_id=$4 WHERE farm_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[farmId,projectId,identityIds,dest.id]);else await c.query('UPDATE animal_identities SET status=$4 WHERE farm_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[farmId,projectId,identityIds,e.type==='sale'?'sold':e.type==='harvest'?'harvested':'dead']);
      }
      if(next.count!==null){const active=await c.query("SELECT count(*)::int AS count FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND status='active'",[farmId,projectId]);if(active.rows[0].count>next.count)throw new ApiError('animal_identity_selection_required',409);}
      return true;
    });return reply.code(created?201:200).send({id:e.id});
  });
  app.get('/v1/farms/:farmId/projects/:projectId/animals',async(req,reply)=>{const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const q=listQuery.parse(req.query);const r=await db.query('SELECT a.*,EXISTS(SELECT 1 FROM animal_market_reservations r WHERE r.identity_id=a.id) AS reserved FROM animal_identities a WHERE farm_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR a.id<$3) ORDER BY a.id DESC LIMIT $4',[farmId,projectId,q.cursor??null,q.limit+1]);return page(r.rows,q.limit);});
  app.post('/v1/farms/:farmId/projects/:projectId/animals',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,identifier:z.string().trim().min(1).max(100),sex:z.enum(['female','male','unknown']).default('unknown'),birthDate:z.iso.date().nullable().default(null),damId:uuid.nullable().default(null),sireId:uuid.nullable().default(null),birthEventId:uuid.nullable().default(null)}).strict().parse(req.body);if(b.damId===b.id||b.sireId===b.id||(b.damId&&b.damId===b.sireId))throw new ApiError('invalid_parents');
    await transaction(async c=>{
      const p=await c.query('SELECT enterprise_type,current_count,reserved_count FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,projectId]);if(!p.rowCount||!['rabbit_breeding','rabbit_growout','broiler','layer','breeder','fish','fish_nursery','fish_breeder'].includes(p.rows[0].enterprise_type))throw new ApiError('animal_project_required');
      for(const [parentId,sex]of [[b.damId,'female'],[b.sireId,'male']])if(parentId){const parent=await c.query('SELECT a.sex,p.enterprise_type FROM animal_identities a JOIN projects p ON p.farm_id=a.farm_id AND p.id=a.project_id WHERE a.farm_id=$1 AND a.id=$2',[farmId,parentId]);if(!parent.rowCount||parent.rows[0].sex!==sex||family(parent.rows[0].enterprise_type)!==family(p.rows[0].enterprise_type))throw new ApiError('invalid_parents');}
      if(b.birthEventId){const born=(await c.query("SELECT e.*,p.enterprise_type FROM animal_events e JOIN projects p ON p.id=e.project_id WHERE e.farm_id=$1 AND e.id=$2 AND e.type IN('kindling','hatch','fish_hatch') AND e.count>0 FOR UPDATE OF e",[farmId,b.birthEventId])).rows[0];if(!born||family(born.enterprise_type)!==family(p.rows[0].enterprise_type))throw new ApiError('birth_event_not_found',404);const identified=Number((await c.query('SELECT count(*) AS n FROM animal_identities WHERE farm_id=$1 AND birth_event_id=$2 AND id<>$3',[farmId,b.birthEventId,b.id])).rows[0].n);if(identified>=Number(born.count))throw new ApiError('birth_identity_count_exceeded',409);if(born.type==='kindling'){const parents=(await c.query('SELECT metadata FROM animal_events WHERE farm_id=$1 AND id=$2',[farmId,born.metadata.matingEventId])).rows[0]?.metadata;if((b.damId&&b.damId!==parents?.damId)||(b.sireId&&b.sireId!==parents?.sireId))throw new ApiError('birth_parent_mismatch',409);}}
      const r=await c.query('INSERT INTO animal_identities(id,farm_id,project_id,identifier,sex,birth_date,dam_id,sire_id,birth_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id',[b.id,farmId,projectId,b.identifier,b.sex,b.birthDate,b.damId,b.sireId,b.birthEventId]);
      if(!r.rowCount){const prev=await c.query('SELECT * FROM animal_identities WHERE farm_id=$1 AND id=$2',[farmId,b.id]);const x=prev.rows[0];if(!x||x.project_id!==projectId||x.identifier!==b.identifier||x.sex!==b.sex||(x.birth_date?new Date(x.birth_date).toISOString().slice(0,10):null)!==b.birthDate||x.dam_id!==b.damId||x.sire_id!==b.sireId||x.birth_event_id!==b.birthEventId)throw new ApiError('idempotency_conflict',409);}
      if(p.rows[0].current_count===null)throw new ApiError('opening_count_required',409);if(p.rows[0].current_count!==null){const n=await c.query("SELECT count(*)::int AS count FROM animal_identities WHERE farm_id=$1 AND project_id=$2 AND status='active'",[farmId,projectId]);if(n.rows[0].count>Number(p.rows[0].current_count))throw new ApiError('identity_exceeds_count',409);const reservedIdentified=Number((await c.query('SELECT count(*) AS n FROM animal_market_reservations r JOIN animal_identities a ON a.id=r.identity_id WHERE a.farm_id=$1 AND a.project_id=$2',[farmId,projectId])).rows[0].n);if(n.rows[0].count+Number(p.rows[0].reserved_count)-reservedIdentified>Number(p.rows[0].current_count))throw new ApiError('unidentified_animals_reserved',409);}
    });return reply.code(201).send({id:b.id});
  });
  app.get('/v1/farms/:farmId/projects/:projectId/restrictions',async(req,reply)=>{const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor))throw new ApiError('not_found',404);const r=await db.query('SELECT id,source_project_id,starts_at,ends_at,scope,reason,authorized_by,created_at FROM treatment_restrictions WHERE farm_id=$1 AND project_id=$2 ORDER BY ends_at DESC',[farmId,projectId]);return {items:r.rows};});
  app.post('/v1/farms/:farmId/projects/:projectId/restrictions',async(req,reply)=>{
    const actor=await user(req,reply);if(!actor)return;const {farmId,projectId}=params.parse(req.params);if(!await member(farmId,actor,manageRoles))throw new ApiError('not_found',404);
    const b=z.object({id:uuid,startsAt:when,endsAt:when,scope:z.enum(['all','harvest','sale','transfer']),reason:z.string().trim().min(1).max(2000),authorizedBy:z.string().trim().min(1).max(200)}).strict().refine(b=>new Date(b.endsAt)>new Date(b.startsAt),'invalid_restriction_period').parse(req.body);
    await transaction(async c=>{const p=await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=$2 FOR NO KEY UPDATE',[farmId,projectId]);if(!p.rowCount)throw new ApiError('project_not_found',404);
      const exists=await c.query('SELECT * FROM treatment_restrictions WHERE id=$1',[b.id]);if(exists.rowCount){const r=exists.rows[0];if(r.farm_id!==farmId||r.project_id!==projectId||r.created_by!==actor||r.scope!==b.scope||r.reason!==b.reason||r.authorized_by!==b.authorizedBy||new Date(r.starts_at).toISOString()!==new Date(b.startsAt).toISOString()||new Date(r.ends_at).toISOString()!==new Date(b.endsAt).toISOString())throw new ApiError('idempotency_conflict',409);return;}
      await c.query('INSERT INTO treatment_restrictions(id,farm_id,project_id,starts_at,ends_at,scope,reason,authorized_by,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[b.id,farmId,projectId,b.startsAt,b.endsAt,b.scope,b.reason,b.authorizedBy,actor]);await audit(c,farmId,actor,'restriction',b.id,'recorded',b.reason,null,b);
    });return reply.code(201).send({id:b.id});
  });
}
