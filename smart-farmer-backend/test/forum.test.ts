import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import type {HTTPMethods} from 'fastify';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';

type Actor = {userId:string; farmId:string; username:string; farmName:string; headers:{authorization:string}};
type Response = {statusCode:number; body:string; json:()=>any};
const entryKeys = ['id','kind','displayName','title','topic','body','status','version','createdAt','updatedAt','replyCount','mine','canEdit','canModerate'].sort();
const discussion = (extra:Record<string,unknown>={}) => ({id:randomUUID(),displayName:'Community grower',title:'Mulching young maize',topic:'crops',body:'Which locally available mulch has worked for you?',shareWithCommunity:true,...extra});
const replyBody = (extra:Record<string,unknown>={}) => ({id:randomUUID(),displayName:'Neighbour grower',body:'We use dry grass and keep it away from the stems.',shareWithCommunity:true,...extra});
const editBody = (version:number, extra:Record<string,unknown>={}) => ({version,displayName:'Community grower',title:'Updated maize discussion',topic:'crops',body:'An updated question for the community.',shareWithCommunity:true,...extra});
function error(response:Response,status:number,code:string,message?:string) {
  assert.equal(response.statusCode,status,message?`${message}: ${response.body}`:response.body);
  assert.equal(response.json().error,code,response.body);
}
function publicEntry(entry:Record<string,unknown>,moderationReason=false) {
  assert.deepEqual(Object.keys(entry).sort(),[...entryKeys,...(moderationReason?['moderationReason']:[])].sort());
}

async function fixture(t:TestContext) {
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL is required; forum tests use real disposable PostgreSQL.');
  const admin=new pg.Pool({connectionString:url});
  const schema=`forum_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:schema});
  const app=buildApp(db,'http://localhost:5173');
  t.after(async()=>{
    await app.close();
    await db.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  });
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
  async function register(label:string):Promise<Actor> {
    const username=`private_${label}_${randomUUID().slice(0,8)}`,farmName=`Private ${label} farm ${randomUUID()}`;
    const password='forum-test-password-2026';
    const created=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName}});
    assert.equal(created.statusCode,201,created.body);
    const login=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});
    assert.equal(login.statusCode,200,login.body);
    return {...created.json(),username,farmName,headers:{authorization:`Bearer ${login.json().token}`}};
  }
  const owner=await register('owner');
  const base=(farmId=owner.farmId)=>`/v1/farms/${farmId}/forum`;
  const send=async(method:HTTPMethods,path:string,payload?:Record<string,unknown>,actor:Actor=owner,farmId=owner.farmId)=>app.inject({
    method,url:path.startsWith('/v1/')?path:base(farmId)+path,headers:actor.headers,
    ...(payload===undefined?{}:{payload}),
  });
  async function post(path:string,payload:Record<string,unknown>,actor=owner,farmId=owner.farmId,status=201) {
    const r=await send('POST',path,payload,actor,farmId);
    assert.equal(r.statusCode,status,r.body);return r.json();
  }
  async function get(path:string,actor=owner,farmId=owner.farmId) {
    const r=await send('GET',path,undefined,actor,farmId);
    assert.equal(r.statusCode,200,r.body);return r.json();
  }
  async function join(actor:Actor,role='worker',farmId=owner.farmId) {
    await db.query('INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,$3)',[actor.userId,farmId,role]);
  }
  async function fractionalTimes(table:'forum_entries'|'forum_reports',ids:string[]) {
    // Different database microseconds within one JavaScript millisecond must stay distinct.
    await db.query(`UPDATE ${table} SET created_at='2026-11-06T09:00:00.123000Z'::timestamptz + fixture.position*interval '100 microseconds'
      FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(id,position) WHERE ${table}.id=fixture.id`,[ids]);
  }
  async function waitForBlockedRequest(blocker:number) {
    const deadline=Date.now()+5000;
    do {
      const r=await db.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2::int=ANY(pg_blocking_pids(pid))',[schema,blocker]);
      if(r.rowCount)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    } while(Date.now()<deadline);
    assert.fail('Forum write did not reach the held authorization row lock');
  }
  return {app,db,owner,base,register,send,post,get,join,fractionalTimes,waitForBlockedRequest};
}

test('community feed crosses farms using only deliberately shared DTO fields and stable filters/pages',async t=>{
  const f=await fixture(t),neighbour=await f.register('neighbour');
  const privateProject=await f.send('POST',`/v1/farms/${f.owner.farmId}/projects`,{name:'Private field ledger',crop:'maize'});
  assert.equal(privateProject.statusCode,201,privateProject.body);
  const first=await f.post('/discussions',discussion({title:'Shade 50%_trial',body:'A literal percentage question.'}));
  const second=await f.post('/discussions',discussion({title:'Shade 500Xtrial',topic:'soil'}),neighbour,neighbour.farmId);
  const third=await f.post('/discussions',discussion({title:'Goat shelter',topic:'livestock'}));
  await f.fractionalTimes('forum_entries',[first.id,second.id,third.id]);
  const response=await f.send('GET','/discussions',undefined,neighbour,neighbour.farmId);
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.headers?.['cache-control'],'no-store');
  const feed=response.json();
  assert.equal(feed.items.length,3);
  for(const entry of feed.items)publicEntry(entry);
  const crossFarm=feed.items.find((entry:any)=>entry.id===first.id);
  assert.equal(crossFarm.body,'A literal percentage question.');
  assert.equal(crossFarm.mine,false);assert.equal(crossFarm.canEdit,false);assert.equal(crossFarm.canModerate,false);
  for(const privateValue of [f.owner.userId,f.owner.farmId,f.owner.username,f.owner.farmName,privateProject.json().id,'Private field ledger'])assert.equal(response.body.includes(privateValue),false,privateValue);
  assert.deepEqual((await f.get('/discussions?topic=soil',neighbour,neighbour.farmId)).items.map((entry:any)=>entry.id),[second.id]);
  assert.deepEqual((await f.get('/discussions?search=50%25_',neighbour,neighbour.farmId)).items.map((entry:any)=>entry.id),[first.id],'search wildcard characters are literal');
  assert.deepEqual((await f.get('/discussions?mine=true',neighbour,neighbour.farmId)).items.map((entry:any)=>entry.id),[second.id]);
  const ids:string[]=[];let cursor:string|null=null;
  do {
    const p=await f.get('/discussions?limit=1'+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''),neighbour,neighbour.farmId);
    assert.equal(p.items.length,1);ids.push(p.items[0].id);cursor=p.nextCursor;
    assert.ok(ids.length<=3,'pagination must terminate without repeating rows');
  } while(cursor);
  assert.equal(new Set(ids).size,3);assert.deepEqual(new Set(ids),new Set([first.id,second.id,third.id]));
  error(await f.send('GET','/discussions',undefined,neighbour,f.owner.farmId),404,'not_found');
});

test('thread replies cross farms, paginate in order, and expose no private author or source fields',async t=>{
  const f=await fixture(t),neighbour=await f.register('neighbour');
  const thread=await f.post('/discussions',discussion());
  const one=await f.post(`/discussions/${thread.id}/replies`,replyBody(),neighbour,neighbour.farmId);
  const two=await f.post(`/discussions/${thread.id}/replies`,replyBody({body:'Second observation.'}));
  await f.fractionalTimes('forum_entries',[one.id,two.id]);
  const page1=await f.get(`/discussions/${thread.id}?limit=1`,neighbour,neighbour.farmId);
  publicEntry(page1.discussion);publicEntry(page1.replies.items[0]);
  assert.equal(page1.replies.items[0].id,one.id);assert.ok(page1.replies.nextCursor);
  const page2=await f.get(`/discussions/${thread.id}?limit=1&cursor=${encodeURIComponent(page1.replies.nextCursor)}`,neighbour,neighbour.farmId);
  assert.equal(page2.replies.items[0].id,two.id);assert.equal(page2.replies.nextCursor,null);
  assert.equal((await f.get('/discussions')).items[0].replyCount,2);
  error(await f.send('POST',`/discussions/${one.id}/replies`,replyBody()),404,'not_found');
  error(await f.send('GET',`/discussions/${one.id}`),404,'not_found');
});

test('authentication, current selected-farm membership and source-farm author membership are enforced',async t=>{
  const f=await fixture(t),writer=await f.register('writer');await f.join(writer);
  error(await f.app.inject({method:'GET',url:f.base()+'/discussions'}),401,'unauthorized');
  const payload=discussion(),entry=await f.post('/discussions',payload,writer);
  const removed=await f.send('DELETE',`/v1/farms/${f.owner.farmId}/members/${writer.userId}`);
  assert.equal(removed.statusCode,204,removed.body);
  error(await f.send('GET','/discussions',undefined,writer),404,'not_found');
  error(await f.send('POST','/discussions',payload,writer),404,'not_found','replays require current membership');
  const ownView=await f.get(`/discussions/${entry.id}`,writer,writer.farmId);
  assert.equal(ownView.discussion.mine,true);assert.equal(ownView.discussion.canEdit,false);
  error(await f.send('PATCH',`/entries/${entry.id}`,editBody(1),writer,writer.farmId),404,'not_found');
  error(await f.send('DELETE',`/entries/${entry.id}`,{version:1},writer,writer.farmId),404,'not_found');
  const revoked=await f.send('DELETE','/v1/sessions/current',undefined,writer,writer.farmId);
  assert.equal(revoked.statusCode,204,revoked.body);
  error(await f.send('GET','/discussions',undefined,writer,writer.farmId),401,'unauthorized');
  error(await f.send('POST','/discussions',discussion(),writer,writer.farmId),401,'unauthorized');
  await f.db.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE user_id=$1',[f.owner.userId]);
  error(await f.send('GET','/discussions'),401,'unauthorized');
});

test('publishing is payload-bound and concurrent retries persist one entry and one audit event',async t=>{
  const f=await fixture(t),neighbour=await f.register('neighbour');
  const payload=discussion(),created=await f.post('/discussions',payload);
  assert.equal(created.duplicate,false);
  const replay=await f.post('/discussions',payload,f.owner,f.owner.farmId,200);
  assert.equal(replay.duplicate,true);assert.equal(replay.id,created.id);
  error(await f.send('POST','/discussions',{...payload,body:'A different message'}),409,'idempotency_conflict');
  error(await f.send('POST','/discussions',payload,neighbour,neighbour.farmId),409,'idempotency_conflict');
  const concurrent=discussion();
  const same=await Promise.all([f.send('POST','/discussions',concurrent),f.send('POST','/discussions',concurrent)]);
  assert.deepEqual(same.map(r=>r.statusCode).sort(),[200,201]);
  assert.deepEqual(same.map(r=>r.json().duplicate).sort(),[false,true]);
  const contested=discussion(),different={...contested,body:'Competing content with the same operation ID'};
  const conflict=await Promise.all([f.send('POST','/discussions',contested),f.send('POST','/discussions',different)]);
  assert.deepEqual(conflict.map(r=>r.statusCode).sort(),[201,409]);
  assert.equal(conflict.find(r=>r.statusCode===409)!.json().error,'idempotency_conflict');
  const stored=await f.db.query('SELECT body FROM forum_entries WHERE id=$1',[contested.id]);
  assert.equal(stored.rows[0].body,conflict.find(r=>r.statusCode===201)!.json().body);
  for(const id of [created.id,concurrent.id,contested.id]) {
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM forum_entries WHERE id=$1',[id])).rows[0].n,1);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='forum_published'",[id])).rows[0].n,1);
  }
  const reply=replyBody();
  const replies=await Promise.all([f.send('POST',`/discussions/${created.id}/replies`,reply),f.send('POST',`/discussions/${created.id}/replies`,reply)]);
  assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,201]);
  error(await f.send('POST',`/discussions/${created.id}/replies`,{...reply,body:'Changed reply'}),409,'idempotency_conflict');
  assert.equal((await f.get(`/discussions/${created.id}`)).replies.items.length,1);
});

test('only the author edits or deletes, version conflicts preserve content, and concurrent edits have one winner',async t=>{
  const f=await fixture(t),writer=await f.register('writer');await f.join(writer);
  const payload=discussion(),entry=await f.post('/discussions',payload,writer);
  error(await f.send('PATCH',`/entries/${entry.id}`,editBody(1)),404,'not_found','farm owners moderate without impersonating authors');
  error(await f.send('DELETE',`/entries/${entry.id}`,{version:1}),404,'not_found');
  const changed=await f.send('PATCH',`/entries/${entry.id}`,editBody(1,{displayName:'Chosen public name',topic:'soil'}),writer);
  assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().version,2);
  assert.equal(changed.json().displayName,'Chosen public name');assert.equal(changed.json().topic,'soil');
  error(await f.send('PATCH',`/entries/${entry.id}`,editBody(1),writer),409,'version_conflict');
  const races=await Promise.all([
    f.send('PATCH',`/entries/${entry.id}`,editBody(2,{body:'First revision'}),writer),
    f.send('PATCH',`/entries/${entry.id}`,editBody(2,{body:'Second revision'}),writer),
  ]);
  assert.deepEqual(races.map(r=>r.statusCode).sort(),[200,409]);
  const latest=(await f.get(`/discussions/${entry.id}`,writer)).discussion;
  assert.equal(latest.version,3);assert.equal(latest.body,races.find(r=>r.statusCode===200)!.json().body);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='forum_edited'",[entry.id])).rows[0].n,2);
  error(await f.send('DELETE',`/entries/${entry.id}`,{version:2},writer),409,'version_conflict');
  const removed=await f.send('DELETE',`/entries/${entry.id}`,{version:3},writer);
  assert.equal(removed.statusCode,204,removed.body);
  error(await f.send('PATCH',`/entries/${entry.id}`,editBody(4),writer),409,'forum_content_removed');
  error(await f.send('DELETE',`/entries/${entry.id}`,{version:4},writer),409,'forum_content_removed');
  const tombstone=await f.post('/discussions',payload,writer,f.owner.farmId,200);
  assert.equal(tombstone.status,'deleted');assert.equal(tombstone.body,'');assert.equal(tombstone.displayName,'');
  assert.equal(tombstone.canEdit,false);assert.equal(tombstone.canModerate,false);
  assert.equal((await f.get('/discussions?mine=true',writer)).items.length,0);
});

test('source-farm owners moderate with versioned audited reasons, while authors cannot unhide their content',async t=>{
  const f=await fixture(t),writer=await f.register('writer'),manager=await f.register('manager'),neighbour=await f.register('neighbour');
  await f.join(writer);await f.join(manager,'manager');await f.join(f.owner,'worker',neighbour.farmId);
  const entry=await f.post('/discussions',discussion(),writer);
  const hide={version:1,status:'hidden',reason:'Private personal information was included.'};
  error(await f.send('POST',`/entries/${entry.id}/moderation`,hide,manager),404,'not_found');
  error(await f.send('POST',`/entries/${entry.id}/moderation`,hide,neighbour,neighbour.farmId),404,'not_found');
  error(await f.send('POST',`/entries/${entry.id}/moderation`,hide,f.owner,neighbour.farmId),404,'not_found');
  error(await f.send('POST',`/entries/${entry.id}/moderation`,{...hide,reason:'no'}),400,'invalid_input');
  const hidden=await f.post(`/entries/${entry.id}/moderation`,hide,f.owner,f.owner.farmId,200);
  assert.equal(hidden.status,'hidden');assert.equal(hidden.version,2);assert.equal(hidden.moderationReason,hide.reason);
  assert.equal((await f.get('/discussions',neighbour,neighbour.farmId)).items.length,0);
  error(await f.send('GET',`/discussions/${entry.id}`,undefined,neighbour,neighbour.farmId),404,'not_found');
  assert.equal((await f.get('/discussions?mine=true',writer)).items[0].status,'hidden');
  assert.equal((await f.get('/hidden')).items[0].id,entry.id);
  error(await f.send('GET','/hidden',undefined,manager),404,'not_found');
  assert.equal((await f.get('/hidden',neighbour,neighbour.farmId)).items.length,0);
  error(await f.send('POST',`/entries/${entry.id}/moderation`,{version:1,status:'visible',reason:'Reviewed current content.'}),409,'version_conflict');
  const edited=await f.send('PATCH',`/entries/${entry.id}`,editBody(2,{body:'Personal information removed.'}),writer);
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().status,'hidden');assert.equal(edited.json().version,3);
  const restored=await f.post(`/entries/${entry.id}/moderation`,{version:3,status:'visible',reason:'Reviewed and removed identifying details.'},f.owner,f.owner.farmId,200);
  assert.equal(restored.version,4);assert.equal(restored.status,'visible');
  const publicView=(await f.get(`/discussions/${entry.id}`,neighbour,neighbour.farmId)).discussion;
  publicEntry(publicView);assert.equal(publicView.body,'Personal information removed.');
  publicEntry((await f.get(`/discussions/${entry.id}`,writer)).discussion,true);
  const audit=await f.db.query("SELECT actor_id,farm_id,reason,previous,current FROM audit_events WHERE entity_id=$1 AND action='forum_hidden'",[entry.id]);
  assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor_id,f.owner.userId);assert.equal(audit.rows[0].farm_id,f.owner.farmId);
  assert.equal(audit.rows[0].reason,hide.reason);assert.deepEqual(audit.rows[0].previous,{status:'visible',version:1});assert.deepEqual(audit.rows[0].current,{status:'hidden',version:2});
});

test('reports are version-bound, idempotent and private; only source-farm owners can resolve them',async t=>{
  const f=await fixture(t),reporter=await f.register('reporter'),member=await f.register('member');await f.join(member,'adviser');
  const entry=await f.post('/discussions',discussion());
  const report={id:randomUUID(),version:1,reason:'privacy',details:'Please review the identifying details.'};
  error(await f.send('POST',`/entries/${entry.id}/reports`,report),404,'not_found');
  error(await f.send('POST',`/entries/${entry.id}/reports`,{...report,version:2},reporter,reporter.farmId),409,'version_conflict');
  const submitted=await f.post(`/entries/${entry.id}/reports`,report,reporter,reporter.farmId);
  assert.deepEqual(submitted,{id:report.id,status:'open',duplicate:false});
  assert.deepEqual(await f.post(`/entries/${entry.id}/reports`,report,reporter,reporter.farmId,200),{...submitted,duplicate:true});
  error(await f.send('POST',`/entries/${entry.id}/reports`,{...report,details:'Changed details'},reporter,reporter.farmId),409,'idempotency_conflict');
  error(await f.send('POST',`/entries/${entry.id}/reports`,{...report,id:randomUUID()},reporter,reporter.farmId),409,'forum_already_reported');
  error(await f.send('POST',`/entries/${entry.id}/reports`,report,member),409,'idempotency_conflict');
  error(await f.send('GET','/reports',undefined,member),404,'not_found');
  assert.equal((await f.get('/reports',reporter,reporter.farmId)).items.length,0);
  const queueResponse=await f.send('GET','/reports'),queue=queueResponse.json();
  assert.equal(queueResponse.statusCode,200,queueResponse.body);assert.equal(queue.items.length,1);
  assert.deepEqual(Object.keys(queue.items[0]).sort(),['id','reason','details','reportedVersion','createdAt','entry'].sort());
  publicEntry(queue.items[0].entry);
  for(const privateValue of [reporter.userId,reporter.username,reporter.farmId,reporter.farmName])assert.equal(queueResponse.body.includes(privateValue),false,privateValue);
  error(await f.send('POST',`/reports/${report.id}/dismiss`,{version:1,reason:'Reviewed the report.'},reporter,reporter.farmId),404,'not_found');
  error(await f.send('POST',`/reports/${report.id}/dismiss`,{version:2,reason:'Reviewed the report.'}),409,'version_conflict');
  error(await f.send('POST',`/reports/${report.id}/dismiss`,{version:1,reason:'no'}),400,'invalid_input');
  const resolved=await f.send('POST',`/reports/${report.id}/dismiss`,{version:1,reason:'Reviewed; no personal information is present.'});
  assert.equal(resolved.statusCode,204,resolved.body);
  error(await f.send('POST',`/reports/${report.id}/dismiss`,{version:1,reason:'Reviewed once again.'}),409,'version_conflict');
  assert.equal((await f.get('/reports')).items.length,0);
  assert.equal((await f.get(`/discussions/${entry.id}`)).discussion.version,1,'dismissing a report does not silently edit content');
  const audit=await f.db.query("SELECT actor_id,reason FROM audit_events WHERE entity_id=$1 AND action='forum_report_dismissed'",[report.id]);
  assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor_id,f.owner.userId);assert.equal(audit.rows[0].reason,'Reviewed; no personal information is present.');
  assert.equal((await f.post(`/entries/${entry.id}/reports`,report,reporter,reporter.farmId,200)).status,'dismissed');
  const edited=await f.send('PATCH',`/entries/${entry.id}`,editBody(1));assert.equal(edited.statusCode,200,edited.body);
  const second={...report,id:randomUUID(),version:2};await f.post(`/entries/${entry.id}/reports`,second,reporter,reporter.farmId);
  await f.post(`/entries/${entry.id}/moderation`,{version:2,status:'hidden',reason:'Review confirmed private information.'},f.owner,f.owner.farmId,200);
  assert.equal((await f.get('/reports')).items.length,0);
  assert.equal((await f.post(`/entries/${entry.id}/reports`,second,reporter,reporter.farmId,200)).status,'actioned');
  const stored=await f.db.query('SELECT status,resolved_by,resolution_note FROM forum_reports WHERE id=$1',[second.id]);
  assert.deepEqual(stored.rows[0],{status:'actioned',resolved_by:f.owner.userId,resolution_note:'Review confirmed private information.'});
});

test('concurrent reports cannot create duplicate complaints about the same version',async t=>{
  const f=await fixture(t),reporter=await f.register('reporter'),entry=await f.post('/discussions',discussion());
  const report={id:randomUUID(),version:1,reason:'spam',details:''};
  const same=await Promise.all([
    f.send('POST',`/entries/${entry.id}/reports`,report,reporter,reporter.farmId),
    f.send('POST',`/entries/${entry.id}/reports`,report,reporter,reporter.farmId),
  ]);
  assert.deepEqual(same.map(r=>r.statusCode).sort(),[200,201]);
  const changed=await f.send('PATCH',`/entries/${entry.id}`,editBody(1));assert.equal(changed.statusCode,200,changed.body);
  const newReports=await Promise.all([
    f.send('POST',`/entries/${entry.id}/reports`,{...report,id:randomUUID(),version:2},reporter,reporter.farmId),
    f.send('POST',`/entries/${entry.id}/reports`,{...report,id:randomUUID(),version:2},reporter,reporter.farmId),
  ]);
  assert.deepEqual(newReports.map(r=>r.statusCode).sort(),[201,409]);
  assert.equal(newReports.find(r=>r.statusCode===409)!.json().error,'forum_already_reported');
  assert.deepEqual((await f.db.query('SELECT reported_version,count(*)::int AS n FROM forum_reports GROUP BY reported_version ORDER BY reported_version')).rows,[{reported_version:1,n:1},{reported_version:2,n:1}]);
});

test('report and hidden-entry cursors preserve PostgreSQL microseconds without repeats or omissions',async t=>{
  const f=await fixture(t),entry=await f.post('/discussions',discussion());
  const reportIds:string[]=[];
  for(const label of ['one','two','three']) {
    const reporter=await f.register(label),id=randomUUID();
    await f.post(`/entries/${entry.id}/reports`,{id,version:1,reason:'other'},reporter,reporter.farmId);reportIds.push(id);
  }
  await f.fractionalTimes('forum_reports',reportIds);
  const seenReports:string[]=[];let cursor:string|null=null;
  do {
    const p=await f.get('/reports?limit=1'+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''));
    assert.equal(p.items.length,1);seenReports.push(p.items[0].id);cursor=p.nextCursor;
    assert.ok(seenReports.length<=3,'report pagination must advance');
  } while(cursor);
  assert.deepEqual(seenReports,reportIds);
  const entries=[entry];
  entries.push(await f.post('/discussions',discussion({title:'Second review item'})));
  entries.push(await f.post('/discussions',discussion({title:'Third review item'})));
  for(const e of entries)await f.post(`/entries/${e.id}/moderation`,{version:1,status:'hidden',reason:'Content is pending owner review.'},f.owner,f.owner.farmId,200);
  await f.fractionalTimes('forum_entries',entries.map(e=>e.id));
  const seenHidden:string[]=[];cursor=null;
  do {
    const p=await f.get('/hidden?limit=1'+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''));
    assert.equal(p.items.length,1);publicEntry(p.items[0],true);seenHidden.push(p.items[0].id);cursor=p.nextCursor;
    assert.ok(seenHidden.length<=3,'hidden-entry pagination must advance');
  } while(cursor);
  assert.deepEqual(seenHidden,entries.map(e=>e.id).reverse());
});

test('hidden replies stay private, deleted replies are blank tombstones, and removed discussions reject new activity',async t=>{
  const f=await fixture(t),neighbour=await f.register('neighbour'),entry=await f.post('/discussions',discussion());
  const reply=await f.post(`/discussions/${entry.id}/replies`,replyBody(),neighbour,neighbour.farmId);
  error(await f.send('PATCH',`/entries/${reply.id}`,editBody(1),neighbour,neighbour.farmId),400,'invalid_input');
  const edited=await f.send('PATCH',`/entries/${reply.id}`,{version:1,displayName:'Neighbour',body:'Corrected observation.',shareWithCommunity:true},neighbour,neighbour.farmId);
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().version,2);
  error(await f.send('POST',`/entries/${reply.id}/moderation`,{version:2,status:'hidden',reason:'Review needed for this reply.'}),404,'not_found','discussion ownership does not confer ownership of another farm reply');
  await f.post(`/entries/${reply.id}/moderation`,{version:2,status:'hidden',reason:'Review needed for this reply.'},neighbour,neighbour.farmId,200);
  assert.equal((await f.get(`/discussions/${entry.id}`)).replies.items.length,0);
  assert.equal((await f.get('/discussions')).items[0].replyCount,0);
  assert.equal((await f.get(`/discussions/${entry.id}`,neighbour,neighbour.farmId)).replies.items[0].status,'hidden');
  error(await f.send('POST',`/entries/${reply.id}/reports`,{id:randomUUID(),version:3,reason:'other'}),404,'not_found');
  const deleted=await f.send('DELETE',`/entries/${reply.id}`,{version:3},neighbour,neighbour.farmId);assert.equal(deleted.statusCode,204,deleted.body);
  const tombstone=(await f.get(`/discussions/${entry.id}`)).replies.items[0];publicEntry(tombstone);
  assert.equal(tombstone.status,'deleted');assert.equal(tombstone.body,'');assert.equal(tombstone.displayName,'');assert.equal(tombstone.title,null);assert.equal(tombstone.topic,null);
  assert.equal(tombstone.canEdit,false);assert.equal(tombstone.canModerate,false);
  error(await f.send('POST',`/entries/${reply.id}/reports`,{id:randomUUID(),version:4,reason:'other'}),404,'not_found');
  const visibleReply=await f.post(`/discussions/${entry.id}/replies`,replyBody({body:'Another observation.'}),neighbour,neighbour.farmId);
  const report={id:randomUUID(),version:1,reason:'other'};await f.post(`/entries/${entry.id}/reports`,report,neighbour,neighbour.farmId);
  const removed=await f.send('DELETE',`/entries/${entry.id}`,{version:1});assert.equal(removed.statusCode,204,removed.body);
  error(await f.send('GET',`/discussions/${entry.id}`),404,'not_found');
  error(await f.send('GET',`/discussions/${entry.id}`,undefined,neighbour,neighbour.farmId),404,'not_found');
  error(await f.send('POST',`/discussions/${entry.id}/replies`,replyBody()),404,'not_found');
  error(await f.send('POST',`/entries/${visibleReply.id}/reports`,{id:randomUUID(),version:1,reason:'other'}),404,'not_found');
  assert.equal((await f.get('/discussions')).items.length,0);
  const resolved=(await f.db.query('SELECT status,resolution_note FROM forum_reports WHERE id=$1',[report.id])).rows[0];
  assert.deepEqual(resolved,{status:'actioned',resolution_note:'author_removed_content'});
});

test('explicit sharing, strict text/input limits and bounded pagination reject invalid data without publishing',async t=>{
  const f=await fixture(t);
  const invalid:Array<Record<string,unknown>>=[
    {shareWithCommunity:false},{shareWithCommunity:undefined},{id:'invalid-id'},{displayName:'x'},{displayName:'x'.repeat(51)},
    {title:'ab'},{title:'x'.repeat(161)},{body:'   '},{body:'x'.repeat(8001)},{body:'bad\u0000text'},{body:'bad\u001btext'},
    {topic:'private-projects'},{farmId:randomUUID()},{authorId:randomUUID()},{projectId:randomUUID()},{media:{private:true}},
  ];
  for(const bad of invalid)error(await f.send('POST','/discussions',discussion(bad)),400,'invalid_input');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM forum_entries')).rows[0].n,0);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='forum_published'")).rows[0].n,0);
  const boundary=await f.post('/discussions',discussion({displayName:'n'.repeat(50),title:'t'.repeat(160),body:'b'.repeat(8000)}));
  assert.equal(boundary.body.length,8000);
  const trimmed=await f.post('/discussions',discussion({displayName:'  Public name  ',title:'  Three  ',body:'  First line\nSecond line\tobservation.  '}));
  assert.equal(trimmed.displayName,'Public name');assert.equal(trimmed.title,'Three');assert.equal(trimmed.body,'First line\nSecond line\tobservation.');
  for(const query of ['limit=0','limit=51','limit=1.5','mine=yes','topic=unknown','search='+encodeURIComponent('x'.repeat(101)),'cursor=invalid','extra=private'])error(await f.send('GET','/discussions?'+query),400,'invalid_input');
  const malformed=Buffer.from(JSON.stringify({time:'not-a-date',id:randomUUID()})).toString('base64url');
  error(await f.send('GET','/discussions?cursor='+malformed),400,'invalid_input');
  error(await f.send('PATCH',`/entries/${boundary.id}`,editBody(0)),400,'invalid_input');
  error(await f.send('PATCH',`/entries/${boundary.id}`,editBody(1,{shareWithCommunity:false})),400,'invalid_input');
  error(await f.send('PATCH',`/entries/${boundary.id}`,{version:1,displayName:'Public',body:'Incomplete discussion edit',shareWithCommunity:true}),400,'invalid_input');
  error(await f.send('DELETE',`/entries/${boundary.id}`,{version:1,force:true}),400,'invalid_input');
  error(await f.send('POST',`/entries/${boundary.id}/moderation`,{version:1,status:'hidden',reason:'x'.repeat(1001)}),400,'invalid_input');
  const reporter=await f.register('reporter');
  const report={id:randomUUID(),version:1,reason:'other',details:''};
  for(const bad of [{details:'x'.repeat(1001)},{details:'bad\u0000text'},{reason:'unknown'},{reporterId:randomUUID()}]) {
    error(await f.send('POST',`/entries/${boundary.id}/reports`,{...report,...bad},reporter,reporter.farmId),400,'invalid_input');
  }
  await f.post(`/entries/${boundary.id}/reports`,{...report,details:'x'.repeat(1000)},reporter,reporter.farmId);
  assert.equal((await f.get(`/discussions/${boundary.id}`)).discussion.version,1);
});

for(const revoked of ['session','membership'] as const)for(const replay of [false,true]) {
  test(`a ${replay?'replayed':'new'} publish rechecks ${revoked} after waiting for an in-flight revocation`,async t=>{
    const f=await fixture(t),writer=await f.register('writer');await f.join(writer);
    const payload=discussion();if(replay)await f.post('/discussions',payload,writer);
    const locker=await f.db.connect();let pending:ReturnType<typeof f.send>|undefined;
    try {
      await locker.query('BEGIN');const blocker=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const hash=sha256(writer.headers.authorization.slice(7));
      if(revoked==='session')await locker.query('SELECT user_id FROM sessions WHERE token_hash=$1 FOR UPDATE',[hash]);
      else await locker.query('SELECT role FROM memberships WHERE user_id=$1 AND farm_id=$2 FOR UPDATE',[writer.userId,f.owner.farmId]);
      pending=f.send('POST','/discussions',payload,writer);await f.waitForBlockedRequest(blocker);
      if(revoked==='session')await locker.query('DELETE FROM sessions WHERE token_hash=$1',[hash]);
      else await locker.query('DELETE FROM memberships WHERE user_id=$1 AND farm_id=$2',[writer.userId,f.owner.farmId]);
      await locker.query('COMMIT');
      error(await pending,revoked==='session'?401:404,revoked==='session'?'unauthorized':'not_found');
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM forum_entries WHERE id=$1',[payload.id])).rows[0].n,replay?1:0);
      assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='forum_published'",[payload.id])).rows[0].n,replay?1:0);
    } finally {
      await locker.query('ROLLBACK');locker.release();if(pending)await pending;
    }
  });
}

test('author edits through another current farm cannot outlive source-farm membership revocation',async t=>{
  const f=await fixture(t),writer=await f.register('writer');await f.join(writer);
  const entry=await f.post('/discussions',discussion(),writer),locker=await f.db.connect();
  let pending:ReturnType<typeof f.send>|undefined;
  try {
    await locker.query('BEGIN');const blocker=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT role FROM memberships WHERE user_id=$1 AND farm_id=$2 FOR UPDATE',[writer.userId,f.owner.farmId]);
    pending=f.send('PATCH',`/entries/${entry.id}`,editBody(1),writer,writer.farmId);await f.waitForBlockedRequest(blocker);
    await locker.query('DELETE FROM memberships WHERE user_id=$1 AND farm_id=$2',[writer.userId,f.owner.farmId]);await locker.query('COMMIT');
    error(await pending,404,'not_found');
    const unchanged=await f.db.query('SELECT version,body FROM forum_entries WHERE id=$1',[entry.id]);
    assert.equal(unchanged.rows[0].version,1);assert.equal(unchanged.rows[0].body,entry.body);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='forum_edited'",[entry.id])).rows[0].n,0);
  } finally {
    await locker.query('ROLLBACK');locker.release();if(pending)await pending;
  }
});
