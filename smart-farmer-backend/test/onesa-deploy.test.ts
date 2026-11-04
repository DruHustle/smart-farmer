import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validate} from '../deploy/onesa/validate.mjs';

test('deployment preflight rejects mutable images, unsafe secrets and insecure external databases', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'farm-deploy-test-'));
  const file = join(folder, 'runtime.env');
  const env = {FARMER_API_IMAGE:'registry.example/api@sha256:'+'a'.repeat(64), FARMER_WEB_IMAGE:'sha256:'+'b'.repeat(64), FARMER_SOURCE_REVISION:'c'.repeat(40), FARMER_WEB_ORIGIN:'https://farmer.onesa.eu', FARMER_API_PORT:'18131', FARMER_WEB_PORT:'18132', FARMER_RUNTIME_ENV_FILE:file, FARMER_POSTGRES_USER:'farm', FARMER_POSTGRES_PASSWORD:'disposable', FARMER_POSTGRES_DB:'farm'};
  try {
    await writeFile(file, 'PGHOST=db\nPGUSER=farm\nPGPASSWORD=disposable\nPGDATABASE=farm\n', {mode:0o600});
    assert.equal(await validate(env), true);
    await assert.rejects(validate({...env,FARMER_API_IMAGE:'registry.example/api:latest'}), /immutable/);
    await assert.rejects(validate({...env,FARMER_SOURCE_REVISION:'latest'}), /exact Git commit/);
    await assert.rejects(validate({...env,FARMER_WEB_PORT:'18131'}), /ports must differ/);
    await chmod(file,0o644); await assert.rejects(validate(env), /owner-only/); await chmod(file,0o600);
    await assert.rejects(validate({...env,FARMER_POSTGRES_PASSWORD:'REPLACE_WITH_DEDICATED_RANDOM_PASSWORD'}), /example database password/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=disable\n');
    await assert.rejects(validate(env), /verify-full/);
    await writeFile(file, 'DATABASE_URL=postgresql://u:p@remote.example/farm?sslmode=verify-full\n');
    assert.equal(await validate(env), true);
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
