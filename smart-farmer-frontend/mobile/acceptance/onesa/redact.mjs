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
