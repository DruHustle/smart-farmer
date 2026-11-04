import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';

async function until(check:()=>Promise<boolean>,message:string,timeout=12000) {
  const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}assert.fail(message);
}
async function stop(child:ChildProcess|null) {
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Gateway failed to stop'));},8000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
}

test('real HTTP gateway confirms feedback, persists an outage buffer and never restarts an expired command',async()=>{
  const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString,'TEST_DATABASE_URL is required');
  const schema=`gateway_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  const temporary=await mkdtemp(join(tmpdir(),'smart-farmer-edge-'));
  let app=buildApp(db,'http://localhost:5173');app.log.level='silent';let gateway:ChildProcess|null=null;
  try{
    for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    const reg=await app.inject({method:'POST',url:'/v1/register',payload:{username:'gateway_fixture',password:'isolated-gateway-password',language:'sn',farmName:'Gateway fixture'}});assert.equal(reg.statusCode,201,reg.body);
    const signed=await app.inject({method:'POST',url:'/v1/sessions',payload:{username:'gateway_fixture',password:'isolated-gateway-password'}});const headers={authorization:`Bearer ${signed.json().token}`};
    const asset=randomUUID(),prefix=`/v1/farms/${reg.json().farmId}/assets/${asset}`;
    await app.inject({method:'POST',url:`/v1/farms/${reg.json().farmId}/assets`,headers,payload:{id:asset,name:'Fixture simulator',category:'pump',protocol:'simulator'}});
    const enrolled=await app.inject({method:'POST',url:prefix+'/gateway-token',headers,payload:{}});assert.equal(enrolled.statusCode,200);
    const address=await app.listen({host:'127.0.0.1',port:0});const port=Number(new URL(address).port);
    let logs='';
    const launch=()=>{
      const child=spawn(process.execPath,['edge/src/gateway.mjs'],{env:{...process.env,API_URL:address,ASSET_GATEWAY_TOKEN:enrolled.json().token,GATEWAY_STATE_DIR:temporary,POLL_MS:'1000',SIMULATOR_INTERLOCK_OK:'true'},stdio:['ignore','pipe','pipe']});
      child.stdout?.on('data',d=>{logs+=d;});child.stderr?.on('data',d=>{logs+=d;});return child;
    };
    gateway=launch();
    await until(async()=>Boolean((await db.query('SELECT last_observed_at FROM assets WHERE id=$1',[asset])).rows[0].last_observed_at),'Gateway did not send HTTP telemetry: '+logs);
    const first={id:randomUUID(),command:'start',confirmed:true,expiresAt:new Date(Date.now()+60000).toISOString()};
    assert.equal((await app.inject({method:'POST',url:prefix+'/commands',headers,payload:first})).statusCode,201);
    await until(async()=>(await db.query('SELECT status FROM equipment_commands WHERE id=$1',[first.id])).rows[0].status==='confirmed','Gateway did not confirm actual simulator feedback');
    assert.equal((await db.query('SELECT latest_telemetry FROM assets WHERE id=$1',[asset])).rows[0].latest_telemetry.running,true);
    await stop(gateway);gateway=null;
    const last={id:randomUUID(),command:'stop',confirmed:true,expiresAt:new Date(Date.now()+1500).toISOString()};
    assert.equal((await app.inject({method:'POST',url:prefix+'/commands',headers,payload:last})).statusCode,201);
    await app.close();gateway=launch();
    await until(async()=>{try{return JSON.parse(await readFile(join(temporary,'state.json'),'utf8')).buffer.length>0;}catch{return false;}},'Outage telemetry was not written durably');
    await delay(1600);await stop(gateway);gateway=null;
    const saved=JSON.parse(await readFile(join(temporary,'state.json'),'utf8'));assert.ok(saved.buffer.length>0);assert.equal(saved.running,true);
    app=buildApp(db,'http://localhost:5173');app.log.level='silent';await app.listen({host:'127.0.0.1',port});gateway=launch();
    await until(async()=>(await db.query('SELECT status FROM equipment_commands WHERE id=$1',[last.id])).rows[0].status==='expired','Expired command was not discarded at reconnection');
    await until(async()=>JSON.parse(await readFile(join(temporary,'state.json'),'utf8')).buffer.length===0,'Persisted telemetry did not drain');
    assert.equal(JSON.parse(await readFile(join(temporary,'state.json'),'utf8')).running,true,'Expired stop must never execute after reconnect');
    assert.ok((await db.query('SELECT count(*)::int AS n FROM telemetry WHERE asset_id=$1',[asset])).rows[0].n>=3);
  }finally{await stop(gateway);await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(temporary,{recursive:true,force:true});}
});
