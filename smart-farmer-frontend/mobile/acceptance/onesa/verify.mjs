// Read only the mapping and membership identifiers. Never read tokens or
// account credentials from the database into device qualification artifacts.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../../../smart-farmer-backend/package.json',import.meta.url));
const {Client} = require('pg');
const [role, readyPath] = process.argv.slice(2);
assert.ok(['admin','member'].includes(role));
const fixture = JSON.parse(readFileSync(readyPath,'utf8'));
const subject = fixture[role === 'member' ? 'MEMBER_SUBJECT' : 'ADMIN_SUBJECT'];
assert.ok(typeof subject === 'string' && typeof fixture.ISSUER === 'string', 'Missing expected Portal identity');
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/farmer_device_test';
const database = new Client({connectionString:url.href});
await database.connect();
try {
  const {rows} = await database.query(
    `SELECT u.id, m.role FROM users u JOIN memberships m ON m.user_id=u.id
      WHERE u.onesa_issuer=$1 AND u.onesa_subject=$2 AND m.farm_id=$3 AND m.role=$4`,
    [fixture.ISSUER, subject, fixture.FARM_ID, role === 'member' ? 'worker' : 'adviser']);
  assert.equal(rows.length,1,'Expected precisely one approved identity with this farm role');
  process.stdout.write(rows[0].id);
} finally { await database.end(); }
