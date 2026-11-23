import assert from 'node:assert/strict';

export async function viewerJourney({browser, ui, apiCall, farm, token, sn, unique}) {
  const username = 'browser_viewer_' + unique;
  const password = 'viewer-fixture-password';
  await apiCall('/v1/register', {username, password, language: 'sn', farmName: 'Viewer test account'});
  const session = await apiCall('/v1/sessions', {username, password});
  const invite = await apiCall(`/v1/farms/${farm.id}/invitations`, {role: 'viewer'}, token);
  await apiCall('/v1/invitations/accept', {token: invite.token}, session.token);
  const context = await browser.newContext({viewport: {width: 320, height: 740}});
  try {
    const page = await context.newPage();
    await page.goto(ui);
    await page.getByLabel(sn.username, {exact: true}).fill(username);
    await page.getByLabel(sn.password, {exact: true}).fill(password);
    await page.getByRole('button', {name: sn.continue, exact: true}).click();
    await page.locator('.farm-switch select').selectOption(farm.id);
    const overview = page.getByTestId('viewer-overview');
    await overview.getByText('Existing irrigated maize', {exact: true}).waitFor();
    assert.equal(await overview.getByRole('heading', {name: sn.projects}).count(), 1);
    assert.equal(await overview.getByRole('heading', {name: sn.tasks}).count(), 1);
    assert.equal(await page.locator('.record-fab').count(), 0);
    assert.equal(await page.locator('.desktop-nav nav button').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  } finally {
    await context.close();
  }
}
