// Only fixed app-defined phase names may leave the raw local log. A missing
// marker is inconclusive if native console delivery was interrupted.
import {existsSync,readFileSync} from 'node:fs';
const allowed = ['entry','session-delete-completed','notification-cleanup-completed','notification-cleanup-failed','local-auth-state-requested'];
const output = new Set();
for (const path of process.argv.slice(2)) {
  if (!existsSync(path)) continue;
  const log = readFileSync(path,'utf8');
  for (const line of log.split('\n')) {
    if (!line.includes('[native-signout]')) continue;
    const message = line.slice(line.indexOf('[native-signout]') + '[native-signout]'.length);
    const phase = allowed.find(name => new RegExp('^[\\s,"\x27:]*'+name+'(?:[^a-z-]|$)').test(message));
    if (phase) output.add(phase);
  }
}
console.log('Observed native sign-out phases: '+([...output].join(', ') || 'none captured'));
