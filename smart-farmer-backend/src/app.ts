import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {hashPassword, verifyPassword, sha256, token} from './security.js';
import {registerFarmEdgeRoutes} from './edge.js';

const uuid = z.string().uuid();
const credentials = z.object({username:z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._-]+$/).transform(s=>s.toLowerCase()), password:z.string().min(12).max(128)});
const register = credentials.extend({language:z.enum(['sn','nd']), farmName:z.string().trim().min(1).max(100)});
const project = z.object({name:z.string().trim().min(1).max(100), crop:z.string().trim().min(1).max(80), irrigation:z.boolean(), plantingDate:z.iso.date().nullable().default(null), variety:z.string().max(100).nullable().default(null), objective:z.string().max(200).nullable().default(null), areaHa:z.number().positive().nullable().default(null), stage:z.string().max(100).nullable().default(null)});
const activity = z.object({id:uuid, projectId:uuid, kind:z.enum(['work','rain','irrigation','observation','harvest','cost','input_use']), observedAt:z.iso.datetime({offset:true}), note:z.string().max(4000).default(''), quantity:z.number().nonnegative().nullable().default(null), unit:z.string().trim().min(1).max(40).nullable().default(null)}).refine(v=>(v.quantity===null)===(v.unit===null), {message:'quantity and unit must be supplied together'});
export function buildApp(db: pg.Pool, origin: string) {
 const app = Fastify({logger:true, bodyLimit: 32_768});
 app.register(cors,{origin});
 app.register(rateLimit,{max:100,timeWindow:'1 minute'});
 app.setErrorHandler((err, _req, reply) => { app.log.error(err); if (err instanceof z.ZodError) return reply.code(400).send({error:'invalid_input', details:err.issues.map(i=>({path:i.path,message:i.message}))}); const status=(err as {statusCode?:number}).statusCode; if (status && status>=400 && status<500) return reply.code(status).send({error:status===429?'rate_limited':'invalid_request'}); return reply.code(500).send({error:'internal_error'}); });
 app.get('/health', async()=>({status:'ok'}));
 app.get('/ready', async(_req,reply)=>{try {await db.query('SELECT 1'); return {status:'ok'};} catch {return reply.code(503).send({status:'unavailable'});}});
 app.post('/v1/register',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
  const body=register.parse(req.body); const client=await db.connect();
  try { await client.query('BEGIN'); const userId=randomUUID(), farmId=randomUUID();
   await client.query('INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,$3,$4)',[userId,body.username,await hashPassword(body.password),body.language]);
   await client.query('INSERT INTO farms(id,name,timezone) VALUES($1,$2,$3)',[farmId,body.farmName,'Africa/Harare']);
   await client.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'owner')",[userId,farmId]); await client.query('COMMIT'); return reply.code(201).send({userId,farmId});
  } catch(e) {await client.query('ROLLBACK'); if ((e as {code?:string}).code==='23505') return reply.code(409).send({error:'username_unavailable'}); throw e;} finally {client.release();}
 });
 app.post('/v1/sessions',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const body=credentials.parse(req.body); const result=await db.query('SELECT id,password_hash,language FROM users WHERE username=$1',[body.username]);
  if (!result.rows[0] || !await verifyPassword(body.password,result.rows[0].password_hash)) return reply.code(401).send({error:'invalid_credentials'});
  const value=token(); await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[sha256(value),result.rows[0].id]);
  return {token:value,language:result.rows[0].language};
 });
 async function user(req: {headers:{authorization?:string}}, reply: {code:(n:number)=>{send:(v:object)=>unknown}}) {
  const value=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!value) {reply.code(401).send({error:'unauthorized'}); return null;}
  const result=await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',[sha256(value)]);
  if (!result.rowCount) {reply.code(401).send({error:'unauthorized'}); return null;} return result.rows[0].user_id as string;
 }
 app.delete('/v1/sessions/current',async(req,reply)=>{const id=await user(req,reply); if(!id)return; await db.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(req.headers.authorization!.slice(7))]); return reply.code(204).send();});
 app.get('/v1/farms',async(req,reply)=>{const id=await user(req,reply); if(!id)return; const result=await db.query('SELECT f.id,f.name,f.timezone,m.role FROM farms f JOIN memberships m ON m.farm_id=f.id WHERE m.user_id=$1 ORDER BY f.name',[id]); return {items:result.rows};});
 async function member(farmId:string, userId:string, roles?:string[]) {const result=await db.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2',[farmId,userId]); return !!result.rowCount && (!roles || roles.includes(result.rows[0].role));}
 app.get('/v1/farms/:farmId/projects',async(req,reply)=>{const id=await user(req,reply); if(!id)return; const {farmId}=z.object({farmId:uuid}).parse(req.params); if(!await member(farmId,id)) return reply.code(404).send({error:'not_found'}); const result=await db.query('SELECT id,name,crop,irrigation,planting_date,variety,objective,area_ha,stage FROM projects WHERE farm_id=$1 ORDER BY created_at DESC LIMIT 100',[farmId]); return {items:result.rows};});
 app.post('/v1/farms/:farmId/projects',async(req,reply)=>{const id=await user(req,reply); if(!id)return; const {farmId}=z.object({farmId:uuid}).parse(req.params); if(!await member(farmId,id,['owner','manager'])) return reply.code(404).send({error:'not_found'}); const p=project.parse(req.body); const projectId=randomUUID(); await db.query('INSERT INTO projects(id,farm_id,name,crop,irrigation,planting_date,variety,objective,area_ha,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[projectId,farmId,p.name,p.crop,p.irrigation,p.plantingDate,p.variety,p.objective,p.areaHa,p.stage]); return reply.code(201).send({id:projectId});});
 app.get('/v1/farms/:farmId/activities',async(req,reply)=>{const id=await user(req,reply); if(!id)return; const {farmId}=z.object({farmId:uuid}).parse(req.params); if(!await member(farmId,id)) return reply.code(404).send({error:'not_found'}); const result=await db.query('SELECT id,project_id,kind,observed_at,recorded_at,note,quantity,unit FROM activities WHERE farm_id=$1 ORDER BY observed_at DESC LIMIT 100',[farmId]); return {items:result.rows};});
 app.post('/v1/farms/:farmId/activities',async(req,reply)=>{const id=await user(req,reply); if(!id)return; const {farmId}=z.object({farmId:uuid}).parse(req.params); if(!await member(farmId,id,['owner','manager','worker'])) return reply.code(404).send({error:'not_found'}); const a=activity.parse(req.body); const hash=sha256(JSON.stringify(a));
  try {const result=await db.query('INSERT INTO activities(id,farm_id,project_id,actor_id,kind,observed_at,note,quantity,unit,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (farm_id,id) DO NOTHING RETURNING id',[a.id,farmId,a.projectId,id,a.kind,a.observedAt,a.note,a.quantity,a.unit,hash]); if(result.rowCount) return reply.code(201).send({id:a.id}); const previous=await db.query('SELECT payload_hash,actor_id FROM activities WHERE farm_id=$1 AND id=$2',[farmId,a.id]); if(previous.rows[0].payload_hash!==hash || previous.rows[0].actor_id!==id) return reply.code(409).send({error:'idempotency_conflict'}); return {id:a.id};} catch(e) {if((e as {code?:string}).code==='23503') return reply.code(404).send({error:'project_not_found'}); throw e;}
 });
 registerFarmEdgeRoutes(app,db,user,member);
 return app;
}
