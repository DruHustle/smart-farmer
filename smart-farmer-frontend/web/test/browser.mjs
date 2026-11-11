/** Real browser + real PostgreSQL acceptance. Requires an isolated TEST_DATABASE_URL. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {completionJourneys} from './browser-completion.mjs';
import {accountingJourneys} from './browser-accounting.mjs';
import {forumJourneys} from './browser-forum.mjs';
import {nodeRedJourneys} from './browser-node-red.mjs';
import {catalog} from '../src/locales.ts';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(web, '../..', 'smart-farmer-backend');
const api = 'http://127.0.0.1:3000'; const ui = 'http://127.0.0.1:4173';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must point at an isolated disposable database.');
const env = {...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, WEB_ORIGIN: ui, PORT: '3000', HOST: '127.0.0.1', LOG_LEVEL: 'warn'};
const artifacts = process.env.TEST_ARTIFACTS_DIR || await mkdtemp(resolve(tmpdir(), 'smart-farmer-browser-'));
await mkdir(artifacts, {recursive: true});
env.MEDIA_ROOT = resolve(artifacts, 'private-media');
const nodeRedControl = resolve(artifacts, 'node-red-control.json');
await writeFile(nodeRedControl, JSON.stringify({enabled: false}));
env.SMART_FARMER_BROWSER_NODE_RED_CONTROL = nodeRedControl;
const children = []; let browser; let page;
const steps = []; const diagnostics = []; const errors = []; let stage = 'setup';
// Accelerated multi-day journeys share one localhost IP. Respect the real API
// window instead of disabling rate limits or hiding HTTP failures.
let rateRemaining = Infinity, rateResetAt = 0;
function observeRate(headers) {
  if (Number(headers['x-ratelimit-limit']) !== 600) return;
  rateRemaining = Number(headers['x-ratelimit-remaining']);
  rateResetAt = Date.now() + Number(headers['x-ratelimit-reset']) * 1000;
}
async function pace() {
  if (rateRemaining >= 100 || rateResetAt <= Date.now()) return;
  const until = rateResetAt + 100;
  console.log(`RATE: allowing the real API window to reset (${Math.ceil((until-Date.now())/1000)} seconds)`);
  while (Date.now() < until) await new Promise(resolvePause => setTimeout(resolvePause, Math.min(59000, until-Date.now())));
  rateRemaining = Infinity;
}
function watchContext(context) {context.on('response', response => {if(response.url().startsWith(api+'/')) {observeRate(response.headers());if(response.status()>=400)diagnostics.push(`http ${response.status()} ${response.request().method()} ${response.url()}`);}});context.on('page',child=>{child.on('pageerror',error=>errors.push(error.message));child.on('console',message=>{if(['error','warning'].includes(message.type()))diagnostics.push(`console ${message.type()}: ${message.text()}`);});child.on('requestfailed',request=>diagnostics.push(`requestfailed ${request.method()} ${request.url()}: ${request.failure()?.errorText}`));});}

function checkpoint(name) {stage = name; console.log(`STEP: ${name}`);}
const watchdog = setTimeout(() => {
  const failure = `Browser suite exceeded 720 seconds during: ${stage}`;
  writeFileSync(resolve(artifacts, 'results.json'), JSON.stringify({status: 'timed_out', stage, passed: steps, error: failure}, null, 2));
  writeFileSync(resolve(artifacts, 'failure-log.txt'), [failure, ...diagnostics, ...children.map(child => child.logs())].join('\n\n'));
  console.error(failure); for (const child of children) child.proc.kill('SIGTERM'); process.exit(1);
}, 720_000); watchdog.unref();
async function command(cmd, args, cwd, extra = {}) {
  await new Promise((resolveCommand, reject) => {
    const proc = spawn(cmd, args, {cwd, env: {...env, ...extra}, stdio: ['ignore', 'pipe', 'pipe']}); let logs = '';
    proc.stdout.on('data', part => {logs += part;}); proc.stderr.on('data', part => {logs += part;});
    children.push({proc, logs: () => logs});
    const timer = setTimeout(() => {proc.kill('SIGTERM'); reject(new Error(`${cmd} ${args.join(' ')} exceeded 60 seconds`));}, 60_000);
    proc.once('error', error => {clearTimeout(timer); reject(error);});
    proc.once('close', code => {clearTimeout(timer); code === 0 ? resolveCommand() : reject(new Error(`${cmd} ${args.join(' ')} failed\n${logs}`));});
  });
}
function server(args, cwd) {const proc = spawn(process.execPath, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']}); let logs = ''; proc.stdout.on('data', part => {logs += part;}); proc.stderr.on('data', part => {logs += part;}); children.push({proc, logs: () => logs}); return proc;}
async function waitUrl(url) {for (let i = 0; i < 100; i++) {try {const response = await fetch(url, {signal: AbortSignal.timeout(2000)}); if (response.ok) return;} catch {} await new Promise(r => setTimeout(r, 100));} throw new Error(`Server did not become ready: ${url}`);}
async function apiCall(path, body, token = '', method = body === undefined ? 'GET' : 'POST') {await pace();const response = await fetch(api + path, {signal: AbortSignal.timeout(10000), method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); observeRate(Object.fromEntries(response.headers));const data = response.status === 204 ? {} : await response.json(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`); return data;}
const sn = catalog.sn, nd = catalog.nd;
const unique = Date.now().toString(36); const username = `web_owner_${unique}`; let password = 'browser-fixture-password-2026';
const note = `Offline field evidence ${unique}`;
const screenshot = async name => page.screenshot({path: resolve(artifacts, name), fullPage: true, timeout: 10000});
async function expectVisible(locator, timeout = 10_000) {await locator.waitFor({state: 'visible', timeout});}
async function expectText(locator, text) {
  // The row exists before its asynchronous command transition finishes.
  await expectVisible(locator.filter({hasText: text}));
  assert.ok((await locator.textContent()).includes(text));
}
async function navigate(target, text = sn[target]) {
  await page.locator('.mobile-nav').getByRole('button', {name: text, exact: true}).click();
  for (const selector of ['.mobile-nav', '.desktop-nav nav']) {
    const current = page.locator(selector).locator('[aria-current="page"]');
    assert.equal(await current.count(), 1, 'navigation exposes exactly one current page');
    assert.equal(await current.textContent(), text);
  }
}
async function more(target, text = sn[target]) {await navigate('more'); await page.locator('.menu-panel').getByRole('button', {name: text, exact: true}).click();}
async function waitProject(name) {await expectVisible(page.getByRole('button', {name: new RegExp(name)}));}
function pass(text) {steps.push(text); console.log(`PASS: ${text}`);}
try {
  checkpoint('Build applications and migrate isolated database');
  await command('npm', ['run', 'build'], backend);
  await command('npm', ['run', 'migrate'], backend);
  await command('npm', ['run', 'build'], web, {VITE_API_URL: api});
  server(['--import', resolve(backend, 'node_modules/tsx/dist/loader.mjs'), resolve(web, 'test/browser-server.mjs')], backend);
  server(['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], web);
  await Promise.all([waitUrl(`${api}/ready`), waitUrl(ui)]);
  checkpoint('Launch Chromium');
  browser = await chromium.launch({headless: true, timeout: 15000, ...((process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) ? {executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : existsSync(chromium.executablePath()) ? {} : existsSync('/usr/bin/chromium') ? {executablePath: '/usr/bin/chromium'} : {}), args: ['--no-sandbox']});
  const context = await browser.newContext({viewport: {width: 390, height: 844}, timezoneId: 'America/Los_Angeles'});
  watchContext(context); page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
  checkpoint('Register owner and acknowledge recovery code');
  await page.goto(ui); await page.getByRole('button', {name: sn.register, exact: true}).click();
  await page.getByLabel(sn.username, {exact: true}).fill(username); await page.getByLabel(sn.password, {exact: true}).fill(password); await page.getByLabel(sn.farmName, {exact: true}).fill('Browser acceptance farm');
  await page.getByRole('button', {name: sn.continue, exact: true}).click();
  await expectVisible(page.getByRole('heading', {name: sn.recoveryCode, exact: true}));
  const recoveryCode = await page.locator('.secret-result code').textContent(); assert.ok(recoveryCode?.length > 15);
  await page.getByRole('button', {name: sn.savedCode, exact: true}).click();
  await expectVisible(page.locator('.farm-switch')); checkpoint('Wait for active service worker and page control');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, {timeout: 15000});
  const workerState = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => ({scope: r.scope, active: r.active?.state, installing: r.installing?.state, waiting: r.waiting?.state})));
  diagnostics.push(`serviceWorker ${JSON.stringify(workerState)}`);
  checkpoint('Create maize project without inventing optional facts');
  await navigate('farm'); await page.locator('summary').filter({hasText: sn.newProject}).click();
  await page.getByLabel(sn.projectName, {exact: true}).fill('Existing irrigated maize');
  await page.getByRole('button', {name: sn.save, exact: true}).click();
  await waitProject('Existing irrigated maize');
  let identity = await apiCall('/v1/sessions', {username, password}); let token = identity.token;
  let farm = (await apiCall('/v1/farms', undefined, token)).items[0];
  let project = (await apiCall(`/v1/farms/${farm.id}/projects`, undefined, token)).items[0];
  assert.equal(project.planting_date, null); assert.equal(project.area_ha, null); assert.equal(project.variety, null); assert.equal(project.irrigation, true);
  await screenshot('phone-projects.png');
  pass('Owner registration, one-time recovery code, active-maize onboarding with unknown facts');

  checkpoint('Stock-linked offline record, photo and restart');
  await more('stock'); await page.locator('summary').filter({hasText: sn.newStock}).click();
  await page.getByLabel(sn.stockName, {exact: true}).fill('Measured fertiliser'); await page.getByLabel(sn.project, {exact: true}).selectOption(project.id);
  await page.getByLabel(sn.quantity, {exact: true}).fill('10'); await page.getByLabel(sn.unit, {exact: true}).selectOption('kg'); await page.getByLabel(sn.unitCost, {exact: true}).fill('2'); await page.getByLabel(sn.currency, {exact: true}).fill('USD');
  await page.getByRole('button', {name: sn.save, exact: true}).click(); await expectVisible(page.locator('.stock-row').filter({hasText: 'Measured fertiliser'}));
  const stock = (await apiCall(`/v1/farms/${farm.id}/stock`, undefined, token)).items[0];
  await context.setOffline(true); await page.locator('.record-fab').click();
  const modal = page.locator('dialog'); await modal.getByLabel(sn.kind, {exact: true}).selectOption('input_use'); await modal.getByLabel(sn.stockItem, {exact: true}).selectOption(stock.id); await modal.getByLabel(sn.quantity, {exact: true}).fill('2');
  await modal.getByLabel(sn.when, {exact: true}).fill('2026-11-03T09:30'); await modal.getByLabel(sn.note, {exact: true}).fill(note);
  await modal.locator('summary').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWPQyPOGIwbiOABrsw4RL3IbzwAAAABJRU5ErkJggg==', 'base64');
  await modal.locator('input[type=file]').first().setInputFiles({name: 'field-evidence.png', mimeType: 'image/png', buffer: png});
  await modal.getByRole('button', {name: sn.save, exact: true}).click(); await modal.waitFor({state: 'hidden'});
  await more('sync', sn.syncPanel); await expectVisible(page.locator('.outbox-row').filter({hasText: note}));
  assert.equal(await page.locator('.outbox-row').count(), 2);
  await page.reload(); await expectVisible(page.getByRole('button', {name: sn.offlineUnlock, exact: true}));
  assert.ok(!(await page.locator('body').innerText()).includes(note));
  await page.getByRole('button', {name: sn.offlineUnlock, exact: true}).click(); await page.getByLabel(sn.username, {exact: true}).fill(username); await page.getByLabel(sn.password, {exact: true}).fill(password); await page.getByRole('button', {name: sn.continue, exact: true}).click();
  await expectVisible(page.locator('.farm-switch')); await page.getByLabel(sn.language, {exact: true}).selectOption('nd'); await expectVisible(page.locator('.mobile-nav').getByRole('button', {name: nd.today, exact: true}));
  await page.getByLabel(nd.language, {exact: true}).selectOption('sn'); await more('sync', sn.syncPanel); assert.equal(await page.locator('.outbox-row').count(), 2);
  await context.setOffline(false); await page.getByRole('button', {name: sn.sync, exact: true}).click();
  // Metadata auto-syncs; the explicit button permits large media independently.
  for (let i = 0; i < 12 && await page.locator('.outbox-row').count(); i++) {await new Promise(r => setTimeout(r, 300)); if (i % 3 === 0) await page.getByRole('button', {name: sn.sync, exact: true}).click();}
  assert.equal(await page.locator('.outbox-row').count(), 0);
  let activities = (await apiCall(`/v1/farms/${farm.id}/activities`, undefined, token)).items;
  const activity = activities.find(a => a.note === note); assert.ok(activity); assert.equal(new Date(activity.observed_at).toISOString(), '2026-11-03T07:30:00.000Z');
  const retryPayload = {id: activity.id, projectId: project.id, kind: 'input_use', observedAt: '2026-11-03T07:30:00.000Z', note, quantity: 2, unit: 'kg', stockItemId: stock.id};
  await apiCall(`/v1/farms/${farm.id}/activities`, retryPayload, token);
  const updatedStock = (await apiCall(`/v1/farms/${farm.id}/stock`, undefined, token)).items.find(s => s.id === stock.id); assert.equal(Number(updatedStock.quantity), 8);
  const report = await apiCall(`/v1/farms/${farm.id}/reports`, undefined, token); assert.equal(Number(report.totals.find(row => row.kind === 'input_consumption').amount), 4);
  const media = await apiCall(`/v1/farms/${farm.id}/media?activityId=${activity.id}`, undefined, token); assert.equal(media.items.length, 1);
  const browserStorage = await page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}})); assert.equal(JSON.stringify(browserStorage).includes(identity.token), false); assert.equal(JSON.stringify(browserStorage).includes(note), false);
  pass('Offline activity + photo survive restart; bilingual unlock, farm time, one stock/cost effect and independent media sync');

  checkpoint('Recover account and re-encrypt old cache');
  await page.locator('.app-header').getByRole('button', {name: sn.lock, exact: true}).click();
  await page.getByRole('button', {name: sn.recover, exact: true}).click(); await page.getByLabel(sn.username, {exact: true}).fill(username); await page.getByLabel(sn.recoveryCode, {exact: true}).fill(recoveryCode); const oldPassword = password; password = 'recovered-browser-fixture-password-2026'; await page.getByLabel(sn.newPassword, {exact: true}).fill(password); await page.getByRole('button', {name: sn.continue, exact: true}).click();
  await expectVisible(page.getByLabel(sn.password, {exact: true})); await page.getByLabel(sn.username, {exact: true}).fill(username); await page.getByLabel(sn.password, {exact: true}).fill(password); await page.getByRole('button', {name: sn.continue, exact: true}).click();
  await expectVisible(page.getByRole('heading', {name: sn.recoverDrafts, exact: true})); await page.getByLabel(sn.previousPassword, {exact: true}).fill(oldPassword); await page.getByRole('button', {name: sn.recoverDrafts, exact: true}).click();
  await expectVisible(page.locator('.farm-switch')); identity = await apiCall('/v1/sessions', {username, password}); token = identity.token;
  assert.equal((await apiCall(`/v1/farms/${farm.id}/activities`, undefined, token)).items.filter(a => a.note === note).length, 1);
  pass('Mailbox-free account recovery and old-cache re-encryption allow normal sign-in');

  checkpoint('Simulated equipment acknowledgement and feedback');
  await more('equipment'); await page.locator('summary').filter({hasText: sn.newAsset}).click();
  await page.getByLabel(sn.assetName, {exact: true}).fill('Pump simulator'); await page.getByLabel(sn.category, {exact: true}).selectOption('pump'); await page.getByLabel(sn.protocol, {exact: true}).selectOption('simulator'); await page.getByRole('button', {name: sn.save, exact: true}).click();
  const assetCard = page.locator('.asset-card').filter({hasText: 'Pump simulator'}); await expectVisible(assetCard); await assetCard.locator('summary').filter({hasText: sn.simulation}).click(); await assetCard.getByLabel(sn.interlockOk, {exact: true}).check(); await assetCard.getByRole('button', {name: sn.simulate, exact: true}).click();
  await assetCard.getByRole('button', {name: sn.start, exact: true}).waitFor({state: 'visible'}); page.once('dialog', dialog => dialog.accept()); await assetCard.getByRole('button', {name: sn.start, exact: true}).click(); await assetCard.locator('summary').filter({hasText: sn.commands}).click(); await expectVisible(assetCard.locator('.command-row'));
  await assetCard.getByRole('button', {name: sn.acknowledge, exact: true}).click(); await expectText(assetCard.locator('.command-row'), sn.acknowledged); await assetCard.getByRole('button', {name: sn.simulatedFeedback, exact: true}).click(); await expectText(assetCard.locator('.command-row'), sn.confirmed);
  const assets = (await apiCall(`/v1/farms/${farm.id}/assets`, undefined, token)).items; const sim = assets.find(a => a.name === 'Pump simulator'); assert.equal(sim.latest_telemetry.running, true);
  assert.equal((await apiCall(`/v1/farms/${farm.id}/assets/${sim.id}/commands`, undefined, token)).items[0].status, 'confirmed');
  pass('Equipment simulator has explicit confirmation, separate acknowledgement and feedback-confirmed outcome');

  await nodeRedJourneys({page, context, api, farm, username, password, sn, nd, more, navigate, checkpoint, pass, artifacts, controlPath: nodeRedControl});
  await completionJourneys({page, context, browser, api, ui, apiCall, farm, project, token, username, password, sn, nd, unique, checkpoint, pass, artifacts, pace, watchContext});
  await accountingJourneys({page, context, browser, api, ui, apiCall, farm, project, token, sn, nd, unique, checkpoint, pass, artifacts, pace, watchContext, backend, startWorker: () => server(['dist/worker.js'], backend)});
  await forumJourneys({page,context,apiCall,farm,token,sn,nd,unique,checkpoint,pass,artifacts});

  checkpoint('Phone and desktop notifications evidence');
  await more('notifications');
  const notificationsHeading = page.getByRole('heading', {level: 1, name: sn.notifications, exact: true});
  for (const [width, height, filename] of [
    [1280, 900, 'desktop-notifications.png'],
    [320, 740, 'small-phone-notifications.png'],
  ]) {
    await page.setViewportSize({width, height});
    await expectVisible(notificationsHeading);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await screenshot(filename);
  }
  await page.setViewportSize({width: 390, height: 844});
  assert.deepEqual(errors, []); pass('Small-phone and desktop layouts have no horizontal overflow or runtime errors');
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({status: 'passed', passed: steps, generatedAt: new Date().toISOString(), viewport: '390x844 + 320x740 + 1280x900', backend: 'real PostgreSQL; isolated fixture only'}, null, 2));
  console.log(`Browser evidence: ${artifacts}`);
} catch (error) {
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({status: 'failed', stage, passed: steps, error: String(error), screenshotsAvailable: Boolean(page)}, null, 2)).catch(() => {});
  await writeFile(resolve(artifacts, 'failure-log.txt'), [String(error), `Stage: ${stage}`, ...diagnostics, ...children.map(child => child.logs())].join('\n\n')).catch(() => {});
  if (page) {await screenshot('failure.png').catch(() => {}); await writeFile(resolve(artifacts, 'failure.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});}
  if(browser)for(const [contextIndex,context] of browser.contexts().entries())for(const [pageIndex,failedPage] of context.pages().entries()){const name=`failure-context-${contextIndex}-page-${pageIndex}`;await failedPage.screenshot({path:resolve(artifacts,`${name}.png`),fullPage:true,timeout:5000}).catch(()=>{});await writeFile(resolve(artifacts,`${name}.txt`),await failedPage.locator('body').innerText().catch(()=>'')).catch(()=>{});}
  console.error(error); console.error(`Failure evidence: ${artifacts}`); for (const child of children) if (child.logs()) console.error(child.logs().slice(-5000)); process.exitCode = 1;
} finally {if (browser) await browser.close(); for (const child of children) child.proc.kill('SIGTERM'); clearTimeout(watchdog);}
