import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validate} from '../deploy/onesa/validate.mjs';

test('deployment preflight rejects mutable images, unsafe secrets and insecure external databases', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'farm-deploy-test-'));
  const file = join(folder, 'runtime.env');
  const env = {FARMER_API_IMAGE:'registry.example/api@sha256:'+'a'.repeat(64), FARMER_WEB_IMAGE:'sha256:'+'b'.repeat(64), FARMER_DB_IMAGE:'sha256:'+'d'.repeat(64), FARMER_SOURCE_REVISION:'c'.repeat(40), FARMER_WEB_ORIGIN:'https://farmer.onesa.eu', FARMER_API_PORT:'18131', FARMER_WEB_PORT:'18132', FARMER_RUNTIME_ENV_FILE:file, FARMER_POSTGRES_USER:'farm', FARMER_POSTGRES_PASSWORD:'disposable', FARMER_POSTGRES_DB:'farm'};
  try {
    await writeFile(file, 'PGHOST=db\nPGUSER=farm\nPGPASSWORD=disposable\nPGDATABASE=farm\n', {mode:0o600});
    assert.equal(await validate(env), true);
    await assert.rejects(validate({...env,FARMER_API_IMAGE:'registry.example/api:latest'}), /immutable/);
    await assert.rejects(validate({...env,FARMER_DB_IMAGE:'postgres:latest'}), /FARMER_DB_IMAGE.*immutable/);
    await assert.rejects(validate({...env,FARMER_SOURCE_REVISION:'latest'}), /exact Git commit/);
    await assert.rejects(validate({...env,FARMER_WEB_PORT:'18131'}), /ports must differ/);
    await chmod(file,0o644); await assert.rejects(validate(env), /owner-only/); await chmod(file,0o600);
    await assert.rejects(validate({...env,FARMER_POSTGRES_PASSWORD:'REPLACE_WITH_DEDICATED_RANDOM_PASSWORD'}), /example database password/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=disable\n');
    await assert.rejects(validate(env), /verify-full/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=verify-full\n');
    assert.equal(await validate({...env,FARMER_DB_IMAGE:''}), true);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@db/farm?host=remote.example&sslmode=disable\n');
    await assert.rejects(validate(env), /unsupported or duplicate/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=verify-full&sslmode=disable\n');
    await assert.rejects(validate(env), /unsupported or duplicate/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=verify-full\nNODE_TLS_REJECT_UNAUTHORIZED=0\n');
    await assert.rejects(validate(env), /may not be disabled/);
    await writeFile(file, 'PGHOST=db\nPGUSER=farm\nPGPASSWORD=disposable\nPGDATABASE=farm\nTRUST_PROXY_IPS=0.0.0.0/0\n');
    await assert.rejects(validate(env), /exact IP addresses/);
  } finally { await rm(folder,{recursive:true,force:true}); }
});


test('managed Auth0 release preflight requires valid separate clients, trusted keys and historic identity mapping', async () => {
  const compose = await readFile(new URL('../deploy/onesa/compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /ONESA_IDENTITY_ACCOUNT_ISSUER: \$\{ONESA_IDENTITY_ACCOUNT_ISSUER:-https:\/\/portal\.onesa\.eu\/api\/v1\/identity\}/);
  const folder = await mkdtemp(join(tmpdir(), 'farmer-managed-identity-'));
  const file = join(folder, 'runtime.env');
  try {
    await writeFile(file, 'PGHOST=db\nPGUSER=farm\nPGPASSWORD=disposable\nPGDATABASE=farm\n', {mode:0o600});
    const base = {
      FARMER_API_IMAGE:'sha256:'+'a'.repeat(64),
      FARMER_WEB_IMAGE:'sha256:'+'b'.repeat(64),
      FARMER_DB_IMAGE:'sha256:'+'d'.repeat(64),
      FARMER_SOURCE_REVISION:'c'.repeat(40),
      FARMER_WEB_ORIGIN:'https://farmer.onesa.eu',
      FARMER_API_PORT:'18131',
      FARMER_WEB_PORT:'18132',
      FARMER_RUNTIME_ENV_FILE:file,
      FARMER_POSTGRES_USER:'farm',
      FARMER_POSTGRES_PASSWORD:'disposable',
      FARMER_POSTGRES_DB:'farm',
      ONESA_IDENTITY_ENABLED:'false'
    };
    assert.equal(await validate(base), true, 'disabled Identity is an explicit safe candidate');
    const managed = {
      ...base,
      ONESA_IDENTITY_ENABLED:'true',
      ONESA_IDENTITY_MODE:'managed',
      ONESA_IDENTITY_ISSUER:'https://auth.onesa.eu/',
      ONESA_IDENTITY_ACCOUNT_ISSUER:'https://portal.onesa.eu/api/v1/identity',
      ONESA_IDENTITY_CLIENT_ID:'farmer-confidential-web-client',
      ONESA_IDENTITY_NATIVE_CLIENT_ID:'farmer-public-native-client',
      ONESA_IDENTITY_CLIENT_SECRET:'x'.repeat(40),
      ONESA_IDENTITY_AUDIENCE:'https://api.farmer.onesa.eu',
      ONESA_IDENTITY_JWKS_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600),
      ONESA_IDENTITY_JWKS:JSON.stringify({keys:[{kid:'fixture-one',kty:'RSA',n:'synthetic-public-modulus',e:'AQAB',alg:'RS256',use:'sig'}]})
    };
    assert.equal(await validate(managed), true);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_ENABLED:'yes'}), /true or false/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_ISSUER:'https://portal.onesa.eu/api/v1/identity'}), /approved Auth0/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_NATIVE_CLIENT_ID:managed.ONESA_IDENTITY_CLIENT_ID}), /distinct/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_CLIENT_SECRET:'short'}), /client secret/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_AUDIENCE:'REPLACE_WITH_REGISTERED_FARMER_API_AUDIENCE'}), /audience/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_ACCOUNT_ISSUER:'https://auth.onesa.eu/'}), /historical account namespace/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_JWKS_EXPIRES_AT:'0'}), /missing or expired/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_JWKS:'{"keys":[{"kid":"fixture-one","kty":"RSA","n":"secret","e":"AQAB","d":"private"}]}'}), /public RS256/);
    await assert.rejects(validate({...managed,ONESA_IDENTITY_JWKS:'{"keys":[{"kid":"same","kty":"RSA","n":"x","e":"AQAB"},{"kid":"same","kty":"RSA","n":"y","e":"AQAB"}]}'}), /unambiguous/);
  } finally {
    await rm(folder, {recursive:true,force:true});
  }
});
