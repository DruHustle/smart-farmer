import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';

// Disposable CI only. Keys stay outside the application and uploaded evidence.
process.umask(0o077);
const directory = process.env.NATIVE_TLS_DIR;
assert.ok(directory, 'NATIVE_TLS_DIR is required');
const file = name => join(directory, name);
const origin = new URL(process.env.EXPO_PUBLIC_API_URL || 'https://127.0.0.1:3001');
assert.equal(origin.protocol, 'https:');
assert.equal(origin.hostname, '127.0.0.1');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
function openssl(...args) { execFileSync('openssl', args, { stdio: 'pipe' }); }
function request(options, path = '/health') {
  return new Promise((resolve, reject) => {
    const req = get(new URL(path, origin), { timeout: 5000, ...options }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('TLS readiness timed out')));
    req.on('error', reject);
  });
}
if (process.argv[2] === 'prepare') {
  mkdirSync(directory, { mode: 0o700 }); // Refuse to reuse a previous identity.
  writeFileSync(file('openssl.cnf'), `[req]
distinguished_name=dn
[dn]
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
`);
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-x509', '-sha256', '-days', '1',
    '-subj', '/CN=Smart Farmer disposable simulator CA', '-config', file('openssl.cnf'), '-extensions', 'ca',
    '-keyout', file('ca.key'), '-out', file('ca.pem'));
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost',
    '-config', file('openssl.cnf'), '-keyout', file('server.key'), '-out', file('server.csr'));
  openssl('x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'),
    '-CAcreateserial', '-out', file('server.pem'), '-days', '1', '-sha256',
    '-extfile', file('openssl.cnf'), '-extensions', 'server');
  openssl('verify', '-CAfile', file('ca.pem'), '-purpose', 'sslserver', file('server.pem'));
} else if (process.argv[2] === 'verify') {
  const ca = readFileSync(file('ca.pem'));
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = await request({ ca }) === 200; } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error;
    }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Actual API must be ready through the TLS proxy');
  await assert.rejects(request({}), error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  await assert.rejects(request({ ca, servername: 'wrong-host.invalid' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  console.log('PASS: TLS API readiness, untrusted CA rejection and wrong-host rejection.');
} else if (process.argv[2] === 'ready') {
  // One read-only probe per endpoint after simulator boot; never create a session
  // or retry a mutation. This measures the host's real TLS/API path, not the app.
  const ca = readFileSync(file('ca.pem'));
  for (const route of ['health', 'ready']) {
    const started = performance.now();
    let status;
    try { status = await request({ ca, signal: AbortSignal.timeout(5000) }, `/${route}`); }
    catch {
      console.log(JSON.stringify({ event: 'native_tls_readiness', at: new Date().toISOString(), route, outcome: 'transport_error', duration_ms: Math.round(performance.now() - started) }));
      throw new Error('Read-only TLS/API readiness transport failed');
    }
    console.log(JSON.stringify({ event: 'native_tls_readiness', at: new Date().toISOString(), route, status, duration_ms: Math.round(performance.now() - started) }));
    assert.equal(status, 200, `Read-only ${route} check must pass through the trusted TLS proxy`);
  }
} else {
  throw new Error('Expected prepare, verify or ready');
}
