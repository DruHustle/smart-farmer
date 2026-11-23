import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Only synthetic source assertions; real Android OAuth and member/admin
// journeys must still pass in native acceptance.
const flow = readFileSync(new URL('../acceptance/onesa/android-complete.yaml', import.meta.url).pathname, 'utf8');

test('Android Onesa acceptance has one cancel, cold and active workflow each', () => {
  const phases = [...flow.matchAll(/true:\s*\$\{FLOW_STATE === '([a-z]+)'\}/g)].map(x => x[1]);
  assert.deepEqual(phases, ['cancel', 'cold', 'active']);
  assert.equal((flow.match(/- runFlow:\s*\n\s*when:/g) || []).length, 3);
});

test('Cancellation tests complete translated denial text and remains signed out', () => {
  const regexLines = flow.split(/\r?\n/).filter(line =>
    line.includes('Kupinda neOnesa kwamiswa[.]') || line.includes('Ukungena nge-Onesa kumisiwe[.]'));
  assert.equal(regexLines.length, 2, 'Both scrolling and exact assertion must inspect the message');
  for (const line of regexLines) {
    const str = line.trim().slice(line.trim().indexOf(':') + 1).trim();
    assert.ok(str.startsWith("'") && str.endsWith("'"), 'Quoted YAML regex must be complete');
    const re = new RegExp(str.slice(1, -1));
    for (const message of ['Kupinda neOnesa kwamiswa. Unogona kuedzazve.',
      'Ukungena nge-Onesa kumisiwe. Ungazama futhi.',
      'Onesa haina kupa mvumo yekupinda muSmart Farmer.',
      'I-Onesa kayinikanga imvumo yokungena ku-Smart Farmer.']) {
      assert.ok(re.test(message), 'Both issuer-denial and OS-dismiss messages are accepted');
    }
    assert.ok(!re.test('Login successful'));
  }
  const phase = flow.split("true: ${FLOW_STATE === 'cancel'}")[1] ?? '';
  assert.ok(phase, 'Cancel phase must be present');
  const cancellation = phase.split("- runFlow:")[0] ?? '';
  assert.match(cancellation, /id: auth-onesa/);
  assert.match(cancellation, /assertNotVisible:\s*\{id: tab-forum\}/);
  assert.ok(flow.includes("id: first-farm-invitation"));
  assert.ok(flow.includes("id: tab-forum, selected: true"));
});

test('remembered sign-in verifies the exact seeded discussion without another centering swipe', () => {
  const active = flow.split("true: ${FLOW_STATE === 'active'}")[1];
  assert.ok(active);
  const item = "id: '^forum-open-${FORUM_DISCUSSION_ID}$'";
  const title = "text: '^${FORUM_TITLE}$'";
  assert.equal(active.split(item).length - 1, 2);
  assert.equal(active.split(title).length - 1, 2);
  assert.match(active, /visibilityPercentage: 50\s+centerElement: false/);
  assert.ok(active.indexOf('id: tab-forum, selected: true') < active.indexOf(item));
});
