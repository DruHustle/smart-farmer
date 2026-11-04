import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateApiOrigin} from '../scripts/validate-container-api.mjs';

test('container builds accept HTTPS and explicit local-development API origins', () => {
  for (const origin of ['https://api.example.invalid', 'https://api.example.invalid:8443',
    'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(validateApiOrigin(origin), origin);
  }
});

test('container builds refuse missing, insecure remote, ambiguous and credential-bearing origins', () => {
  for (const origin of [undefined, '', '/api', 'api:3000', 'http://api.example.invalid',
    'ftp://api.example.invalid', 'https://user:example-password@api.example.invalid',
    'https://api.example.invalid/', 'https://api.example.invalid/v1',
    'https://api.example.invalid?key=value', 'https://api.example.invalid#fragment',
    ' https://api.example.invalid', 'https://api.example.invalid\n',
    'http://127.0.0.1.example.invalid:3000']) {
    assert.throws(() => validateApiOrigin(origin), /VITE_API_URL must be/);
  }
});

test('the build validator exits unsuccessfully without echoing rejected credentials', () => {
  const script = fileURLToPath(new URL('../scripts/validate-container-api.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {encoding:'utf8',
    env:{...process.env, VITE_API_URL:'https://user:example-password@api.example.invalid'}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VITE_API_URL must be/);
  assert.doesNotMatch(result.stdout + result.stderr, /example-password/);
  execFileSync(process.execPath, [script], {env:{...process.env, VITE_API_URL:'http://localhost:3000'}});
});
