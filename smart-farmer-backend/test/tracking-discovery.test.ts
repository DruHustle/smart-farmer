import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';

const url=process.env.TEST_DATABASE_URL;
async function fixture(){
  assert.ok(url,'Disposable TEST_DATABASE_URL is required');
  const admin=new pg.Pool({connectionString:url});
  const schema='herd_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:url,options:'-c search_path='+schema+' -c statement_timeout=10000'});
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
    await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const app=buildApp(db,'http://localhost:5173');
  app.log.level='silent';
  async function register(label:string){
    const username=label+'_'+randomUUID().slice(0,8),password='private-herd-test-2026';
    const created=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName:label+' test farm'}});
    assert.equal(created.statusCode,201,created.body);
    const logged=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});
    assert.equal(logged.statusCode,200,logged.body);
    return {farmId:created.json().farmId,headers:{authorization:'Bearer '+logged.json().token}};
  }
  const owner=await register('seller'),buyer=await register('buyer');
  const request=(method:any,path:string,payload?:unknown,headers:Record<string,string>=owner.headers)=>app.inject({
    method,url:path,headers,...(payload===undefined?{}:{payload})
  });
  return {db,app,owner,buyer,request,async close(){
    await app.close();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  }};
}

test('GPS tracker ingest is private, signed, replay-safe and geofenced with stale proof',async()=>{
 const f=await fixture();
 try{
   const farm='/v1/farms/'+f.owner.farmId;
   const project=await f.request('POST',farm+'/projects',{name:'Existing grazing group',enterpriseType:'rabbit_growout',asOfDate:'2026-11-01',openingCount:4,countBasis:'verified'});
   assert.equal(project.statusCode,201,project.body);
   const p=project.json();
   const fence=await f.request('POST',farm+'/geofences',{id:randomUUID(),name:'Kraal',projectId:p.id,latitude:-17.82,longitude:31.05,radiusMeters:200});
   assert.equal(fence.statusCode,201,fence.body);
   const trackerId=randomUUID();
   const tracker=await f.request('POST',farm+'/trackers',{id:trackerId,projectId:p.id,animalId:null,provider:'demo',label:'Tagged lead animal',externalId:'demo-lead-001'});
   assert.equal(tracker.statusCode,201,tracker.body);
   const secret=tracker.json().ingestToken;
   assert.equal(secret.length,43);
   const roster=await f.request('GET',farm+'/trackers');
   assert.equal(roster.statusCode,200,roster.body);
   assert.equal(roster.json().items[0].coverage,'herd_representative');
   assert.equal(roster.body.includes(secret),false,'ingest key is never returned in list');
   assert.equal((await f.request('GET','/v1/farms/'+f.buyer.farmId+'/trackers',undefined,f.buyer.headers)).json().items.length,0);
   assert.equal((await f.request('GET',farm+'/trackers',undefined,f.buyer.headers)).statusCode,404);
   const endpoint='/v1/trackers/'+trackerId+'/observations';
   const first={id:randomUUID(),observedAt:new Date().toISOString(),latitude:-17.82,longitude:31.05,accuracyMeters:5,batteryPercent:80,quality:'simulated'};
   assert.equal((await f.request('POST',endpoint,first)).statusCode,401);
   const headers={'x-tracker-token':secret};
   const inside=await f.request('POST',endpoint,first,headers);
   assert.equal(inside.statusCode,201,inside.body);
   assert.equal((await f.request('POST',endpoint,first,headers)).statusCode,200);
   assert.equal((await f.request('POST',endpoint,{...first,latitude:-17.9},headers)).statusCode,409);
   const outside={...first,id:randomUUID(),observedAt:new Date(Date.now()+1000).toISOString(),latitude:-17.83,batteryPercent:12};
   assert.equal((await f.request('POST',endpoint,outside,headers)).statusCode,201);
   const alerts=await f.request('GET',farm+'/tracker-alerts');
   assert.equal(alerts.statusCode,200,alerts.body);
   assert.ok(alerts.json().items.some((x:any)=>x.kind==='outside_geofence'));
   assert.ok(alerts.json().items.some((x:any)=>x.kind==='low_battery'));
   const alert=alerts.json().items[0];
   assert.equal((await f.request('POST',farm+'/tracker-alerts/'+alert.id+'/acknowledge',{})).statusCode,200);
   const history=await f.request('GET',farm+'/trackers/'+trackerId+'/history');
   assert.equal(history.statusCode,200);
   assert.equal(history.json().items.length,2);
   const fresh=await f.request('GET',farm+'/trackers');
   assert.equal(fresh.json().items[0].latitude,outside.latitude);
   const rotate=await f.request('POST',farm+'/trackers/'+trackerId+'/rotate-token',{});
   assert.equal(rotate.statusCode,200,rotate.body);
   assert.notEqual(rotate.json().ingestToken,secret);
   assert.equal((await f.request('POST',endpoint,{...outside,id:randomUUID()},headers)).statusCode,401);
   assert.equal((await f.request('PATCH',farm+'/trackers/'+trackerId,{status:'revoked'})).statusCode,200);
   assert.equal((await f.request('POST',endpoint,{...outside,id:randomUUID()},{'x-tracker-token':rotate.json().ingestToken})).statusCode,401);
   const manual=await f.request('POST',farm+'/trackers',{id:randomUUID(),projectId:p.id,animalId:null,provider:'manual_reference',label:'AirTag reference only',externalId:'apple-find-my-label'});
   assert.equal(manual.statusCode,201,manual.body);
   assert.equal(manual.json().manualOnly,true);
   assert.equal(manual.json().ingestToken,undefined);
 }finally{await f.close();}
});
test('market discovery supports scoped favourites, saved searches, follows and matching alerts',async()=>{
 const f=await fixture();
 try{
   const seller='/v1/farms/'+f.owner.farmId;
   assert.equal((await f.request('GET','/v1/market/sellers/'+f.owner.farmId)).statusCode,404,'Private farms without public listings stay undiscoverable');
   assert.equal((await f.request('PUT','/v1/market/follows/'+f.owner.farmId,undefined,f.buyer.headers)).statusCode,404,'Cannot follow an unpublished farm');
   const saved=await f.request('POST','/v1/market/saved-searches',{id:randomUUID(),query:'maize',category:'produce',area:'Harare',currency:'USD',minPrice:1,maxPrice:5,condition:'',notify:true},f.buyer.headers);
   assert.equal(saved.statusCode,201,saved.body);
   const stock=await f.request('POST',seller+'/stock',{id:randomUUID(),name:'Stored maize',unit:'kg',quantity:100});
   assert.equal(stock.statusCode,201,stock.body);
   const makeListing=(title:string,price:number)=>({id:randomUUID(),stockItemId:stock.json().id,animalProjectId:null,title,quantity:10,price,currency:'USD',collectionArea:'Harare',category:'produce',condition:'fresh',grade:'A',terms:'Collect at market'});
   const listing=await f.request('POST',seller+'/listings',makeListing('Fresh maize',3));
   assert.equal(listing.statusCode,201,listing.body);
   const publicSeller=await f.request('GET','/v1/market/sellers/'+f.owner.farmId);
   assert.equal(publicSeller.statusCode,200,publicSeller.body);
   assert.equal(publicSeller.json().active_listings,1);
   const list=await f.request('GET','/v1/market/listings?area=harare&minPrice=2&maxPrice=4&currency=USD&condition=fresh');
   assert.equal(list.statusCode,200,list.body);
   assert.ok(list.json().items.some((x:any)=>x.id===listing.json().id));
   assert.equal((await f.request('GET','/v1/market/listings?minPrice=8&maxPrice=2')).statusCode,400);
   const alerts=await f.request('GET','/v1/market/alerts',undefined,f.buyer.headers);
   assert.equal(alerts.statusCode,200,alerts.body);
   assert.ok(alerts.json().items.some((x:any)=>x.listing_id===listing.json().id));
   const fav=await f.request('PUT','/v1/market/favorites/'+listing.json().id,undefined,f.buyer.headers);
   assert.equal(fav.statusCode,200,fav.body);
   assert.equal((await f.request('GET','/v1/market/favorites',undefined,f.buyer.headers)).json().items.length,1);
   const follow=await f.request('PUT','/v1/market/follows/'+f.owner.farmId,undefined,f.buyer.headers);
   assert.equal(follow.statusCode,200,follow.body);
   assert.equal((await f.request('PUT','/v1/market/follows/'+f.owner.farmId)).statusCode,400);
   const next=await f.request('POST',seller+'/listings',makeListing('Other produce',4));
   assert.equal(next.statusCode,201,next.body);
   const notices=(await f.request('GET','/v1/market/alerts',undefined,f.buyer.headers)).json().items;
   assert.ok(notices.some((x:any)=>x.kind==='followed_seller'&&x.listing_id===next.json().id));
   const seen=await f.request('POST','/v1/market/alerts/'+notices[0].id+'/read',{},f.buyer.headers);
   assert.equal(seen.statusCode,200,seen.body);
   assert.equal((await f.request('GET','/v1/market/favorites')).json().items.length,0);
   assert.equal((await f.request('DELETE','/v1/market/favorites/'+listing.json().id,undefined,f.buyer.headers)).statusCode,204);
   assert.equal((await f.request('DELETE','/v1/market/follows/'+f.owner.farmId,undefined,f.buyer.headers)).statusCode,204);
 }finally{await f.close();}
});
