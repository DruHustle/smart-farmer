import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {previewFeatures, previewDestination} from '../src/lib/preview.ts';
import {destination, pages} from '../src/lib/destination.ts';
import {catalog} from '../src/locales.ts';

test('the signed-out preview shows six distinct features, each returning to a recognised app route', () => {
  assert.equal(previewFeatures.length, 6);
  assert.equal(new Set(previewFeatures.map(f => f.page)).size, previewFeatures.length);
  for (const {page} of previewFeatures) {
    assert.ok(pages.includes(page), page);
    const path = previewDestination(page);
    assert.equal(destination(new URL(path, 'https://farmer.example.test')).page, page, path);
  }
  assert.deepEqual(previewFeatures.map(f => f.page), ['today', 'farm', 'services', 'market', 'forum', 'reports']);
});

test('every preview word exists in English, Shona and isiNdebele', () => {
  const keys = new Set(['previewTitle', 'previewIntro', 'previewSample', 'previewSampleNote', 'previewOpen']);
  for (const feature of previewFeatures) {
    keys.add(feature.title); keys.add(feature.text);
    for (const row of feature.sample) keys.add(row.text);
  }
  for (const lang of ['sn', 'nd', 'en']) for (const key of keys) {
    assert.equal(typeof catalog[lang][key], 'string', `${lang}.${key}`);
    assert.ok(catalog[lang][key].trim().length > 0, `${lang}.${key}`);
  }
  assert.notEqual(catalog.sn.previewOpen, catalog.nd.previewOpen);
});

test('samples are illustrative only: bounded meters and no farm data or API access in the preview', () => {
  for (const feature of previewFeatures) for (const row of feature.sample) {
    if (row.meter !== undefined) assert.ok(row.meter >= 0 && row.meter <= 100, `${feature.page}.${row.text}`);
  }
  const component = readFileSync(new URL('../src/components/PublicPreview.tsx', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../src/lib/preview.ts', import.meta.url), 'utf8');
  for (const source of [component, data]) {
    assert.doesNotMatch(source, /\bfetch\(|\brequest\(|lib\/api|Vault|localStorage|sessionStorage/);
  }
  // Every card is labelled as an example and carries a sign-in action named after its feature.
  assert.match(component, /<figcaption>\{t\.previewSample\}<\/figcaption>/);
  assert.match(component, /aria-label=\{`\$\{t\.previewOpen\}: \$\{title\}`\}/);
});

test('a preview or guest action stores its route before starting Onesa sign-in', () => {
  const auth = readFileSync(new URL('../src/Auth.tsx', import.meta.url), 'utf8');
  assert.match(auth, /function openFeature\(page: Page\) \{signInFor\(pagePath\(page\)\);\}/);
  const action = auth.slice(auth.indexOf('function signInFor'), auth.indexOf('async function signIn('));
  assert.ok(action.indexOf("history.replaceState(null, '', path)") >= 0);
  assert.ok(action.indexOf("history.replaceState(null, '', path)") < action.indexOf('beginOnesa(onesa, accountLanguage)'));
});

test('guests browse only the offers the API publishes without a token, and every guest action signs in', async () => {
  const {guestTabs, guestPaths, guestPageSize, isGuestTab} = await import('../src/lib/preview.ts');
  assert.deepEqual(guestTabs, ['market', 'services']);
  assert.deepEqual(guestPaths, {market: '/v1/market/listings', services: '/v1/services'});
  assert.ok(guestPageSize > 0 && guestPageSize <= 100);
  for (const page of ['today', 'farm', 'forum', 'reports', 'accounting', 'people', 'settings', 'security']) assert.equal(isGuestTab(page), false, page);
  const guest = readFileSync(new URL('../src/components/GuestMarket.tsx', import.meta.url), 'utf8');
  // Requests carry no token and nothing is ever written by a guest.
  assert.doesNotMatch(guest, /jsonBody|method:|Vault|token|localStorage|sessionStorage/);
  assert.match(guest, /onSignIn\(`\/\?listing=\$\{text\(row\.id\)\}`\)/);
  assert.match(guest, /onSignIn\('\/\?page=services'\)/);
  for (const lang of ['sn', 'nd', 'en']) for (const key of ['guestBrowse', 'guestTitle', 'guestNote', 'guestBuy', 'guestBook', 'guestSeller', 'guestShared', 'guestUnavailable'])
    assert.ok(catalog[lang][key]?.trim(), `${lang}.${key}`);
});
