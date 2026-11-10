import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {ApiError} from '../src/context.js';
import {nodeRedConfigurations} from '../src/node-red/configuration.js';
import {postgresInstallStore} from '../src/node-red/store.js';
import type {InstallOperation,NodeRedActor} from '../src/node-red/types.js';
import {gateway,selection,enrollment,environment,runtimeFixture,waitForOutcome,installBody} from './node-red-fixture.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL is required for Node-RED authorization and concurrency tests; use disposable PostgreSQL.');
async function fixture() {
  const schema='node_red_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:databaseUrl});
  await admin.query('CREATE SCHEMA '+schema);
  const options={connectionString:databaseUrl,options:'-c search_path='+schema};
  const db=new pg.Pool(options),farm=randomUUID();
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())
    await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await db.query("INSERT INTO farms(id,name,timezone) VALUES($1,'Synthetic farm','Africa/Harare')",[farm]);
  const configuration=()=>nodeRedConfigurations(environment({[gateway]:enrollment},{[gateway]:farm}));
  const runtime=runtimeFixture(configuration()[0]);
  const app=buildApp(db,'http://localhost:5173',{}, {configuration,fetcher:runtime.fetcher});
  async function account(role='owner',farmId=farm) {
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,'synthetic-fixture-hash','sn')",[id,'owner-'+id]);
    await db.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)',[id,farmId,role]);
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[sha256(token),id]);
    return {actor:{id,farmId,sessionHash:sha256(token)} satisfies NodeRedActor,headers:{authorization:'Bearer '+token},token};
  }
  const owner=await account(),store=postgresInstallStore(db);
  const base='/v1/farms/'+farm+'/node-red/gateways',packages=base+'/'+gateway+'/packages';
  return {schema,options,db,app,farm,configuration,runtime,account,owner,store,base,packages,
    close:async()=>{await app.close();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}};
}
const operation=(who:NodeRedActor):InstallOperation=>({
  id:randomUUID(),runtimeId:enrollment.runtimeId,targetRevision:'e'.repeat(64),farmId:who.farmId,
  gatewayId:gateway,actorId:who.id,...selection,state:'installing',message:'Synthetic reservation',
  startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()
});

test('all HTTP management routes enforce current session and farm ownership with no cross-farm calls',async()=>{
  const f=await fixture();
  try {
    const routes=[
      {method:'GET' as const,url:f.base},
      {method:'GET' as const,url:f.packages},
      {method:'POST' as const,url:f.packages+'/review',payload:selection},
      {method:'POST' as const,url:f.packages+'/install',payload:installBody('invalid')},
      {method:'POST' as const,url:f.packages+'/reconcile',payload:{}}
    ];
    for(const route of routes)assert.equal((await f.app.inject(route)).statusCode,401);
    for(const role of ['manager','worker','adviser']){
      const member=await f.account(role);
      for(const route of routes){const response=await f.app.inject({...route,headers:member.headers});assert.equal(response.statusCode,403);assert.equal(response.json().error,'owner_required');}
    }
    const otherFarm=randomUUID();
    await f.db.query("INSERT INTO farms(id,name,timezone) VALUES($1,'Other farm','Africa/Harare')",[otherFarm]);
    const other=await f.account('owner',otherFarm);
    for(const route of routes)assert.equal((await f.app.inject({...route,headers:other.headers})).statusCode,404);
    assert.equal(f.runtime.calls.length,0);
    const farms=await f.app.inject({method:'GET',url:'/v1/farms',headers:f.owner.headers});
    assert.deepEqual(farms.json().capabilities,['node-red-package-management-v1']);
    const list=await f.app.inject({method:'GET',url:f.base,headers:f.owner.headers});
    assert.equal(list.statusCode,200);assert.equal(list.json().items.length,1);assert.equal(list.json().items[0].gatewayId,gateway);
    const foreign=await f.app.inject({method:'GET',url:'/v1/farms/'+otherFarm+'/node-red/gateways',headers:other.headers});
    assert.equal(foreign.json().state,'disabled');assert.deepEqual(foreign.json().items,[]);
    await f.db.query('DELETE FROM sessions WHERE token_hash=$1',[f.owner.actor.sessionHash]);
    assert.equal((await f.app.inject({method:'GET',url:f.base,headers:f.owner.headers})).statusCode,401);
  } finally {await f.close();}
});
test('real PostgreSQL reservation serializes API replicas, survives pool restart and protects request identity',async()=>{
  const f=await fixture(),replica=new pg.Pool(f.options);
  let replicaClosed=false;
  try {
    const alternate=postgresInstallStore(replica),first=operation(f.owner.actor),second={...first,id:randomUUID()};
    const results=await Promise.allSettled([f.store.claim(first,f.owner.actor),alternate.claim(second,f.owner.actor)]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const winner=results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<{operation:InstallOperation;accepted:boolean}>;
    const saved=winner.value.operation;
    assert.equal(winner.value.accepted,true);
    assert.equal((await alternate.current(enrollment.runtimeId,f.farm))?.id,saved.id);
    assert.equal((await alternate.claim(saved,f.owner.actor)).accepted,false);
    await assert.rejects(alternate.claim({...saved,module:'different-package'},f.owner.actor),/different installation/);
    await replica.end();replicaClosed=true;
    const restarted=new pg.Pool(f.options);
    try {
      const store=postgresInstallStore(restarted);
      assert.equal((await store.current(enrollment.runtimeId,f.farm))?.state,'installing');
      await assert.rejects(store.claim({...first,id:randomUUID()},f.owner.actor),/pending or unconfirmed/);
      await store.finish({...saved,state:'unconfirmed',message:'Lost synthetic response'});
      await store.finish({...saved,state:'installed',message:'Verified synthetic inventory'});
      assert.equal((await f.store.finish({...saved,state:'unconfirmed',message:'Late network error'})).state,'installed');
      const count=await f.db.query('SELECT count(*) FROM node_red_package_operations');assert.equal(count.rows[0].count,'1');
      const audit=await f.db.query("SELECT action FROM audit_events WHERE entity_type='node_red_package' ORDER BY created_at,id");
      assert.equal(audit.rows.filter(row=>row.action==='install_reserved').length,1);
      assert.equal(audit.rows.filter(row=>row.action==='install_outcome').length,2);
    } finally {await restarted.end();}
  } finally {if(!replicaClosed)await replica.end();await f.close();}
});
test('reservation rechecks current owner and session independently of the HTTP route',async()=>{
  const f=await fixture();
  try {
    await f.db.query("UPDATE memberships SET role='manager' WHERE user_id=$1 AND farm_id=$2",[f.owner.actor.id,f.farm]);
    await assert.rejects(f.store.claim(operation(f.owner.actor),f.owner.actor),(error:unknown)=>error instanceof ApiError&&error.code==='owner_required');
    await f.db.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND farm_id=$2",[f.owner.actor.id,f.farm]);
    await f.db.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',[f.owner.actor.sessionHash]);
    await assert.rejects(f.store.claim(operation(f.owner.actor),f.owner.actor),(error:unknown)=>error instanceof ApiError&&error.code==='unauthorized');
    assert.equal((await f.db.query('SELECT count(*) FROM node_red_package_operations')).rows[0].count,'0');
  } finally {await f.close();}
});
test('HTTP install commits its reservation before one POST and keeps accepted-POST verification loss durable',async()=>{
  const f=await fixture();
  try {
    let durableAtPost=false;
    f.runtime.state.failReadback='settings';
    f.runtime.state.beforeRequest=async(_url,init)=>{
      if(init.method==='POST')durableAtPost=(await f.store.current(enrollment.runtimeId,f.farm))?.state==='installing';
    };
    const review=await f.app.inject({method:'POST',url:f.packages+'/review',headers:f.owner.headers,payload:selection});
    assert.equal(review.statusCode,200);
    const request=installBody(review.json().reviewToken);
    const installed=await f.app.inject({method:'POST',url:f.packages+'/install',headers:f.owner.headers,payload:request});
    assert.equal(installed.statusCode,202);
    assert.equal((await waitForOutcome(f.store,enrollment.runtimeId,f.farm)).state,'unconfirmed');
    assert.equal(durableAtPost,true);assert.equal(f.runtime.state.posts,1);
    const again=await f.app.inject({method:'POST',url:f.packages+'/install',headers:f.owner.headers,payload:{...request,requestId:randomUUID()}});
    assert.equal(again.statusCode,409);assert.equal(f.runtime.state.posts,1);
    const freshApp=buildApp(f.db,'http://localhost:5173',{}, {configuration:f.configuration,fetcher:f.runtime.fetcher});
    try {
      const status=await freshApp.inject({method:'GET',url:f.packages,headers:f.owner.headers});
      assert.equal(status.json().state,'unavailable');assert.equal(status.json().operation.id,request.requestId);assert.equal(status.json().operation.state,'unconfirmed');
      assert.ok(!JSON.stringify(status.json()).includes('secret-value'));
      f.runtime.state.failReadback='';
      const reconciled=await freshApp.inject({method:'POST',url:f.packages+'/reconcile',headers:f.owner.headers,payload:{}});
      assert.equal(reconciled.statusCode,200);assert.equal(reconciled.json().operation.state,'installed');assert.equal(f.runtime.state.posts,1);
    } finally {await freshApp.close();}
  } finally {await f.close();}
});
for(const change of ['membership','session'] as const)test('revoked '+change+' after reservation prevents installer transmission',async()=>{
  const f=await fixture();
  try {
    const review=await f.app.inject({method:'POST',url:f.packages+'/review',headers:f.owner.headers,payload:selection});
    let changed=false;
    f.runtime.state.beforeRequest=async()=>{
      if(changed)return;changed=true;
      if(change==='membership')await f.db.query("UPDATE memberships SET role='manager' WHERE user_id=$1 AND farm_id=$2",[f.owner.actor.id,f.farm]);
      else await f.db.query('DELETE FROM sessions WHERE token_hash=$1',[f.owner.actor.sessionHash]);
    };
    assert.equal((await f.app.inject({method:'POST',url:f.packages+'/install',headers:f.owner.headers,payload:installBody(review.json().reviewToken)})).statusCode,202);
    assert.equal((await waitForOutcome(f.store,enrollment.runtimeId,f.farm)).state,'failed');assert.equal(f.runtime.state.posts,0);
  } finally {await f.close();}
});
test('management fails closed without additive storage while existing readiness remains usable',async()=>{
  const f=await fixture();
  try {
    await f.db.query('DROP TABLE node_red_package_runtimes,node_red_package_operations');
    assert.equal((await f.app.inject({method:'GET',url:'/ready'})).statusCode,200);
    const status=await f.app.inject({method:'GET',url:f.packages,headers:f.owner.headers});
    assert.equal(status.json().state,'unavailable');assert.equal(status.json().operation,null);
    const review=await f.app.inject({method:'POST',url:f.packages+'/review',headers:f.owner.headers,payload:selection});
    assert.equal(review.statusCode,503);assert.equal(review.json().error,'node_red_unavailable');assert.equal(f.runtime.state.posts,0);
  } finally {await f.close();}
});
