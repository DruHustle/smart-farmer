import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const web = createRequire(resolve('smart-farmer-frontend/web/package.json'));
const backend = createRequire(resolve('smart-farmer-backend/package.json'));
const { chromium } = web('playwright');
const { Client } = backend('pg');
const note = 'Field sample ' + randomUUID().slice(0, 8);
const ids = JSON.parse(readFileSync(process.env.NATIVE_FIXTURE_PATH, 'utf8'));
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(process.env.WEB_ORIGIN);
  await page.locator('input[name="username"]').fill('native_owner');
  await page.locator('input[name="password"]').fill('NativeAcceptanceOnly!2026');
  await page.locator('form button[type="submit"], form button.primary').first().click();
  await page.locator('.record-fab').click();
  const form = page.getByRole('dialog');
  await form.locator('select[name="projectId"]').selectOption(ids.projectId);
  await form.locator('select[name="kind"]').selectOption('observation');
  await form.locator('textarea[name="note"]').fill(note);
  await form.locator('input[name="quantity"]').fill('3');
  await form.locator('[name="unit"]').fill('kg');
  const accepted = page.waitForResponse(res => res.url().endsWith('/activities') && res.request().method() === 'POST');
  await form.locator('button[type="submit"]').click();
  const created = await accepted;
  assert.equal(created.status(), 201);
  const request = created.request();
  const activity = request.postDataJSON();
  assert.equal(activity.note, note);
  assert.equal(activity.projectId, ids.projectId);
  const repeat = await page.request.post(request.url(), {headers: {authorization: await request.headerValue('authorization')}, data: activity});
  assert.equal(repeat.status(), 200);
  const pg = new Client({connectionString: process.env.DATABASE_URL});
  await pg.connect();
  try {
    const rows = await pg.query('SELECT id FROM activities WHERE farm_id=$1 AND project_id=$2 AND note=$3 AND quantity=3 AND unit=$4', [ids.farmId, ids.projectId, note, 'kg']);
    assert.deepEqual(rows.rows.map(row => row.id), [activity.id]);
  } finally { await pg.end(); }
  await form.waitFor({state:'hidden'});
  await page.screenshot({path: resolve(process.env.RUNNER_TEMP, 'record-proof/web.png')});
  writeFileSync(resolve(process.env.RUNNER_TEMP, 'record-proof/web.json'), JSON.stringify({note, activityId:activity.id, projectId:ids.projectId, farmId:ids.farmId, create:201, replay:200, databaseRows:1, browser:browser.version()}, null, 2));
} finally { await browser.close(); }
