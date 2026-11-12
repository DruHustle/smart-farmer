// Read only the already-open tab. Android Chrome can attach CDP before its
// Custom Tab appears, and the previous role may still have a background page.
function hasFixtureOrigin(page, origins) {
  try { return origins.includes(new URL(page.url()).origin); }
  catch { return false; }
}

export async function waitForVisibleFixturePage(browser, origins, timeoutMs = 10000, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  do {
    const visible = [];
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      if (!hasFixtureOrigin(page, origins)) continue;
      let active;
      try {
        active = await page.evaluate(() => document.visibilityState === 'visible');
      } catch (error) {
        // A navigation may replace this one document after pages() was read.
        if (!page.isClosed() && !/Execution context was destroyed/.test(String(error))) throw error;
        continue;
      }
      if (active && hasFixtureOrigin(page, origins)) visible.push(page);
    }
    if (visible.length > 1) throw new Error('Ambiguous visible fixture tabs');
    if (visible.length === 1) return visible[0];
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (true);
  throw new Error('No visible fixture tab before the handoff deadline');
}

export const chromeFailureStages = new Set([
  'connect', 'visible-tab', 'cancel', 'credential-entry', 'dismiss-keyboard',
  'read-back-email', 'remember-device', 'submit-credentials', 'mfa-entry',
  'mfa-keyboard', 'mfa-submit', 'warm-account', 'return-bridge',
  'target-receipt', 'native-return',
]);
