import {randomUUID} from 'node:crypto';
import {NodeRedError,MANAGEMENT_PERMISSIONS,nodeRedConfigurations,type NodeRedConfiguration} from '../src/node-red/configuration.js';
import {pendingInstall,type InstallOperation,type NodeRedActor} from '../src/node-red/types.js';
import type {InstallStore} from '../src/node-red/store.js';

export const farmId='fd8af0f8-7cb2-43c8-97bf-7bc011a0e293';
export const actor:NodeRedActor={id:'83e61784-ff1b-42b2-9177-354070a50ed0',farmId,sessionHash:'b'.repeat(64)};
export const gateway='pi-farm-1';
export const selection={module:'@fixture/node-red-test',version:'1.2.3'};
export const enrollment={runtimeId:'8d70df1b-5722-4e7f-8dfc-e90cfa875a77',label:'Synthetic farm gateway',
  version:'4.1.4',adminUrl:'http://127.0.0.1:18880/admin',token:'a'.repeat(64)};
export const environment=(entries:Record<string,unknown>={[gateway]:enrollment},farms:Record<string,string>={[gateway]:farmId})=>({
  SMART_FARMER_NODE_RED_MANAGEMENT_ENABLED:'true',
  SMART_FARMER_EDGE_GATEWAYS:JSON.stringify(Object.fromEntries(Object.entries(farms).map(([id,farm])=>[id,{farmId:farm,secret:'s'.repeat(40),sources:['pivot-1']}]))),
  SMART_FARMER_NODE_RED_GATEWAYS:JSON.stringify(entries)
});
export const configurations=()=>nodeRedConfigurations(environment());
export function memoryStore() {
  const records=new Map<string,InstallOperation>();
  let current:InstallOperation|null=null;
  const control={authorizationError:null as Error|null,authorizations:0,claims:0};
  const store:InstallStore={
    authorize:async()=>{control.authorizations++;if(control.authorizationError)throw control.authorizationError;},
    current:async()=>structuredClone(current),
    claim:async(next,who)=>{
      await store.authorize(who);control.claims++;
      const existing=records.get(next.id);
      if(existing){
        if(['actorId','farmId','gatewayId','runtimeId','targetRevision','module','version'].some(key=>existing[key as keyof InstallOperation]!==next[key as keyof InstallOperation]))
          throw new NodeRedError('Request ID mismatch',true);
        return {operation:structuredClone(existing),accepted:false};
      }
      if(pendingInstall(current))throw new NodeRedError('Installation pending or unconfirmed',true);
      current=structuredClone(next);records.set(next.id,current);
      return {operation:structuredClone(next),accepted:true};
    },
    finish:async(next)=>{
      if(!current||current.id!==next.id)throw new Error('Wrong reservation');
      if(!pendingInstall(current))return structuredClone(current);
      current=structuredClone(next);records.set(next.id,current);return structuredClone(current);
    }
  };
  return {store,control};
}
export function runtimeFixture(config:NodeRedConfiguration=configurations()[0]) {
  const state={installed:false,posts:0,postFailure:null as 'lost'|'refused'|null,
    failReadback:'' as ''|'settings'|'nodes'|'plugins',pluginOnly:false,wrongVersion:false,
    pendingVersion:null as string|null,loadError:false,runtimeId:config.target.id,
    runtimeVersion:'4.1.4',permissions:[...MANAGEMENT_PERMISSIONS],
    palette:{allowInstall:true,allowUpdate:false,allowUpload:false},
    metadata:undefined as unknown,
    beforeRequest:undefined as undefined|((url:string,init:RequestInit)=>Promise<void>)};
  const calls:Array<{url:string;init:RequestInit}>=[];
  const entry=()=>({module:selection.module,name:'test',version:state.wrongVersion?'9.9.9':selection.version,enabled:true,
    ...(state.loadError?{err:'private upstream details'}:{})});
  const module=()=>({name:selection.module,version:entry().version,
    nodes:state.pluginOnly?[]:[entry()],plugins:state.pluginOnly?[entry()]:[],
    ...(state.pendingVersion?{pending_version:state.pendingVersion}:{}),path:'/private/userDir'});
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{
    'content-type':'application/json','x-smart-farmer-node-red-runtime':state.runtimeId}});
  const fetcher:typeof fetch=async(input,init={})=>{
    const url=String(input);calls.push({url,init});await state.beforeRequest?.(url,init);
    if(url.startsWith('https://registry.npmjs.org/'))return reply(state.metadata??{
      name:selection.module,version:selection.version,description:'Synthetic farm adapter',
      'node-red':state.pluginOnly?{plugins:{test:'plugin.js'}}:{nodes:{test:'node.js'}}});
    if(init.method==='POST'){
      state.posts++;
      if(state.postFailure==='refused')return reply({message:'Bearer secret-value'},401);
      if(state.postFailure==='lost')throw new Error('Bearer secret-value private.gateway');
      state.installed=true;return reply(module());
    }
    if(state.posts&&state.failReadback&&url.endsWith('/'+state.failReadback))return reply({message:'password=secret-value'},401);
    if(url.endsWith('/settings'))return reply({version:state.runtimeVersion,user:{permissions:state.permissions},externalModules:{palette:state.palette}});
    if(url.endsWith('/nodes'))return reply(state.installed&&!state.pluginOnly?[entry()]:[]);
    if(url.endsWith('/plugins'))return reply(state.installed&&state.pluginOnly?[entry()]:[]);
    if(url.endsWith('/nodes/'+encodeURIComponent(selection.module)))return reply(module());
    throw new Error('Unexpected fixture route');
  };
  return {state,calls,fetcher,reply};
}
export async function waitForOutcome(store:InstallStore,runtimeId=enrollment.runtimeId,farm=farmId) {
  const deadline=Date.now()+4_000;
  while(Date.now()<deadline){
    const value=await store.current(runtimeId,farm);
    if(value&&value.state!=='installing')return value;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Synthetic installation did not settle');
}
export const installBody=(reviewToken:string)=>({reviewToken,requestId:randomUUID(),acknowledgeCodeExecution:true as const});
