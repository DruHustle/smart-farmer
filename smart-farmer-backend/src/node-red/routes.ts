import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {ApiError,type Context} from '../context.js';
import {sha256} from '../security.js';
import {NodeRedError,safeNodeRedError,type NodeRedConfiguration} from './configuration.js';
import {gatewayId,installRequest,packageSelection,type NodeRedActor} from './types.js';
import {NodeRedPackageService} from './service.js';
import {postgresInstallStore} from './store.js';

export type NodeRedOptions = {configuration?:()=>NodeRedConfiguration[];fetcher?:typeof fetch};
export function registerNodeRedPackages(app:FastifyInstance,ctx:Context,options:NodeRedOptions={}) {
  const service=new NodeRedPackageService(postgresInstallStore(ctx.db),options.configuration,options.fetcher);
  async function actor(req:FastifyRequest,reply:FastifyReply):Promise<NodeRedActor|null> {
    const id=await ctx.user(req,reply);
    if (!id) return null;
    const {farmId}=z.object({farmId:z.string().uuid()}).parse(req.params);
    if (!await ctx.member(farmId,id)) throw new ApiError('not_found',404);
    if (!await ctx.member(farmId,id,['owner'])) throw new ApiError('owner_required',403);
    return {id,farmId,sessionHash:sha256(req.headers.authorization!.slice('Bearer '.length))};
  }
  const selected=(req:FastifyRequest)=>z.object({gatewayId}).parse(req.params).gatewayId;
  async function guarded<T>(action:()=>Promise<T>) {
    try {return await action();}
    catch(error) {
      if (error instanceof ApiError || error instanceof z.ZodError) throw error;
      throw new ApiError('node_red_unavailable',error instanceof NodeRedError && error.rejected?409:503,{message:safeNodeRedError(error)});
    }
  }
  const base='/v1/farms/:farmId/node-red/gateways';
  app.get(base,async(req,reply)=>{
    const owner=await actor(req,reply);if (!owner) return;
    return guarded(()=>service.gateways(owner));
  });
  app.get(base+'/:gatewayId/packages',async(req,reply)=>{
    const owner=await actor(req,reply);if (!owner) return;
    return guarded(()=>service.status(owner,selected(req)));
  });
  const mutationOptions={bodyLimit:4096,config:{rateLimit:{max:12,timeWindow:'1 minute'}}};
  app.post(base+'/:gatewayId/packages/review',mutationOptions,async(req,reply)=>{
    const owner=await actor(req,reply);if (!owner) return;
    return guarded(()=>service.review(owner,selected(req),packageSelection.parse(req.body)));
  });
  app.post(base+'/:gatewayId/packages/install',mutationOptions,async(req,reply)=>{
    const owner=await actor(req,reply);if (!owner) return;
    const operation=await guarded(()=>service.install(owner,selected(req),installRequest.parse(req.body)));
    return reply.code(202).send(operation);
  });
  app.post(base+'/:gatewayId/packages/reconcile',mutationOptions,async(req,reply)=>{
    const owner=await actor(req,reply);if (!owner) return;
    z.object({}).strict().parse(req.body);
    return {operation:await guarded(()=>service.reconcile(owner,selected(req)))};
  });
}
