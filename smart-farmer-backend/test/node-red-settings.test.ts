import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {MANAGEMENT_PERMISSIONS} from '../src/node-red/configuration.js';
import {enrollment} from './node-red-fixture.js';

const source=readFileSync(new URL('../edge/node-red/settings.js',import.meta.url),'utf8');
function settings(extra:Record<string,string>={}){
  const module={exports:{} as any};
  runInNewContext(source,{module,require:createRequire(import.meta.url),Buffer,process:{env:{
    NODE_RED_ADMIN_USER:'fixture-editor',NODE_RED_ADMIN_PASSWORD_HASH:'$2b$12$fixture-hash',
    NODE_RED_CREDENTIAL_SECRET:'fixture-encryption-secret',...extra}}});
  return module.exports;
}
test('unconfigured management preserves editor auth, local authenticated flows and crypto context',()=>{
  const value=settings();
  assert.equal(value.uiHost,'127.0.0.1');assert.equal(value.httpAdminRoot,'/admin');assert.equal(value.httpNodeRoot,'/flows');
  assert.equal(value.adminAuth.users[0].permissions,'*');assert.equal(value.adminAuth.tokens,undefined);
  assert.equal(value.httpNodeAuth.user,'fixture-editor');assert.equal(value.httpNodeAuth.pass,'$2b$12$fixture-hash');
  assert.equal(typeof value.functionGlobalContext.crypto.createHmac,'function');assert.equal(value.externalModules,undefined);
});
test('dedicated package token has narrow authority and no effect on local flow authentication',async()=>{
  const value=settings({NODE_RED_RUNTIME_ID:enrollment.runtimeId,NODE_RED_ADMIN_TOKEN:enrollment.token});
  assert.deepEqual(JSON.parse(JSON.stringify(await value.adminAuth.tokens(enrollment.token))),{
    username:'smart-farmer-package-manager',permissions:MANAGEMENT_PERMISSIONS});
  for(const token of ['c'.repeat(64),'short','é'.repeat(64),null])assert.equal(await value.adminAuth.tokens(token),null);
  assert.deepEqual(JSON.parse(JSON.stringify(value.externalModules.palette)),{allowInstall:true,allowUpdate:false,allowUpload:false});
  let header='',id='',called=0;
  value.httpAdminMiddleware({},{set:(key:string,val:string)=>{header=key;id=val;}},()=>called++);
  assert.equal(header,'X-Smart-Farmer-Node-RED-Runtime');assert.equal(id,enrollment.runtimeId);assert.equal(called,1);
  assert.equal(value.uiHost,'127.0.0.1');assert.equal(value.httpNodeRoot,'/flows');assert.equal(value.httpNodeAuth.user,'fixture-editor');
});
test('partial or weak management enrollment fails gateway startup',()=>{
  assert.throws(()=>settings({NODE_RED_ADMIN_TOKEN:enrollment.token}),/UUID/);
  assert.throws(()=>settings({NODE_RED_RUNTIME_ID:enrollment.runtimeId,NODE_RED_ADMIN_TOKEN:'weak'}),/token/);
});
