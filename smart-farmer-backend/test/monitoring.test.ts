import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {evaluateMonitoringRules} from '../src/monitoring/rules.js';
import {forecastIsStale,normalizeMetNo,normalizeOpenMeteo,refreshDueWeather} from '../src/monitoring/weather.js';
import {queueNotifications} from '../src/operations/notifications.js';

async function fixture(){
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.endsWith('_test'),'An explicitly isolated database ending in _test is required');
  const schema='monitoring_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:url});
  await admin.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:url,options:'-c search_path='+schema});
  for(const file of (await readdir(new URL('../migrations',import.meta.url))).filter(x=>x.endsWith('.sql')).sort())await db.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  process.env.NODE_ENV='test';
  const app=buildApp(db,'http://localhost:5173');app.log.level='silent';
  async function register(){
    const username='monitor_'+randomUUID().slice(0,10),password='Synthetic-monitoring!2026';
    const r=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName:'Synthetic monitoring farm'}});
    assert.equal(r.statusCode,201,r.body);
    const s=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});assert.equal(s.statusCode,200,s.body);
    return {...r.json(),headers:{authorization:'Bearer '+s.json().token}};
  }
  const owner=await register(),prefix='/v1/farms/'+owner.farmId;
  const request=(method:any,path:string,payload?:any,actor=owner)=>app.inject({method,url:path.startsWith('/v1')?path:prefix+path,headers:actor.headers,...(payload===undefined?{}:{payload})});
  async function ok(method:any,path:string,payload?:any,status=200,actor=owner){const r=await request(method,path,payload,actor);assert.equal(r.statusCode,status,r.body);return r.json();}
  async function evaluate(now=Date.now()){
    const c=await db.connect();await c.query('BEGIN');
    try{const r=await evaluateMonitoringRules(c,now);await queueNotifications(c);await c.query('COMMIT');return r;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function asset(protocol='http'){
    const a=await ok('POST','/assets',{id:randomUUID(),name:'Synthetic sensor',category:'sensor',protocol,model:'Fixture'},201);
    await db.query("UPDATE assets SET integration_state=$2,configuration=$3 WHERE id=$1",[a.id,protocol==='simulator'?'simulated':'verified-read-only',{telemetry:[{name:'soil_moisture',unit:'%'}]}]);
    return a.id;
  }
  async function observation(assetId:string,value:number,extra:Record<string,unknown>={}){
    const id=randomUUID();
    await db.query('INSERT INTO asset_observations(id,farm_id,asset_id,measurement,value,unit,observed_at,source,quality,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id,owner.farmId,assetId,'soil_moisture',JSON.stringify(value),extra.unit??'%',extra.observedAt??new Date(),extra.source??'gateway',extra.quality??'good','synthetic']);
    return id;
  }
  return {app,db,owner,prefix,register,request,ok,evaluate,asset,observation,close:async()=>{await app.close();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}};
}
const rule=(extra:Record<string,unknown>={})=>({id:randomUUID(),name:'Farmer chosen threshold',source:'weather',metric:'temperature_2m',operator:'below',threshold:0,unit:'C',cooldownMinutes:1,...extra});
const metData=(now=Date.now())=>({properties:{meta:{updated_at:new Date(now).toISOString()},timeseries:[0,1,2].map((h)=>({time:new Date(now+h*3_600_000).toISOString(),data:{instant:{details:{air_temperature:h-2,relative_humidity:60,wind_speed:2}},...(h===2?{next_6_hours:{details:{precipitation_amount:60}}}:{next_1_hours:{details:{precipitation_amount:3}}})}}))}});
async function server(handler:Parameters<typeof createServer>[0]){
  const s=createServer(handler);await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+(s.address() as any).port,close:()=>new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()))};
}

test('MET forecast preserves missing hourly precipitation, converts wind and rejects unordered times',()=>{
  const now=Date.now(),data=metData(now),f=normalizeMetNo(data,-17.8,31.4);
  assert.deepEqual(f.hourly.precipitation,[3,3,null]);assert.deepEqual(f.hourly.wind_speed_10m,[7.2,7.2,7.2]);
  assert.ok(f.attribution.includes('MET Norway'));assert.equal(f.validUntil,new Date(now+3*3_600_000).toISOString());
  assert.equal(forecastIsStale({fetched_at:new Date(now),data:f},{latitude:-17.8,longitude:31.4},now),false);
  assert.equal(forecastIsStale({fetched_at:new Date(now),data:f},{latitude:-18,longitude:31.4},now),true);
  assert.equal(forecastIsStale({fetched_at:new Date(now+1),data:f},{latitude:-17.8,longitude:31.4},now+4*3_600_000),true);
  data.properties.timeseries.reverse();assert.throws(()=>normalizeMetNo(data,-17.8,31.4),/invalid_provider_response/);
  assert.throws(()=>normalizeOpenMeteo({hourly:{time:[10,10],temperature_2m:[1,2],relative_humidity_2m:[1,2],precipitation:[1,2],wind_speed_10m:[1,2]}},0,0),/invalid_provider_response/);
});

test('MET refresh identifies the app, truncates coordinates, caches, revalidates and keeps provider failures visible',async()=>{
  const f=await fixture();let requests=0,notModified=false,fail=false;let s:Awaited<ReturnType<typeof server>>|undefined;
  try{
    await f.ok('PATCH','/settings',{confirmed:true,weatherEnabled:true,latitude:-17.876543,longitude:31.412345});
    s=await server((req,res)=>{
      requests++;const u=new URL(req.url!,'http://localhost');
      assert.equal(u.searchParams.get('lat'),'-17.8765');assert.equal(u.searchParams.get('lon'),'31.4123');
      assert.equal(req.headers['user-agent'],'SmartFarmerTest https://example.invalid');
      if(fail){res.statusCode=503;res.end('unavailable');return;}
      if(notModified){assert.equal(req.headers['if-modified-since'],'Sat, 28 Nov 2026 10:00:00 GMT');res.statusCode=304;res.end();return;}
      res.setHeader('Content-Type','application/json');res.setHeader('Last-Modified','Sat, 28 Nov 2026 10:00:00 GMT');res.setHeader('Expires',new Date(Date.now()+4*3_600_000).toUTCString());res.end(JSON.stringify(metData()));
    });
    process.env.WEATHER_PROVIDER='met-no';process.env.MET_WEATHER_USER_AGENT='SmartFarmerTest https://example.invalid';process.env.WEATHER_API_URL=s.url;
    const first=await f.ok('POST','/weather/refresh',{});assert.equal(first.forecast.provider,'met-no');assert.equal(first.stale,false);assert.equal(first.locationMatched,true);
    await f.ok('POST','/weather/refresh',{});assert.equal(requests,1);
    const nearby=await f.register();
    await f.ok('PATCH','/v1/farms/'+nearby.farmId+'/settings',{confirmed:true,weatherEnabled:true,latitude:-17.876544,longitude:31.412349},200,nearby);
    const shared=await f.ok('POST','/v1/farms/'+nearby.farmId+'/weather/refresh',{},200,nearby);
    assert.equal(requests,1,'two farms with identical rounded provider coordinates share one request');
    assert.equal(shared.forecast.latitude,-17.876544);assert.equal(shared.locationMatched,true);
    assert.equal(shared.forecast.fetchedAt,first.forecast.fetchedAt,'copying a shared cache preserves its real fetch time');
    await f.db.query("UPDATE weather_refresh_state SET next_attempt_at=now()-interval '1 second'");
    await f.db.query("UPDATE weather_provider_cache SET next_attempt_at=now()-interval '1 second'");notModified=true;
    const validated=await f.ok('POST','/weather/refresh',{});assert.equal(requests,2);assert.deepEqual(validated.forecast.hourly,first.forecast.hourly);
    await f.db.query("UPDATE weather_refresh_state SET next_attempt_at=now()-interval '1 second'");
    await f.db.query("UPDATE weather_provider_cache SET next_attempt_at=now()-interval '1 second'");fail=true;
    const failed=await f.request('POST','/weather/refresh',{});assert.equal(failed.statusCode,503);
    const kept=await f.ok('GET','/weather');assert.equal(kept.lastError,'provider_unavailable');assert.deepEqual(kept.forecast.hourly,first.forecast.hourly);
    await f.ok('PATCH','/settings',{confirmed:true,latitude:-18});assert.equal((await f.ok('GET','/weather')).stale,true);
    await f.ok('PATCH','/settings',{confirmed:true,weatherEnabled:false});assert.equal((await f.request('POST','/weather/refresh',{})).statusCode,409);
  }finally{delete process.env.WEATHER_PROVIDER;delete process.env.MET_WEATHER_USER_AGENT;delete process.env.WEATHER_API_URL;if(s)await s.close();await f.close();}
});

test('monitoring rules enforce membership, exact units, source identity, replay and version conflicts',async()=>{
  const f=await fixture();try{
    const outsider=await f.register();
    assert.equal((await f.request('GET','/monitoring',undefined,outsider)).statusCode,404);
    assert.equal((await f.app.inject({method:'GET',url:f.prefix+'/monitoring'})).statusCode,401);
    const b=rule(),saved=await f.ok('POST','/monitoring/rules',b,201);assert.equal(saved.version,1);
    assert.equal((await f.ok('POST','/monitoring/rules',b)).id,b.id);
    assert.equal((await f.request('POST','/monitoring/rules',{...b,threshold:1})).statusCode,409);
    assert.equal((await f.request('POST','/monitoring/rules',rule({unit:'F'}))).statusCode,400);
    assert.equal((await f.request('POST','/monitoring/rules',rule({source:'asset',assetId:randomUUID(),metric:'soil_moisture',unit:'%'}))).statusCode,404);
    const changed=await f.ok('PATCH','/monitoring/rules/'+b.id,{version:1,enabled:false});assert.equal(changed.enabled,false);
    assert.equal((await f.request('PATCH','/monitoring/rules/'+b.id,{version:1,enabled:true})).statusCode,409);
    await f.db.query("INSERT INTO memberships(farm_id,user_id,role) VALUES($1,$2,'worker')",[f.owner.farmId,outsider.userId]);
    assert.equal((await f.request('POST','/monitoring/rules',rule(),outsider)).statusCode,404);
    assert.equal((await f.ok('GET','/monitoring',undefined,200,outsider)).commandCapability,false);
  }finally{await f.close();}
});

test('sensor thresholds reject stale, uncertain, changed-unit and simulated readings, then queue exactly one opted-in delivery',async()=>{
  const f=await fixture();try{
    const assetId=await f.asset(),b=rule({source:'asset',assetId,metric:'soil_moisture',unit:'%',operator:'below',threshold:20});
    await f.ok('POST','/monitoring/rules',b,201);
    await f.observation(assetId,10,{observedAt:new Date(Date.now()-4*3_600_000)});assert.equal((await f.evaluate()).alertsCreated,0);
    await f.observation(assetId,10,{quality:'uncertain'});assert.equal((await f.evaluate()).alertsCreated,0);
    await f.observation(assetId,10,{unit:'m'});assert.equal((await f.evaluate()).alertsCreated,0);
    const sim=await f.asset('simulator');await f.observation(sim,10,{source:'simulator'});
    await f.ok('POST','/monitoring/rules',rule({source:'asset',assetId:sim,metric:'soil_moisture',unit:'%',threshold:20}),201);
    assert.equal((await f.evaluate()).alertsCreated,0);
    await f.observation(assetId,10);
    await f.db.query("INSERT INTO notification_preferences(farm_id,user_id,push) VALUES($1,$2,true)",[f.owner.farmId,f.owner.userId]);
    await f.db.query("INSERT INTO notification_channels(id,user_id,channel,address_cipher,address_hash,masked_address,verified_at) VALUES($1,$2,'push','{}','synthetic-channel','Expo…fixture',now())",[randomUUID(),f.owner.userId]);
    const checks=await Promise.all([f.evaluate(),f.evaluate()]);assert.equal(checks.reduce((s,x)=>s+x.alertsCreated,0),1);
    assert.equal((await f.db.query('SELECT count(*) FROM monitoring_alerts')).rows[0].count,'1');
    assert.equal((await f.db.query('SELECT count(*) FROM notifications')).rows[0].count,'1');
    assert.equal((await f.db.query('SELECT count(*) FROM notification_deliveries')).rows[0].count,'1');
    await f.evaluate(Date.now()+65_000);assert.equal((await f.db.query('SELECT count(*) FROM monitoring_alerts')).rows[0].count,'1');
    const dashboard=await f.ok('GET','/monitoring');assert.equal(dashboard.sensors.find((s:any)=>s.assetId===assetId).value,10);
    assert.equal(dashboard.sensors.find((s:any)=>s.assetId===sim).simulated,true);
    assert.equal((await f.db.query('SELECT count(*) FROM equipment_commands')).rows[0].count,'0');
  }finally{await f.close();}
});

test('edge status separates recent gateway receipt from stale sensor data and never invents battery/data status',async()=>{
  const f=await fixture();try{
    const secret='synthetic-hmac-secret-for-monitoring-tests-only';
    process.env.SMART_FARMER_EDGE_GATEWAYS=JSON.stringify({synthetic:{farmId:f.owner.farmId,secret,sources:['sensor']},silent:{farmId:f.owner.farmId,secret,sources:['sensor']}});
    async function event(metric:string,value:number,unit:string,at=new Date().toISOString()){
      const body=JSON.stringify({schemaVersion:1,eventId:randomUUID(),sourceId:'sensor',observedAt:at,kind:'measurement',data:{assetId:'tank',metric,value,unit}});
      const time=String(Math.floor(Date.now()/1000)),signature='sha256='+createHmac('sha256',secret).update(time+'.'+body).digest('hex');
      const r=await f.app.inject({method:'POST',url:'/v1/edge/synthetic/events',headers:{'content-type':'application/vnd.smart-farmer.edge+json','x-edge-timestamp':time,'x-edge-signature':signature},payload:body});assert.equal(r.statusCode,202,r.body);
    }
    await event('water_level',1.5,'m',new Date(Date.now()-3*3_600_000).toISOString());
    const first=await f.ok('GET','/monitoring');assert.equal(first.gateways.find((x:any)=>x.id==='synthetic').state,'online');assert.equal(first.sensors[0].stale,true);assert.equal(first.gateways[0].batteryPercent,null);
    assert.equal(first.gateways.find((x:any)=>x.id==='silent').state,'unknown');
    await event('battery_percent',74,'%');
    const r=rule({source:'edge',gatewayId:'synthetic',sourceId:'sensor',edgeAssetId:'tank',metric:'water_level',unit:'m',threshold:2});
    await f.ok('POST','/monitoring/rules',r,201);assert.equal((await f.evaluate()).alertsCreated,0);
    await event('water_level',1.5,'m');assert.equal((await f.evaluate()).alertsCreated,1);
    const dashboard=await f.ok('GET','/monitoring');assert.equal(dashboard.gateways.find((x:any)=>x.id==='synthetic').batteryPercent,74);assert.equal(dashboard.gateways.find((x:any)=>x.id==='synthetic').dataUsageMb,null);
    assert.equal(dashboard.alerts[0].evidence.commissioned,false);
    delete process.env.SMART_FARMER_EDGE_GATEWAYS;assert.equal((await f.evaluate(Date.now()+65_000)).alertsCreated,0);
  }finally{delete process.env.SMART_FARMER_EDGE_GATEWAYS;await f.close();}
});

test('forecast alerts require matching coordinates and future valid samples, with automatic refresh only for opted-in rules',async()=>{
  const f=await fixture();let s:Awaited<ReturnType<typeof server>>|undefined;try{
    let requests=0;
    s=await server((_req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(metData(Date.now()+3_600_000)));});
    process.env.WEATHER_PROVIDER='met-no';process.env.MET_WEATHER_USER_AGENT='SmartFarmerTest https://example.invalid';process.env.WEATHER_API_URL=s.url;
    await f.ok('PATCH','/settings',{confirmed:true,weatherEnabled:true,latitude:-17.8,longitude:31.4});
    await refreshDueWeather(f.db);assert.equal(requests,0);
    await f.ok('POST','/monitoring/rules',rule(),201);await refreshDueWeather(f.db);assert.equal(requests,1);
    assert.equal((await f.evaluate()).alertsCreated,1);await f.evaluate(Date.now()+65_000);assert.equal((await f.db.query('SELECT count(*) FROM monitoring_alerts')).rows[0].count,'1');
    await f.ok('POST','/monitoring/rules',rule({name:'Other threshold',threshold:2}),201);
    await f.ok('PATCH','/settings',{confirmed:true,latitude:-18});assert.equal((await f.evaluate()).alertsCreated,0);
    await f.ok('PATCH','/settings',{confirmed:true,latitude:-17.8,weatherEnabled:false});assert.equal((await f.evaluate()).alertsCreated,0);
  }finally{delete process.env.WEATHER_PROVIDER;delete process.env.MET_WEATHER_USER_AGENT;delete process.env.WEATHER_API_URL;if(s)await s.close();await f.close();}
});

test('forecast failures after a location or provider change honor backoff instead of retrying each worker pass',async()=>{
  const f=await fixture();let s:Awaited<ReturnType<typeof server>>|undefined;
  try{
    let requests=0,fail=false;
    s=await server((_req,res)=>{requests++;if(fail){res.statusCode=503;res.end('fixture outage');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(metData()));});
    process.env.WEATHER_PROVIDER='met-no';process.env.MET_WEATHER_USER_AGENT='SmartFarmerTest https://example.invalid';process.env.WEATHER_API_URL=s.url;
    await f.ok('PATCH','/settings',{confirmed:true,weatherEnabled:true,latitude:-17.8,longitude:31.4});
    await f.ok('POST','/monitoring/rules',rule(),201);
    assert.deepEqual(await refreshDueWeather(f.db),{refreshed:1});assert.equal(requests,1);
    await f.ok('PATCH','/settings',{confirmed:true,latitude:-18});fail=true;
    await assert.rejects(()=>refreshDueWeather(f.db),/provider_unavailable/);assert.equal(requests,2);
    const state=(await f.db.query('SELECT * FROM weather_refresh_state WHERE farm_id=$1',[f.owner.farmId])).rows[0];
    assert.equal(state.location_key,`-18,31.4,${(await f.ok('GET','/settings')).timezone}`);
    assert.equal(state.last_error,'provider_unavailable');assert.ok(new Date(state.next_attempt_at).getTime()>Date.now());
    assert.deepEqual(await refreshDueWeather(f.db),{refreshed:0});assert.equal(requests,2,'changed coordinates do not bypass failure backoff');
    process.env.WEATHER_PROVIDER='open-meteo';
    await assert.rejects(()=>refreshDueWeather(f.db),/provider_unavailable/);assert.equal(requests,3);
    assert.equal((await f.db.query('SELECT provider FROM weather_refresh_state WHERE farm_id=$1',[f.owner.farmId])).rows[0].provider,'open-meteo');
    assert.deepEqual(await refreshDueWeather(f.db),{refreshed:0});assert.equal(requests,3,'changed providers do not bypass failure backoff');
    const saved=await f.ok('GET','/weather');assert.equal(saved.forecast.latitude,-17.8,'provider failure preserves prior evidence');assert.equal(saved.stale,true);
  }finally{delete process.env.WEATHER_PROVIDER;delete process.env.MET_WEATHER_USER_AGENT;delete process.env.WEATHER_API_URL;if(s)await s.close();await f.close();}
});
