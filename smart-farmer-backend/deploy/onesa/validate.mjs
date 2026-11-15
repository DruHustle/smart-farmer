import {lstat, readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';

const immutable = /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/;
const fail = message => { throw new Error(message); };
export async function validate(env) {
  for (const key of ['FARMER_API_IMAGE', 'FARMER_WEB_IMAGE'])
    if (!immutable.test(env[key] || '')) fail(`${key} must be an immutable SHA-256 image reference`);
  if (!/^[a-f0-9]{40}$/.test(env.FARMER_SOURCE_REVISION || '')) fail('FARMER_SOURCE_REVISION must be an exact Git commit');
  let origin;
  try { origin = new URL(env.FARMER_WEB_ORIGIN); } catch { fail('FARMER_WEB_ORIGIN must be an HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== env.FARMER_WEB_ORIGIN || origin.username || origin.password)
    fail('FARMER_WEB_ORIGIN must be an HTTPS origin without credentials or a path');
  const ports = ['FARMER_API_PORT','FARMER_WEB_PORT'].map(key => {
    const value = env[key] || '';
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) fail(`${key} must be a valid unprivileged port`);
    return Number(value);
  });
  if (ports[0] === ports[1]) fail('API and web ports must differ');
  if (!env.FARMER_RUNTIME_ENV_FILE) fail('FARMER_RUNTIME_ENV_FILE is required');
  const file = await lstat(env.FARMER_RUNTIME_ENV_FILE);
  if (!file.isFile() || (file.mode & 0o077)) fail('Runtime environment must be a regular owner-only file');
  const content = await readFile(env.FARMER_RUNTIME_ENV_FILE, 'utf8');
  // Compose's raw env_file mode retains quote characters; require unquoted
  // assignments so this check and the container see the same credentials.
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]/m.test(content)) fail('Runtime values must be unquoted in the raw environment file');
  if (content.split(/\r?\n/).some(line => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) && line.includes('#')))
    fail('Encode # characters in runtime values to avoid ambiguous parsing');
  const runtime = parseEnv(content);
  if (runtime.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS certificate verification may not be disabled');
  if (runtime.PGPASSWORD?.startsWith('REPLACE_WITH_') || env.FARMER_POSTGRES_PASSWORD?.startsWith('REPLACE_WITH_'))
    fail('Replace the example database password');
  let localCredentials;
  if (runtime.DATABASE_URL) {
    let url;
    try { url = new URL(runtime.DATABASE_URL); } catch { fail('Invalid database configuration'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1))
      fail('Invalid database configuration');
    const allowed = new Set(['sslmode','sslrootcert','sslcert','sslkey','application_name']);
    for (const key of url.searchParams.keys())
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) fail('Database URL contains unsupported or duplicate parameters');
    if (url.hostname !== 'db' && url.searchParams.get('sslmode') !== 'verify-full')
      fail('External database connections require sslmode=verify-full');
    if (url.hostname === 'db') {
      try { localCredentials = [decodeURIComponent(url.username), decodeURIComponent(url.password), decodeURIComponent(url.pathname.slice(1))]; }
      catch { fail('Invalid database configuration'); }
    }
  } else {
    if (!['PGHOST','PGUSER','PGPASSWORD','PGDATABASE'].every(key => runtime[key])) fail('Database connection configuration is incomplete');
    if (runtime.PGHOST !== 'db' && runtime.PGSSLMODE !== 'verify-full') fail('External database connections require PGSSLMODE=verify-full');
    if (runtime.PGHOST === 'db') localCredentials = [runtime.PGUSER, runtime.PGPASSWORD, runtime.PGDATABASE];
  }
  if (localCredentials && (!env.FARMER_POSTGRES_PASSWORD ||
      localCredentials[0] !== (env.FARMER_POSTGRES_USER || 'smart_farmer') ||
      localCredentials[1] !== env.FARMER_POSTGRES_PASSWORD ||
      localCredentials[2] !== (env.FARMER_POSTGRES_DB || 'smart_farmer')))
    fail('Dedicated local database and runtime credentials must match');
  if (localCredentials && !immutable.test(env.FARMER_DB_IMAGE || ''))
    fail('FARMER_DB_IMAGE must be an immutable SHA-256 image reference for the local database');
  const proxies = (runtime.TRUST_PROXY_IPS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (proxies.length > 8 || proxies.some(x => !isIP(x))) fail('TRUST_PROXY_IPS must contain at most eight exact IP addresses');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await validate(process.env); console.log('Candidate configuration passed static checks; ingress, capacity, backup and release qualification remain required.'); }
  catch (error) { console.error(`Invalid candidate configuration: ${error.message}`); process.exitCode = 1; }
}
