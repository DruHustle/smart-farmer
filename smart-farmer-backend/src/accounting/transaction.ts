import type { PoolClient } from 'pg';
import { ApiError, checkReplay, manageRoles, type Context } from '../context.js';
import { sha256 } from '../security.js';

/** Farm before membership is the same lock order as role changes and document intake. */
export async function accountingMutation<T>(ctx:Context,farmId:string,actor:string,id:string,intent:unknown,action:(c:PoolClient)=>Promise<T>) {
  const hash=sha256(JSON.stringify(intent));
  return ctx.transaction(async c=>{
    // Permit operational INSERTs' FK KEY SHARE locks while serializing role changes.
    await c.query('SELECT id FROM farms WHERE id=$1 FOR NO KEY UPDATE',[farmId]);
    const membership=(await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[farmId,actor])).rows[0];
    if(!membership||!manageRoles.includes(membership.role))throw new ApiError('not_found',404);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`product:${id}`]);
    const old=(await c.query('SELECT * FROM product_requests WHERE id=$1',[id])).rows[0];
    if(old){if(old.farm_id!==farmId)throw new ApiError('idempotency_conflict',409);checkReplay(old,hash,actor);return {body:old.response as T,replayed:true};}
    const body=await action(c);
    await c.query('INSERT INTO product_requests(id,farm_id,actor_id,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[id,farmId,actor,hash,JSON.stringify(body)]);
    return {body,replayed:false};
  });
}
