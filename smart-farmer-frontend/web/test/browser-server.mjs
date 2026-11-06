/** Real API/database browser harness with a synthetic private Node-RED transport. */
import {readFileSync, writeFileSync} from 'node:fs';
import {pool} from '../../../smart-farmer-backend/dist/db.js';
import {buildApp} from '../../../smart-farmer-backend/dist/app.js';
import {runtimeFixture, environment, enrollment} from '../../../smart-farmer-backend/test/node-red-fixture.ts';
import {nodeRedConfigurations} from '../../../smart-farmer-backend/src/node-red/configuration.ts';

if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !process.env.SMART_FARMER_BROWSER_NODE_RED_CONTROL) {
  throw new Error('The browser fixture requires an explicitly isolated test database and control file.');
}
const controlPath = process.env.SMART_FARMER_BROWSER_NODE_RED_CONTROL;
const evidencePath = controlPath + '.evidence.json';
const control = () => JSON.parse(readFileSync(controlPath, 'utf8'));
const registrations = {
  'fixture-north': {...enrollment, label: 'Synthetic north gateway'},
  'fixture-south': {...enrollment, runtimeId: 'd5047a10-18a8-4e02-821d-e700d7532ab4', label: 'Synthetic south gateway', adminUrl: 'http://127.0.0.1:18881/admin'},
};
const fixtures = new Map();
const configuration = () => {
  const value = control();
  if (!value.enabled) return [];
  return nodeRedConfigurations(environment(registrations, Object.fromEntries(Object.keys(registrations).map(id => [id, value.farmId]))));
};
const fetcher = async (input, init = {}) => {
  const configs = configuration();
  const url = String(input);
  const config = configs.find(item => url.startsWith(item.adminUrl + '/')) ?? configs[0];
  if (!config) throw new Error('Synthetic gateway not enabled');
  let fixture = fixtures.get(config.gatewayId);
  if (!fixture) {fixture = runtimeFixture(config); fixtures.set(config.gatewayId, fixture);}
  const value = control();
  fixture.state.postFailure = value.confirmed ? null : 'lost';
  if (value.confirmed && fixture.state.posts) fixture.state.installed = true;
  try {return await fixture.fetcher(input, init);}
  finally {
    writeFileSync(evidencePath, JSON.stringify(Object.fromEntries([...fixtures].map(([id, item]) => [id, {posts: item.state.posts}]))));
  }
};
const app = buildApp(pool, process.env.WEB_ORIGIN, {}, {configuration, fetcher});
let stopping = false;
const stop = async () => {if (stopping) return; stopping = true; await app.close(); await pool.end();};
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
await app.listen({host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000)});
