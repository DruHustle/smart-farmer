import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function nodeRedJourneys({page, context, api, farm, username, password, sn, nd, more, navigate, checkpoint, pass, artifacts, controlPath}) {
  checkpoint('Node-RED owner review, one install and durable unknown outcome');
  await writeFile(controlPath, JSON.stringify({enabled: true, farmId: farm.id, confirmed: false}));
  const managementRequests = [];
  const watch = request => {if (request.url().includes('/node-red/')) managementRequests.push({url: request.url(), method: request.method()});};
  page.on('request', watch);
  const panel = page.locator('.node-red-packages');
  const review = panel.getByRole('button', {name: sn.nodeRedReview, exact: true});
  const moduleField = panel.getByLabel(sn.nodeRedModule, {exact: true});
  const versionField = panel.getByLabel(sn.nodeRedVersion, {exact: true});
  const install = panel.getByRole('button', {name: sn.nodeRedInstall, exact: true});
  async function prepare() {
    await moduleField.fill('@fixture/node-red-test'); await versionField.fill('1.2.3');
    await review.click(); await panel.getByRole('heading', {name: sn.nodeRedReviewTitle, exact: true}).waitFor();
  }
  async function loginAfterReload() {
    await page.reload();
    await page.getByLabel(sn.username, {exact: true}).fill(username);
    await page.getByLabel(sn.password, {exact: true}).fill(password);
    await page.getByRole('button', {name: sn.continue, exact: true}).click();
    await page.locator('.farm-switch').waitFor(); await more('equipment');
  }
  try {
    await more('equipment'); await moduleField.waitFor();
    assert.equal(await panel.getByLabel(sn.nodeRedGateway, {exact: true}).inputValue(), 'fixture-north');
    await prepare(); assert.equal(await install.isDisabled(), true);
    await panel.getByLabel(sn.nodeRedAcknowledge, {exact: true}).check(); assert.equal(await install.isEnabled(), true);
    await versionField.fill('1.2.4'); assert.equal(await install.count(), 0, 'Editing the version invalidates the reviewed action');
    await prepare(); await panel.getByLabel(sn.nodeRedAcknowledge, {exact: true}).check();
    await panel.getByLabel(sn.nodeRedGateway, {exact: true}).selectOption('fixture-south');
    await moduleField.waitFor(); assert.equal(await install.count(), 0, 'Changing the gateway discards the old review');
    await prepare(); assert.equal(await panel.getByLabel(sn.nodeRedAcknowledge, {exact: true}).isChecked(), false);
    await panel.getByLabel(sn.nodeRedAcknowledge, {exact: true}).check();
    await install.dblclick();
    await panel.locator('.node-red-operation').getByText(sn.nodeRedUnconfirmed, {exact: true}).waitFor();
    assert.equal(await review.isDisabled(), true); assert.equal(await moduleField.isDisabled(), true);
    let evidence = JSON.parse(await readFile(controlPath + '.evidence.json', 'utf8'));
    assert.equal(evidence['fixture-south'].posts, 1); assert.equal(evidence['fixture-north'].posts, 0);
    assert.equal(managementRequests.filter(item => item.url.endsWith('/install')).length, 1);
    for (const width of [390, 320]) {
      await page.setViewportSize({width, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await panel.screenshot({path: resolve(artifacts, `node-red-${width}-unconfirmed.png`)});
    }
    await page.setViewportSize({width: 390, height: 844});
    await loginAfterReload();
    await panel.getByLabel(sn.nodeRedGateway, {exact: true}).selectOption('fixture-south');
    await panel.locator('.node-red-operation').getByText(sn.nodeRedUnconfirmed, {exact: true}).waitFor();
    assert.equal(await review.isDisabled(), true, 'Reload retains the server reservation');
    const unchanged = page.waitForResponse(item => item.url().endsWith('/packages/reconcile') && item.request().method() === 'POST');
    await panel.getByRole('button', {name: sn.nodeRedReconcile, exact: true}).click();
    assert.equal((await (await unchanged).json()).operation.state, 'unconfirmed');
    await panel.locator('.node-red-gateway[aria-busy="false"]').waitFor();
    assert.equal(await review.isDisabled(), true, 'Absent runtime package does not unlock another install');
    await writeFile(controlPath, JSON.stringify({enabled: true, farmId: farm.id, confirmed: true}));
    await panel.getByRole('button', {name: sn.nodeRedReconcile, exact: true}).click();
    await panel.locator('.node-red-operation').getByText(sn.nodeRedSuccess, {exact: true}).waitFor();
    await panel.locator('.node-red-gateway[aria-busy="false"]').waitFor();
    assert.equal(await review.isEnabled(), true);
    evidence = JSON.parse(await readFile(controlPath + '.evidence.json', 'utf8'));
    assert.equal(evidence['fixture-south'].posts, 1, 'Reconciliation never transmits a second install');
    const reconciliationCount = managementRequests.filter(item => item.url.endsWith('/reconcile')).length;
    await panel.getByLabel(sn.nodeRedGateway, {exact: true}).selectOption('fixture-north');
    await prepare(); await panel.getByLabel(sn.nodeRedAcknowledge, {exact: true}).check();
    await install.click();
    await panel.locator('.node-red-operation').getByText(sn.nodeRedSuccess, {exact: true}).waitFor();
    await panel.locator('.node-red-gateway[aria-busy="false"]').waitFor();
    assert.equal(await review.isEnabled(), true, 'A normally confirmed installation unlocks without reconciliation');
    assert.equal(managementRequests.filter(item => item.url.endsWith('/reconcile')).length, reconciliationCount);
    evidence = JSON.parse(await readFile(controlPath + '.evidence.json', 'utf8'));
    assert.equal(evidence['fixture-north'].posts, 1);
    assert.equal(evidence['fixture-south'].posts, 1);
    await page.getByLabel(sn.language, {exact: true}).selectOption('nd');
    await panel.getByRole('heading', {name: nd.nodeRedTitle, exact: true}).waitFor();
    await panel.getByRole('heading', {name: nd.nodeRedInstalled, exact: true}).waitFor();
    await page.getByLabel(nd.language, {exact: true}).selectOption('sn');
    await panel.getByRole('heading', {name: sn.nodeRedTitle, exact: true}).waitFor();
    pass('Node-RED exact review, explicit acknowledgement, gateway invalidation, one POST per action, durable uncertainty, read-only reconciliation and normal-success unlock');

    checkpoint('Node-RED offline and older-API rollback capability boundaries');
    const beforeOffline = managementRequests.length;
    await context.setOffline(true); await panel.waitFor({state: 'hidden'});
    assert.equal(managementRequests.length, beforeOffline, 'Offline mode never queues or repeats a package action');
    await context.setOffline(false); await moduleField.waitFor();
    await panel.locator('.node-red-gateway[aria-busy="false"]').waitFor();
    let capabilities = false, role = 'owner';
    const farmRoute = api + '/v1/farms';
    const handler = async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const {capabilities: _capabilities, ...body} = await response.json();
      // Retain the actual API's CORS/status headers while simulating rollback
      // capability omission and current farm membership changes.
      return route.fulfill({response, json: {...body, items: body.items.map(item => item.id === farm.id ? {...item, role} : item), ...(capabilities ? {capabilities: ['node-red-package-management-v1']} : {})}});
    };
    await page.route(farmRoute, handler);
    try {
      const beforeRollback = managementRequests.length;
      const [response] = await Promise.all([
        page.waitForResponse(item => item.url() === farmRoute && item.request().method() === 'GET'),
        panel.getByRole('button', {name: sn.refresh, exact: true}).click(),
      ]);
      await response.finished(); await panel.waitFor({state: 'hidden'});
      assert.equal(managementRequests.length, beforeRollback, 'Older API capability omission causes zero management RPCs');
      capabilities = true; role = 'manager';
      const [revoked] = await Promise.all([
        page.waitForResponse(item => item.url() === farmRoute && item.request().method() === 'GET'),
        (async () => {await navigate('today'); await more('equipment');})(),
      ]);
      await revoked.finished();
      assert.equal(await panel.count(), 0, 'A freshly revoked owner role hides package management');
      assert.equal(managementRequests.length, beforeRollback);
    } finally {await page.unroute(farmRoute, handler);}
    pass('Older API and current non-owner membership hide management; offline mode issues no install or replay');
  } finally {
    page.off('request', watch);
    await context.setOffline(false);
    await writeFile(controlPath, JSON.stringify({enabled: false}));
    await navigate('today');
  }
}
