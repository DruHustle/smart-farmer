import type pg from 'pg';
import {ApiError,audit} from '../context.js';
import {NodeRedError} from './configuration.js';
import {installOperation,pendingInstall,type InstallOperation,type NodeRedActor} from './types.js';

export interface InstallStore {
  authorize(actor:NodeRedActor):Promise<void>;
  current(runtimeId:string,farmId:string):Promise<InstallOperation|null>;
  claim(operation:InstallOperation,actor:NodeRedActor):Promise<{operation:InstallOperation;accepted:boolean}>;
  finish(operation:InstallOperation,actorId?:string):Promise<InstallOperation>;
}
type Database = Pick<pg.Pool,'query'> | Pick<pg.PoolClient,'query'>;
async function authorize(db:Database,actor:NodeRedActor) {
  const session = await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[actor.sessionHash,actor.id]);
  if (!session.rowCount) throw new ApiError('unauthorized',401);
  const member = await db.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2',[actor.farmId,actor.id]);
  if (!member.rowCount) throw new ApiError('not_found',404);
  if (member.rows[0].role !== 'owner') throw new ApiError('owner_required',403);
}
function decode(raw:unknown,farmId:string):InstallOperation|null {
  if (!raw) return null;
  const parsed = installOperation.safeParse(raw);
  if (!parsed.success || parsed.data.farmId !== farmId)
    throw new NodeRedError('The saved runtime binding requires an operator review before any further installation.');
  return parsed.data;
}
async function current(db:Database,runtimeId:string,farmId:string) {
  const result = await db.query('SELECT o.operation FROM node_red_package_runtimes r JOIN node_red_package_operations o ON o.id=r.operation_id WHERE r.runtime_id=$1',[runtimeId]);
  return decode(result.rows[0]?.operation,farmId);
}

export function postgresInstallStore(pool:pg.Pool):InstallStore {
  async function transaction<T>(runtimeId:string,action:(db:pg.PoolClient)=>Promise<T>) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL statement_timeout='3000ms'");
      // Lock the runtime, not its farm/gateway alias; all API processes share it.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['node_red_runtime:'+runtimeId]);
      const value = await action(db);
      await db.query('COMMIT');
      return value;
    } catch (error) {await db.query('ROLLBACK');throw error;}
    finally {db.release();}
  }
  return {
    authorize:actor=>authorize(pool,actor),
    current:(runtimeId,farmId)=>current(pool,runtimeId,farmId),
    claim:(operation,actor)=>transaction(operation.runtimeId,async db=>{
      await authorize(db,actor);
      if (operation.actorId !== actor.id || operation.farmId !== actor.farmId)
        throw new ApiError('owner_required',403);
      const row = await db.query('SELECT operation FROM node_red_package_operations WHERE id=$1',[operation.id]);
      if (row.rowCount) {
        const previous = decode(row.rows[0].operation,actor.farmId)!;
        if (['runtimeId','targetRevision','farmId','gatewayId','actorId','module','version'].some(key=>
          previous[key as keyof InstallOperation] !== operation[key as keyof InstallOperation]))
          throw new NodeRedError('This request identifier belongs to a different installation request.',true);
        return {operation:previous,accepted:false};
      }
      if (pendingInstall(await current(db,operation.runtimeId,actor.farmId)))
        throw new NodeRedError('An installation for this runtime is pending or unconfirmed. Check its outcome before another installation.',true);
      await db.query('INSERT INTO node_red_package_operations(id,runtime_id,farm_id,actor_id,operation) VALUES($1,$2,$3,$4,$5)',
        [operation.id,operation.runtimeId,operation.farmId,operation.actorId,JSON.stringify(operation)]);
      await db.query('INSERT INTO node_red_package_runtimes(runtime_id,operation_id) VALUES($1,$2) ON CONFLICT(runtime_id) DO UPDATE SET operation_id=excluded.operation_id',
        [operation.runtimeId,operation.id]);
      await audit(db,operation.farmId,actor.id,'node_red_package',operation.id,'install_reserved','owner_acknowledged_runtime_code',null,operation);
      return {operation,accepted:true};
    }),
    finish:(operation,actorId=operation.actorId)=>transaction(operation.runtimeId,async db=>{
      const previous = await current(db,operation.runtimeId,operation.farmId);
      if (!previous || previous.id !== operation.id)
        throw new NodeRedError('The active installation changed. Refresh its saved status.');
      // Late network failures cannot overwrite a successful read-back.
      if (!pendingInstall(previous)) return previous;
      await db.query('UPDATE node_red_package_operations SET operation=$2 WHERE id=$1',[operation.id,JSON.stringify(operation)]);
      await audit(db,operation.farmId,actorId,'node_red_package',operation.id,'install_outcome','runtime_inventory_check',previous,operation);
      return operation;
    })
  };
}
