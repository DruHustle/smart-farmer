import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountManagementUrl} from '../src/account-origin';

test('managed Auth0 sessions use the distinct Onesa Account origin', () => {
  assert.equal(accountManagementUrl('https://auth.onesa.eu/', true), 'https://account.onesa.eu/account');
  assert.notEqual(accountManagementUrl('https://auth.onesa.eu/', true), 'https://auth.onesa.eu/account');
});

test('legacy Portal accounts retain their original account entry', () => {
  assert.equal(accountManagementUrl('https://portal.onesa.eu/identity', false), 'https://portal.onesa.eu/account');
});

// A provider outage must never send a customer to Company Portal administration.
test('native account fallback stays on the managed Account host', async () => {
  const {readFileSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const source = readFileSync(fileURLToPath(import.meta.resolve('../src/screens/AuthScreen.tsx')), 'utf8');
  assert.match(source, /Linking\.openURL\('https:\/\/account\.onesa\.eu\/account'\)/);
  assert.doesNotMatch(source, /Linking\.openURL\('https:\/\/portal\.onesa\.eu\/account'\)/);
});
