import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {sha256} from '../src/security.js';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../src/app.js';

test('Approved Onesa users keep their farm membership and administrators require MFA',async t=>{
  const verifier = 'V'.repeat(43), clientId = 'farmer-test', secret='synthetic-secret-for-a-local-integration-test';
  const grant='synthetic-opaque-central-session-grant';
  const origin='http://127.0.0.1:5173', callback=origin+'/auth/onesa/callback';
  const subject=randomUUID();
  let allowed=true, role=true, mfa=true, verified=true, active=true, audience=clientId, returnedSubject=subject, unavailable=false;
  let duringValidation:(()=>Promise<void>) | null=null;
  const issued=new Set<string>();
  let issuer='';
  const server=createServer(async(req,res)=>{
    let body='';for await (const chunk of req) body+=chunk;
    const send=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.headers.authorization !== 'Basic '+Buffer.from(clientId+':'+secret).toString('base64')) return send(401,{});
    if(req.url==='/api/v1/identity/token'){
      const p=new URLSearchParams(body);
      if(p.get('redirect_uri')!==callback || p.get('code_verifier')!==verifier || !issued.delete(p.get('code')??''))return send(400,{});
      return send(200,{token_type:'Bearer',access_token:grant});
    }
    if(req.url!=='/api/v1/identity/session'||JSON.parse(body).token!==grant)return send(400,{});
    if(unavailable)return send(503,{});
    if(duringValidation)await duringValidation();
    const now=Math.floor(Date.now()/1000);
    send(200,{active,iss:issuer,aud:audience,sub:returnedSubject,email_verified:verified,auth_time:now-2,exp:now+900,amr:mfa?['pwd','otp']:['pwd'],onesa_roles:role?['global_admin']:[],onesa_applications:allowed?['farmer']:[],onesa_product_roles:{farmer:role?'admin':'user'}});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  issuer='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1/identity';
  const env={ONESA_IDENTITY_ENABLED:'true',ONESA_IDENTITY_CLIENT_ID:clientId,ONESA_IDENTITY_CLIENT_SECRET:secret,ONESA_IDENTITY_ISSUER:issuer};
  const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  Object.assign(process.env,env);t.after(()=>{for(const [k,v] of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  const schema='onesa_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url});
  await admin.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:url,options:'-c search_path='+schema});
  t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
  for(const sql of (await readdir(new URL('../migrations/',import.meta.url))).sort()) await db.query(await readFile(new URL('../migrations/'+sql,import.meta.url),'utf8'));
  const app=buildApp(db,origin);t.after(()=>app.close());
  assert.deepEqual((await app.inject('/v1/onesa/config')).json(),{issuer,clientId,callback,local_credentials:true});
  let syntheticClient=1;
  // Distinct loopback clients keep this authority matrix independent of the
  // separately tested per-client sign-in rate limit.
  const signIn=(code:string)=>app.inject({method:'POST',url:'/v1/onesa/sessions',remoteAddress:'127.0.0.'+(syntheticClient++),payload:{code,verifier,language:'sn'}});
  const fresh=()=>{const code=randomUUID();issued.add(code);return signIn(code);};
  const [one,two]=await Promise.all([fresh(),fresh()]);
  assert.equal(one.statusCode,200,one.body);assert.equal(two.statusCode,200,two.body);
  const a=one.json(),b=two.json();
  assert.equal(a.userId,b.userId);assert.equal(a.vaultKey,b.vaultKey);assert.notEqual(a.token,b.token);
  assert.equal((await db.query('SELECT count(*) FROM users')).rows[0].count,'1');
  const stored=(await db.query('SELECT onesa_grant,token_hash FROM sessions')).rows;
  assert.ok(stored.every(r=>r.onesa_grant!==grant&&r.token_hash!==a.token));
  const headers={authorization:'Bearer '+a.token};
  const me=()=>app.inject({url:'/v1/me',headers});
  assert.equal((await me()).statusCode,200);
  const farmId=randomUUID();
  await db.query("INSERT INTO farms(id,name,timezone) VALUES($1,'Other farm','Africa/Harare')",[farmId]);
  assert.equal((await app.inject({url:'/v1/farms/'+farmId+'/members',headers})).statusCode,404);
  assert.deepEqual((await app.inject({url:'/v1/farms',headers})).json().items,[]);
  await db.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'adviser')",[a.userId,farmId]);
  assert.equal((await app.inject({url:'/v1/farms',headers})).json().items[0].role,'adviser');
  audience='other-app';assert.equal((await me()).statusCode,401);audience=clientId;
  assert.equal((await me()).statusCode,401,'Restoring the audience cannot revive a rejected session');
  mfa=false;assert.equal((await fresh()).statusCode,401);mfa=true;
  const verifiedIdentity=(await fresh()).json(), verifiedHeaders={authorization:'Bearer '+verifiedIdentity.token};
  assert.equal((await app.inject({url:'/v1/me',headers:verifiedHeaders})).statusCode,200);
  verified=false;assert.equal((await app.inject({url:'/v1/me',headers:verifiedHeaders})).statusCode,401);verified=true;
  assert.equal((await app.inject({url:'/v1/me',headers:verifiedHeaders})).statusCode,401);
  role=false; mfa=false;
  const ordinary=await fresh();
  assert.equal(ordinary.statusCode,200,ordinary.body);
  assert.equal(ordinary.json().userId,a.userId);
  const ordinaryHeaders={authorization:'Bearer '+ordinary.json().token};
  const farms=await app.inject({url:'/v1/farms',headers:ordinaryHeaders});
  assert.deepEqual(farms.json().items.map((farm:{id:string;role:string})=>[farm.id,farm.role]),[[farmId,'adviser']]);
  allowed=false;
  assert.equal((await app.inject({url:'/v1/me',headers:ordinaryHeaders})).statusCode,401);
  assert.equal((await fresh()).statusCode,401);
  allowed=true; role=true; mfa=true;
  assert.equal((await app.inject({url:'/v1/me',headers:ordinaryHeaders})).statusCode,401,'Restored product access requires fresh sign-in');
  const activeIdentity=(await fresh()).json(), activeHeaders={authorization:'Bearer '+activeIdentity.token};
  assert.equal((await app.inject({url:'/v1/me',headers:activeHeaders})).statusCode,200);
  active=false;assert.equal((await app.inject({url:'/v1/me',headers:activeHeaders})).statusCode,401);active=true;
  assert.equal((await app.inject({url:'/v1/me',headers:activeHeaders})).statusCode,401);
  assert.equal((await signIn('invalid-code')).statusCode,401);
  let retryToken='';
  await t.test('Temporary issuer outage preserves the same valid session',async()=>{
    const identity=(await fresh()).json(), h={authorization:'Bearer '+identity.token};
    retryToken=identity.token;
    unavailable=true;assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,503);unavailable=false;
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,200);
    assert.equal(identity.userId,a.userId);
  });
  await t.test('A substituted subject permanently retires its local session',async()=>{
    const identity=(await fresh()).json(), h={authorization:'Bearer '+identity.token};
    returnedSubject=randomUUID();assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);returnedSubject=subject;
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);
    assert.equal((await db.query('SELECT 1 FROM sessions WHERE token_hash=$1',[sha256(identity.token)])).rowCount,0);
  });
  await t.test('A corrupt encrypted grant cannot revive after its envelope is restored',async()=>{
    const identity=(await fresh()).json(), h={authorization:'Bearer '+identity.token}, hash=sha256(identity.token);
    const original=(await db.query('SELECT onesa_grant FROM sessions WHERE token_hash=$1',[hash])).rows[0].onesa_grant;
    await db.query("UPDATE sessions SET onesa_grant='invalid' WHERE token_hash=$1",[hash]);
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);
    assert.equal((await db.query('UPDATE sessions SET onesa_grant=$1 WHERE token_hash=$2',[original,hash])).rowCount,0);
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);
  });
  for(const change of ['logout','expiry'] as const)await t.test('Concurrent '+change+' during issuer validation remains denied',async()=>{
    const identity=(await fresh()).json(), h={authorization:'Bearer '+identity.token};
    duringValidation=async()=>{await db.query(change==='logout'?'DELETE FROM sessions WHERE token_hash=$1':"UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[sha256(identity.token)]);};
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);duringValidation=null;
    assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);
  });
  await t.test('Flag rollback never converts central authority to a legacy session',async()=>{
    process.env.ONESA_IDENTITY_ENABLED='false';
    const rollback=buildApp(db,origin);
    await rollback.ready();
    process.env.ONESA_IDENTITY_ENABLED='true';
    try {
      const h={authorization:'Bearer '+retryToken};
      assert.equal((await rollback.inject({url:'/v1/me',headers:h})).statusCode,401);
      assert.equal((await app.inject({url:'/v1/me',headers:h})).statusCode,401);
    } finally { await rollback.close(); }
  });
  const finalIdentity=(await fresh()).json(), finalHeaders={authorization:'Bearer '+finalIdentity.token};
  assert.equal(finalIdentity.userId,a.userId);
  assert.equal((await app.inject({method:'DELETE',url:'/v1/sessions/current',headers:finalHeaders})).statusCode,204);
  assert.equal((await app.inject({url:'/v1/me',headers:finalHeaders})).statusCode,401);
});

test('Public Farmer requires Portal even when its issuer is unavailable', async t => {
  // Database access would indicate a legacy credential operation ran.
  const db = {query: async () => {throw Error('Unexpected credential query');}} as unknown as pg.Pool;
  const app = buildApp(db, 'https://farmer.onesa.eu');
  t.after(() => app.close());
  assert.equal((await app.inject('/v1/onesa/config')).json().local_credentials, undefined);
  for (const url of ['/v1/register','/v1/sessions','/v1/recover','/v1/recovery-codes','/v1/invitations/accept']) {
    const response = await app.inject({method:'POST',url,payload:{}});
    assert.equal(response.statusCode, 403, url);
    assert.equal(response.json().error, 'onesa_sign_in_required');
  }
});
