import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

// Signed-out journeys. The Onesa issuer and code exchange are synthetic boundaries, as in the
// registration journey; the market and service offers come from the real API and database.

/** Watches a signed-out page: no credentials, no HTTP errors and no console errors until `stop()`. */
function watchSignedOut(page) {
  const state = {failures: [], tokens: [], active: true};
  page.on('request', request => {if (state.active && request.headers().authorization) state.tokens.push(request.url());});
  page.on('response', response => {if (state.active && response.status() >= 400) state.failures.push(`${response.status()} ${response.url()}`);});
  page.on('console', message => {if (state.active && message.type() === 'error') state.failures.push('console: ' + message.text());});
  return {stop() {
    state.active = false;
    assert.deepEqual(state.tokens, [], 'signed-out pages send no credentials');
    assert.deepEqual(state.failures, [], 'signed-out pages load without errors');
  }};
}

/** Routes Onesa sign-in through a synthetic issuer that returns straight to the Farmer callback. */
async function syntheticOnesa(page, ui, api, language) {
  const issuer = 'https://farmer-provider.example.test/';
  const callback = ui + '/auth/onesa/callback';
  const headers = {'Access-Control-Allow-Origin': ui, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
  let challenge, nonce;
  await page.route(api + '/v1/onesa/config', route => route.fulfill({headers, json: {
    issuer, clientId: 'synthetic-farmer', audience: 'https://farmer-api.example.test', callback,
  }}));
  await page.route(issuer + 'authorize?**', route => {
    const params = new URL(route.request().url()).searchParams;
    assert.equal(params.get('redirect_uri'), callback);
    assert.equal(params.get('code_challenge_method'), 'S256');
    challenge = params.get('code_challenge'); nonce = params.get('nonce');
    const url = new URL(callback);
    url.search = new URLSearchParams({code: 'synthetic-preview', state: params.get('state'), iss: issuer});
    return route.fulfill({contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(url.href) + ')</script>'});
  });
  await page.route(api + '/v1/onesa/sessions', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    const body = route.request().postDataJSON();
    assert.equal(body.code, 'synthetic-preview');
    assert.equal(body.nonce, nonce);
    assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge);
    return route.fulfill({headers, json: {token: 'synthetic-preview-token', userId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', username: 'synthetic-visitor',
      language, vaultKey: 'synthetic-preview-vault-key', expiresAt: new Date(Date.now() + 300000).toISOString()}});
  });
}

async function accessible(page, selector) {
  const result = await new AxeBuilder({page}).include(selector).analyze();
  assert.deepEqual(result.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({id: item.id, nodes: item.nodes.length})), [], selector);
}

async function openContext(browser, language, width) {
  const context = await browser.newContext({serviceWorkers: 'block', viewport: {width, height: 900}});
  await context.addInitScript(lang => localStorage.setItem('smart-farmer-language', lang), language);
  return context;
}

// Signed-out visitors see Farmer's features first; a feature action signs in and returns to that feature.
export async function previewJourney(browser, ui, api, catalog) {
  for (const [language, width] of [['sn', 1280], ['nd', 320]]) {
    const t = catalog[language];
    const context = await openContext(browser, language, width);
    try {
      const page = await context.newPage();
      const signedOut = watchSignedOut(page);
      await syntheticOnesa(page, ui, api, language);
      await page.goto(ui);
      const preview = page.getByRole('region', {name: t.previewTitle});
      await preview.waitFor();
      assert.equal(await preview.getByRole('article').count(), 6);
      assert.equal(await preview.getByText(t.previewSample, {exact: true}).count(), 6);
      for (const title of [t.previewTodayTitle, t.previewFarmTitle, t.services, t.market, t.forum, t.reports]) {
        await preview.getByRole('heading', {name: title, exact: true}).waitFor();
        const box = await preview.getByRole('button', {name: `${t.previewOpen}: ${title}`, exact: true}).boundingBox();
        assert.ok(box && box.height >= 44, `${title} action is a full-size tap target`);
      }
      // Only the features with public offers offer guest browsing.
      assert.equal(await preview.getByRole('button', {name: new RegExp('^' + t.guestBrowse + ':')}).count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll at ${width}px`);
      await accessible(page, '.public-preview');
      signedOut.stop();

      const exchange = page.waitForResponse(api + '/v1/onesa/sessions');
      await preview.getByRole('button', {name: `${t.previewOpen}: ${t.market}`, exact: true}).click();
      assert.equal((await exchange).status(), 200);
      await page.waitForURL(ui + '/?page=market');
      const current = page.locator('nav [aria-current=page]:visible').first();
      await current.waitFor();
      assert.ok((await current.innerText()).includes(t.market), 'sign-in returns to the chosen feature');
    } finally {
      await context.close();
    }
  }
}

// Guests browse real public market and service offers without credentials; buying signs in and
// returns to the same listing. Runs after the suite has published listings and services.
export async function guestJourney(browser, ui, api, catalog) {
  const published = await (await fetch(`${api}/v1/market/listings?limit=1`)).json();
  assert.ok(published.items.length > 0, 'the suite has an active public listing to browse');
  const listing = published.items[0];
  const services = await (await fetch(`${api}/v1/services?limit=1`)).json();
  for (const [language, width] of [['nd', 1280], ['sn', 320]]) {
    const t = catalog[language];
    const context = await openContext(browser, language, width);
    try {
      const page = await context.newPage();
      const signedOut = watchSignedOut(page);
      await syntheticOnesa(page, ui, api, language);
      // A shared listing link opens straight into guest browsing, with that listing first.
      await page.goto(`${ui}/?listing=${listing.id}`);
      const guest = page.getByRole('region', {name: t.guestTitle});
      await guest.waitFor();
      const shared = guest.locator('.guest-shared').getByRole('article', {name: listing.title});
      await shared.waitFor();
      assert.ok((await shared.innerText()).includes(listing.seller_name), 'guests see who is selling');
      // Search the public market as a guest.
      await guest.getByRole('searchbox').fill(listing.title);
      await guest.getByRole('button', {name: t.search, exact: true}).click();
      await guest.getByRole('article', {name: listing.title}).first().waitFor();
      // Service offers are also open to guests.
      await guest.getByRole('button', {name: t.services, exact: true}).click();
      assert.equal(new URL(page.url()).search, '?page=services');
      if (services.items.length) await guest.getByRole('article', {name: services.items[0].name}).first().waitFor();
      else await guest.getByText(t.noData, {exact: true}).waitFor();
      assert.equal(await guest.getByRole('button', {name: t.guestBook}).count() > 0, services.items.length > 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll at ${width}px`);
      await accessible(page, '.guest-market');
      await guest.getByRole('button', {name: t.market, exact: true}).click();
      await shared.waitFor();
      signedOut.stop();

      // Buying or asking needs an account: sign in, then land back on the same listing.
      const exchange = page.waitForResponse(api + '/v1/onesa/sessions');
      await shared.getByRole('button', {name: t.guestBuy}).click();
      assert.equal((await exchange).status(), 200);
      await page.waitForURL(`${ui}/?listing=${listing.id}`);
      const current = page.locator('nav [aria-current=page]:visible').first();
      await current.waitFor();
      assert.ok((await current.innerText()).includes(t.market), 'sign-in returns to the shared listing in the market');
    } finally {
      await context.close();
    }
  }
}
