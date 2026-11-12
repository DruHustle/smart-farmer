import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
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
