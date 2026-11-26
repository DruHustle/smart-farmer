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

test('native issuer outage keeps the customer on Farmer with a retry', async () => {
  const {readFileSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const {dirname, resolve} = await import('node:path');
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/screens/AuthScreen.tsx'), 'utf8');
  assert.match(source, /testID="auth-onesa-retry"/);
  assert.doesNotMatch(source, /Linking\.openURL\('https:\/\/(?:account|portal)\.onesa\.eu\/account'\)/);
});
