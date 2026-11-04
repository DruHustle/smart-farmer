import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {farmEdgeEvent,verifyFarmEdgeSignature} from '../src/edge.js';

const sample={
  schemaVersion:1,eventId:randomUUID(),sourceId:'pivot-1',observedAt:'2026-11-03T12:00:00Z',
  kind:'measurement' as const,data:{assetId:'pivot-1',metric:'pressure',value:3.4,unit:'bar'}
};
const secret='test-agent-gateway-secret-longer-than-32-chars';
function signed(body:string, timestamp=String(Math.floor(Date.now()/1000))) {
  return {
    'content-type':'application/vnd.smart-farmer.edge+json',
    'x-edge-timestamp':timestamp,
    'x-edge-signature':'sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex')
  };
}
test('edge signature rejects expired and mutated payloads',()=>{
  const bytes=Buffer.from(JSON.stringify(sample));
  const now=Date.now(), timestamp=String(Math.floor(now/1000));
  const signature=signed(bytes.toString(),timestamp)['x-edge-signature'];
  assert.equal(verifyFarmEdgeSignature(bytes,timestamp,signature,secret,now),true);
  assert.equal(verifyFarmEdgeSignature(Buffer.from('tamper'),timestamp,signature,secret,now),false);
  assert.equal(verifyFarmEdgeSignature(bytes,String(Math.floor(now/1000)-301),signature,secret,now),false);
  assert.equal(farmEdgeEvent.safeParse({...sample,data:{...sample.data,command:'start'}}).success,false);
  assert.equal(farmEdgeEvent.safeParse({...sample,data:{...sample.data,value:Infinity}}).success,false);
});

test('gateway signature, source scope, replay conflicts and farm access',
  {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const schema='edge_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  const previous=process.env.SMART_FARMER_EDGE_GATEWAYS;
  const app=buildApp(db,'http://localhost:5173');
  try{
    for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())
      await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
    const register=async(username:string)=> (await app.inject({
      method:'POST',url:'/v1/register',
      payload:{username,password:'a-long-password-123',language:'sn',farmName:'Isolated farm'}
    })).json();
    const one=await register('edgeowner1'),two=await register('edgeowner2');
    process.env.SMART_FARMER_EDGE_GATEWAYS=JSON.stringify({
      'pi-farm-1':{farmId:one.farmId,secret,sources:['pivot-1']}
    });
    const payload=JSON.stringify(sample);
    const address='/v1/edge/pi-farm-1/events';
    const post=(body:string,headers=signed(body))=>app.inject({
      method:'POST',url:address,payload:body,headers
    });
    assert.equal((await post(payload,{'content-type':'application/vnd.smart-farmer.edge+json'})).statusCode,401);
    assert.equal((await post(payload)).statusCode,202);
    assert.equal((await post(payload)).json().duplicate,true);
    assert.equal((await post(JSON.stringify({...sample,data:{...sample.data,value:4.8}}))).statusCode,409);
    const unauthorized=JSON.stringify({...sample,eventId:randomUUID(),sourceId:'uncommissioned'});
    assert.equal((await post(unauthorized)).statusCode,403);
    const logon=async(username:string)=>{
      const res=await app.inject({method:'POST',url:'/v1/sessions',
        payload:{username,password:'a-long-password-123'}});
      return {authorization:'Bearer '+res.json().token};
    };
    const owner=await logon('edgeowner1'),other=await logon('edgeowner2');
    const records=await app.inject({method:'GET',url:'/v1/farms/'+one.farmId+'/equipment/observations',headers:owner});
    assert.equal(records.statusCode,200);
    assert.equal(records.json().items.length,1);
    assert.equal(records.json().commandCapability,false);
    assert.equal((await app.inject({method:'GET',url:'/v1/farms/'+one.farmId+'/equipment/observations',headers:other})).statusCode,404);
    assert.equal((await app.inject({method:'GET',url:'/v1/farms/'+two.farmId+'/equipment/observations',headers:owner})).statusCode,404);
  }finally{
    await app.close();
    if(previous===undefined)delete process.env.SMART_FARMER_EDGE_GATEWAYS;
    else process.env.SMART_FARMER_EDGE_GATEWAYS=previous;
    await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  }
});
