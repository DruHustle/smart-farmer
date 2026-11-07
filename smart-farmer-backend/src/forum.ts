import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {ApiError, audit, type Context} from './context.js';
import {sha256} from './security.js';

const uuid = z.string().uuid();
export const forumTopics = ['crops','livestock','soil','irrigation','equipment','markets','general'] as const;
const topic = z.enum(forumTopics);
const text = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Unsupported control character');
const content = z.object({displayName: text(2,50), body: text(1,8000), shareWithCommunity: z.literal(true)});
const discussionInput = content.extend({id: uuid, title: text(3,160), topic}).strict();
const replyInput = content.extend({id: uuid}).strict();
const editInput = content.extend({version: z.number().int().positive().max(2_000_000_000), title: text(3,160).optional(), topic: topic.optional()}).strict();
const versionInput = z.object({version: z.number().int().positive().max(2_000_000_000)}).strict();
const moderationInput = versionInput.extend({status: z.enum(['visible','hidden']), reason: text(5,1000)}).strict();
const reportInput = versionInput.extend({id: uuid, reason: z.enum(['spam','abuse','unsafe_advice','privacy','other']), details: text(0,1000).default('')}).strict();
const listInput = z.object({topic: topic.optional(), search: text(0,100).default(''), mine: z.enum(['true','false']).default('false'), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(200).optional()}).strict();
const pageInput = listInput.pick({limit:true,cursor:true});
const cursorValue = z.object({time:z.iso.datetime(),id:uuid}).strict();
const farmParams = z.object({farmId:uuid});
type Query = Pick<pg.Pool,'query'> | Pick<pg.PoolClient,'query'>;
type Entry = {
  id:string; farm_id:string; author_id:string; parent_id:string|null; display_name:string;
  title:string|null; topic:typeof forumTopics[number]|null; body:string; status:'visible'|'hidden'|'deleted';
  version:number; moderation_reason:string|null; payload_hash:string; created_at:Date; updated_at:Date;
  mine:boolean; source_member:boolean; can_moderate:boolean; reply_count?:string; cursor_time:string;
};
const projection = `e.*,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,e.author_id=$1 AS mine,
 EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.farm_id=e.farm_id) AS source_member,
 (e.farm_id=$2 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.farm_id=e.farm_id AND m.role='owner')) AS can_moderate`;
function dto(e:Entry) {
  return {id:e.id,kind:e.parent_id?'reply':'discussion',displayName:e.display_name,title:e.title,topic:e.topic,
    body:e.body,status:e.status,version:e.version,createdAt:e.created_at,updatedAt:e.updated_at,
    replyCount:Number(e.reply_count??0),mine:e.mine,canEdit:e.mine&&e.source_member&&e.status!=='deleted',
    canModerate:e.can_moderate&&e.status!=='deleted',
    ...((e.mine||e.can_moderate)&&e.moderation_reason?{moderationReason:e.moderation_reason}:{})};
}
function cursor(raw?:string) {
  if(!raw)return null;
  try{return cursorValue.parse(JSON.parse(Buffer.from(raw,'base64url').toString('utf8')));}catch{throw new ApiError('invalid_input');}
}
function page(rows:Entry[],limit:number) {
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items:items.map(dto),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({time:last.cursor_time,id:last.id})).toString('base64url'):null};
}
async function findEntry(db:Query,id:string,actor:string,farmId:string,lock=false) {
  const result=await db.query<Entry>(`SELECT ${projection} FROM forum_entries e WHERE e.id=$3 ${lock?'FOR UPDATE OF e':''}`,[actor,farmId,id]);
  if(!result.rowCount)throw new ApiError('not_found',404);
  return result.rows[0]!;
}
function visible(e:Entry) {return e.status==='visible'||(e.status==='hidden'&&(e.mine||e.can_moderate));}
function currentVersion(e:Entry,version:number) {if(e.version!==version)throw new ApiError('version_conflict',409);}
const writeLimit={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};

export function registerForum(app:FastifyInstance,ctx:Context) {
  const {db,user,member,transaction}=ctx;
  async function access(req:FastifyRequest,reply:FastifyReply) {
    const actor=await user(req,reply);if(!actor)return null;
    const {farmId}=farmParams.parse(req.params);
    if(!await member(farmId,actor))throw new ApiError('not_found',404);
    return {actor,farmId};
  }
  // Lock the live session and membership during writes, including idempotent replays.
  async function writeAccess(c:pg.PoolClient,req:FastifyRequest,actor:string,farmId:string,owner=false) {
    const session=await c.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR SHARE',[sha256(req.headers.authorization!.slice(7)),actor]);
    if(!session.rowCount)throw new ApiError('unauthorized',401);
    const membership=await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[farmId,actor]);
    if(!membership.rowCount||(owner&&membership.rows[0].role!=='owner'))throw new ApiError('not_found',404);
  }
  async function authorAccess(c:pg.PoolClient,e:Entry,actor:string) {
    if(e.author_id!==actor)throw new ApiError('not_found',404);
    const membership=await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[e.farm_id,actor]);
    if(!membership.rowCount)throw new ApiError('not_found',404);
    if(e.status==='deleted')throw new ApiError('forum_content_removed',409);
  }
  const base='/v1/farms/:farmId/forum';
  app.get(base+'/discussions',async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const q=listInput.parse(req.query),p=cursor(q.cursor);
    const search=q.search?`%${q.search.replace(/[\\%_]/g,'\\$&')}%`:null;
    const result=await db.query<Entry>(`SELECT ${projection},
      (SELECT count(*) FROM forum_entries r WHERE r.parent_id=e.id AND r.status='visible') AS reply_count
      FROM forum_entries e WHERE e.parent_id IS NULL
      AND (e.status='visible' OR ($3 AND e.author_id=$1 AND e.status='hidden'))
      AND (NOT $3 OR e.author_id=$1) AND ($4::text IS NULL OR e.topic=$4)
      AND ($5::text IS NULL OR e.title ILIKE $5 OR e.body ILIKE $5)
      AND ($6::timestamptz IS NULL OR (e.created_at,e.id)<($6::timestamptz,$7::uuid))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $8`,[a.actor,a.farmId,q.mine==='true',q.topic??null,search,p?.time??null,p?.id??null,q.limit+1]);
    return page(result.rows,q.limit);
  });
  app.get(base+'/discussions/:discussionId',async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {discussionId}=z.object({discussionId:uuid}).parse(req.params),q=pageInput.parse(req.query),p=cursor(q.cursor);
    const discussion=await findEntry(db,discussionId,a.actor,a.farmId);
    if(discussion.parent_id||!visible(discussion))throw new ApiError('not_found',404);
    const replies=await db.query<Entry>(`SELECT ${projection} FROM forum_entries e WHERE e.parent_id=$3
      AND (e.status IN ('visible','deleted') OR e.author_id=$1 OR (e.farm_id=$2 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.farm_id=e.farm_id AND m.role='owner')))
      AND ($4::timestamptz IS NULL OR (e.created_at,e.id)>($4::timestamptz,$5::uuid)) ORDER BY e.created_at,e.id LIMIT $6`,[a.actor,a.farmId,discussionId,p?.time??null,p?.id??null,q.limit+1]);
    return {discussion:dto(discussion),replies:page(replies.rows,q.limit)};
  });
  async function publish(req:FastifyRequest,reply:FastifyReply,kind:'discussion'|'reply') {
    const a=await access(req,reply);if(!a)return;
    const b=kind==='discussion'?discussionInput.parse(req.body):replyInput.parse(req.body);
    const parentId=kind==='reply'?z.object({discussionId:uuid}).parse(req.params).discussionId:null;
    const hash=sha256(JSON.stringify({kind,farmId:a.farmId,parentId,...b}));
    const result=await transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['forum-publish:'+b.id]);
      const prior=await c.query<Entry>('SELECT * FROM forum_entries WHERE id=$1',[b.id]);
      if(prior.rowCount) {
        if(prior.rows[0]!.author_id!==a.actor||prior.rows[0]!.payload_hash!==hash)throw new ApiError('idempotency_conflict',409);
        return {entry:await findEntry(c,b.id,a.actor,a.farmId),duplicate:true};
      }
      if(parentId) {
        const parent=await c.query('SELECT parent_id,status FROM forum_entries WHERE id=$1 FOR SHARE',[parentId]);
        if(!parent.rowCount||parent.rows[0].parent_id||parent.rows[0].status!=='visible')throw new ApiError('not_found',404);
      }
      await c.query('INSERT INTO forum_entries(id,farm_id,author_id,parent_id,display_name,title,topic,body,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[b.id,a.farmId,a.actor,parentId,b.displayName,'title'in b?b.title:null,'topic'in b?b.topic:null,b.body,hash]);
      await audit(c,a.farmId,a.actor,'forum_entry',b.id,'forum_published','explicit_community_sharing',null,{kind,parentId});
      return {entry:await findEntry(c,b.id,a.actor,a.farmId),duplicate:false};
    });
    return reply.code(result.duplicate?200:201).send({...dto(result.entry),duplicate:result.duplicate});
  }
  app.post(base+'/discussions',writeLimit,(req,reply)=>publish(req,reply,'discussion'));
  app.post(base+'/discussions/:discussionId/replies',writeLimit,(req,reply)=>publish(req,reply,'reply'));
  app.patch(base+'/entries/:entryId',writeLimit,async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {entryId}=z.object({entryId:uuid}).parse(req.params),b=editInput.parse(req.body);
    return transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId);const e=await findEntry(c,entryId,a.actor,a.farmId,true);
      await authorAccess(c,e,a.actor);currentVersion(e,b.version);
      if(e.parent_id&&(b.title!==undefined||b.topic!==undefined))throw new ApiError('invalid_input');
      if(!e.parent_id&&(b.title===undefined||b.topic===undefined))throw new ApiError('invalid_input');
      await c.query('UPDATE forum_entries SET display_name=$2,title=$3,topic=$4,body=$5,version=version+1,updated_at=now() WHERE id=$1',[entryId,b.displayName,b.title??null,b.topic??null,b.body]);
      await audit(c,e.farm_id,a.actor,'forum_entry',entryId,'forum_edited','explicit_community_sharing',{version:e.version,status:e.status},{version:e.version+1,status:e.status});
      return dto(await findEntry(c,entryId,a.actor,a.farmId));
    });
  });
  app.delete(base+'/entries/:entryId',writeLimit,async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {entryId}=z.object({entryId:uuid}).parse(req.params),b=versionInput.parse(req.body);
    await transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId);const e=await findEntry(c,entryId,a.actor,a.farmId,true);
      await authorAccess(c,e,a.actor);currentVersion(e,b.version);
      await c.query("UPDATE forum_entries SET status='deleted',display_name='',body='',title=CASE WHEN parent_id IS NULL THEN '' ELSE NULL END,moderation_reason=NULL,version=version+1,updated_at=now() WHERE id=$1",[entryId]);
      await c.query("UPDATE forum_reports SET status='actioned',resolved_at=now(),resolved_by=$2,resolution_note='author_removed_content' WHERE entry_id=$1 AND status='open'",[entryId,a.actor]);
      await audit(c,e.farm_id,a.actor,'forum_entry',entryId,'forum_deleted','author_removed_content',{status:e.status,version:e.version},{status:'deleted',version:e.version+1});
    });return reply.code(204).send();
  });
  app.post(base+'/entries/:entryId/reports',writeLimit,async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {entryId}=z.object({entryId:uuid}).parse(req.params),b=reportInput.parse(req.body);
    const hash=sha256(JSON.stringify({entryId,...b}));
    const result=await transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['forum-report:'+b.id]);
      const previous=await c.query('SELECT reporter_id,payload_hash,status FROM forum_reports WHERE id=$1',[b.id]);
      if(previous.rowCount) {if(previous.rows[0].reporter_id!==a.actor||previous.rows[0].payload_hash!==hash)throw new ApiError('idempotency_conflict',409);return {id:b.id,status:previous.rows[0].status,duplicate:true};}
      const e=await findEntry(c,entryId,a.actor,a.farmId,true);
      if(e.status!=='visible'||e.author_id===a.actor)throw new ApiError('not_found',404);
      if(e.parent_id){const parent=await c.query('SELECT status FROM forum_entries WHERE id=$1 FOR SHARE',[e.parent_id]);if(parent.rows[0]?.status!=='visible')throw new ApiError('not_found',404);}
      currentVersion(e,b.version);
      const existing=await c.query('SELECT id FROM forum_reports WHERE entry_id=$1 AND reporter_id=$2 AND reported_version=$3',[entryId,a.actor,b.version]);
      if(existing.rowCount)throw new ApiError('forum_already_reported',409);
      await c.query('INSERT INTO forum_reports(id,entry_id,reporter_id,reported_version,reason,details,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[b.id,entryId,a.actor,b.version,b.reason,b.details,hash]);
      return {id:b.id,status:'open',duplicate:false};
    });return reply.code(result.duplicate?200:201).send(result);
  });
  app.get(base+'/reports',async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    if(!await member(a.farmId,a.actor,['owner']))throw new ApiError('not_found',404);
    const q=pageInput.parse(req.query),p=cursor(q.cursor);
    const reports=await db.query(`SELECT r.id,r.reason,r.details,r.reported_version,r.created_at,r.entry_id,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM forum_reports r JOIN forum_entries e ON e.id=r.entry_id WHERE e.farm_id=$1 AND r.status='open'
      AND ($2::timestamptz IS NULL OR (r.created_at,r.id)>($2::timestamptz,$3::uuid)) ORDER BY r.created_at,r.id LIMIT $4`,[a.farmId,p?.time??null,p?.id??null,q.limit+1]);
    const rows=reports.rows.slice(0,q.limit),items=[];
    for(const report of rows)items.push({id:report.id,reason:report.reason,details:report.details,reportedVersion:report.reported_version,createdAt:report.created_at,entry:dto(await findEntry(db,report.entry_id,a.actor,a.farmId))});
    const last=rows.at(-1);return {items,nextCursor:reports.rows.length>q.limit&&last?Buffer.from(JSON.stringify({time:last.cursor_time,id:last.id})).toString('base64url'):null};
  });
  app.get(base+'/hidden',async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    if(!await member(a.farmId,a.actor,['owner']))throw new ApiError('not_found',404);
    const q=pageInput.parse(req.query),p=cursor(q.cursor);
    const rows=await db.query<Entry>(`SELECT ${projection} FROM forum_entries e WHERE e.farm_id=$2 AND e.status='hidden'
      AND ($3::timestamptz IS NULL OR (e.created_at,e.id)<($3::timestamptz,$4::uuid)) ORDER BY e.created_at DESC,e.id DESC LIMIT $5`,[a.actor,a.farmId,p?.time??null,p?.id??null,q.limit+1]);
    return page(rows.rows,q.limit);
  });
  app.post(base+'/entries/:entryId/moderation',writeLimit,async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {entryId}=z.object({entryId:uuid}).parse(req.params),b=moderationInput.parse(req.body);
    return transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId,true);const e=await findEntry(c,entryId,a.actor,a.farmId,true);
      if(e.farm_id!==a.farmId)throw new ApiError('not_found',404);
      if(e.status==='deleted')throw new ApiError('forum_content_removed',409);currentVersion(e,b.version);
      await c.query('UPDATE forum_entries SET status=$2,moderation_reason=$3,version=version+1,updated_at=now() WHERE id=$1',[entryId,b.status,b.reason]);
      if(b.status==='hidden')await c.query("UPDATE forum_reports SET status='actioned',resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE entry_id=$1 AND status='open'",[entryId,a.actor,b.reason]);
      await audit(c,e.farm_id,a.actor,'forum_entry',entryId,'forum_'+b.status,b.reason,{status:e.status,version:e.version},{status:b.status,version:e.version+1});
      return dto(await findEntry(c,entryId,a.actor,a.farmId));
    });
  });
  app.post(base+'/reports/:reportId/dismiss',writeLimit,async(req,reply)=>{
    const a=await access(req,reply);if(!a)return;
    const {reportId}=z.object({reportId:uuid}).parse(req.params),b=versionInput.extend({reason:text(5,1000)}).strict().parse(req.body);
    await transaction(async c=>{
      await writeAccess(c,req,a.actor,a.farmId,true);
      const report=await c.query('SELECT entry_id,status FROM forum_reports WHERE id=$1',[reportId]);if(!report.rowCount)throw new ApiError('not_found',404);
      const e=await findEntry(c,report.rows[0].entry_id,a.actor,a.farmId,true);
      if(e.farm_id!==a.farmId)throw new ApiError('not_found',404);currentVersion(e,b.version);
      const changed=await c.query("UPDATE forum_reports SET status='dismissed',resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE id=$1 AND status='open'",[reportId,a.actor,b.reason]);
      if(!changed.rowCount)throw new ApiError('version_conflict',409);
      await audit(c,e.farm_id,a.actor,'forum_report',reportId,'forum_report_dismissed',b.reason);
    });return reply.code(204).send();
  });
}
