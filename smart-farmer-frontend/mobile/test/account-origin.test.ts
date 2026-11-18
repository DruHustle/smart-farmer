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
