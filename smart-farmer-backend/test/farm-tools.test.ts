import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import pg from 'pg';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import {digest,sealSecret} from '../src/operations/common.js';
import {phoneSignature,type PhoneEnvelope} from '../src/farm-tools/basic-phone.js';

const today=()=>new Date().toISOString().slice(0,10),now=()=>new Date().toISOString();
async function fixture(t:TestContext){
  const url=process.env.TEST_DATABASE_URL;assert.ok(url&&new URL(url).pathname.endsWith('_test'),'Isolated *_test PostgreSQL database required');
  const admin=new pg.Pool({connectionString:url}),schema='farmtools_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const app=buildApp(db,'http://localhost:5173');
  t.after(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const actors:any[]=[];
  async function actor(role?:string){
    const username='farmtools_'+randomUUID(),password='synthetic-farm-tools-2026';
    const registration=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName:'Synthetic tools farm'}});assert.equal(registration.statusCode,201,registration.body);
    const session=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});assert.equal(session.statusCode,200,session.body);
    const result={...registration.json(),token:session.json().token};
    if(role)await db.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)',[result.userId,actors[0].farmId,role]);
    actors.push(result);return result;
  }
  const owner=await actor();const base='/v1/farms/'+owner.farmId;
  const send=(method:any,path:string,payload?:any,who=owner)=>app.inject({method,url:path.startsWith('/v1/')?path:base+path,headers:{authorization:'Bearer '+who.token},...(payload===undefined?{}:{payload})});
  async function get(path:string,who=owner){const response=await send('GET',path,undefined,who);assert.equal(response.statusCode,200,response.body);return response.json();}
  async function post(path:string,payload:any,who=owner,status=201){const response=await send('POST',path,payload,who);assert.equal(response.statusCode,status,response.body);return response.json();}
  const crop=await post('/projects',{name:'Trial maize',crop:'maize'});
  return {app,db,owner,crop,base,actor,send,get,post};
}
function env(t:TestContext,values:Record<string,string>){const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});}
const price=()=>({id:randomUUID(),commodity:'Maize',market:'Mbare',price:12.5,currency:'USD',unit:'20 kg bag',observedAt:now(),source:'Recorded seller quotation, synthetic test only'});
const centre=()=>({id:randomUUID(),name:'Synthetic extension office',kind:'support_centre',area:'Test district',sourceUrl:'https://example.org/extension',verifiedOn:today()});
const trial=(projectId:string)=>({id:randomUUID(),name:'Mulch comparison',projectId,controlLabel:'Control plot',treatmentLabel:'Mulched plot',practice:'One recorded management difference',metric:'Measured harvest',unit:'kg per equal plot',startedOn:today()});

test('market prices retain unit, source and currency; require current management and isolate farms',async t=>{
  const f=await fixture(t),worker=await f.actor('worker'),outsider=await f.actor();const p=price();
  const saved=await f.post('/market-prices',p);assert.equal(saved.unit,p.unit);assert.equal(saved.source,p.source);assert.equal(saved.currency,'USD');
  await f.post('/market-prices',p,f.owner,200);
  assert.equal((await f.get('/market-prices?commodity=maize',worker)).items.length,1);
  assert.equal((await f.send('GET','/market-prices',undefined,outsider)).statusCode,404);
  assert.equal((await f.send('POST','/market-prices',price(),worker)).statusCode,404);
  assert.equal((await f.send('POST','/market-prices',{...p,price:13})).statusCode,409);
  assert.equal((await f.send('POST','/market-prices',{...price(),observedAt:new Date(Date.now()+86400000).toISOString()})).statusCode,400);
  assert.equal((await f.send('POST','/market-prices',{...price(),sourceUrl:'javascript:alert(1)'})).statusCode,400);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM financial_entries')).rows[0].n,0);
});

test('support distances are sorted across pages; visit requests require recorded confirmation',async t=>{
  const f=await fixture(t);const far=await f.post('/support/centres',{...centre(),latitude:-18,longitude:31}),near=await f.post('/support/centres',{...centre(),latitude:-17,longitude:31});
  const first=await f.get('/support/centres?latitude=-17&longitude=31&limit=1');assert.equal(first.items[0].id,near.id);assert.equal(first.items[0].distanceKm,0);assert.ok(first.nextCursor);
  const second=await f.get('/support/centres?latitude=-17&longitude=31&limit=1&cursor='+first.nextCursor);assert.equal(second.items[0].id,far.id);assert.equal(second.nextCursor,null);
  assert.equal((await f.get('/support/centres')).locationKnown,false);
  const visit=await f.post('/support/visits',{id:randomUUID(),centreId:near.id,requestedFor:new Date(Date.now()+86400000).toISOString(),reason:'Inspect trial plots'});
  assert.equal(visit.status,'requested');
  assert.equal((await f.send('PATCH','/support/visits/'+visit.id,{version:1,status:'completed',note:'No confirmation recorded'})).statusCode,409);
  assert.equal((await f.send('PATCH','/support/visits/'+visit.id,{version:1,status:'confirmed',note:'Officer confirmed by phone'})).statusCode,200);
  assert.equal((await f.send('PATCH','/support/visits/'+visit.id,{version:1,status:'cancelled',note:'Conflicting stale version'})).statusCode,409);
  assert.equal((await f.send('PATCH','/support/visits/'+visit.id,{version:2,status:'completed',note:'Visit actually completed'})).statusCode,200);
});

test('training content records review provenance and requires deliberate secure video links',async t=>{
  const f=await fixture(t),guide={id:randomUUID(),title:'Synthetic reading guide',summary:'Example only',content:'Record measured observations.',language:'en',sourceUrl:'https://example.org/guide',reviewedBy:'Test reviewer',reviewedOn:today()};
  await f.post('/support/guides',guide);
  assert.equal((await f.get('/support/guides?language=en')).items[0].reviewed_by,'Test reviewer');
  assert.equal((await f.send('POST','/support/guides',{...guide,id:randomUUID(),reviewedBy:''})).statusCode,400);
  assert.equal((await f.send('POST','/support/guides',{...guide,id:randomUUID(),videoUrl:'http://example.org/video.mp4'})).statusCode,400);
  assert.equal((await f.send('POST','/support/guides',{...guide,id:randomUUID(),videoSizeKb:100})).statusCode,400);
});

test('trial comparisons use all samples, preserve evidence and avoid zero-baseline percentages',async t=>{
  const f=await fixture(t),worker=await f.actor('worker');const saved=await f.post('/trials',trial(f.crop.id));
  const path='/trials/'+saved.id+'/observations';
  const sample={id:randomUUID(),arm:'control',value:0,observedAt:now(),source:'Calibrated synthetic scale'};
  await f.post(path,sample,worker);await f.post(path,sample,worker,200);
  await f.post(path,{...sample,id:randomUUID(),arm:'treatment',value:6});
  await f.post(path,{...sample,id:randomUUID(),arm:'treatment',value:8});
  const result=await f.get('/trials/'+saved.id+'?limit=1');
  assert.equal(result.observations.length,1);assert.ok(result.nextCursor);assert.deepEqual(result.summary.control,{count:1,mean:0});assert.deepEqual(result.summary.treatment,{count:2,mean:7});assert.equal(result.summary.difference,7);assert.equal(result.summary.percentChange,null);
  assert.match(result.summary.shareText,/n=2/);assert.match(result.summary.caution,/does not establish/);
  assert.equal((await f.send('POST',path,{...sample,id:randomUUID(),mediaIds:[randomUUID()]})).statusCode,404);
  const activityId=randomUUID(),receiptActivityId=randomUUID();
  for(const id of [activityId,receiptActivityId])await f.post('/activities',{id,projectId:f.crop.id,kind:'observation',observedAt:now(),note:'Synthetic trial evidence'});
  const photoId=randomUUID(),receiptId=randomUUID(),documentId=randomUUID();
  for(const [id,parent,mime]of [[photoId,activityId,'image/png'],[receiptId,receiptActivityId,'image/png'],[documentId,activityId,'application/pdf']])await f.db.query('INSERT INTO private_media(id,farm_id,activity_id,actor_id,mime_type,size_bytes,content_hash,object_key,filename) VALUES($1,$2,$3,$4,$5,12,$6,$7,$8)',[id,f.owner.farmId,parent,f.owner.userId,mime,'0'.repeat(64),id,'synthetic-evidence']);
  await f.post('/expenses',{id:randomUUID(),projectId:f.crop.id,category:'other',amount:1,currency:'USD',observedAt:now(),note:'Synthetic receipt linkage',receiptActivityId});
  const media=(await f.get('/media')).items;
  assert.equal(media.find((item:any)=>item.id===photoId).trial_eligible,true);
  assert.equal(media.find((item:any)=>item.id===receiptId).trial_eligible,false,'ordinary activity receipts are excluded even when the stored financial flag is false');
  assert.equal(media.find((item:any)=>item.id===documentId).trial_eligible,false);
  await f.post(path,{...sample,id:randomUUID(),mediaIds:[photoId]},worker);
  assert.equal((await f.send('POST',path,{...sample,id:randomUUID(),mediaIds:[receiptId]})).statusCode,404);
  assert.equal((await f.send('POST',path,{...sample,id:randomUUID(),mediaIds:[documentId]})).statusCode,404);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM forum_entries')).rows[0].n,0,'comparison never auto-publishes');
});

test('hydroponic and aquaponic systems validate farm projects and preserve zero-valued water logs',async t=>{
  const f=await fixture(t),worker=await f.actor('worker');
  const system={id:randomUUID(),name:'Synthetic nutrient loop',type:'hydroponics',cropProjectId:f.crop.id,volumeLitres:1000};
  const saved=await f.post('/growing-systems',system);
  assert.equal((await f.send('POST','/growing-systems',{...system,id:randomUUID(),type:'aquaponics'})).statusCode,400);
  assert.equal((await f.send('POST','/growing-systems',{...system,id:randomUUID(),type:'aquaponics',fishProjectId:f.crop.id})).statusCode,400);
  assert.equal((await f.send('POST','/growing-systems',{...system,id:randomUUID(),cropProjectId:randomUUID()})).statusCode,404);
  const path='/growing-systems/'+saved.id+'/logs',log={id:randomUUID(),observedAt:now(),source:'Synthetic calibrated meter',ph:7,ecMsCm:0,temperatureC:21,dissolvedOxygenMgL:6};
  await f.post(path,log,worker);await f.post(path,log,worker,200);
  const result=await f.get('/growing-systems/'+saved.id);assert.equal(result.logs.length,1);assert.equal(Number(result.logs[0].ec_ms_cm),0);assert.equal(Number(result.logs[0].ph),7);
  assert.equal((await f.send('POST',path,{...log,id:randomUUID(),ph:15})).statusCode,400);
  assert.equal((await f.send('POST',path,{id:randomUUID(),observedAt:now(),source:'No measurement'})).statusCode,400);
});

test('advisor supports English, enforces image consent and reports an unconfigured provider truthfully',async t=>{
  env(t,{AI_BASE_URL:'',AI_API_KEY:'',AI_MODEL:''});const f=await fixture(t);
  const path='/projects/'+f.crop.id+'/companion/chat',question={question:'What is recorded?',language:'en',referenceIds:[]};
  const result=await f.post(path,question,f.owner,200);assert.equal(result.mode,'record_based');assert.equal(result.imageAnalysed,false);assert.match(result.answer,/provider is not connected/);
  assert.equal((await f.send('POST',path,{...question,image:{mimeType:'image/jpeg',base64:'AAAA'}})).statusCode,400);
  assert.equal((await f.send('POST',path,{...question,imageConsent:true,image:{mimeType:'image/jpeg',base64:'AAAA'}})).statusCode,400);
  const image=await sharp({create:{width:10,height:10,channels:3,background:'#256a40'}}).png().toBuffer();
  const photo=await f.post(path,{...question,imageConsent:true,image:{mimeType:'image/png',base64:image.toString('base64')}},f.owner,200);assert.equal(photo.imageAnalysed,false);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM private_media')).rows[0].n,0,'advisor image is not persisted');
});

test('advisor sends sanitized consented image, bounds citations and rechecks membership after provider delay',async t=>{
  let received:any,revoke:(()=>Promise<void>)|undefined;
  const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received=JSON.parse(Buffer.concat(chunks).toString());await revoke?.();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'Record symptoms and ask a qualified adviser.',referenceIds:[],limitations:[]})}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  env(t,{NODE_ENV:'test',AI_BASE_URL:'http://127.0.0.1:'+(server.address()as any).port,AI_API_KEY:'synthetic',AI_MODEL:'synthetic-vision'});
  const f=await fixture(t);await f.db.query('UPDATE farms SET operations_settings=$2 WHERE id=$1',[f.owner.farmId,{aiEnabled:true}]);
  const image=await sharp({create:{width:20,height:20,channels:3,background:'#256a40'}}).png().toBuffer();
  const path='/projects/'+f.crop.id+'/companion/chat',body={question:'What is visible?',language:'en',imageConsent:true,image:{mimeType:'image/png',base64:image.toString('base64')}};
  const answer=await f.post(path,body,f.owner,200);assert.equal(answer.imageAnalysed,true);assert.equal(answer.mode,'model');assert.equal(received.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'),true);assert.match(received.messages[0].content,/untrusted evidence/);
  revoke=async()=>{await f.db.query('DELETE FROM memberships WHERE farm_id=$1 AND user_id=$2',[f.owner.farmId,f.owner.userId]);};
  assert.equal((await f.send('POST',path,body)).statusCode,404);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM companion_interactions')).rows[0].n,1);
});

test('signed basic-phone requests link only verified numbers, deduplicate writes and obey session revocation',async t=>{
  env(t,{PROVIDER_SECRET_KEY:'12'.repeat(32),BASIC_PHONE_WEBHOOK_SECRET:'34'.repeat(32)});const f=await fixture(t),channelId=randomUUID(),phone='+263770000001';
  await f.db.query("INSERT INTO notification_channels(id,user_id,channel,address_cipher,address_hash,masked_address,verified_at) VALUES($1,$2,'sms',$3,$4,'***0001',now())",[channelId,f.owner.userId,sealSecret(phone,channelId),digest(phone)]);
  const link=await f.post('/basic-phone/link',{id:randomUUID(),channelId,projectId:f.crop.id,consent:true});assert.equal(link.code.length,12);
  const provider=(text:string,extra:Partial<PhoneEnvelope>={})=>({id:randomUUID(),channel:'sms' as const,from:phone,sessionId:'',text,timestamp:now(),...extra});
  async function incoming(payload:PhoneEnvelope,signature=phoneSignature(payload,process.env.BASIC_PHONE_WEBHOOK_SECRET!)){return f.app.inject({method:'POST',url:'/v1/integrations/basic-phone',headers:{'x-farmer-signature':signature},payload});}
  assert.equal((await incoming(provider('LINK '+link.code),'0'.repeat(64))).statusCode,401);
  const wrong=await incoming(provider('LINK '+link.code,{from:'+263770000002'}));assert.match(wrong.json().message,/verify your phone/);
  assert.match((await incoming(provider('LINK '+link.code))).json().message,/Phone linked/);
  const rain=provider('RAIN 12.5');assert.match((await incoming(rain)).json().message,/12.5 mm/);assert.equal((await incoming(rain)).statusCode,200);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM weather_observations')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT kind FROM weather_observations')).rows[0].kind,'rainfall');
  assert.equal((await incoming({...rain,text:'RAIN 13'})).statusCode,409);
  const menu=await incoming(provider('',{channel:'ussd',sessionId:'test-session'}));assert.equal(menu.json().continueSession,true);
  assert.equal((await incoming(provider('1*7',{channel:'ussd',sessionId:'test-session'}))).statusCode,200);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM weather_observations')).rows[0].n,2);
  await f.send('DELETE','/v1/sessions/current');
  assert.match((await incoming(provider('RAIN 99'))).json().message,/expired/);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM weather_observations')).rows[0].n,2);
});

test('shared basic phones switch farms only after LINK; private/future alerts stay hidden and STOP opts out',async t=>{
  env(t,{PROVIDER_SECRET_KEY:'12'.repeat(32),BASIC_PHONE_WEBHOOK_SECRET:'34'.repeat(32)});const f=await fixture(t),other=await f.actor();const phone='+263770000003';
  const otherBase='/v1/farms/'+other.farmId,otherCrop=await f.post(otherBase+'/projects',{name:'Other test project',crop:'maize'},other);
  async function makeLink(who:any,projectId:string){const id=randomUUID();await f.db.query("INSERT INTO notification_channels(id,user_id,channel,address_cipher,address_hash,masked_address,verified_at) VALUES($1,$2,'sms',$3,$4,'***0003',now())",[id,who.userId,sealSecret(phone,id),digest(phone)]);return {channelId:id,...await f.post('/v1/farms/'+who.farmId+'/basic-phone/link',{id:randomUUID(),channelId:id,projectId,consent:true},who)};}
  async function send(text:string){const payload:PhoneEnvelope={id:randomUUID(),channel:'sms',from:phone,sessionId:'',text,timestamp:now()};const r=await f.app.inject({method:'POST',url:'/v1/integrations/basic-phone',payload,headers:{'x-farmer-signature':phoneSignature(payload,process.env.BASIC_PHONE_WEBHOOK_SECRET!)}});assert.equal(r.statusCode,200,r.body);return r.json();}
  const first=await makeLink(f.owner,f.crop.id);await send('LINK '+first.code);
  const second=await makeLink(other,otherCrop.id);
  await send('RAIN 3');assert.equal((await f.db.query('SELECT farm_id FROM weather_observations')).rows[0].farm_id,f.owner.farmId,'requesting another code cannot move an active number');
  await send('LINK '+second.code);await send('RAIN 4');
  const rows=(await f.db.query('SELECT farm_id,value FROM weather_observations ORDER BY value')).rows;assert.equal(rows[1].farm_id,other.farmId);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM farm_phone_links WHERE revoked_at IS NULL AND linked_at IS NOT NULL')).rows[0].n,1);
  assert.match((await send('LINK '+first.code)).message,/verify your phone/);
  for(const [kind,title,offset]of [['reminder','Visible reminder','0 hours'],['reminder','Future private reminder','1 hour'],['camera','Revoked camera title','0 hours']])await f.db.query("INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_id,dedupe_key,available_at) VALUES($1,$2,$3,'reminder',$4,$5,$6,now()+$7::interval)",[other.farmId,other.userId,kind,{title},randomUUID(),randomUUID(),offset]);
  const alerts=await send('ALERTS');assert.match(alerts.message,/Visible reminder/);assert.doesNotMatch(alerts.message,/Future private|Revoked camera/);
  await f.db.query('INSERT INTO notification_preferences(farm_id,user_id,sms) VALUES($1,$2,true)',[other.farmId,other.userId]);
  assert.match((await send('STOP')).message,/SMS alerts stopped/);
  assert.ok((await f.db.query('SELECT disabled_at FROM notification_channels WHERE id=$1',[second.channelId])).rows[0].disabled_at);
  assert.equal((await f.db.query('SELECT sms FROM notification_preferences WHERE farm_id=$1 AND user_id=$2',[other.farmId,other.userId])).rows[0].sms,false);
  await send('RAIN 99');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM weather_observations')).rows[0].n,2);
});
