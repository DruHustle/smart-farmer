import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../src/app.js';

test('managed browser and native sessions retain legacy records and survive an issuer outage until expiry', async t => {
  const now=()=>Math.floor(Date.now()/1000);
  const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
  const jwk={...await exportJWK(publicKey),kid:'fixture-current',alg:'RS256',use:'sig'};
  const stableId=randomUUID(), farmerId=randomUUID(), farmId=randomUUID();
  const nonce='n'.repeat(43), verifier='v'.repeat(43), secret='synthetic-farmer-confidential-client-secret';
  const clientId='web-pilot', nativeId='native-pilot', audience='https://api.farmer.onesa.eu';
  const origin='http://127.0.0.1:5173', providerSubject='oidc|synthetic-fixture';
  const codes=new Set<string>();
  let online=true, remaining=180, products=['farmer'], targetAudience=audience, idNonce=nonce;
  let issuer='', mfaTime:number | undefined;
  const server=createServer(async(req,res)=>{
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if (!online) return send(503,{});
    if (req.url!=='/oauth/token') return send(404,{});
    let body='';for await (const chunk of req) body+=chunk;
    const form=new URLSearchParams(body);
    const native=form.get('client_id')===nativeId;
    const basic='Basic '+Buffer.from(clientId+':'+secret).toString('base64');
    if ((native ? !!req.headers.authorization : req.headers.authorization!==basic) ||
        form.get('code_verifier')!==verifier || !codes.delete(form.get('code')??'') ||
        form.get('redirect_uri')!==origin+'/auth/onesa/callback') return send(400,{});
    const client=native ? nativeId : clientId;
    const issue=(claims:Record<string,unknown>,aud:string,expiry:number)=>new SignJWT(claims)
      .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(providerSubject)
      .setAudience(aud).setIssuedAt().setExpirationTime(now()+expiry).sign(privateKey);
    const access=await issue({
      'https://onesa.eu/claims/user_id':stableId,'https://onesa.eu/claims/products':products,
      'https://onesa.eu/claims/roles':['user'],'https://onesa.eu/claims/mfa_time':mfaTime,azp:client,
    },targetAudience,remaining);
    const id=await issue({nonce:idNonce},client,300);
    return send(200,{token_type:'Bearer',access_token:access,id_token:id});
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  issuer='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/';
  const legacy=issuer+'api/v1/identity';
  const env={ONESA_IDENTITY_ENABLED:'true',ONESA_IDENTITY_MODE:'managed',ONESA_IDENTITY_ISSUER:issuer,
    ONESA_IDENTITY_AUDIENCE:audience, ONESA_IDENTITY_CLIENT_ID:clientId,ONESA_IDENTITY_NATIVE_CLIENT_ID:nativeId,
    ONESA_IDENTITY_CLIENT_SECRET:secret,ONESA_IDENTITY_ACCOUNT_ISSUER:legacy,
    ONESA_IDENTITY_JWKS:JSON.stringify({keys:[jwk]}),ONESA_IDENTITY_JWKS_EXPIRES_AT:String(now()+3600)};
  const saved=Object.entries(env).map(([k])=>[k,process.env[k]] as const);
  Object.assign(process.env,env);
  t.after(()=>{for(const [k,v] of saved) {if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.endsWith('_test') && ['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  const schema='oidc_'+randomUUID().replaceAll('-','');
  const pool=new pg.Pool({connectionString:url});
  await pool.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:url,options:'-c search_path='+schema});
  t.after(async()=>{await db.end();await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();});
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).sort()) {
    await db.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  await db.query("INSERT INTO users(id,username,password_hash,language,onesa_issuer,onesa_subject,onesa_vault_key) VALUES($1,'fixture','!','sn',$2,$3,'persistent-local-key')",[farmerId,legacy,stableId]);
  await db.query("INSERT INTO farms(id,name,timezone) VALUES($1,'Synthetic farm','Africa/Harare')",[farmId]);
  await db.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'adviser')",[farmerId,farmId]);
  const start=()=>{const a=buildApp(db,origin);t.after(()=>a.close());return a;};
  const app=start();
  const signin=async(api=app,native=false)=>{
    const code=randomUUID();codes.add(code);
    return api.inject({method:'POST',url:'/v1/onesa/sessions',payload:{code,nonce,verifier,language:'sn',...(native&&{native:true})}});
  };
  const config=(await app.inject('/v1/onesa/config')).json();
  assert.equal(config.audience,audience);assert.equal(config.nativeClientId,nativeId);
  const web=await signin(), native=await signin(app,true);
  assert.equal(web.statusCode,200,web.body);assert.equal(native.statusCode,200,native.body);
  for(const session of [web,native]) {
    assert.equal(session.json().userId,farmerId);assert.equal(session.json().vaultKey,'persistent-local-key');
  }
  const headers={authorization:'Bearer '+web.json().token};
  const records=async(api=app)=>api.inject({url:'/v1/farms',headers});
  assert.equal((await records()).json().items[0].id,farmId);
  targetAudience='https://api.other.example';assert.equal((await signin()).statusCode,401);targetAudience=audience;
  products=[];assert.equal((await signin()).statusCode,401);products=['farmer'];
  idNonce='other';assert.equal((await signin()).statusCode,401);idNonce=nonce;
  remaining=301;assert.equal((await signin()).statusCode,401);
  const memberUrl='/v1/farms/'+farmId+'/members/'+farmerId;
  const change=async(api:ReturnType<typeof start>, token:string)=>api.inject({
    method:'PATCH',url:memberUrl,headers:{authorization:'Bearer '+token},payload:{role:'adviser'},
  });
  mfaTime=now()-301;remaining=180;
  const stale=await signin();
  assert.equal((await change(app,stale.json().token)).json().error,'fresh_mfa_required');
  mfaTime=now();const recent=await signin();
  // Fresh MFA permits the check to reach local Farmer ownership, which still rejects an adviser.
  assert.equal((await change(app,recent.json().token)).statusCode,404);
  remaining=2;
  const short=await signin();assert.equal(short.statusCode,200,short.body);
  online=false;
  const restarted=start();assert.equal((await records(restarted)).statusCode,200);
  assert.equal((await signin(restarted)).statusCode,503);
  assert.equal((await change(restarted,web.json().token)).json().error,'fresh_mfa_required');
  await new Promise(r=>setTimeout(r,2100));
  const expired=await restarted.inject({url:'/v1/farms',headers:{authorization:'Bearer '+short.json().token}});
  assert.equal(expired.statusCode,401);
  await db.query("UPDATE memberships SET role='worker' WHERE user_id=$1 AND farm_id=$2",[farmerId,farmId]);
  process.env.ONESA_IDENTITY_ISSUER=legacy;process.env.ONESA_IDENTITY_MODE='portal';
  const rollback=start();
  assert.equal((await records(rollback)).statusCode,401);
  assert.equal((await db.query('SELECT count(*) FROM users')).rows[0].count,'1');
  online=true;remaining=180;
  assert.equal((await records(restarted)).json().items[0].role,'worker');
  assert.equal((await signin(restarted)).json().userId,farmerId);
});
