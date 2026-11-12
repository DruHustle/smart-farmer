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
