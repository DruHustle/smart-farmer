import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {runMaintenance} from '../src/worker.js';
import {sha256,token} from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
async function fixture() {
  assert.ok(url,'TEST_DATABASE_URL is required for integration verification');
  const schema=`integration_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  for(const migration of (await readdir(new URL('../migrations',import.meta.url))).filter(p=>p.endsWith('.sql')).sort())await db.query(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
  const media=await mkdtemp(join(tmpdir(),'smart-farmer-media-'));process.env.MEDIA_ROOT=media;
  const app=buildApp(db,'http://localhost:5173');app.log.level='silent';
  const register=async(name:string)=>{
    const username=`${name}_${randomUUID().slice(0,8)}`;const password='isolated-fixture-password';
    const created=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName:`${name} test farm`}});
    assert.equal(created.statusCode,201,created.body);
    const signed=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});assert.equal(signed.statusCode,200,signed.body);
    return {...created.json(),headers:{authorization:`Bearer ${signed.json().token}`}};
  };
  const owner=await register('owner');
  const request=async(method:any,path:string,payload?:object,actor=owner)=>app.inject({method,url:path,headers:actor.headers,...(payload?{payload}: {})});
  const prefix=`/v1/farms/${owner.farmId}`;
  const project=async()=>{const r=await request('POST',`${prefix}/projects`,{name:'Recorded maize',crop:'maize',irrigation:true});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  return {app,db,owner,register,request,prefix,project,close:async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(media,{recursive:true,force:true});}};
}

test('equipment: capability gates, freshness, interlocks, command replay, feedback and lost acknowledgements',async()=>{
  const f=await fixture();try{
    const unknown=randomUUID(),asset=randomUUID();
    assert.equal((await f.request('POST',`${f.prefix}/assets`,{id:unknown,name:'Unknown pump',category:'pump'})).statusCode,201);
    assert.equal((await f.request('POST',`${f.prefix}/assets`,{id:asset,name:'Simulator pump',category:'pump',protocol:'simulator'})).statusCode,201);
    const command=()=>({id:randomUUID(),command:'start',confirmed:true,expiresAt:new Date(Date.now()+60000).toISOString()});
    assert.equal((await f.request('POST',`${f.prefix}/assets/${unknown}/commands`,command())).json().error,'control_not_commissioned');
    assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,command())).json().error,'telemetry_stale');
    await f.request('POST',`${f.prefix}/assets/${asset}/simulate`,{running:false,interlockOk:false});
    assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,command())).json().error,'interlock_open');
    await f.request('POST',`${f.prefix}/assets/${asset}/simulate`,{running:false,interlockOk:true});
    const c=command();assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,c)).statusCode,201);
    assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,c)).statusCode,200);
    assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,{...c,command:'stop'})).statusCode,409);
    const gateway=await f.request('POST',`${f.prefix}/assets/${asset}/gateway-token`,{});assert.equal(gateway.statusCode,200);
    const edge={headers:{authorization:`Bearer ${gateway.json().token}`}};
    assert.equal((await f.request('POST',`/v1/edge/commands/${c.id}/result`,{status:'confirmed',feedback:{running:true,interlock_ok:true}},edge)).json().error,'command_not_dispatched');
    const dispatched=await f.request('POST','/v1/edge/commands/next',{},edge);assert.equal(dispatched.json().command.id,c.id);
    assert.equal((await f.request('POST','/v1/edge/commands/next',{},edge)).json().command,null,'never redeliver dispatched commands');
    assert.equal((await f.request('POST',`/v1/edge/commands/${c.id}/result`,{status:'acknowledged'},edge)).json().status,'acknowledged');
    assert.equal((await f.request('POST',`/v1/edge/commands/${c.id}/result`,{status:'confirmed'},edge)).json().error,'feedback_required');
    assert.equal((await f.request('POST',`/v1/edge/commands/${c.id}/result`,{status:'confirmed',feedback:{running:true,interlock_ok:true}},edge)).json().status,'confirmed');
    const lost={...command(),command:'stop'};await f.request('POST',`${f.prefix}/assets/${asset}/commands`,lost);await f.request('POST','/v1/edge/commands/next',{},edge);
    await f.db.query("UPDATE equipment_commands SET expires_at=now()-interval '1 second' WHERE id=$1",[lost.id]);await runMaintenance(f.db);
    assert.equal((await f.db.query('SELECT status FROM equipment_commands WHERE id=$1',[lost.id])).rows[0].status,'outcome_unknown');
    assert.equal((await f.request('POST','/v1/edge/commands/next',{},edge)).json().command,null);
    const expires=command();await f.request('POST',`${f.prefix}/assets/${asset}/commands`,expires);await f.db.query("UPDATE equipment_commands SET expires_at=now()-interval '1 second' WHERE id=$1",[expires.id]);await runMaintenance(f.db);
    assert.equal((await f.db.query('SELECT status FROM equipment_commands WHERE id=$1',[expires.id])).rows[0].status,'expired');
    const outsider=await f.register('outsider');assert.equal((await f.request('GET',`${f.prefix}/assets`,undefined,outsider)).statusCode,404);
    await f.request('POST',`${f.prefix}/assets/${asset}/gateway-token`,{});assert.equal((await f.request('POST','/v1/edge/commands/next',{},edge)).statusCode,401,'rotation invalidates prior device credential');
  }finally{await f.close();}
});

test('equipment waits cannot outlive expiry or gateway rotation; manual simulation audits dispatch',async()=>{
  const f=await fixture();let locker:pg.PoolClient|undefined;
  try{
    const asset=randomUUID();await f.request('POST',`${f.prefix}/assets`,{id:asset,name:'Concurrency simulator',category:'pump',protocol:'simulator'});
    await f.request('POST',`${f.prefix}/assets/${asset}/simulate`,{running:false,interlockOk:true});
    const gateway=await f.request('POST',`${f.prefix}/assets/${asset}/gateway-token`,{});const edge={headers:{authorization:`Bearer ${gateway.json().token}`}};
    const command={id:randomUUID(),command:'start',confirmed:true,expiresAt:new Date(Date.now()+60000).toISOString()};assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,command)).statusCode,201);
    const waitForLock=async()=>{
      for(let attempt=0;attempt<100;attempt++){
        const r=await f.db.query("SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND pid<>pg_backend_pid() LIMIT 1");
        if(r.rowCount)return;await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw new Error('Expected edge request to be waiting for asset lock');
    };
    locker=await f.db.connect();await locker.query('BEGIN');await locker.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE',[asset]);
    const pending=f.request('POST','/v1/edge/commands/next',{},edge);await waitForLock();
    // Expiry becomes past after the edge transaction began, while it waits on another row.
    await f.db.query("UPDATE equipment_commands SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[command.id]);
    await locker.query('COMMIT');const expired=await pending;assert.equal(expired.statusCode,200,expired.body);assert.equal(expired.json().command,null);assert.equal((await f.db.query('SELECT status FROM equipment_commands WHERE id=$1',[command.id])).rows[0].status,'expired');
    await locker.query('BEGIN');await locker.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE',[asset]);
    const beforeRotation=f.request('POST','/v1/edge/commands/next',{},edge);await waitForLock();
    await locker.query('UPDATE assets SET gateway_token_hash=$2 WHERE id=$1',[asset,sha256(token())]);await locker.query('COMMIT');assert.equal((await beforeRotation).statusCode,401);
    const manual={...command,id:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString()};assert.equal((await f.request('POST',`${f.prefix}/assets/${asset}/commands`,manual)).statusCode,201);
    const confirmed=await f.request('POST',`${f.prefix}/assets/${asset}/commands/${manual.id}/simulate`,{status:'confirmed',feedback:{running:true,interlock_ok:true}});assert.equal(confirmed.statusCode,200,confirmed.body);assert.equal(confirmed.json().status,'confirmed');
    const audit=await f.db.query('SELECT status FROM command_audit WHERE command_id=$1 ORDER BY id',[manual.id]);assert.deepEqual(audit.rows.map(r=>r.status),['requested','authorized','dispatched','confirmed']);
  }finally{if(locker){await locker.query('ROLLBACK');locker.release();}await f.close();}
});

test('private media: durable upload retry, separate activity, file validation, cross-farm and financial isolation',async()=>{
  const f=await fixture();try{
    const projectId=await f.project();const activityId=randomUUID();
    assert.equal((await f.request('POST',`${f.prefix}/activities`,{id:activityId,projectId,kind:'observation',observedAt:new Date().toISOString(),note:'Isolated attachment test'})).statusCode,201);
    const dataBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD0cAAAAASUVORK5CYII=';
    const body={id:randomUUID(),activityId,mimeType:'image/png',dataBase64,filename:'field.png'};
    assert.equal((await f.request('POST',`${f.prefix}/media`,body)).statusCode,201);
    assert.equal((await f.request('POST',`${f.prefix}/media`,body)).statusCode,200);
    assert.equal((await f.request('POST',`${f.prefix}/media`,{...body,filename:'changed-name.png'})).json().error,'idempotency_conflict');
    const read=await f.request('GET',`${f.prefix}/media/${body.id}/content`);assert.equal(read.statusCode,200);assert.equal(read.rawPayload.toString('base64'),dataBase64);
    assert.equal((await f.db.query("SELECT count(*) FROM audit_events WHERE entity_type='media' AND entity_id=$1 AND action='content_accessed'",[body.id])).rows[0].count,'1');
    assert.equal((await f.request('POST',`${f.prefix}/media`,{...body,id:randomUUID(),dataBase64:dataBase64+'#'})).statusCode,400);
    assert.equal((await f.request('POST',`${f.prefix}/media`,{...body,id:randomUUID(),dataBase64:Buffer.from('<script>alert(1)</script>').toString('base64')})).statusCode,400);
    const outsider=await f.register('outsider');assert.equal((await f.request('GET',`${f.prefix}/media/${body.id}/content`,undefined,outsider)).statusCode,404);
    assert.equal((await f.db.query('SELECT count(*) AS n FROM activities')).rows[0].n,'1');
    assert.equal((await f.db.query('SELECT count(*) AS n FROM private_media')).rows[0].n,'1');
    const workerId=randomUUID();await f.db.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)',[outsider.userId,f.owner.farmId,'worker']);
    const cost=randomUUID();await f.request('POST',`${f.prefix}/activities`,{id:cost,projectId,kind:'cost',observedAt:new Date().toISOString(),amount:5,currency:'USD'});
    const receipt={...body,id:workerId,activityId:cost};assert.equal((await f.request('POST',`${f.prefix}/media`,receipt)).statusCode,201);
    assert.equal((await f.request('GET',`${f.prefix}/media/${receipt.id}/content`,undefined,outsider)).statusCode,404);
    assert.equal((await f.request('GET',`${f.prefix}/media`,undefined,outsider)).json().items.length,1,'worker cannot list cost receipts');
  }finally{await f.close();}
});

test('market: concurrent reservations cannot oversell, cancellation releases stock and settlement is not an automatic payment',async()=>{
  const f=await fixture();try{
    const projectId=await f.project(),stockId=randomUUID(),listingId=randomUUID();
    assert.equal((await f.request('POST',`${f.prefix}/stock`,{id:stockId,projectId,name:'Harvested maize',unit:'kg',quantity:10})).statusCode,201);
    const listing={id:listingId,stockItemId:stockId,title:'Maize test fixture',quantity:10,price:2,currency:'USD',collectionArea:'Test collection area'};
    assert.equal((await f.request('POST',`${f.prefix}/listings`,listing)).statusCode,201);
    const buyer=await f.register('buyer');const one={id:randomUUID(),quantity:7},two={id:randomUUID(),quantity:7};
    const attempts=await Promise.all([f.request('POST',`/v1/market/listings/${listingId}/orders`,one,buyer),f.request('POST',`/v1/market/listings/${listingId}/orders`,two,buyer)]);
    assert.deepEqual(attempts.map(x=>x.statusCode).sort(),[201,409]);
    const accepted=attempts.find(x=>x.statusCode===201)!.json();
    assert.equal(Number((await f.db.query('SELECT reserved_quantity FROM stock_items WHERE id=$1',[stockId])).rows[0].reserved_quantity),7);
    assert.equal((await f.request('POST',`/v1/market/orders/${accepted.id}/status`,{status:'fulfilled'},buyer)).statusCode,404);
    assert.equal((await f.request('POST',`/v1/market/orders/${accepted.id}/status`,{status:'cancelled'},buyer)).statusCode,200);
    assert.equal(Number((await f.db.query('SELECT reserved_quantity FROM stock_items WHERE id=$1',[stockId])).rows[0].reserved_quantity),0);
    const final={id:randomUUID(),quantity:6};const created=await f.request('POST',`/v1/market/listings/${listingId}/orders`,final,buyer);assert.equal(created.statusCode,201);
    assert.equal((await f.request('POST',`/v1/market/listings/${listingId}/orders`,final,buyer)).statusCode,200);
    assert.equal((await f.request('POST',`/v1/market/orders/${final.id}/status`,{status:'fulfilled'})).statusCode,200);
    assert.equal((await f.request('POST',`/v1/market/orders/${final.id}/status`,{status:'fulfilled'})).statusCode,200);
    const stock=(await f.db.query('SELECT quantity,reserved_quantity FROM stock_items WHERE id=$1',[stockId])).rows[0];assert.equal(Number(stock.quantity),4);assert.equal(Number(stock.reserved_quantity),0);
    const ledger=(await f.db.query('SELECT kind,amount,currency FROM financial_entries')).rows;assert.equal(ledger.length,1);assert.equal(ledger[0].kind,'revenue');assert.equal(Number(ledger[0].amount),12);
    const payment={id:randomUUID(),amount:5,currency:'USD',note:'Manual receipt'};
    assert.equal((await f.request('POST',`/v1/market/orders/${final.id}/payments`,payment)).statusCode,201);
    assert.equal((await f.request('POST',`/v1/market/orders/${final.id}/payments`,payment)).statusCode,200);
    assert.equal((await f.request('POST',`/v1/market/orders/${final.id}/payments`,{...payment,id:randomUUID(),currency:'EUR'})).json().error,'currency_mismatch');
    const reports=(await f.request('GET',`${f.prefix}/reports`));assert.equal(reports.statusCode,200);
    await f.db.query("INSERT INTO treatment_restrictions(id,farm_id,project_id,starts_at,ends_at,scope,reason,authorized_by,created_by) VALUES($1,$2,$3,now()-interval '1 hour',now()+interval '1 day','sale','Test restriction','Test veterinarian',$4)",[randomUUID(),f.owner.farmId,projectId,f.owner.userId]);
    assert.equal((await f.request('POST',`/v1/market/listings/${listingId}/orders`,{id:randomUUID(),quantity:1},buyer)).json().error,'treatment_restriction');
  }finally{await f.close();}
});

test('services: request, quote, explicit version acceptance, concurrent overlap rejection and one project expense',async()=>{
  const f=await fixture();try{
    const provider=await f.register('provider'),serviceId=randomUUID();const projectId=await f.project();
    const listing={id:serviceId,name:'Tractor test',description:'Isolated service',serviceArea:'Test area',rate:25,currency:'USD',rateBasis:'hour',operatorIncluded:true,fuelIncluded:false};
    assert.equal((await f.request('POST',`/v1/farms/${provider.farmId}/services`,listing,provider)).statusCode,201);
    const startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.now()+90000000).toISOString();
    const a=randomUUID(),b=randomUUID();
    for(const id of [a,b]){
      assert.equal((await f.request('POST',`/v1/services/${serviceId}/bookings`,{id,farmId:f.owner.farmId,projectId,startsAt,endsAt})).statusCode,201);
      const quote=await f.request('POST',`/v1/farms/${provider.farmId}/bookings/${id}/status`,{status:'quoted',version:1,amount:25,currency:'USD'},provider);assert.equal(quote.statusCode,200,quote.body);
    }
    assert.equal((await f.request('POST',`${f.prefix}/bookings/${a}/status`,{status:'confirmed',version:1})).json().error,'version_conflict');
    const confirmed=await Promise.all([a,b].map(id=>f.request('POST',`${f.prefix}/bookings/${id}/status`,{status:'confirmed',version:2})));
    assert.deepEqual(confirmed.map(x=>x.statusCode).sort(),[200,409]);
    const accepted=confirmed.find(x=>x.statusCode===200)!.json();
    assert.equal((await f.request('POST',`${f.prefix}/bookings/${accepted.id}/status`,{status:'completed',version:accepted.version})).statusCode,200);
    assert.equal((await f.request('POST',`${f.prefix}/bookings/${accepted.id}/status`,{status:'completed',version:accepted.version})).statusCode,409);
    const expense=(await f.db.query("SELECT * FROM financial_entries WHERE source_type='service_booking' AND kind='expense'")).rows;assert.equal(expense.length,1);assert.equal(Number(expense[0].amount),25);assert.equal(expense[0].project_id,projectId);assert.equal(expense[0].farm_id,f.owner.farmId);const revenue=(await f.db.query("SELECT * FROM financial_entries WHERE source_type='service_booking' AND kind='revenue'")).rows;assert.equal(revenue.length,1);assert.equal(revenue[0].farm_id,provider.farmId);assert.equal(Number(revenue[0].amount),25);
    assert.equal((await f.request('POST','/v1/reviews',{id:randomUUID(),bookingId:accepted.id,rating:4,note:'Completed fixture'})).statusCode,201);
  }finally{await f.close();}
});

test('camera events stay private, preserve delayed event time, and expire through maintenance',async()=>{
  const f=await fixture();try{
    const camera=randomUUID();await f.request('POST',`${f.prefix}/assets`,{id:camera,name:'Simulated camera',category:'camera',protocol:'simulator'});
    const event={id:randomUUID(),assetId:camera,kind:'motion',observedAt:new Date(Date.now()-300000).toISOString(),retentionDays:1};
    assert.equal((await f.request('POST',`${f.prefix}/camera-events`,event)).statusCode,201);
    assert.equal((await f.request('POST',`${f.prefix}/camera-events`,event)).statusCode,200);
    const events=(await f.request('GET',`${f.prefix}/camera-events`)).json().items;assert.equal(events.length,1);assert.equal(events[0].kind,'motion');assert.equal(events[0].delayed,true);
    const outsider=await f.register('outsider');assert.equal((await f.request('GET',`${f.prefix}/camera-events`,undefined,outsider)).statusCode,404);
    await f.db.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)',[outsider.userId,f.owner.farmId,'worker']);
    assert.deepEqual((await f.request('GET',`${f.prefix}/camera-events`,undefined,outsider)).json().items,[],'no events without an explicit camera grant');
    await f.db.query("UPDATE camera_events SET expires_at=now()-interval '1 second' WHERE id=$1",[event.id]);await runMaintenance(f.db);
    assert.equal((await f.request('GET',`${f.prefix}/camera-events`)).json().items.length,0);
    assert.equal((await f.db.query("SELECT count(*) AS n FROM worker_heartbeats WHERE name='maintenance'")).rows[0].n,'1');
  }finally{await f.close();}
});

test('linked machinery listings share a resource lock and reject cross-listing overlap',async()=>{
  const f=await fixture();try{
    const provider=await f.register('provider'),assetId=randomUUID(),foreignAsset=randomUUID();
    assert.equal((await f.request('POST',`/v1/farms/${provider.farmId}/assets`,{id:assetId,name:'One physical tractor',category:'other'},provider)).statusCode,201);
    assert.equal((await f.request('POST',`${f.prefix}/assets`,{id:foreignAsset,name:'Other farm resource',category:'other'})).statusCode,201);
    const listing={id:randomUUID(),name:'Tractor service',description:'Isolated linked service',serviceArea:'Test area',rate:25,currency:'USD',rateBasis:'hour',operatorIncluded:true,fuelIncluded:false,resourceAssetId:assetId};
    assert.equal((await f.request('POST',`/v1/farms/${provider.farmId}/services`,{...listing,id:randomUUID(),resourceAssetId:foreignAsset},provider)).statusCode,404,'resource must belong to provider');
    const serviceA=listing.id,serviceB=randomUUID();
    for(const id of [serviceA,serviceB])assert.equal((await f.request('POST',`/v1/farms/${provider.farmId}/services`,{...listing,id},provider)).statusCode,201);
    const publicListings=await f.app.inject({method:'GET',url:'/v1/services'});assert.equal(publicListings.statusCode,200);assert.equal(publicListings.json().items[0].resource_asset_id,undefined,'private equipment identifier is not public');
    const startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.now()+90000000).toISOString();
    const bookings=[randomUUID(),randomUUID()];
    for(const [index,serviceId]of [serviceA,serviceB].entries()){
      assert.equal((await f.request('POST',`/v1/services/${serviceId}/bookings`,{id:bookings[index],farmId:f.owner.farmId,startsAt,endsAt})).statusCode,201);
      assert.equal((await f.request('POST',`/v1/farms/${provider.farmId}/bookings/${bookings[index]}/status`,{status:'quoted',version:1,amount:25,currency:'USD'},provider)).statusCode,200);
    }
    const confirmed=await Promise.all(bookings.map(id=>f.request('POST',`${f.prefix}/bookings/${id}/status`,{status:'confirmed',version:2})));
    assert.deepEqual(confirmed.map(r=>r.statusCode).sort(),[200,409]);assert.equal(confirmed.find(r=>r.statusCode===409)!.json().error,'booking_overlap');
    const accepted=confirmed.find(r=>r.statusCode===200)!.json();
    const cancelled=await f.request('POST',`${f.prefix}/bookings/${accepted.id}/status`,{status:'cancelled',version:accepted.version});assert.equal(cancelled.statusCode,200);
    const remaining=bookings.find(id=>id!==accepted.id)!;assert.equal((await f.request('POST',`${f.prefix}/bookings/${remaining}/status`,{status:'confirmed',version:2})).statusCode,200,'cancellation releases the resource across both listings');
  }finally{await f.close();}
});
