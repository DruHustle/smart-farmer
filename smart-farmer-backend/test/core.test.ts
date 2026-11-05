import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required for core integration tests; use a disposable PostgreSQL database.');
const password='a-long-test-password-0123';
const observedAt='2026-11-03T10:00:00+02:00';
type Payload=Record<string,unknown>;
async function fixture() {
  const admin=new pg.Pool({connectionString:url});
  const schema=`core_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const app=buildApp(db,'http://localhost:5173');
  const register=await app.inject({method:'POST',url:'/v1/register',payload:{username:'test_owner',password,language:'sn',farmName:'Isolated test farm'}});assert.equal(register.statusCode,201,register.body);
  const registration=register.json();
  const login=await app.inject({method:'POST',url:'/v1/sessions',payload:{username:'test_owner',password}});assert.equal(login.statusCode,200,login.body);
  const headers={authorization:`Bearer ${login.json().token}`},farmId=registration.farmId as string;
  const path=`/v1/farms/${farmId}`;
  const send=(method:'GET'|'POST'|'PATCH'|'DELETE',route:string,payload?:Payload,h=headers)=>app.inject({method,url:route.startsWith('/v1')?route:path+route,headers:h,...(payload?{payload}:{})});
  const post=async(route:string,payload:Payload,status=201)=>{const r=await send('POST',route,payload);assert.equal(r.statusCode,status,r.body);return r.json();};
  const get=async(route:string,h=headers)=>{const r=await send('GET',route,undefined,h);assert.equal(r.statusCode,200,r.body);return r.json();};
  const project=async(type='crop',opening=0,more:Payload={})=>post('/projects',type==='crop'?{name:'Existing maize',crop:'maize',irrigation:true,...more}:{name:`${type} test`,enterpriseType:type,openingCount:opening,countBasis:'verified',asOfDate:'2026-11-03',...more});
  const stock=async(name:string,unit:string,quantity:number,more:Payload={})=>post('/stock',{id:randomUUID(),name,unit,quantity,...more});
  const event=async(projectId:string,type:string,more:Payload={},status=201)=>post(`/projects/${projectId}/events`,{id:randomUUID(),type,observedAt,...more},status);
  const count=async(id:string)=>Number((await db.query('SELECT current_count FROM projects WHERE id=$1',[id])).rows[0].current_count);
  const balance=async(id:string)=>Number((await db.query('SELECT quantity FROM stock_items WHERE id=$1',[id])).rows[0].quantity);
  const close=async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};
  return {app,db,headers,farmId,path,registration,send,post,get,project,stock,event,count,balance,close};
}

test('worker invitation, multi-farm membership, preference, recovery, one-use tokens and revocation',async()=>{
  const f=await fixture();try{
    const invite=await f.post('/invitations',{role:'worker'});
    const joinResponse=await f.app.inject({method:'POST',url:'/v1/invitations/accept',payload:{token:invite.token,username:'field_worker',password,language:'nd'}});assert.equal(joinResponse.statusCode,201,joinResponse.body);const joined=joinResponse.json();
    assert.equal(joined.farmId,f.farmId);assert.ok(joined.recoveryCode);
    const reused=await f.send('POST','/v1/invitations/accept',{token:invite.token,username:'another_worker',password,language:'sn'},{authorization:''});assert.equal(reused.statusCode,400);
    const login=await f.app.inject({method:'POST',url:'/v1/sessions',payload:{username:'field_worker',password,deviceName:'Shared phone'}});assert.equal(login.statusCode,200,login.body);const wh={authorization:`Bearer ${login.json().token}`};
    assert.equal(login.json().userId,joined.userId);assert.equal((await f.get('/v1/me',wh)).language,'nd');
    const language=await f.send('PATCH','/v1/me',{language:'sn'},wh);assert.equal(language.statusCode,200);
    assert.equal((await f.send('GET','/reports',undefined,wh)).statusCode,404);
    assert.equal((await f.send('POST','/invitations',{role:'manager'},wh)).statusCode,404);
    const sessions=await f.get('/v1/sessions',wh);assert.equal(sessions.items.length,1);assert.equal(sessions.items[0].label,'Shared phone');assert.equal(sessions.items[0].current,true);assert.equal(sessions.items[0].token_hash,undefined);
    const tokenRows=await f.db.query('SELECT token_hash FROM invitations');assert.notEqual(tokenRows.rows[0].token_hash,invite.token);
    const recovered=await f.app.inject({method:'POST',url:'/v1/recover',payload:{username:'field_worker',recoveryCode:joined.recoveryCode,password:'another-test-password-123'}});assert.equal(recovered.statusCode,204,recovered.body);
    assert.equal((await f.send('GET','/v1/me',undefined,wh)).statusCode,401);
    const recoveryReplay=await f.app.inject({method:'POST',url:'/v1/recover',payload:{username:'field_worker',recoveryCode:joined.recoveryCode,password}});assert.equal(recoveryReplay.statusCode,400);
    const after=await f.app.inject({method:'POST',url:'/v1/sessions',payload:{username:'field_worker',password:'another-test-password-123'}});assert.equal(after.statusCode,200);const newHeaders={authorization:`Bearer ${after.json().token}`};
    assert.equal((await f.get('/v1/me',newHeaders)).language,'sn');
    const other=await f.post('/v1/farms',{name:'Second isolated farm'});const secondInvite=await f.send('POST',`/v1/farms/${other.id}/invitations`,{role:'adviser'});assert.equal(secondInvite.statusCode,201);
    const acceptedExisting=await f.send('POST','/v1/invitations/accept',{token:secondInvite.json().token},newHeaders);assert.equal(acceptedExisting.statusCode,201);
    assert.equal((await f.get('/v1/farms',newHeaders)).items.length,2);
    const lastOwner=await f.send('DELETE',`/members/${f.registration.userId}`);assert.equal(lastOwner.statusCode,409);assert.equal(lastOwner.json().error,'last_owner');
    assert.equal((await f.send('DELETE',`/members/${joined.userId}`)).statusCode,204);
    assert.equal((await f.send('GET','/projects',undefined,newHeaders)).statusCode,404);
    assert.equal((await f.get('/v1/farms',newHeaders)).items.length,1);
    const newCode=await f.send('POST','/v1/recovery-codes',{password:'another-test-password-123'},newHeaders);assert.equal(newCode.statusCode,200);
    const race=await Promise.all([
      f.app.inject({method:'POST',url:'/v1/recover',payload:{username:'field_worker',recoveryCode:newCode.json().recoveryCode,password:'final-recovered-password-123'}}),
      f.app.inject({method:'POST',url:'/v1/sessions',payload:{username:'field_worker',password:'another-test-password-123'}})
    ]);assert.equal(race[0].statusCode,204,race[0].body);assert.ok([200,401].includes(race[1].statusCode));
    if(race[1].statusCode===200)assert.equal((await f.send('GET','/v1/me',undefined,{authorization:`Bearer ${race[1].json().token}`})).statusCode,401);
  }finally{await f.close();}
});

for (const method of ['PATCH','DELETE'] as const) {
  test(`queued membership ${method} rechecks owner authority after concurrent demotion`,{timeout:30_000},async()=>{
    const f=await fixture();let locker:pg.PoolClient|undefined;let pending:Promise<Awaited<ReturnType<typeof f.send>>>|undefined;
    try{
      const invite=await f.post('/invitations',{role:'worker'});
      const joined=await f.app.inject({method:'POST',url:'/v1/invitations/accept',payload:{token:invite.token,username:'second_owner',password,language:'sn'}});
      assert.equal(joined.statusCode,201,joined.body);const secondId=joined.json().userId;
      assert.equal((await f.send('PATCH',`/members/${secondId}`,{role:'owner'})).statusCode,200);
      const login=await f.app.inject({method:'POST',url:'/v1/sessions',payload:{username:'second_owner',password}});
      assert.equal(login.statusCode,200,login.body);const secondHeaders={authorization:`Bearer ${login.json().token}`};
      const thirdInvite=await f.post('/invitations',{role:'worker'});
      const third=await f.app.inject({method:'POST',url:'/v1/invitations/accept',payload:{token:thirdInvite.token,username:'retained_worker',password,language:'sn'}});
      assert.equal(third.statusCode,201,third.body);const thirdId=third.json().userId;
      const targetId=method==='PATCH'?secondId:thirdId;
      const auditBefore=Number((await f.db.query('SELECT count(*) FROM audit_events WHERE farm_id=$1',[f.farmId])).rows[0].count);
      locker=await f.db.connect();await locker.query('BEGIN');
      const lockerPid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await locker.query('SELECT id FROM farms WHERE id=$1 FOR UPDATE',[f.farmId]);
      pending=f.send(method,`/members/${targetId}`,method==='PATCH'?{role:'owner'}:undefined,secondHeaders).then(r=>r);
      // Observe the actual database wait: the request has passed the old pool-level
      // authorization check and cannot proceed until this transaction commits.
      const deadline=Date.now()+5000;let waiting=false;
      while(Date.now()<deadline){
        const result=await f.db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[lockerPid]);
        if(result.rowCount){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(waiting,'membership request must be waiting on the held farm lock');
      await locker.query("UPDATE memberships SET role='worker' WHERE farm_id=$1 AND user_id=$2",[f.farmId,secondId]);
      await locker.query('COMMIT');
      const response=await pending;assert.equal(response.statusCode,404,response.body);assert.equal(response.json().error,'not_found');
      const roles=await f.db.query('SELECT user_id,role FROM memberships WHERE farm_id=$1',[f.farmId]);
      assert.equal(roles.rows.find(row=>row.user_id===secondId)?.role,'worker');
      assert.equal(roles.rows.find(row=>row.user_id===f.registration.userId)?.role,'owner');
      assert.equal(roles.rows.find(row=>row.user_id===thirdId)?.role,'worker');
      assert.equal(Number((await f.db.query('SELECT count(*) FROM audit_events WHERE farm_id=$1',[f.farmId])).rows[0].count),auditBefore,'denied mutation creates no audit event');
      // The surviving owner still has authority, and the last-owner guard remains.
      assert.equal((await f.send('PATCH',`/members/${secondId}`,{role:'manager'})).statusCode,200);
      const lastOwner=await f.send('DELETE',`/members/${f.registration.userId}`);
      assert.equal(lastOwner.statusCode,409);assert.equal(lastOwner.json().error,'last_owner');
    }finally{
      if(locker){await locker.query('ROLLBACK');locker.release();}
      if(pending)await pending;
      await f.close();
    }
  });
}

test('maize facts, version conflict, offline-ID retry, transactional stock/cost/task and competing input use',async()=>{
  const f=await fixture();try{
    const projectId=randomUUID(),p=await f.project('crop',0,{id:projectId});const retry=await f.post('/projects',{id:projectId,name:'Existing maize',crop:'maize',irrigation:true},200);assert.equal(retry.id,p.id);const first=(await f.get('/projects')).items[0];assert.equal(first.planting_date,null);assert.equal(first.area_ha,null);
    const patch=await f.send('PATCH',`/projects/${p.id}`,{version:1,reason:'Confirmed planting record',plantingDate:'2026-10-20',areaHa:1});assert.equal(patch.statusCode,200);assert.equal(patch.json().version,2);
    const stale=await f.send('PATCH',`/projects/${p.id}`,{version:1,reason:'Other worker update',variety:'Recorded variety'});assert.equal(stale.statusCode,409);assert.equal(stale.json().current.version,2);
    const feed=await f.stock('Measured input','kg',10,{unitCost:2,currency:'USD'});
    const task=await f.post('/tasks',{id:randomUUID(),projectId:p.id,title:'Record input application',assigneeId:f.registration.userId,dueAt:observedAt});
    const activity={id:randomUUID(),projectId:p.id,kind:'input_use',observedAt,note:'Applied confirmed quantity',stockItemId:feed.id,quantity:2000,unit:'g',taskId:task.id,taskVersion:1};
    const attempts=await Promise.all([f.send('POST','/activities',activity),f.send('POST','/activities',activity)]);assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,201]);
    assert.equal(await f.balance(feed.id),8);const ledger=await f.db.query("SELECT * FROM financial_entries WHERE source_type='activity' AND source_id=$1",[activity.id]);assert.equal(ledger.rowCount,1);assert.equal(Number(ledger.rows[0].amount),4);assert.equal(ledger.rows[0].kind,'input_consumption');
    assert.equal((await f.get('/tasks')).items[0].status,'completed');assert.equal((await f.get('/activities')).items.length,1);
    const wrong=await f.send('POST','/activities',{...activity,quantity:3,unit:'kg'});assert.equal(wrong.statusCode,409);assert.equal(await f.balance(feed.id),8);
    const rejected=await f.send('POST','/activities',{id:randomUUID(),projectId:p.id,kind:'input_use',observedAt,stockItemId:feed.id,quantity:1,unit:'l'});assert.equal(rejected.statusCode,400);assert.equal((await f.get('/activities')).items.length,1);
    const one={id:randomUUID(),projectId:p.id,kind:'input_use',observedAt,stockItemId:feed.id,quantity:6,unit:'kg'};
    const race=await Promise.all([f.send('POST','/activities',one),f.send('POST','/activities',{...one,id:randomUUID()})]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[201,409]);assert.equal(await f.balance(feed.id),2);
    await f.post('/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount:5,currency:'USD'});
    await f.post('/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount:100,currency:'ZAR'});
    for(const amount of [0.1,0.3])await f.post('/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount,currency:'USD'});
    const fractionalMoney=await f.send('POST','/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount:0.000000001,currency:'USD'});assert.equal(fractionalMoney.statusCode,400);
    const reports=await f.get('/reports');assert.equal(reports.profit,null);assert.equal(reports.totals.find((r:any)=>r.currency==='USD'&&r.kind==='expense').amount,'5.40');assert.equal(reports.totals.find((r:any)=>r.currency==='ZAR'&&r.kind==='expense').amount,'100.00');
    const stock=await f.stock('Harvested maize','kg',0,{projectId:p.id});await f.post('/activities',{id:randomUUID(),projectId:p.id,kind:'harvest',observedAt,stockItemId:stock.id,quantity:12,unit:'kg'});
    await f.post(`/stock/${stock.id}/movements`,{id:randomUUID(),kind:'consumption',quantity:2,unit:'kg',observedAt,reason:'Household consumption'});assert.equal(await f.balance(stock.id),10);
    const tiny=await f.send('POST',`/stock/${stock.id}/movements`,{id:randomUUID(),kind:'adjustment',quantity:0.000000001,unit:'kg',observedAt,reason:'Must not round a recorded operation to zero'});assert.equal(tiny.statusCode,400);assert.equal(await f.balance(stock.id),10);
    const impreciseConversion=await f.send('POST',`/stock/${stock.id}/movements`,{id:randomUUID(),kind:'consumption',quantity:0.000001,unit:'g',observedAt,reason:'Quantity cannot be represented in this stock unit'});assert.equal(impreciseConversion.statusCode,400);assert.equal(impreciseConversion.json().error,'unit_precision_exceeded');assert.equal(await f.balance(stock.id),10);
  }finally{await f.close();}
});

test('worker assignment and financial isolation include linked animal cost metadata; incidents keep audit',async()=>{
  const f=await fixture();try{
    const p=await f.project();const inv=await f.post('/invitations',{role:'worker'});
    const join=await f.app.inject({method:'POST',url:'/v1/invitations/accept',payload:{token:inv.token,username:'worker_two',password,language:'sn'}});assert.equal(join.statusCode,201,join.body);const workerId=join.json().userId;
    const login=await f.app.inject({method:'POST',url:'/v1/sessions',payload:{username:'worker_two',password}});const wh={authorization:`Bearer ${login.json().token}`};
    const task=await f.post('/tasks',{id:randomUUID(),title:'Observe irrigated crop',projectId:p.id,assigneeId:workerId});
    const noEvidence=await f.send('PATCH',`/tasks/${task.id}`,{version:1,status:'completed'},wh);assert.equal(noEvidence.statusCode,400);
    const done=await f.send('PATCH',`/tasks/${task.id}`,{version:1,status:'completed',evidence:'Observation recorded'},wh);assert.equal(done.statusCode,200);
    const conflict=await f.send('PATCH',`/tasks/${task.id}`,{version:1,status:'started'},wh);assert.equal(conflict.statusCode,409);
    const stock=await f.stock('Feed','kg',2,{unitCost:3,currency:'USD'});const stockRows=await f.get('/stock',wh);assert.equal(stockRows.items[0].unit_cost,undefined);
    await f.post('/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount:9,currency:'USD',note:'Private cost'});assert.equal((await f.get('/activities',wh)).items.length,0);
    const deniedCost=await f.send('POST','/activities',{id:randomUUID(),projectId:p.id,kind:'cost',observedAt,amount:1,currency:'USD'},wh);assert.equal(deniedCost.statusCode,403);
    const incident=await f.send('POST','/incidents',{id:randomUUID(),projectId:p.id,title:'Problem observed',severity:'high'},wh);assert.equal(incident.statusCode,201);
    const assigned=await f.send('PATCH',`/incidents/${incident.json().id}`,{version:1,status:'acknowledged',assigneeId:workerId,note:'Assigned for follow up'});assert.equal(assigned.statusCode,200);
    const resolved=await f.send('PATCH',`/incidents/${incident.json().id}`,{version:2,status:'resolved',note:'Observed correction and documented result'},wh);assert.equal(resolved.statusCode,200);
    const history=await f.db.query('SELECT count(*) FROM audit_events WHERE entity_type=$1 AND entity_id=$2',['incident',incident.json().id]);assert.equal(Number(history.rows[0].count),2);
    assert.equal(await f.balance(stock.id),2);
  }finally{await f.close();}
});

test('broilers: placement, feeding, sampled growth, losses, partial sales, payment and explicit closure',async()=>{
  const f=await fixture();try{
    const p=await f.project('broiler');await f.event(p.id,'acquisition',{count:20,amount:10,currency:'USD'});assert.equal(await f.count(p.id),20);
    const feed=await f.stock('Broiler feed','kg',5,{unitCost:1.5,currency:'USD'});const feeding={id:randomUUID(),type:'feed',observedAt,stockItemId:feed.id,quantity:1,unit:'kg'};
    await f.post(`/projects/${p.id}/events`,feeding);await f.post(`/projects/${p.id}/events`,feeding,200);assert.equal(await f.balance(feed.id),4);
    await f.event(p.id,'growth_sample',{quantity:200,unit:'g',metadata:{sampleSize:5,measurementBasis:'mean_weight'}});assert.equal(await f.count(p.id),20);
    await f.event(p.id,'mortality',{count:1,note:'Observed loss'});await f.event(p.id,'sale',{count:9,amount:18,currency:'USD'});assert.equal(await f.count(p.id),10);
    const earlyClose=await f.send('POST',`/projects/${p.id}/events`,{id:randomUUID(),type:'close',observedAt,note:'Review'});assert.equal(earlyClose.statusCode,409);
    await f.event(p.id,'sale',{count:10,amount:20,currency:'USD'});assert.equal(await f.count(p.id),0);
    const ledger=(await f.get(`/projects/${p.id}/ledger`)).items;const revenue=ledger.find((x:any)=>x.kind==='revenue');const pay={id:randomUUID(),revenueId:revenue.id,amount:Number(revenue.amount),currency:'USD',observedAt,note:'Manually received'};
    const paid=await f.post(`/projects/${p.id}/payments`,pay);assert.equal(paid.providerVerified,false);await f.post(`/projects/${p.id}/payments`,pay,200);
    const over=await f.send('POST',`/projects/${p.id}/payments`,{...pay,id:randomUUID(),amount:1});assert.equal(over.statusCode,409);
    await f.event(p.id,'close',{note:'All birds reconciled'});assert.equal((await f.get('/projects')).items[0].status,'closed');
    const after=await f.send('POST',`/projects/${p.id}/events`,{id:randomUUID(),type:'observation',observedAt,note:'Should not mutate closed cycle'});assert.equal(after.statusCode,409);
    const totals=(await f.get('/reports')).totals;assert.equal(totals.find((r:any)=>r.kind==='revenue').amount,'38.00');assert.equal(totals.find((r:any)=>r.kind==='input_consumption').amount,'1.50');
  }finally{await f.close();}
});

test('layers and hatchery: egg grades/dispositions, traceable chicks, total hatch failure, no duplicated counts',async()=>{
  const f=await fixture();try{
    const layer=await f.project('layer',10),hatchery=await f.project('hatchery'),broiler=await f.project('broiler');
    const eggs=await f.stock('Saleable eggs','egg',0,{projectId:layer.id});await f.event(layer.id,'egg_collection',{count:10,stockItemId:eggs.id,metadata:{rejects:2}});assert.equal(await f.balance(eggs.id),8);
    await f.event(layer.id,'egg_consumption',{count:2,stockItemId:eggs.id});await f.event(layer.id,'egg_sale',{count:3,stockItemId:eggs.id,amount:1.5,currency:'USD'});assert.equal(await f.count(layer.id),10);assert.equal(await f.balance(eggs.id),3);
    await f.event(hatchery.id,'incubation',{count:3,stockItemId:eggs.id});assert.equal(await f.balance(eggs.id),0);assert.equal(await f.count(hatchery.id),3);
    const hatch={id:randomUUID(),type:'hatch',observedAt,count:2,destinationProjectId:broiler.id,metadata:{eggsProcessed:3,costAllocations:[{amount:0.5,currency:'USD',basis:'Recorded egg allocation'}]}};
    await f.post(`/projects/${hatchery.id}/events`,hatch);await f.post(`/projects/${hatchery.id}/events`,hatch,200);assert.equal(await f.count(hatchery.id),0);assert.equal(await f.count(broiler.id),2);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM project_cost_transfers')).rows[0].count),1);
    const incoming=await f.get(`/projects/${broiler.id}/events`);assert.equal(incoming.items[0].project_id,hatchery.id);
    await f.event(layer.id,'egg_collection',{count:2,stockItemId:eggs.id});await f.event(hatchery.id,'incubation',{count:2,stockItemId:eggs.id});await f.event(hatchery.id,'hatch',{count:0,metadata:{eggsProcessed:2},note:'No live chicks'});assert.equal(await f.count(broiler.id),2);assert.equal(await f.count(hatchery.id),0);
    const state=(await f.get('/projects')).items.find((p:any)=>p.id===layer.id);assert.equal(state.status,'active');
    const fractional=await f.send('POST','/stock',{id:randomUUID(),name:'Invalid fraction','unit':'egg',quantity:0.5});assert.equal(fractional.statusCode,400);
  }finally{await f.close();}
});

test('rabbit parents, mating, kindling, fostering, weaning, lineage and zero-live kindling reconcile',async()=>{
  const f=await fixture();try{
    const breeding=await f.project('rabbit_breeding',2),litter=await f.project('rabbit_growout'),foster=await f.project('rabbit_growout'),growout=await f.project('rabbit_growout');
    const dam=await f.post(`/projects/${breeding.id}/animals`,{id:randomUUID(),identifier:'Doe 1',sex:'female'});const sire=await f.post(`/projects/${breeding.id}/animals`,{id:randomUUID(),identifier:'Buck 1',sex:'male'});
    const mating=await f.event(breeding.id,'mating',{metadata:{damId:dam.id,sireId:sire.id,followUpAt:'2026-11-20T10:00:00+02:00'}});assert.equal((await f.get('/tasks')).items.length,1);
    await f.event(breeding.id,'kindling',{count:6,destinationProjectId:litter.id,metadata:{matingEventId:mating.id,stillborn:1}});assert.equal(await f.count(breeding.id),2);assert.equal(await f.count(litter.id),6);
    const duplicate=await f.send('POST',`/projects/${breeding.id}/events`,{id:randomUUID(),type:'kindling',observedAt,count:6,destinationProjectId:litter.id,metadata:{matingEventId:mating.id}});assert.equal(duplicate.statusCode,409);
    const kit=await f.post(`/projects/${litter.id}/animals`,{id:randomUUID(),identifier:'Kit 1',sex:'unknown',damId:dam.id,sireId:sire.id});
    await f.event(litter.id,'fostering',{count:1,destinationProjectId:foster.id,metadata:{identityIds:[kit.id]}});await f.event(litter.id,'weaning',{count:5,destinationProjectId:growout.id});assert.equal(await f.count(litter.id),0);assert.equal(await f.count(foster.id),1);assert.equal(await f.count(growout.id),5);
    const child=(await f.get(`/projects/${foster.id}/animals`)).items[0];assert.equal(child.dam_id,dam.id);assert.equal(child.sire_id,sire.id);
    const identityRequired=await f.send('POST',`/projects/${foster.id}/events`,{id:randomUUID(),type:'sale',observedAt,count:1,amount:3,currency:'USD'});assert.equal(identityRequired.statusCode,409);assert.equal(await f.count(foster.id),1);
    await f.event(foster.id,'sale',{count:1,amount:3,currency:'USD',metadata:{identityIds:[kit.id]}});assert.equal((await f.get(`/projects/${foster.id}/animals`)).items[0].status,'sold');
    const nextMating=await f.event(breeding.id,'mating',{metadata:{damId:dam.id,sireId:sire.id}});await f.event(breeding.id,'kindling',{count:0,metadata:{matingEventId:nextMating.id,stillborn:2}});assert.equal(await f.count(breeding.id),2);
  }finally{await f.close();}
});

test('fish nursery, sourced water data, samples, estimated transfers, partial harvest and reconciliation',async()=>{
  const f=await fixture();try{
    const nursery=await f.project('fish_nursery',0,{countBasis:'estimated',details:{species:'Documented species'}}),pond=await f.project('fish',0);
    await f.event(nursery.id,'stocking',{count:100});await f.event(nursery.id,'water_observation',{metadata:{measurement:'pH',value:7.2,unit:'pH',source:'Manual meter reading',testType:'Calibrated meter'}});
    await f.event(nursery.id,'growth_sample',{quantity:15,unit:'g',metadata:{sampleSize:10,measurementBasis:'mean_weight'}});
    await f.event(nursery.id,'transfer',{count:60,destinationProjectId:pond.id});assert.equal(await f.count(nursery.id),40);assert.equal(await f.count(pond.id),60);assert.equal((await f.db.query('SELECT count_basis FROM projects WHERE id=$1',[pond.id])).rows[0].count_basis,'estimated');
    const feed=await f.stock('Fish feed','kg',10,{unitCost:2,currency:'USD'});await f.event(pond.id,'feed',{stockItemId:feed.id,quantity:2,unit:'kg'});await f.event(pond.id,'mortality',{count:2,note:'Observed losses'});
    const fish=await f.stock('Harvested fish','kg',0,{projectId:pond.id});await f.event(pond.id,'harvest',{count:20,quantity:10,unit:'kg',stockItemId:fish.id});assert.equal(await f.count(pond.id),38);
    const wrongRoute=await f.send('POST','/activities',{id:randomUUID(),projectId:pond.id,kind:'harvest',observedAt,stockItemId:fish.id,quantity:1,unit:'kg'});assert.equal(wrongRoute.statusCode,409);assert.equal(wrongRoute.json().error,'animal_harvest_event_required');assert.equal(await f.balance(fish.id),10);assert.equal(await f.count(pond.id),38);
    await f.event(pond.id,'harvest',{count:38,quantity:19,unit:'kg',stockItemId:fish.id});assert.equal(await f.balance(fish.id),29);assert.equal(await f.count(pond.id),0);await f.event(pond.id,'close',{note:'Estimated stock reconciled against all recorded removals'});
    const unknown=await f.post('/projects',{name:'Uncounted pond',enterpriseType:'fish'});const unrecorded=await f.send('POST',`/projects/${unknown.id}/events`,{id:randomUUID(),type:'mortality',observedAt,count:1,note:'Cannot invent opening stock'});assert.equal(unrecorded.statusCode,409);
    await f.event(unknown.id,'adjustment',{count:12,metadata:{reason:'Documented manual estimate',countBasis:'estimated'}});assert.equal(await f.count(unknown.id),12);
  }finally{await f.close();}
});

test('treatment restrictions follow animals and egg/chick transfers and cannot be bypassed by backdated events',async()=>{
  const f=await fixture();try{
    const source=await f.project('fish',10),target=await f.project('fish',0);const startsAt=new Date(Date.now()-60_000).toISOString(),endsAt=new Date(Date.now()+86_400_000).toISOString();
    await f.post(`/projects/${source.id}/restrictions`,{id:randomUUID(),startsAt,endsAt,scope:'sale',reason:'Verified recorded withdrawal instruction',authorizedBy:'Test authorised professional'});
    await f.event(source.id,'transfer',{count:5,destinationProjectId:target.id});const carried=await f.get(`/projects/${target.id}/restrictions`);assert.equal(carried.items.length,1);assert.equal(carried.items[0].source_project_id,source.id);
    const sale=await f.send('POST',`/projects/${target.id}/events`,{id:randomUUID(),type:'sale',observedAt:'2025-01-01T00:00:00Z',count:1,amount:2,currency:'USD'});assert.equal(sale.statusCode,409);assert.equal(sale.json().error,'treatment_restriction');assert.equal(await f.count(target.id),5);
    await f.post(`/projects/${target.id}/restrictions`,{id:randomUUID(),startsAt,endsAt,scope:'harvest',reason:'Verified harvest restriction',authorizedBy:'Test authorised professional'});
    const output=await f.stock('Fish output','kg',0,{projectId:target.id});const harvest=await f.send('POST',`/projects/${target.id}/events`,{id:randomUUID(),type:'harvest',observedAt,count:1,quantity:0.5,unit:'kg',stockItemId:output.id});assert.equal(harvest.statusCode,409);assert.equal(await f.balance(output.id),0);
    const layer=await f.project('layer',2),incubator=await f.project('hatchery'),chicks=await f.project('broiler');const eggs=await f.stock('Eggs','egg',0,{projectId:layer.id});
    await f.post(`/projects/${layer.id}/restrictions`,{id:randomUUID(),startsAt,endsAt,scope:'sale',reason:'Verified output restriction',authorizedBy:'Test authorised professional'});
    await f.event(layer.id,'egg_collection',{count:2,stockItemId:eggs.id});await f.event(incubator.id,'incubation',{count:2,stockItemId:eggs.id});await f.event(incubator.id,'hatch',{count:2,destinationProjectId:chicks.id,metadata:{eggsProcessed:2}});
    const restriction=await f.get(`/projects/${chicks.id}/restrictions`);assert.equal(restriction.items.length,1);const blocked=await f.send('POST',`/projects/${chicks.id}/events`,{id:randomUUID(),type:'sale',observedAt,count:1,amount:2,currency:'USD'});assert.equal(blocked.statusCode,409);
  }finally{await f.close();}
});
