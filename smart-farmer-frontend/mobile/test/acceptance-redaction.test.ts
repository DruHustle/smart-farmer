import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('split native acceptance diagnostics reveal only fixed phase and landmark labels', () => {
  const directory=mkdtempSync(join(tmpdir(),'farmer-redaction-'));
  try {
    const secret='private-credential-and-callback-code';
    writeFileSync(join(directory,'hierarchy.json'),`tab-forum ${secret}`);
    writeFileSync(join(directory,'entry.log'),`Completed ${secret}`);
    writeFileSync(join(directory,'browser.log'),`Error: ${secret} https://localhost/callback?code=${secret}`);
    writeFileSync(join(directory,'complete.log'),`[Failed] Assertion is false: forum-new ${secret}`);
    writeFileSync(join(directory,'untrusted.log'),`[Failed] Password ${secret}`);
    const output=execFileSync(process.execPath,['acceptance/onesa/redact.mjs',directory],{encoding:'utf8'});
    assert.equal(output,'Visible screen landmarks: tab-forum\nFailed phase: browser\nFailed command landmarks: none identified\nFailed phase: complete\nFailed command landmarks: forum-new\n');
    assert.equal(output.includes(secret),false);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});


test('unfinished private auth commands retain only fixed categories and never values', () => {
  const directory=mkdtempSync(join(tmpdir(),'farmer-redaction-'));
  try {
    const email='private-user@example.invalid',secret='private-password-pkce-and-recovery';
    const capture=join(directory,'2026-11-12_000000','cold');mkdirSync(capture,{recursive:true});
    writeFileSync(join(capture,'commands.json'),JSON.stringify([
      {command:{assertConditionCommand:{condition:{visible:{textRegex:'^'+email+'$'}}}},metadata:{status:'FAILED'}},
      {command:{assertConditionCommand:{condition:{visible:{textRegex:'^(Dzokera muSmart Farmer|Buyela ku-Smart Farmer)$'}}}},metadata:{status:'RUNNING'}},
      {command:{assertConditionCommand:{condition:{visible:{idRegex:'first-farm-invitation'}}}},metadata:{status:'RUNNING'}},
      {command:{inputTextCommand:{text:secret}},metadata:{status:'COMPLETED'}},
      {command:{privateUnrecognizedCommand:secret},metadata:{status:'FAILED'}},
    ]));
    writeFileSync(join(capture,'ignored.json'),JSON.stringify({value:secret}));
    const output=execFileSync(process.execPath,['acceptance/onesa/redact.mjs',directory],{encoding:'utf8'});
    assert.equal(output,'Visible screen landmarks: \nUnfinished command categories: assert-visibility / auth-email-readback / failed, assert-visibility / callback-return / running, assert-visibility / native-workspace / running, unclassified / unclassified / failed\n');
    for (const value of [email,secret,'privateUnrecognizedCommand','2026-11-12_000000']) assert.equal(output.includes(value),false);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('private driver exceptions expose fixed classes without raw errors or URLs', () => {
  const directory=mkdtempSync(join(tmpdir(),'farmer-redaction-'));
  try {
    const secret='private-password-pkce-and-recovery';
    writeFileSync(join(directory,'xctest_runner_2026-11-12_000000.log'),
      'Failed to get matching snapshots: Application com.apple.SafariViewService is not running '+secret+' https://localhost/callback?code='+secret);
    writeFileSync(join(directory,'untrusted.log'),'TimeoutException '+secret);
    symlinkSync(join(directory,'untrusted.log'),join(directory,'device-xctest.log'));
    for (const errorClass of ['XCTestServerError','XCUITestServerError','DeviceUnreachableException']) {
      writeFileSync(join(directory,'maestro.log'),errorClass+': '+secret);
      const output=execFileSync(process.execPath,['acceptance/onesa/redact.mjs',directory],{encoding:'utf8'});
      assert.equal(output,'Visible screen landmarks: \nDiagnostic failure categories: driver-unreachable, ios-snapshot\n');
      for (const value of [secret,'https://','SafariViewService','TimeoutException',errorClass]) assert.equal(output.includes(value),false);
    }
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('Chrome handoff waits for one visible page at an exact fixture origin', async () => {
  const {waitForVisibleFixturePage} = await import('../acceptance/onesa/chrome-tab.mjs');
  const issuer = 'https://localhost:46501';
  const allowed = [issuer, 'https://127.0.0.1:46502'];
  const candidate = (url: string, visible: boolean) => ({
    url: () => url,
    evaluate: async () => visible,
    isClosed: () => false,
  });
  const selected = candidate(issuer + '/sign-in', true);
  const stale = candidate(issuer + '/sign-in', false);
  const foreign = { ...selected, url: () => 'https://elsewhere.invalid/', evaluate: () => assert.fail('unrelated tab inspected') };
  const snapshots = [[foreign, stale], [foreign, stale, selected]];
  const browser = {contexts: () => [{pages: () => snapshots.shift() ?? [selected]}]};
  assert.equal(await waitForVisibleFixturePage(browser, allowed, 1000, 1), selected);
  await assert.rejects(waitForVisibleFixturePage({contexts: () => [{pages: () => [selected, selected]}]}, allowed, 0),
    /Ambiguous visible fixture tabs/);
  await assert.rejects(waitForVisibleFixturePage({contexts: () => [{pages: () => [foreign, stale]}]}, allowed, 0),
    /No visible fixture tab/);
});

test('only an allowlisted Chrome phase can leave the private browser log', () => {
  const directory = mkdtempSync(join(tmpdir(), 'farmer-browser-stage-'));
  try {
    writeFileSync(join(directory, 'browser.log'), [
      'ONESA_BROWSER_FAILED_STAGE private-credential-and-callback-code',
      'ONESA_BROWSER_FAILED_STAGE mfa-submit',
      'private unknown input',
    ].join('\n'));
    const output = execFileSync(process.execPath, ['acceptance/onesa/redact.mjs', directory], {encoding: 'utf8'});
    assert.equal(output, 'Visible screen landmarks: \nFailed Chrome stage: mfa-submit\n');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('iOS Portal submission requires the expected email and a filled secure field; diagnostics expose neither', () => {
  const directory = mkdtempSync(join(tmpdir(), 'farmer-safari-form-'));
  try {
    const email = 'test-account@example.invalid';
    const password = 'synthetic-form-value';
    const data = join(directory, 'fixture.json');
    const screen = join(directory, 'screen.json');
    writeFileSync(data, JSON.stringify({ MEMBER_EMAIL: email, PASSWORD: password }));
    const check = (shownEmail: string, shownPassword: string, label = 'Password') => {
      return () => {
        writeFileSync(screen, JSON.stringify({ children: [
          { attributes: { accessibilityText: 'Email address', value: shownEmail } },
          { attributes: { accessibilityText: label, value: shownPassword } },
        ] }));
        return execFileSync(process.execPath, ['acceptance/onesa/verify-ios-email.mjs', screen, data, 'member'], { encoding: 'utf8', stdio: 'pipe' });
      };
    };
    assert.equal(check(email, '•'.repeat(password.length))(), '');
    const cases: [() => string, string[]][] = [
      [check(email, ''), ['password']],
      [check(email, '•'.repeat(password.length - 1)), ['password']],
      [check('other@example.invalid', '•'.repeat(password.length)), ['email']],
      [check(email, password), ['password']],
      [check(email, '•'.repeat(password.length), 'Other control'), ['password']],
      [check('other@example.invalid', ''), ['email', 'password']],
    ];
    for (const [attempt, fields] of cases) {
      assert.throws(attempt, (error: unknown) => {
        if (!error || typeof error !== 'object' || !('stderr' in error)) return false;
        const message = String(error.stderr);
        const expected = fields.map(field => 'ONESA_IOS_FIELD_UNVERIFIED ' + field);
        expected.push('The Portal email control or secure password control was not filled as expected.');
        assert.equal(message.trim(), expected.join('\n'));
        writeFileSync(join(directory, 'browser.log'), message + '\nONESA_IOS_FIELD_UNVERIFIED ' + password);
        const publicText = execFileSync(process.execPath, ['acceptance/onesa/redact.mjs', directory], { encoding: 'utf8' });
        for (const field of fields) assert.ok(publicText.includes('Unverified Portal field: ' + field));
        return !publicText.includes(email) && !publicText.includes(password);
      });
    }
  } finally { rmSync(directory, { force: true, recursive: true }); }
});
