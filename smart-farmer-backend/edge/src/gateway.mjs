import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {applyDecision,decideCommand,enqueueObservation} from './simulator.mjs';

const base=new URL(process.env.API_URL||'http://127.0.0.1:3000');
if(base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('API_URL must be an origin without embedded credentials');
if(base.protocol!=='https:' && !(base.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname) && process.env.NODE_ENV!=='production'))throw new Error('HTTPS is required outside local development');
const credential=process.env.ASSET_GATEWAY_TOKEN;
if(!credential||!/^[A-Za-z0-9_-]{43}$/.test(credential))throw new Error('An owner-issued simulator gateway token is required');
const interval=Number(process.env.POLL_MS||5000);
if(!Number.isInteger(interval)||interval<1000||interval>60000)throw new Error('POLL_MS must be between 1000 and 60000');
const directory=resolve(process.env.GATEWAY_STATE_DIR||'.data/gateway');
await mkdir(directory,{recursive:true,mode:0o700});
const file=resolve(directory,'state.json');
let state={version:1,running:false,interlockOk:process.env.SIMULATOR_INTERLOCK_OK==='true',executions:[],buffer:[],droppedObservations:0};
try{
  const saved=JSON.parse(await readFile(file,'utf8'));
  if(saved.version!==1||!Array.isArray(saved.executions)||!Array.isArray(saved.buffer)||typeof saved.running!=='boolean')throw new Error('Invalid gateway state; investigate before restarting');
  state={...saved,interlockOk:process.env.SIMULATOR_INTERLOCK_OK==='true'};
}catch(error){if(error.code!=='ENOENT')throw error;}
async function save(){const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(state),{mode:0o600,flag:'wx'});await rename(temporary,file);}
async function post(path,payload){
  const response=await fetch(new URL(path,base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});
  if(!response.ok){const error=new Error(`API returned ${response.status}`);error.status=response.status;throw error;}
  return response.json();
}
let stopping=false;const shutdown=new AbortController();
const stop=()=>{stopping=true;shutdown.abort();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log(JSON.stringify({event:'gateway_started',mode:'simulator',hardwareControl:false}));
while(!stopping){
  state=enqueueObservation(state,{id:randomUUID(),observedAt:new Date().toISOString(),measurements:{running:state.running,interlock_ok:state.interlockOk}});
  await save();
  try{
    while(state.buffer.length&&!stopping){await post('/v1/edge/telemetry',state.buffer[0]);state={...state,buffer:state.buffer.slice(1)};await save();}
    if(stopping)break;
    const {command}=await post('/v1/edge/commands/next',{});
    if(command){
      const decision=decideCommand(command,state);
      if(decision.status==='confirmed'){
        await post(`/v1/edge/commands/${command.id}/result`,{status:'acknowledged'});
        // Check the local deadline again after the network round trip.
        const current=decideCommand(command,state);
        if(current.status==='confirmed'){state=applyDecision(command,state,current);await save();}
        await post(`/v1/edge/commands/${command.id}/result`,current);
      }else await post(`/v1/edge/commands/${command.id}/result`,decision);
    }
    console.log(JSON.stringify({event:'gateway_synced',pending:state.buffer.length,dropped:state.droppedObservations}));
  }catch(error){
    console.warn(JSON.stringify({event:'gateway_sync_failed',httpStatus:error.status||null,pending:state.buffer.length}));
    if(error.status===401){stopping=true;process.exitCode=1;}
  }
  if(!stopping)await delay(interval,undefined,{signal:shutdown.signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
}
await save();
