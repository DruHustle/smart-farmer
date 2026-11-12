// Run against the two disposable databases and TLS origin started by scripts/portal-device-fixture.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { catalog } from '../src/locales.ts';

const fixture = JSON.parse(await readFile(process.env.FIXTURE_READY_FILE, 'utf8'));
const farmer = new URL(process.env.FARMER_TEST_ORIGIN || 'https://127.0.0.1:46502');
const portal = new URL(process.env.PORTAL_TEST_ORIGIN || 'https://localhost:46501');
for (const url of [farmer, portal]) {
  assert.equal(url.protocol, 'https:');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
}
const farmName = 'Website farm ' + randomUUID().slice(0, 8);
const cropName = 'North maize plot';
const destination = farmer.origin + '/?page=farm';

async function signIn(width) {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH});
  try {
    const page = await browser.newPage({ignoreHTTPSErrors: true, viewport: {width, height: 880}});
    await page.goto(destination);
    await page.locator('.onesa-signin').click();
    await page.waitForURL(url => url.origin === portal.origin && url.pathname.startsWith('/account/sign-in/'));
    const form = page.locator('form').filter({has: page.locator('input[name=password]')});
    await form.locator('input[name=email]').fill(fixture.MEMBER_EMAIL);
    await form.locator('input[name=password]').fill(fixture.PASSWORD);
    await form.locator('button[type=submit], button:not([type])').first().click();
    await page.waitForURL(destination);
    return {browser, page};
  } catch (error) {
    await browser.close();
    throw error;
  }
}

const desktop = await signIn(1280);
try {
  const {page} = desktop;
  const attempts = [];
  await page.route(farmer.origin + '/v1/farms', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    attempts.push(request.postDataJSON().id);
    if (attempts.length > 1) return route.continue();
    const committed = await route.fetch();
    assert.ok(committed.ok(), 'first creation must commit before disconnecting the response');
    await route.abort('failed');
  });
  const create = page.locator('form.first-farm');
  await create.locator('input[name=farmName]').fill(farmName);
  await create.getByRole('button').click();
  await create.locator('input[readonly]').waitFor();
  await create.getByRole('button').click();
  const farms = page.locator('.farm-switch option');
  await farms.filter({hasText: farmName}).waitFor({state: 'attached'});
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0]);
  assert.equal(attempts[1], attempts[0]);
  assert.equal(await farms.count(), 1);
  await page.locator('summary').filter({hasText: catalog.sn.newProject}).click();
  await page.getByLabel(catalog.sn.projectName, {exact: true}).fill(cropName);
  await page.getByRole('button', {name: catalog.sn.save, exact: true}).click();
  await page.getByRole('button', {name: new RegExp(cropName)}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('Desktop Portal return, first farm, exactly-once response-loss recovery and crop creation passed.');
} finally {
  await desktop.browser.close();
}

const mobile = await signIn(390);
try {
  const {page} = mobile;
  await page.getByRole('button', {name: new RegExp(cropName)}).click();
  await page.getByText(cropName, {exact: true}).first().waitFor();
  assert.equal(await page.locator('.farm-switch option:checked').textContent(), farmName);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('Fresh phone-width browser signed in through Portal and reopened the saved crop in the same farm.');
} finally {
  await mobile.browser.close();
}
