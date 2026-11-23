import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeReturnLink} from '../src/lib/native-return.ts';
import {consumeOnesaTransaction, onesaTransactionKey} from '../src/lib/browser-transaction.ts';

test('native code returns only to the installed Farmer scheme, with state and issuer intact',()=>{
  const state='native_'+'a'.repeat(64),issuer='https://portal.example.test/api/v1/identity';
  const url=new URL('https://farmer.example.test/auth/onesa/callback');
  url.search=new URLSearchParams({code:'proof-bound-code',state,iss:issuer,return_to:'https://unrelated.example.test/'});
  const result=new URL(nativeReturnLink(url));
  assert.equal(result.protocol,'smartfarmer:');assert.equal(result.host,'onesa');assert.equal(result.pathname,'/callback');
  assert.deepEqual(Object.fromEntries(result.searchParams),{state,iss:issuer,code:'proof-bound-code'});
  url.searchParams.set('error','access_denied');assert.equal(new URL(nativeReturnLink(url)).searchParams.has('code'),false);
  url.searchParams.delete('error');url.searchParams.append('code','duplicate');assert.equal(nativeReturnLink(url),null);
  url.searchParams.set('state','ordinary-browser-state');assert.equal(nativeReturnLink(url),null);
});

import {centralLogoutDestination, destination, registrationUrl, rememberRegistration, takeRegistration} from '../src/lib/destination.ts';
test('restore the intended Farmer screen or shared listing using only recognized local routes', () => {
  const read = path => destination(new URL(path, 'https://farmer.example.test'));
  const listing = '12a34567-89ab-4cde-8fab-0123456789ab';
  assert.equal(read('/?listing=' + listing + '&code=private').path, '/?listing=' + listing);
  assert.equal(read('/?page=forum&return=https://other.example').path, '/?page=forum');
  assert.equal(read('/account-deletion?code=private').path, '/account-deletion');
  assert.equal(read('/?listing=invalid&page=unrecognized').path, '/');
  assert.equal(read('/auth/onesa/callback?code=secret&state=s').path, '/');
});

test('registration returns the same tab to its Farmer listing before a fresh sign-in', () => {
  const values = new Map();
  const storage = {setItem:(key,value)=>values.set(key,value), getItem:key=>values.get(key), removeItem:key=>values.delete(key)};
  const listing = '12a34567-89ab-4cde-8fab-0123456789ab';
  rememberRegistration(storage,new URL('https://farmer.example.test/?listing='+listing+'&token=private'));
  assert.equal(registrationUrl('admin'),'https://account.onesa.eu/register?audience=admin&product=farmer&platform=web');
  assert.equal(registrationUrl('user'),'https://account.onesa.eu/register?audience=user&product=farmer&platform=web');
  assert.equal(takeRegistration(storage),'/?listing='+listing);
  assert.equal(takeRegistration(storage),null);
  values.set('smart-farmer:registration','https://unrelated.example/');
  assert.equal(takeRegistration(storage),'/');
});

test('the signed-out return goes only through Onesa and back to the Farmer origin', () => {
  const origin='https://farmer.example.test';
  const good='https://auth.onesa.eu/oidc/logout?'+new URLSearchParams({
    client_id:'farmer-web-fixture',post_logout_redirect_uri:origin+'/',
  });
  assert.equal(centralLogoutDestination(good,origin),good);
  assert.equal(centralLogoutDestination(good,'https://someone-else.example.test'),null);
  assert.equal(centralLogoutDestination(good.replace('/oidc/logout','/authorize'),origin),null);
  assert.equal(centralLogoutDestination(good+'&federated',origin),null);
  assert.equal(centralLogoutDestination(undefined,origin),null);
});

test('a stale or foreign callback cannot consume the current browser transaction', () => {
  const saved={state:'a'.repeat(43),verifier:'v'.repeat(43),issuer:'https://auth.onesa.eu/',
    language:'sn',returnTo:'/?page=forum',expires:2000};
  const values=new Map([[onesaTransactionKey,JSON.stringify(saved)]]);
  const storage={getItem:key=>values.get(key),removeItem:key=>values.delete(key)};
  const origin='https://farmer.example.test';
  const target=new URL(origin+'/auth/onesa/callback');
  target.search=new URLSearchParams({state:saved.state,iss:saved.issuer,error:'access_denied'});
  const stale=new URL(target); stale.searchParams.set('state','b'.repeat(43));
  const foreign=new URL(target); foreign.searchParams.set('iss','https://unknown.example.test/');
  for (const url of [stale,foreign]) {
    assert.throws(()=>consumeOnesaTransaction(storage,url,origin,1000),/unauthorized/);
    assert.ok(values.has(onesaTransactionKey));
  }
  assert.deepEqual(consumeOnesaTransaction(storage,target,origin,1000),saved);
  assert.throws(()=>consumeOnesaTransaction(storage,target,origin,1000),/unauthorized/);
});

// A failed issuer discovery must offer the Onesa Account service, never Portal administration.
test('web issuer outage account fallback goes to managed Onesa Account', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/Auth.tsx', import.meta.url), 'utf8');
  assert.match(source, /href="https:\/\/account\.onesa\.eu\/account"/);
  assert.doesNotMatch(source, /href="https:\/\/portal\.onesa\.eu\/account"/);
});
