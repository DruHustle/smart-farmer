import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required for API integration tests; use a disposable PostgreSQL database.');
test('farm isolation, unknown crop facts and idempotent field records', async()=>{
 const schema=`test_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:url});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const app=buildApp(db,'http://localhost:5173');
 try {
  for(const method of ['PATCH','DELETE']) {
   const preflight=await app.inject({method:'OPTIONS',url:'/v1/me/preferences',headers:{origin:'http://localhost:5173','access-control-request-method':method,'access-control-request-headers':'authorization,content-type'}});
   assert.equal(preflight.statusCode,204,preflight.body);
   assert.equal(preflight.headers['access-control-allow-origin'],'http://localhost:5173');
   assert.equal(preflight.headers['access-control-allow-credentials'],'true');
   assert.ok(String(preflight.headers['access-control-allow-methods']).split(',').map(x=>x.trim()).includes(method));
   assert.match(String(preflight.headers['access-control-allow-headers']),/authorization/i);
  }
  const foreignOrigin=await app.inject({method:'OPTIONS',url:'/v1/me/preferences',headers:{origin:'https://unrelated.invalid','access-control-request-method':'PATCH'}});
  assert.equal(foreignOrigin.headers['access-control-allow-origin'],undefined,'unrelated browser origins receive no CORS grant');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) await db.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const reg=async(username:string)=>{const response=await app.inject({method:'POST',url:'/v1/register',payload:{username,password:'a-long-password-123',language:'sn',farmName:'Test farm'}});assert.equal(response.statusCode,201);return response.json();};
  const one=await reg('farmer_one'), two=await reg('farmer_two');
  const sign=await app.inject({method:'POST',url:'/v1/sessions',payload:{username:'farmer_one',password:'a-long-password-123'}}); assert.equal(sign.statusCode,200); const headers={authorization:`Bearer ${sign.json().token}`};
  const forbidden=await app.inject({method:'GET',url:`/v1/farms/${two.farmId}/projects`,headers}); assert.equal(forbidden.statusCode,404);
  const created=await app.inject({method:'POST',url:`/v1/farms/${one.farmId}/projects`,headers,payload:{name:'Existing maize',crop:'maize',irrigation:true}});assert.equal(created.statusCode,201);
  const list=await app.inject({method:'GET',url:`/v1/farms/${one.farmId}/projects`,headers});const p=list.json().items[0];assert.equal(p.planting_date,null);assert.equal(p.variety,null);assert.equal(p.area_ha,null);
  const event={id:randomUUID(),projectId:created.json().id,kind:'irrigation',observedAt:'2026-11-03T10:00:00Z',note:'Watered',quantity:10,unit:'litre'};
  const post=(payload:object)=>app.inject({method:'POST',url:`/v1/farms/${one.farmId}/activities`,headers,payload});
  assert.equal((await post(event)).statusCode,201);assert.equal((await post(event)).statusCode,200);assert.equal((await post({...event,quantity:11})).statusCode,409);assert.equal((await post({...event,id:randomUUID(),unit:null})).statusCode,400);
  const events=await app.inject({method:'GET',url:`/v1/farms/${one.farmId}/activities`,headers});assert.equal(events.json().items.length,1);
  assert.equal((await app.inject({method:'DELETE',url:'/v1/sessions/current',headers})).statusCode,204);assert.equal((await app.inject({method:'GET',url:'/v1/farms',headers})).statusCode,401);
 } finally {await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('a viewer invitation grants only the selected farm overview, including after an active role changes', async () => {
 const schema = `viewer_${randomUUID().replaceAll('-', '')}`;
 const admin = new pg.Pool({connectionString: url});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const db = new pg.Pool({connectionString: url, options: `-c search_path=${schema}`});
 const app = buildApp(db, 'http://localhost:5173');
 try {
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
   await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  async function register(username: string) {
   const password = 'viewer-fixture-password';
   const registration = await app.inject({method: 'POST', url: '/v1/register',
    payload: {username, password, language: 'sn', farmName: username}});
   assert.equal(registration.statusCode, 201, registration.body);
   const signIn = await app.inject({method: 'POST', url: '/v1/sessions', payload: {username, password}});
   assert.equal(signIn.statusCode, 200, signIn.body);
   return {userId: registration.json().userId, farmId: registration.json().farmId,
    headers: {authorization: `Bearer ${signIn.json().token}`}};
  }
  const owner = await register('viewer_test_owner');
  const viewer = await register('viewer_test_member');
  const unrelated = await register('viewer_test_unrelated');
  const farm = `/v1/farms/${owner.farmId}`;
  const project = await app.inject({method: 'POST', url: farm + '/projects', headers: owner.headers,
   payload: {name: 'Maize trial', crop: 'maize', objective: 'Internal notes'}});
  assert.equal(project.statusCode, 201, project.body);
  const stock = await app.inject({method: 'POST', url: farm + '/stock', headers: owner.headers,
   payload: {id: randomUUID(), name: 'Seed store', unit: 'kg', quantity: 12.5, unitCost: 16, currency: 'USD'}});
  assert.equal(stock.statusCode, 201, stock.body);
  const invite = await app.inject({method: 'POST', url: farm + '/invitations', headers: owner.headers, payload: {role: 'viewer'}});
  assert.equal(invite.statusCode, 201, invite.body);
  const accept = await app.inject({method: 'POST', url: '/v1/invitations/accept', headers: viewer.headers, payload: {token: invite.json().token}});
  assert.equal(accept.statusCode, 201, accept.body);
  const farms = await app.inject({url: '/v1/farms', headers: viewer.headers});
  assert.equal(farms.json().items.find((item: {id: string}) => item.id === owner.farmId).role, 'viewer');

  const overview = farm + '/viewer-overview';
  const response = await app.inject({url: overview, headers: viewer.headers});
  assert.equal(response.statusCode, 200, response.body);
  const {projects, stock: stockSummary, incidents, tasks} = response.json();
  assert.deepEqual(projects, [{id: project.json().id, name: 'Maize trial', enterprise_type: 'crop', status: 'active'}]);
  assert.equal(stockSummary[0].name, 'Seed store');
  assert.equal(Number(stockSummary[0].quantity), 12.5);
  assert.deepEqual(Object.keys(stockSummary[0]).sort(), ['id', 'name', 'quantity', 'unit']);
  assert.deepEqual(incidents, []);
  assert.deepEqual(tasks, []);
  assert.equal((await app.inject({url: overview})).statusCode, 401);
  assert.equal((await app.inject({url: overview, headers: unrelated.headers})).statusCode, 404);
  assert.equal((await app.inject({url: overview, headers: owner.headers})).statusCode, 404);
  for (const route of ['/projects', '/members', '/assets', '/notifications', '/forum/discussions']) {
   assert.equal((await app.inject({url: farm + route, headers: viewer.headers})).statusCode, 404, route);
  }
  const observation = {
   id: randomUUID(), projectId: project.json().id, kind: 'observation',
   observedAt: '2026-11-03T10:00:00Z', note: 'Recorded by an adviser',
  };
  const read = (path: string) => app.inject({url: path, headers: viewer.headers});
  const write = () => app.inject({method: 'POST', url: farm + '/activities', headers: viewer.headers, payload: observation});
  assert.equal((await write()).statusCode, 404);
  const changeRole = (role: string) => app.inject({method: 'PATCH', url: farm + '/members/' + viewer.userId, headers: owner.headers, payload: {role}});
  assert.equal((await changeRole('adviser')).statusCode, 200);
  assert.equal((await read(overview)).statusCode, 404);
  assert.equal((await write()).statusCode, 201);
  assert.equal((await changeRole('viewer')).statusCode, 200);
  assert.equal((await write()).statusCode, 404);
  assert.equal((await read(overview)).statusCode, 200);
  const removal = await app.inject({method: 'DELETE', url: farm + '/members/' + viewer.userId, headers: owner.headers});
  assert.equal(removal.statusCode, 204, removal.body);
  assert.equal((await read(overview)).statusCode, 404);
 } finally {
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
 }
});

