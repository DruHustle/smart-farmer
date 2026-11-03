import type pg from 'pg';
import type {FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {ApiError,checkReplay,manageRoles,type Context} from '../context.js';
import {uuid} from '../core.js';
import {sha256} from '../security.js';
export const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(100),cursor:uuid.optional()});
export const text=z.string().trim().min(1).max(2000);
export function page<T extends {id:string}>(rows:T[],limit:number){return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};}
export async function auth(ctx:Context,req:FastifyRequest,reply:FastifyReply,roles?:string[]){const actor=await ctx.user(req,reply);if(!actor)return null;const {farmId}=z.object({farmId:uuid}).parse(req.params);if(!await ctx.member(farmId,actor,roles))throw new ApiError('not_found',404);return {farmId,actor};}
export function row<T>(value:T|undefined,code='not_found'):T{if(!value)throw new ApiError(code,404);return value;}
export async function project(c:pg.PoolClient,farmId:string,id:string,lock=false){return row((await c.query(`SELECT * FROM projects WHERE farm_id=$1 AND id=$2${lock?' FOR NO KEY UPDATE':''}`,[farmId,id])).rows[0],'project_not_found');}
export async function idempotent<T>(ctx:Context,farmId:string|null,actor:string,id:string,body:unknown,action:(c:pg.PoolClient)=>Promise<T>,roles:string[]=manageRoles){
 const hash=sha256(JSON.stringify(body));return ctx.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`product:${id}`]);
  if(farmId){const m=(await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[farmId,actor])).rows[0];if(!m||!roles.includes(m.role))throw new ApiError('not_found',404);}
  const old=(await c.query('SELECT * FROM product_requests WHERE id=$1',[id])).rows[0];if(old){if(old.farm_id!==farmId)throw new ApiError('idempotency_conflict',409);checkReplay(old,hash,actor);return {body:old.response as T,replayed:true};}
  const result=await action(c);await c.query('INSERT INTO product_requests(id,farm_id,actor_id,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[id,farmId,actor,hash,JSON.stringify(result)]);return {body:result,replayed:false};
 });
}
export async function validateProject(c:pg.PoolClient,farmId:string,id:string|null|undefined){if(id)await project(c,farmId,id);}
export async function validateMember(c:pg.PoolClient,farmId:string,id:string|null|undefined){if(id&&!((await c.query('SELECT 1 FROM memberships WHERE farm_id=$1 AND user_id=$2',[farmId,id])).rowCount))throw new ApiError('assignee_not_found',404);}
export function cents(n:number){return Math.round(n*100);}
