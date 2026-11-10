import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../context.js';
import {farmEdgeGateways} from '../edge.js';
import {gatewayId, type NodeRedTarget} from './types.js';

export class NodeRedError extends Error {
  constructor(message:string, readonly rejected=false) {super(message);}
}
export type NodeRedConfiguration = {
  farmId:string; gatewayId:string; target:NodeRedTarget; adminUrl:string; token:string;
};
export const MANAGEMENT_PERMISSIONS = ['nodes.read','nodes.write','plugins.read','settings.read'];
export const REQUEST_TIMEOUT_MS = 8_000;
export const INSTALL_TIMEOUT_MS = 120_000;
export const REVIEW_LIFETIME_MS = 10 * 60_000;
const enrollment = z.object({
  runtimeId:z.string().uuid(), label:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/),
  // Separate POST /nodes version and inventory behavior are verified for 4.1.4.
  version:z.literal('4.1.4'), adminUrl:z.string().max(300), token:z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();

export function nodeRedConfigurations(env:NodeJS.ProcessEnv=process.env):NodeRedConfiguration[] {
  if (env.SMART_FARMER_NODE_RED_MANAGEMENT_ENABLED !== 'true') return [];
  try {
    const records = z.record(gatewayId,enrollment).parse(JSON.parse(env.SMART_FARMER_NODE_RED_GATEWAYS ?? ''));
    const entries = Object.entries(records);
    if (!entries.length || entries.length > 32) throw new Error('count');
    const edge = farmEdgeGateways(env), runtimes = new Set<string>(), routes = new Set<string>();
    return entries.map(([id,entry]) => {
      const farmId = edge[id]?.farmId;
      const url = new URL(entry.adminUrl);
      // Literal loopback only. A separately approved private forward must share
      // the API process/container network namespace; browser input cannot pick it.
      if (!farmId || url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) ||
          !url.port || url.username || url.password || url.search || url.hash ||
          !['/admin','/admin/'].includes(url.pathname)) throw new Error('route');
      const adminUrl = url.origin + '/admin', runtimeId = entry.runtimeId.toLowerCase();
      if (runtimes.has(runtimeId) || routes.has(adminUrl)) throw new Error('duplicate');
      runtimes.add(runtimeId); routes.add(adminUrl);
      const revision = createHash('sha256').update(JSON.stringify([
        farmId,id,adminUrl,runtimeId,entry.version,entry.label,entry.token
      ])).digest('hex');
      return {farmId,gatewayId:id,adminUrl,token:entry.token,
        target:{id:runtimeId,label:entry.label,version:entry.version,revision}};
    });
  } catch {
    throw new NodeRedError('Review the private Node-RED gateway enrollment: use an existing farm gateway, unique runtime UUID and loopback route, dedicated token, and the supported exact runtime version.');
  }
}
export function safeNodeRedError(error:unknown):string {
  if (error instanceof NodeRedError) return error.message;
  if (error instanceof ApiError && ['unauthorized','owner_required','not_found'].includes(error.code))
    return 'A current farm owner session is required. No new installation was authorized.';
  return 'Node-RED management is unavailable. Check the private route and saved operation.';
}
