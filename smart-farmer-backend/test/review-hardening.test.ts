import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {test} from 'node:test';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import pg from 'pg';
import {buildApp, withoutSecrets} from '../src/app.js';
import {ApiError} from '../src/context.js';
import {managedAccount, managedIdentity} from '../src/managed-identity.js';
import {sha256} from '../src/security.js';
import {runMaintenance} from '../src/worker.js';

const now = () => Math.floor(Date.now() / 1000);
const bearer = () => randomBytes(32).toString('base64url');

async function isolatedDatabase(t: {after: (fn: () => Promise<void>) => void}) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.endsWith('_test') && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  const schema = 'review_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({connectionString: url});
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new pg.Pool({connectionString: url, options: '-c search_path=' + schema});
  t.after(async () => { await db.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort())
    await db.query(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  return db;
}

async function signedInUser(db: pg.Pool, onesa = false) {
  const id = randomUUID(), value = bearer();
  await db.query("INSERT INTO users(id,username,password_hash,language,onesa_issuer,onesa_subject,onesa_vault_key) VALUES($1,$2,'!','sn',$3,$4,$5)",
    [id, (onesa ? 'onesa+' : 'local') + id.slice(0, 8), onesa ? 'https://portal.onesa.eu/api/v1/identity' : null, onesa ? randomUUID() : null, onesa ? 'synthetic-vault-key' : null]);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at,onesa_grant,onesa_token_issuer) VALUES($1,$2,now()+interval '1 hour',$3,$4)",
    [sha256(value), id, onesa ? 'sealed-synthetic-grant' : null, onesa ? 'https://auth.onesa.eu/' : null]);
  return {id, value, headers: {authorization: 'Bearer ' + value}};
}

test('a missing identity configuration keeps Onesa sessions retryable instead of deleting them', async t => {
  const previous = process.env.ONESA_IDENTITY_ENABLED;
  delete process.env.ONESA_IDENTITY_ENABLED;
  t.after(() => { if (previous !== undefined) process.env.ONESA_IDENTITY_ENABLED = previous; });
  const db = await isolatedDatabase(t);
  const holder = await signedInUser(db, true);
  const app = buildApp(db, 'https://farmer.onesa.eu');
  t.after(() => app.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const me = await app.inject({method: 'GET', url: '/v1/me', headers: holder.headers});
    assert.equal(me.statusCode, 503, me.body);
    assert.equal(me.json().error, 'onesa_unavailable');
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1', [sha256(holder.value)])).rows[0].n, 1);
});

test('rate limits are kept per live session while unknown bearers share the address limit', async t => {
  const db = await isolatedDatabase(t);
  const first = await signedInUser(db), second = await signedInUser(db);
  const app = buildApp(db, 'http://127.0.0.1:5173');
  t.after(() => app.close());
  const accept = (headers?: Record<string, string>) =>
    app.inject({method: 'POST', url: '/v1/invitations/accept', headers, payload: {}});
  for (let i = 0; i < 10; i++) assert.equal((await accept(first.headers)).statusCode, 400);
  assert.equal((await accept(first.headers)).statusCode, 429);
  assert.equal((await accept(second.headers)).statusCode, 400, 'another signed-in user keeps their own allowance');
  for (let i = 0; i < 10; i++) assert.equal((await accept({authorization: 'Bearer ' + bearer()})).statusCode, 400);
  assert.equal((await accept({authorization: 'Bearer ' + bearer()})).statusCode, 429, 'fresh forged bearers cannot mint new allowances');
  assert.equal((await accept()).statusCode, 429, 'forged bearers count against the shared address allowance');
  assert.equal((await accept(second.headers)).statusCode, 400);
});

test('stale or expired pinned signing keys are reported as unavailable, not as a rejection', async () => {
  const issuer = new URL('http://127.0.0.1:9/');
  const current = await generateKeyPair('RS256', {extractable: true});
  const other = await generateKeyPair('RS256', {extractable: true});
  const jwk = {...await exportJWK(current.publicKey), kid: 'current', alg: 'RS256', use: 'sig'};
  const env = (expiresAt: number) => ({
    ONESA_IDENTITY_AUDIENCE: 'https://api.farmer.onesa.eu', ONESA_IDENTITY_CLIENT_ID: 'web-pilot',
    ONESA_IDENTITY_NATIVE_CLIENT_ID: 'native-pilot', ONESA_IDENTITY_ACCOUNT_ISSUER: issuer.origin + '/api/v1/identity',
    ONESA_IDENTITY_JWKS: JSON.stringify({keys: [jwk]}), ONESA_IDENTITY_JWKS_EXPIRES_AT: String(expiresAt),
  });
  const sign = (key: CryptoKey, kid: string) => new SignJWT({
    'https://onesa.eu/claims/user_id': randomUUID(), 'https://onesa.eu/claims/products': ['farmer'],
    'https://onesa.eu/claims/roles': ['user'], azp: 'web-pilot',
  }).setProtectedHeader({alg: 'RS256', kid}).setIssuer(issuer.href).setSubject('oidc|synthetic')
    .setAudience('https://api.farmer.onesa.eu').setIssuedAt().setExpirationTime(now() + 120).sign(key);
  const config = (expiresAt: number) => ({issuer: issuer.href, clientId: 'web-pilot', managed: managedIdentity(env(expiresAt), issuer, true)});
  const status = async (expiresAt: number, token: string) => {
    try { await managedAccount(config(expiresAt), token); return 200; }
    catch (error) { assert.ok(error instanceof ApiError); return error.status; }
  };
  const live = now() + 3600;
  assert.equal(await status(live, await sign(current.privateKey, 'current')), 200);
  assert.equal(await status(live, await sign(other.privateKey, 'rotated')), 503, 'a key missing from the snapshot is retryable');
  assert.equal(await status(live, await sign(other.privateKey, 'current')), 401, 'a bad signature on a known key is a rejection');
  assert.doesNotThrow(() => config(now() - 60), 'an expired snapshot must not stop the API from starting');
  assert.equal(await status(now() - 60, await sign(current.privateKey, 'current')), 503);
  assert.throws(() => config(Number.NaN), /signing-key expiry/);
});

test('one failing maintenance step is rolled back and reported without blocking the others', async t => {
  const db = await isolatedDatabase(t);
  const holder = await signedInUser(db);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [sha256(holder.value)]);
  await db.query('DROP TABLE camera_events CASCADE');
  const errors: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); };
  let result: Awaited<ReturnType<typeof runMaintenance>>;
  try {
    // The worker lock is database-wide and other test files share the database.
    const deadline = Date.now() + 5000;
    result = await runMaintenance(db);
    while ('skipped' in result && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      result = await runMaintenance(db);
    }
  } finally { console.error = original; }
  assert.equal('skipped' in result, false, 'this fixture must complete a maintenance iteration');
  assert.ok('failedSteps' in result && result.failedSteps.includes('expire_camera_events'));
  assert.equal('expiredSessions' in result && result.expiredSessions, 1, 'later steps still run');
  const heartbeat = (await db.query("SELECT details FROM worker_heartbeats WHERE name='maintenance'")).rows[0];
  assert.ok(heartbeat.details.failedSteps.includes('expire_camera_events'));
  const logged = errors.map(line => JSON.parse(line)).find(entry => entry.step === 'expire_camera_events');
  assert.deepEqual(logged, {event: 'maintenance_step_failed', step: 'expire_camera_events', error: 'error', code: '42P01'});
});

test('conflict responses omit credential hashes and sealed grants from the stored row', () => {
  const details = withoutSecrets({current: {id: 'a', version: 3, name: 'Pump', gateway_token_hash: 'h', configuration_hash: 'c', payload_hash: 'p', onesa_grant: 'g'}});
  assert.deepEqual(details, {current: {id: 'a', version: 3, name: 'Pump'}});
  assert.deepEqual(withoutSecrets({currentVersion: 2}), {currentVersion: 2});
});
