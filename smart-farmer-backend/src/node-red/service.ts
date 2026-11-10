import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {NodeRedClient} from './client.js';
import {
  INSTALL_TIMEOUT_MS, REQUEST_TIMEOUT_MS, REVIEW_LIFETIME_MS,
  NodeRedError, nodeRedConfigurations, safeNodeRedError, type NodeRedConfiguration
} from './configuration.js';
import type {InstallStore} from './store.js';
import {
  gatewayId, installRequest, packageSelection, pendingInstall, type InstallOperation,
  type NodeRedActor, type NodeRedGateways, type NodeRedStatus, type PackageReview
} from './types.js';

const reviewPayload = packageSelection.extend({
  actorId:z.string().uuid(),farmId:z.string().uuid(),gatewayId,
  runtimeId:z.string().uuid(),
  revision:z.string().regex(/^[a-f0-9]{64}$/),expires:z.number().int()
}).strict();
type ReviewPayload = z.infer<typeof reviewPayload>;
const stamp = () => new Date().toISOString();
const matches = (item:Awaited<ReturnType<NodeRedClient['installed']>>,version:string) =>
  !!item && item.version === version && !item.pendingVersion && !item.loadError;
function sign(body:string,config:NodeRedConfiguration,sessionHash:string) {
  // Bind the opaque session without returning its token or stored hash.
  return createHmac('sha256',config.token).update(sessionHash).update('.').update(body).digest('base64url');
}
function encodeReview(payload:ReviewPayload,config:NodeRedConfiguration,sessionHash:string) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body+'.'+sign(body,config,sessionHash);
}
function decodeReview(token:string,actor:NodeRedActor,config:NodeRedConfiguration) {
  const parts = token.split('.'),[body,signature] = parts;
  const expected = Buffer.from(sign(body??'',config,actor.sessionHash)), received = Buffer.from(signature??'');
  if (parts.length !== 2 || expected.byteLength !== received.byteLength || !timingSafeEqual(expected,received))
    throw new NodeRedError('The package review is invalid or the gateway configuration changed. Review the package again.',true);
  let parsed:ReturnType<typeof reviewPayload.safeParse>;
  try {parsed=reviewPayload.safeParse(JSON.parse(Buffer.from(body,'base64url').toString('utf8')));}
  catch {throw new NodeRedError('The package review is invalid. Review the package again.',true);}
  if (!parsed.success || parsed.data.actorId !== actor.id || parsed.data.farmId !== actor.farmId ||
      parsed.data.gatewayId !== config.gatewayId ||
      parsed.data.runtimeId !== config.target.id || parsed.data.revision !== config.target.revision ||
      parsed.data.expires <= Date.now() || parsed.data.expires > Date.now()+REVIEW_LIFETIME_MS)
    throw new NodeRedError('The package review expired or no longer matches this owner session and gateway. Review the package again.',true);
  return parsed.data;
}

export class NodeRedPackageService {
  constructor(
    private readonly store:InstallStore,
    private readonly configuration:()=>NodeRedConfiguration[]=nodeRedConfigurations,
    private readonly fetcher:typeof fetch=fetch
  ) {}
  private config(actor:NodeRedActor,gateway:string) {
    const config=this.configuration().find(item=>item.farmId===actor.farmId && item.gatewayId===gateway);
    if (!config) throw new NodeRedError('Node-RED package management is not configured for this farm gateway.');
    return config;
  }
  private client(config:NodeRedConfiguration) {return new NodeRedClient(config,this.fetcher);}

  async gateways(actor:NodeRedActor):Promise<NodeRedGateways> {
    await this.store.authorize(actor);
    try {
      const entries=this.configuration().filter(item=>item.farmId===actor.farmId);
      return {state:entries.length?'configured':'disabled',
        message:entries.length?'Select an enrolled farm gateway.':'Package management is not configured for this farm. An operator must enroll its private maintenance route and dedicated credential.',
        items:entries.map(item=>({gatewayId:item.gatewayId,target:item.target}))};
    } catch(error) {return {state:'unavailable',message:safeNodeRedError(error),items:[]};}
  }
  async status(actor:NodeRedActor,gateway:string):Promise<NodeRedStatus> {
    await this.store.authorize(actor);
    let target:NodeRedStatus['target']=null,operation:InstallOperation|null=null;
    try {
      const config=this.config(actor,gateway);
      target=config.target;
      operation=await this.store.current(target.id,actor.farmId);
      const client=this.client(config);
      await client.checkRuntime();
      return {state:'ready',message:'Connected to the enrolled farm Node-RED runtime.',target,packages:await client.packages(),operation};
    } catch(error) {return {state:'unavailable',message:safeNodeRedError(error),target,packages:[],operation};}
  }
  async review(actor:NodeRedActor,gateway:string,selection:z.infer<typeof packageSelection>):Promise<PackageReview> {
    const input=packageSelection.parse(selection);
    await this.store.authorize(actor);
    const config=this.config(actor,gateway);
    if (pendingInstall(await this.store.current(config.target.id,actor.farmId)))
      throw new NodeRedError('Check the pending installation before reviewing another package.',true);
    const client=this.client(config);
    await client.checkRuntime();
    if (await client.installed(input))
      throw new NodeRedError('This package is already present. Updates and reinstalls require a separate gateway maintenance review.',true);
    const metadata=await client.packageMetadata(input), expires=Date.now()+REVIEW_LIFETIME_MS;
    return {...input,...metadata,target:config.target,expiresAt:new Date(expires).toISOString(),
      reviewToken:encodeReview({...input,actorId:actor.id,farmId:actor.farmId,
        gatewayId:gateway,runtimeId:config.target.id,revision:config.target.revision,expires},config,actor.sessionHash)};
  }
  async install(actor:NodeRedActor,gateway:string,request:z.infer<typeof installRequest>) {
    const input=installRequest.parse(request);
    await this.store.authorize(actor);
    const config=this.config(actor,gateway),reviewed=decodeReview(input.reviewToken,actor,config);
    const operation:InstallOperation={id:input.requestId,runtimeId:config.target.id,targetRevision:config.target.revision,
      actorId:actor.id,farmId:actor.farmId,gatewayId:gateway,module:reviewed.module,version:reviewed.version,
      state:'installing',message:'Installation reserved. The gateway will verify this owner request before running the package installer.',
      startedAt:stamp(),updatedAt:stamp()};
    const claimed=await this.store.claim(operation,actor);
    if (claimed.accepted) {
      // claim commits independently BEFORE remote mutation. A restart never
      // replays it; every API replica sees the durable pending runtime slot.
      void this.run(operation,config,actor).catch(()=>{
        // Persistence failure retains the pending slot; never retry or unlock.
      });
    }
    return claimed.operation;
  }
  private async run(operation:InstallOperation,config:NodeRedConfiguration,actor:NodeRedActor) {
    const client=this.client(config),selection={module:operation.module,version:operation.version};
    let transmitted=false,postCompleted=false,outcome:InstallOperation;
    try {
      await client.checkRuntime();
      const installed=await client.installed(selection);
      if (installed) {
        if (!matches(installed,operation.version))
          throw new NodeRedError('The package is present with another version or needs runtime attention. No update was requested.',true);
        outcome={...operation,state:'installed',message:'The exact package version was already present with no reported load errors. No installation request was sent.',updatedAt:stamp()};
      } else {
        if (this.config(actor,operation.gatewayId).target.revision !== operation.targetRevision)
          throw new NodeRedError('Gateway configuration changed after approval. Review the package again.',true);
        await this.store.authorize(actor);
        const current=await this.store.current(operation.runtimeId,actor.farmId);
        if (!current || current.id !== operation.id || current.state !== 'installing') return;
        transmitted=true;
        await client.install(selection);
        postCompleted=true;
        await client.checkRuntime();
        const verified=await client.installed(selection);
        if (!matches(verified,operation.version))
          throw new NodeRedError('Node-RED did not report the exact version without pending changes or load errors. Check the runtime before another installation.');
        outcome={...operation,state:'installed',message:'The exact package version is present in the enrolled runtime with no reported load errors. Commission its nodes separately before equipment use.',updatedAt:stamp()};
      }
    } catch(error) {
      outcome={...operation,state:transmitted && (postCompleted || !(error instanceof NodeRedError && error.rejected))?'unconfirmed':'failed',
        message:safeNodeRedError(error),updatedAt:stamp()};
    }
    await this.store.finish(outcome);
  }
  async reconcile(actor:NodeRedActor,gateway:string) {
    await this.store.authorize(actor);
    const config=this.config(actor,gateway),operation=await this.store.current(config.target.id,actor.farmId);
    if (!operation || !pendingInstall(operation)) return operation;
    if (operation.targetRevision !== config.target.revision)
      throw new NodeRedError('The gateway configuration changed since this request. Review the original enrollment before reconciling it.',true);
    if (operation.state === 'installing' && Date.now()-Date.parse(operation.startedAt) < INSTALL_TIMEOUT_MS+4*REQUEST_TIMEOUT_MS)
      throw new NodeRedError('The installation is still within its response window. Wait for its saved result before checking recovery.',true);
    const client=this.client(config);
    await client.checkRuntime();
    const installed=await client.installed({module:operation.module,version:operation.version});
    return this.store.finish({...operation,state:matches(installed,operation.version)?'installed':'unconfirmed',
      message:matches(installed,operation.version)
        ?'Read-back confirms the exact package version with no reported load errors. This verifies inventory, not commissioning or active flow behavior.'
        :'The exact version is unconfirmed. The installer may still be running or may have changed files. New installations remain blocked until the gateway is reviewed.',
      updatedAt:stamp()},actor.id);
  }
}
