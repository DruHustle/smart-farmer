// The Safari accessibility label and editable field value occupy different
// attributes. Require both on the same control. Never log either input.
import { readFileSync } from 'node:fs';

function matchesField(node, expected) {
  const attributes = node?.attributes ?? {};
  const labels = [attributes.accessibilityText, attributes.title, attributes.hintText, attributes['resource-id']];
  const emailControl = labels.some(label => typeof label === 'string' && /^(email|email address(?:, text field)?)$/i.test(label));
  if (emailControl && [attributes.value, attributes.text].includes(expected)) return true;
  return (node?.children ?? []).some(child => matchesField(child, expected));
}

try {
  const [hierarchyFile, fixtureFile, role] = process.argv.slice(2);
  if (!['member', 'admin'].includes(role)) throw new Error();
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  const expected = fixture[role.toUpperCase() + '_EMAIL'];
  if (typeof expected !== 'string' || !expected.length) throw new Error();
  if (!matchesField(JSON.parse(readFileSync(hierarchyFile, 'utf8')), expected)) throw new Error();
} catch {
  console.error('The Portal email field did not contain the expected synthetic account.');
  process.exitCode = 1;
}
