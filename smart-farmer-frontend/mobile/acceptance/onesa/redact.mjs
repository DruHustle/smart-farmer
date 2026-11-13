// Emit a fixed vocabulary of screen landmarks. Browser hierarchies and Maestro
// failure details can contain PKCE values or synthetic credentials.
import {readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {chromeFailureStages} from './chrome-tab.mjs';
const file = join(process.argv[2],'hierarchy.json');
const text = existsSync(file) ? readFileSync(file,'utf8') : '';
const landmarks = ['auth-onesa','device-reauthenticate','first-farm-invitation','tab-forum','forum-new',
  'Email address','Authenticator or recovery code','Remember this browser','Continue as','Cancel sign-in',
  'Dzokera muSmart Farmer','Buyela ku-Smart Farmer','Use without an account','Your connection is not private',
  'Development servers','Continue','Close','Open','No thanks','Chrome','Save password','Sign in to Onesa',
  'Encryption & credentials','Install a certificate','CA certificate','Install anyway',
  'Show roots','Open navigation drawer','Open from','Onesa test issuer','farmer-device-ca.crt',
  'Onesa temporary device fixture','com.google.android.documentsui','com.android.documentsui'];
console.log('Visible screen landmarks: '+landmarks.filter(s=>text.includes(s)).join(', '));
// Android uses separate native/browser/native phases. Only these fixed file
// names and allowlisted labels can leave the private runner directory.
for (const phase of ['run','entry','portal','email','browser','complete']) {
  const runFile = join(process.argv[2],phase+'.log');
  if (!existsSync(runFile)) continue;
  const privateLines = readFileSync(runFile,'utf8').split('\n');
  if (phase === 'browser') {
    const tag = 'ONESA_BROWSER_FAILED_STAGE ';
    const stage = privateLines.find(line => line.startsWith(tag) && chromeFailureStages.has(line.slice(tag.length)));
    if (stage) console.log('Failed Chrome stage: '+stage.slice(tag.length));
  }
  const lines = privateLines.filter(line => /\[Failed\]|Element not found|Assertion is false|Timeout|Unable to|XCTest.*failed|AssertionError|Error:/i.test(line));
  const failed = lines.at(-1) || '';
  if (!failed) continue;
  const targets = [...landmarks,'Password','first-farm-join','Remember this browser','Morning irrigation inspection','Device Qualification Farm','Android driver','XCTest','Keyboard','Scroll','Submit'];
  console.log('Failed phase: '+phase);
  console.log('Failed command landmarks: '+(targets.filter(item=>failed.toLowerCase().includes(item.toLowerCase())).join(', ') || 'none identified'));
}

// Preserve only known failure classes and unfinished command categories. iOS
// driver failures can leave commands RUNNING and emit no useful console line.
// These private files are never copied or printed; values are not output labels.
const categories = new Set();
const unfinished = new Set();
const errorKinds = [
  ['driver-unreachable', /DeviceUnreachable|XCUITestServerError|XCTestServerError|ConnectException|Connection refused|SocketTimeoutException/i],
  ['ios-snapshot', /Failed to get matching snapshots|Timed out while evaluating UI query|SafariViewService is not running/i],
  ['assertion', /Assertion is false|No visible element found|Element not found/i],
  ['timeout', /TimeoutException|timed out/i],
];
const commandKinds = {assertConditionCommand:'assert-visibility',tapOnElement:'tap',inputTextCommand:'input',scrollUntilVisible:'scroll',runFlowCommand:'run-flow',launchAppCommand:'launch'};
function commandStage(command) {
  const text = JSON.stringify(command);
  const assertion = command.assertConditionCommand?.condition?.visible?.textRegex;
  if (typeof assertion==='string' && (assertion==='^${EMAIL}$' || /^\^[^\s@^$"/<>]+@[^\s@^$"/<>]+\$$/.test(assertion))) return 'auth-email-readback';
  if (/Authenticator or recovery code/.test(text)) return 'auth-mfa';
  if (/Wants to Use.*to Sign In/.test(text)) return 'browser-consent';
  if (/Dzokera muSmart Farmer|Buyela ku-Smart Farmer/.test(text)) return 'callback-return';
  if (/first-farm-invitation|first-farm-join|tab-forum|forum-new/.test(text)) return 'native-workspace';
  if (/auth-onesa/.test(text)) return 'native-sign-in';
  if (/Continue as/.test(text)) return 'browser-sso';
  if (/Email address/.test(text)) return 'auth-email-field';
  if (/Password/.test(text)) return 'auth-password-field';
  return 'unclassified';
}
let inspected = 0;
function inspectPrivate(directory,depth=0) {
  if (depth>4 || inspected>=24) return;
  for (const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (inspected>=24) break;
    const file = join(directory,entry.name);
    if (entry.isDirectory()) { inspectPrivate(file,depth+1); continue; }
    if (!entry.isFile() || !/^(commands[.]json|maestro[.]log|device-xctest[.]log|xctest_runner_[0-9_-]+[.]log)$/.test(entry.name)) continue;
    inspected++;
    if (statSync(file).size>16*1024*1024) continue;
    const text = readFileSync(file,'utf8');
    if (entry.name==='commands.json') {
      let commands; try { commands=JSON.parse(text); } catch { categories.add('invalid-command-diagnostic'); continue; }
      if (!Array.isArray(commands)) { categories.add('invalid-command-diagnostic'); continue; }
      for (const row of commands) {
        const status=row?.metadata?.status;
        if (!['FAILED','RUNNING'].includes(status)) continue;
        const command=row?.command;
        if (!command || typeof command!=='object') continue;
        const kind=Object.keys(commandKinds).find(key=>Object.hasOwn(command,key));
        unfinished.add((kind ? commandKinds[kind] : 'unclassified')+' / '+commandStage(command)+' / '+status.toLowerCase());
      }
    } else for (const [label,pattern] of errorKinds) if (pattern.test(text)) categories.add(label);
  }
}
try { inspectPrivate(process.argv[2]); } catch { categories.add('unreadable-private-diagnostic'); }
if (categories.size) console.log('Diagnostic failure categories: '+[...categories].sort().join(', '));
if (unfinished.size) console.log('Unfinished command categories: '+[...unfinished].sort().join(', '));
