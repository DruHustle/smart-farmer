import type {FastifyReply, FastifyRequest} from 'fastify';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {sha256} from './security.js';

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly details?: unknown) {
    super(code);
  }
}
export const writeRoles = ['owner','manager','worker'];
export const manageRoles = ['owner','manager'];
export function createContext(db: pg.Pool) {
  async function user(req: FastifyRequest, reply: FastifyReply) {
    const value = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!value) { reply.code(401).send({error:'unauthorized'}); return null; }
    const result = await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()', [sha256(value)]);
    if (!result.rowCount) { reply.code(401).send({error:'unauthorized'}); return null; }
    return result.rows[0].user_id as string;
  }
  async function member(farmId: string, userId: string, roles?: string[]) {
    const result = await db.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2', [farmId,userId]);
    return !!result.rowCount && (!roles || roles.includes(result.rows[0].role));
  }
  async function transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result=await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return {db,user,member,transaction};
}
export type Context = ReturnType<typeof createContext>;
export async function audit(client: pg.PoolClient, farmId: string|null, actorId: string, entityType: string, entityId: string, action: string, reason: string, previous: unknown=null, current: unknown=null) {
  await client.query('INSERT INTO audit_events(id,farm_id,actor_id,entity_type,entity_id,action,reason,previous,current) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(),farmId,actorId,entityType,entityId,action,reason,previous===null?null:JSON.stringify(previous),current===null?null:JSON.stringify(current)]);
}
export function checkReplay(previous: {payload_hash:string,actor_id?:string,created_by?:string}, hash:string, actorId:string) {
  if(previous.payload_hash!==hash || (previous.actor_id??previous.created_by)!==actorId) throw new ApiError('idempotency_conflict',409);
}
