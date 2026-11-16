import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotificationEmail } from "../src/operations/email-template.js";
import { prepareNotificationRequest } from "../src/operations/notification-request.js";

test("localized email escapes content and highlights verification without exposing the code in its preheader", () => {
  const html = renderNotificationEmail({ title: "Kodhi yekusimbisa", body: "123456", language: "sn" }, true);
  assert.match(html, /<html lang="sn">/);
  assert.match(html, /Vhura Smart Farmer/);
  assert.match(html, /font-size:36px/);
  assert.ok(!html.slice(html.indexOf('display:none'), html.indexOf('</div>')).includes("123456"));
  const hostile = renderNotificationEmail({ title: '<img src=x onerror="bad()">', body: '<script>bad()</script>\n\n@@ACTION@@', language: "nd" });
  assert.doesNotMatch(hostile, /<script>|<img src=x/);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(hostile, /@@ACTION@@/);
  assert.match(hostile, /Vula Smart Farmer/);
});

test("oversized escaped HTML falls back to the complete existing plain-text request", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NOTIFICATION_MODE: "live", RESEND_API_KEY: "fixture", NOTIFICATION_FROM: "Smart Farmer <notifications-farmer@onesa.eu>" });
    const text = '"'.repeat(2400);
    const request = prepareNotificationRequest("email", "fixture@example.org", { title: "Fixture", body: text }, "fixture-email");
    const body = JSON.parse(request.body);
    assert.equal(body.text, text);
    assert.equal(body.html, undefined);
    assert.ok(Buffer.byteLength(request.body) <= 16384);
  } finally {
    for (const key of ["NOTIFICATION_MODE", "RESEND_API_KEY", "NOTIFICATION_FROM"])
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
