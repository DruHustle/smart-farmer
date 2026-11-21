import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PendingOnesaTransactions, SingleNativeRedemption, isOwnedNativeCallback, nativeCode, requireOwnedOnesaSession, type PendingOnesa} from '../src/onesa-callback';

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

test('interactive sign-in never treats an absent or consumed callback as a successful cancellation', () => {
  const example = {token: 'synthetic-test-token', username: 'fixture'};
  assert.equal(requireOwnedOnesaSession(example), example);
  assert.throws(() => requireOwnedOnesaSession(null), /unauthorized/);
});

test('OS callback observation is scoped to one exact native state and route', () => {
  const state='native_'+'d'.repeat(64);
  const valid='smartfarmer://onesa/callback?state='+state+'&code=one-time-code';
  assert.equal(isOwnedNativeCallback(valid,state),true);
  assert.equal(isOwnedNativeCallback('smartfarmer://onesa/callback?state='+state+'&error=access_denied',state),true);
  for(const candidate of [
    valid+'&state='+state,
    valid.replace('code=one-time-code','code=one-time-code#fragment'),
    valid.replace('smartfarmer:','https:'),
    valid.replace('//onesa/','//another/'),
    valid.replace('/callback?','/else?'),
    valid.replace(state,'wrong'),
    'not-a-url',
  ]) assert.equal(isOwnedNativeCallback(candidate,state),false);
});

test('native and browser handoffs share exactly one secure code redemption', async() => {
  const redemption=new SingleNativeRedemption<string|null>();
  let requests=0;
  const first=redemption.once(async()=>{requests++;return 'verified-server-session';});
  const second=redemption.once(async()=>{requests++;return 'should-never-run';});
  assert.strictEqual(first,second);
  assert.strictEqual(redemption.current(),first);
  assert.equal(await first,'verified-server-session');
  assert.equal(await second,'verified-server-session');
  assert.equal(requests,1);
});

test('a real browser dismissal cannot convert a missing callback into a session', () => {
  const redemption=new SingleNativeRedemption<null>();
  assert.equal(redemption.current(),null);
  assert.throws(()=>requireOwnedOnesaSession(redemption.current()),/unauthorized/);
});
