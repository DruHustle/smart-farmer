import type {FastifyReply, FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ApiError, type createContext} from '../context.js';
import {sha256} from '../security.js';

export type Context = ReturnType<typeof createContext>;
export const uuid = z.string().uuid();
export const instant = z.iso.datetime({offset: true});
export const money = z.number().finite().min(0).max(999999999).multipleOf(0.01);
export const quantity = z.number().finite().positive().max(999999999).multipleOf(0.000001);
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const hash = (data: unknown) => sha256(JSON.stringify(data));
export async function authorize(ctx: Context, req: FastifyRequest, reply: FastifyReply, roles?: string[]) {
  const userId = await ctx.user(req, reply);
  if (!userId) return null;
  const {farmId} = z.object({farmId: uuid}).parse(req.params);
  if (!await ctx.member(farmId, userId, roles)) throw new ApiError('not_found', 404);
  return {userId, farmId};
}
export async function operationLock(client: PoolClient, scope: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
}
export function requireRow<T>(row: T | undefined): T {
  if (!row) throw new ApiError('not_found', 404);
  return row;
}
export const managers = ['owner', 'manager'];
export const recorders = ['owner', 'manager', 'worker'];
