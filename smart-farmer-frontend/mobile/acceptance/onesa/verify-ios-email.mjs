// The Safari accessibility label and editable field value occupy different
// attributes. Require both on the same control. Never log either input.
import { readFileSync } from 'node:fs';

function matchesFields(node, fixture, role, found) {
  const attributes = node?.attributes ?? {};
  const labels = [attributes.accessibilityText, attributes.title, attributes.hintText, attributes['resource-id']];
  const emailControl = labels.some(label => typeof label === 'string' && /^(email|email address(?:, text field)?)$/i.test(label));
  const passwordControl = labels.some(label => typeof label === 'string' && /^password(?:, secure(?: text)? field)?$/i.test(label));
  const values = [attributes.value, attributes.text];
  if (emailControl && values.includes(fixture[role.toUpperCase() + '_EMAIL'])) found.email = true;
  // Compare only native masked fields; never reveal or normalize the password.
  if (passwordControl && values.some(value => typeof value === 'string' &&
      value.length === fixture.PASSWORD.length && /^[•●]+$/u.test(value))) found.password = true;
  for (const child of node?.children ?? []) matchesFields(child, fixture, role, found);
}

try {
  const [hierarchyFile, fixtureFile, role] = process.argv.slice(2);
  if (!['member', 'admin'].includes(role)) throw new Error();
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  const expected = fixture[role.toUpperCase() + '_EMAIL'];
  if (typeof expected !== 'string' || !expected.length) throw new Error();
  if (typeof fixture.PASSWORD !== 'string' || !fixture.PASSWORD.length) throw new Error();
  const found = { email: false, password: false };
  matchesFields(JSON.parse(readFileSync(hierarchyFile, 'utf8')), fixture, role, found);
  if (!found.email || !found.password) {
    if (!found.email) console.error('ONESA_IOS_FIELD_UNVERIFIED email');
    if (!found.password) console.error('ONESA_IOS_FIELD_UNVERIFIED password');
    throw new Error();
  }
} catch {
  console.error('The Portal email control or secure password control was not filled as expected.');
  process.exitCode = 1;
}
