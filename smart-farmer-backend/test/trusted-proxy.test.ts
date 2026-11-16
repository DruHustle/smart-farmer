import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {buildApp} from '../src/app.js';

const db = {} as pg.Pool;

test('client IP is taken from forwarded headers only for the explicitly trusted proxy', async () => {
  const previous = process.env.TRUST_PROXY_IPS;
  process.env.TRUST_PROXY_IPS = '192.0.2.10';
  const app = buildApp(db, 'https://farmer.onesa.eu');
  app.get('/test-client-ip', async request => ({ip: request.ip}));
  try {
    const headers = {'x-forwarded-for': '198.51.100.45'};
    const trusted = await app.inject({method: 'GET', url: '/test-client-ip', remoteAddress: '192.0.2.10', headers});
    assert.equal(trusted.json().ip, '198.51.100.45');
    const chain = await app.inject({method: 'GET', url: '/test-client-ip', remoteAddress: '192.0.2.10', headers: {'x-forwarded-for': '203.0.113.20, 198.51.100.45'}});
    assert.equal(chain.json().ip, '198.51.100.45');
    const untrusted = await app.inject({method: 'GET', url: '/test-client-ip', remoteAddress: '192.0.2.11', headers});
    assert.equal(untrusted.json().ip, '192.0.2.11');
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.TRUST_PROXY_IPS;
    else process.env.TRUST_PROXY_IPS = previous;
  }
});

test('invalid or broad proxy specifications fail closed', () => {
  const previous = process.env.TRUST_PROXY_IPS;
  try {
    for (const value of ['true', '0.0.0.0/0', 'proxy.example', '192.0.2.1,192.0.2.0/24']) {
      process.env.TRUST_PROXY_IPS = value;
      assert.throws(() => buildApp(db, 'https://farmer.onesa.eu'), /exact IP addresses/);
    }
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_IPS;
    else process.env.TRUST_PROXY_IPS = previous;
  }
});

test('release identity reports only a complete commit', async () => {
  const previous = process.env.APP_REVISION;
  process.env.APP_REVISION = 'c'.repeat(40);
  const app = buildApp(db, 'https://farmer.onesa.eu');
  try {
    assert.equal((await app.inject({method:'GET',url:'/version'})).json().revision, 'c'.repeat(40));
    process.env.APP_REVISION = 'latest';
    assert.equal((await app.inject({method:'GET',url:'/version'})).json().revision, null);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.APP_REVISION;
    else process.env.APP_REVISION = previous;
  }
});

test('authentication limits separate trusted clients and ignore forged headers from untrusted peers', async () => {
  const previous = process.env.TRUST_PROXY_IPS;
  process.env.TRUST_PROXY_IPS = '192.0.2.10';
  const app = buildApp(db, 'https://farmer.onesa.eu');
  const post = (remoteAddress: string, forwarded: string) => app.inject({
    method:'POST', url:'/v1/sessions', remoteAddress,
    headers:{'x-forwarded-for':forwarded}, payload:{}
  });
  try {
    for (let i=0; i<10; i++) assert.equal((await post('192.0.2.10','198.51.100.1')).statusCode,403);
    assert.equal((await post('192.0.2.10','198.51.100.1')).statusCode,429);
    assert.equal((await post('192.0.2.10','198.51.100.2')).statusCode,403);
    for (let i=0; i<10; i++) assert.equal((await post('192.0.2.11',`203.0.113.${i+1}`)).statusCode,403);
    assert.equal((await post('192.0.2.11','203.0.113.99')).statusCode,429);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.TRUST_PROXY_IPS;
    else process.env.TRUST_PROXY_IPS = previous;
  }
});
