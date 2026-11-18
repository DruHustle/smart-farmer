import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeReturnLink} from '../src/lib/native-return.ts';

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

import {destination, registrationUrl, rememberRegistration, takeRegistration} from '../src/lib/destination.ts';
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

// A failed issuer discovery must offer the Onesa Account service, never Portal administration.
test('web issuer outage account fallback goes to managed Onesa Account', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/Auth.tsx', import.meta.url), 'utf8');
  assert.match(source, /href="https:\/\/account\.onesa\.eu\/account"/);
  assert.doesNotMatch(source, /href="https:\/\/portal\.onesa\.eu\/account"/);
});
