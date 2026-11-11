// Emit a fixed vocabulary of screen landmarks. Browser hierarchies and Maestro
// failure details can contain PKCE values or synthetic credentials.
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const file = join(process.argv[2],'hierarchy.json');
const text = existsSync(file) ? readFileSync(file,'utf8') : '';
const landmarks = ['auth-onesa','device-reauthenticate','first-farm-invitation','tab-forum','forum-new',
  'Email address','Authenticator or recovery code','Remember this browser','Continue as','Cancel sign-in',
  'Dzokera muSmart Farmer','Buyela ku-Smart Farmer','Use without an account','Your connection is not private',
  'Development servers','Continue','Close','Open','No thanks','Chrome','Save password','Sign in to Onesa'];
console.log('Visible screen landmarks: '+landmarks.filter(s=>text.includes(s)).join(', '));
const runFile = join(process.argv[2],'run.log');
if (existsSync(runFile)) {
  const lines = readFileSync(runFile,'utf8').split('\n').filter(line => /\[Failed\]|Element not found|Assertion is false|Timeout|Unable to|XCTest.*failed/i.test(line));
  const failed = lines.at(-1) || '';
  const targets = [...landmarks,'Password','first-farm-join','Remember this browser','Morning irrigation inspection','Device Qualification Farm','Android driver','XCTest','Keyboard','Scroll','Submit'];
  console.log('Failed command landmarks: '+(targets.filter(item=>failed.toLowerCase().includes(item.toLowerCase())).join(', ') || 'none identified'));
}
