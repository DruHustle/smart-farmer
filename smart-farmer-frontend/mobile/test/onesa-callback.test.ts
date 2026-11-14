import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PendingOnesaTransactions, nativeCode,type PendingOnesa} from '../src/onesa-callback';

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

test('a denied Portal transaction is surfaced only after matching its state and issuer', () => {
  const issuer = 'https://portal.example.test/api/v1/identity';
  const origin = 'https://farmer.example.test';
  const pending: PendingOnesa = {issuer, origin, expires: 1000, verifier: 'device-only', state: 'native_' + 'a'.repeat(64), language: 'nd'};
  const callback = new URL('smartfarmer://onesa/callback');
  callback.search = new URLSearchParams({state: pending.state, iss: issuer, error: 'access_denied'}).toString();
  assert.throws(() => nativeCode(callback.href, pending, origin, 999), /onesa_denied/);
  callback.searchParams.set('state', 'unrelated');
  assert.throws(() => nativeCode(callback.href, pending, origin, 999), /unauthorized/);
});

test('only one delivery claims a native transaction, and old cleanup preserves a new attempt', async () => {
  let value: string | null = null;
  const transactions = new PendingOnesaTransactions({
    read: async () => value,
    write: async next => { value = next; },
    remove: async () => { value = null; },
  });
  const origin = 'https://farmer.example.test';
  const attempt: PendingOnesa = {
    origin, issuer: 'https://portal.example.test/api/v1/identity',
    state: 'first-attempt', verifier: 'synthetic-device-verifier',
    language: 'sn', expires: Date.now() + 300_000,
  };
  const callback = 'smartfarmer://onesa/callback?code=fixture&state=first-attempt';
  await transactions.save(attempt);
  const claims = await Promise.all([transactions.claim(callback, origin), transactions.claim(callback, origin)]);
  assert.deepEqual(claims, [{pending: attempt, code: 'fixture'}, null]);

  const next = {...attempt, state: 'second-attempt'};
  await Promise.all([transactions.save(next), transactions.clear(attempt.state)]);
  await assert.rejects(transactions.claim(callback, origin), /unauthorized/);
  assert.deepEqual(await transactions.claim(callback.replace('first-attempt', next.state), origin),
    {pending: next, code: 'fixture'});

  await transactions.save(attempt);
  const denial = callback.replace('code=fixture', 'error=access_denied');
  await assert.rejects(transactions.claim(denial + '&iss=https://unrelated.example', origin), /unauthorized/);
  await assert.rejects(transactions.claim(denial, origin), /onesa_denied/);
  assert.equal(await transactions.claim(callback, origin), null);
});
