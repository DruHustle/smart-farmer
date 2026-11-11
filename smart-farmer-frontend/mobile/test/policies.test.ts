import {test} from 'node:test';
import assert from 'node:assert/strict';
import {policyUrl} from '../src/policies';

test('retail policy links require real HTTPS destinations without credentials', () => {
  for (const value of [undefined, '', 'not a URL', 'http://onesa.eu/privacy', 'https://a:b@onesa.eu/legal',
    'https://invalid.example/policy', 'https://example.com', 'https://fixture.test', 'https://localhost', 'https://127.0.0.1']) {
    assert.equal(policyUrl(value), null);
  }
  assert.equal(policyUrl('https://onesa.eu/legal#privacy'), 'https://onesa.eu/legal#privacy');
});
