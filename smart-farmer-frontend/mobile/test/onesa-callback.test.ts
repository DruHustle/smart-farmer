import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeCode,type PendingOnesa} from '../src/onesa-callback';

test('an app return requires the original pending transaction, issuer, exact route and API',()=>{
  const origin='https://farmer-api.example.test', issuer='https://portal.example.test/api/v1/identity';
  const pending:PendingOnesa={issuer,origin,expires:1000,verifier:'device-only',state:'native_'+'a'.repeat(64),language:'sn'};
  const target=new URL('smartfarmer://onesa/callback');
  target.search=new URLSearchParams({code:'one-time-code',state:pending.state,iss:issuer}).toString();
  assert.equal(nativeCode(target.href,pending,origin,999),'one-time-code');
  for(const [field,value] of [['state','unrelated'],['iss','https://foreign.invalid'],['error','denied']] as const){
    const modified=new URL(target);modified.searchParams.set(field,value);assert.throws(()=>nativeCode(modified.href,pending,origin,999));
  }
  assert.throws(()=>nativeCode(target.href,{...pending,expires:999},origin,999));
  assert.throws(()=>nativeCode(target.href,pending,'https://different.invalid',999));
  assert.throws(()=>nativeCode(target.href+'&code=duplicate',pending,origin,999));
  assert.throws(()=>nativeCode(target.href.replace('//onesa/','//foreign/'),pending,origin,999));
  assert.throws(()=>nativeCode(target.href.replace('/callback?','/else?'),pending,origin,999));
});
