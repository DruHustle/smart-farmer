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

