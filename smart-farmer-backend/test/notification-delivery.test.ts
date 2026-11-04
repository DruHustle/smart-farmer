import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { sha256, token } from "../src/security.js";
import { deliverNotifications, dispatchNotification, queueNotifications } from "../src/operations/notifications.js";
import { digest, openSecret, sealSecret } from "../src/operations/common.js";
import { providerStatus } from "../src/operations/farm.js";
import { notificationRetryWindowMs, prepareNotificationRequest, sealNotificationRequest, validNotificationFrom } from "../src/operations/notification-request.js";

const execute = promisify(execFile);
const environmentKeys = ["NODE_ENV", "NOTIFICATION_MODE", "PROVIDER_SECRET_KEY", "RESEND_API_KEY", "NOTIFICATION_FROM", "RESEND_API_URL", "EXPO_PUSH_URL", "EXPO_ACCESS_TOKEN", "SMS_WEBHOOK_URL", "SMS_WEBHOOK_TOKEN"];
type Call = { url: string; body: string; headers: Headers };
async function fixture(t: TestContext, lastMigration = "999") {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required for delivery durability evidence");
  const url = process.env.TEST_DATABASE_URL;
  const saved = Object.fromEntries(environmentKeys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NODE_ENV: "test", NOTIFICATION_MODE: "live", PROVIDER_SECRET_KEY: randomBytes(32).toString("hex"),
    RESEND_API_KEY: "fixture-only-resend-key", NOTIFICATION_FROM: "Smart Farmer <notifications-farmer@onesa.eu>",
    RESEND_API_URL: "https://resend.fixture.invalid/emails", EXPO_PUSH_URL: "https://expo.fixture.invalid/send",
    EXPO_ACCESS_TOKEN: "fixture-only-expo-key", SMS_WEBHOOK_URL: "https://sms.fixture.invalid/send", SMS_WEBHOOK_TOKEN: "fixture-only-sms-key",
  });
  const schema = "notification_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: url });
  await admin.query("CREATE SCHEMA " + schema);
  // The worker must opt back into durable commits even if the pool default is off.
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c synchronous_commit=off` });
  t.after(async () => {
    await db.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await db.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
  for (const name of (await readdir(new URL("../migrations", import.meta.url))).filter((n) => n.endsWith(".sql") && n.slice(0, 3) <= lastMigration).sort()) {
    await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
  }
  const userId = randomUUID(), farmId = randomUUID();
  await db.query("INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,'fixture-not-a-password','sn')", [userId, "notification_" + userId]);
  await db.query("INSERT INTO farms(id,name,timezone) VALUES($1,'Notification fixture','Africa/Harare')", [farmId]);
  await db.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'owner')", [userId, farmId]);
  await db.query("INSERT INTO notification_preferences(farm_id,user_id,email,sms,push) VALUES($1,$2,true,true,true)", [farmId, userId]);
  const calls: Call[] = [];
  const providerAssertionErrors: unknown[] = [];
  t.after(() => assert.deepEqual(providerAssertionErrors, [], "provider fixture assertions must not be swallowed as network errors"));
  let respond: (call: Call) => Promise<Response> = async () => Response.json({ id: "fixture-provider-receipt" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: String(init?.body), headers: new Headers(init?.headers) };
    calls.push(call);
    try { return await respond(call); }
    catch (error) {
      if ((error as any)?.code === "ERR_ASSERTION") providerAssertionErrors.push(error);
      throw error;
    }
  });
  async function seed(channel = "email", state = "pending", attempts = 0) {
    const id = randomUUID(), channelId = randomUUID(), notificationId = randomUUID();
    const address = channel === "email" ? `fixture-${channelId}@example.org` : channel === "sms" ? "+263771234567" : `ExpoPushToken[${channelId.replaceAll("-", "")}]`;
    await db.query("INSERT INTO notification_channels(id,user_id,channel,address_cipher,address_hash,masked_address,verified_at) VALUES($1,$2,$3,$4,$5,'fixture-masked',now())", [channelId, userId, channel, sealSecret(address, channelId), digest(address)]);
    await db.query("INSERT INTO notifications(id,farm_id,user_id,kind,message_key,arguments,dedupe_key) VALUES($1,$2,$3,'reminder','reminder',$4,$5)", [notificationId, farmId, userId, { title: "Original title", note: "Original private note" }, notificationId]);
    await db.query("INSERT INTO notification_deliveries(id,notification_id,channel_id,state,attempts) VALUES($1,$2,$3,$4,$5)", [id, notificationId, channelId, state, attempts]);
    return { id, channelId, notificationId, address };
  }
  const row = async (id: string) => (await db.query("SELECT d.*,c.channel,c.address_cipher,c.address_hash FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.id=$1", [id])).rows[0];
  const ready = (id: string) => db.query("UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);
  function decode(r: any) {
    return JSON.parse(openSecret(r.request_cipher, `notification-request:v1:${r.id}:${r.notification_id}:${r.channel_id}`));
  }
  async function rewriteRequest(id: string, change: (request: any) => void) {
    const r = await row(id), request = decode(r);
    change(request);
    await db.query("UPDATE notification_deliveries SET request_cipher=$2,request_body_hash=$3,request_prepared_at=$4 WHERE id=$1", [id, sealNotificationRequest(request, r), request.bodyHash, request.preparedAt]);
  }
  return { db, schema, userId, farmId, url, calls, seed, row, ready, decode, rewriteRequest, respond: (next: typeof respond) => { respond = next; } };
}

test("sender validation accepts one explicit mailbox and refuses header injection without enabling delivery", async (t) => {
  const f = await fixture(t);
  for (const value of ["notifications-farmer@onesa.eu", "Smart Farmer <notifications-farmer@onesa.eu>", "Custom Operator <custom@example.org>"])
    assert.equal(validNotificationFrom(value), true, value);
  for (const value of ["", "bad", "a@example.org,b@example.org", "Smart Farmer <a@example.org> <b@example.org>", "Smart Farmer\r\nBcc: other@example.org <a@example.org>", "Bad\0Name <a@example.org>"])
    assert.equal(validNotificationFrom(value), false, value);
  process.env.NOTIFICATION_FROM = "Bad\nSender <a@example.org>";
  assert.equal(providerStatus().email.configured, false);
  assert.equal((await dispatchNotification("email", "test@example.org", { title: "test", body: "test" }, "fixture-id")).state, "unconfigured");
  process.env.NOTIFICATION_MODE = "disabled";
  process.env.NOTIFICATION_FROM = "Smart Farmer <notifications-farmer@onesa.eu>";
  await deliverNotifications(f.db);
  assert.equal(f.calls.length, 0);
});

test("encrypted request and synchronous commit precede POST; resumed retries keep exact bytes despite sender/content/language drift", async (t) => {
  const f = await fixture(t), item = await f.seed();
  let frozen: any;
  f.respond(async (call) => {
    frozen = await f.row(item.id); // independent transaction can see the claim before the provider is called
    assert.equal(frozen.state, "sending");
    assert.equal(frozen.attempts, 1);
    assert.equal(frozen.request_body_hash, digest(call.body));
    const request = f.decode(frozen);
    assert.equal(request.body, call.body);
    assert.equal(typeof JSON.parse(call.body).html, "string");
    assert.ok(JSON.parse(call.body).html.includes('lang="sn"'));
    assert.equal(request.recipientHash, digest(item.address));
    assert.ok(!JSON.stringify(frozen.request_cipher).includes(item.address));
    assert.ok(!JSON.stringify(request).includes(process.env.RESEND_API_KEY!));
    assert.ok(!Object.hasOwn(request, "Authorization"));
    throw new TypeError("fixture connection lost after possible acceptance");
  });
  let durableClaim = false;
  const realConnect = f.db.connect.bind(f.db);
  const observed = { connect: async () => {
    const client = await realConnect();
    return { query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET state='sending'")) {
        assert.equal((await client.query("SHOW synchronous_commit")).rows[0].synchronous_commit, "on");
        durableClaim = true;
      }
      return client.query(sql, values);
    }, release: () => client.release() };
  }, query: f.db.query.bind(f.db) } as unknown as pg.Pool;
  assert.equal(await deliverNotifications(observed, 1), 1);
  assert.equal(durableClaim, true);
  assert.equal((await f.row(item.id)).state, "pending");
  process.env.NOTIFICATION_FROM = "Changed sender <changed@example.org>";
  await f.db.query("UPDATE notifications SET arguments=$2,message_key='task_due' WHERE id=$1", [item.notificationId, { title: "Changed title", note: "Different note" }]);
  await f.db.query("UPDATE users SET language='nd' WHERE id=$1", [f.userId]);
  await f.ready(item.id);
  f.respond(async () => Response.json({ id: "original-provider-receipt" }));
  await deliverNotifications(f.db, 1);
  const final = await f.row(item.id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body, f.calls[0].body);
  assert.equal(f.calls[1].headers.get("Idempotency-Key"), item.id);
  assert.equal(JSON.parse(f.calls[1].body).from, "Smart Farmer <notifications-farmer@onesa.eu>");
  assert.deepEqual(final.request_cipher, frozen.request_cipher);
  assert.equal(final.request_prepared_at.toISOString(), frozen.request_prepared_at.toISOString());
  assert.equal(final.state, "accepted");
  assert.equal(final.provider_id, "original-provider-receipt");
  assert.equal(final.last_error, null);
});

for (const [name, change] of [
  ["credential", () => { process.env.RESEND_API_KEY = "fixture-only-other-account-key"; }],
  ["endpoint", () => { process.env.RESEND_API_URL = "https://other.fixture.invalid/emails"; }],
  ["disabled mode", () => { process.env.NOTIFICATION_MODE = "disabled"; }],
  ["simulated mode", () => { process.env.NOTIFICATION_MODE = "simulated"; }],
  ["encryption key", () => { process.env.PROVIDER_SECRET_KEY = randomBytes(32).toString("hex"); }],
] as const) test(`a changed ${name} holds the original pending request without another POST`, async (t) => {
  const f = await fixture(t), item = await f.seed();
  f.respond(async () => { throw new TypeError("fixture unknown response"); });
  await deliverNotifications(f.db, 1);
  const before = await f.row(item.id);
  change();
  await f.ready(item.id);
  await deliverNotifications(f.db, 1);
  const after = await f.row(item.id);
  assert.equal(after.state, "unknown");
  assert.equal(after.attempts, 1);
  assert.equal(after.last_error, name === "encryption key" ? "notification_request_unreadable" : "notification_provider_changed");
  assert.deepEqual(after.request_cipher, before.request_cipher);
  assert.equal(f.calls.length, 1);
});

test("recipient changes cannot redirect a pending delivery", async (t) => {
  const f = await fixture(t), item = await f.seed();
  f.respond(async () => { throw new TypeError("fixture unknown response"); });
  await deliverNotifications(f.db, 1);
  const changed = "different-recipient@example.org";
  await f.db.query("UPDATE notification_channels SET address_cipher=$2,address_hash=$3 WHERE id=$1", [item.channelId, sealSecret(changed, item.channelId), digest(changed)]);
  await f.ready(item.id);
  await deliverNotifications(f.db, 1);
  assert.equal((await f.row(item.id)).last_error, "notification_recipient_changed");
  assert.equal((await f.row(item.id)).state, "unknown");
  assert.equal(f.calls.length, 1);
});

test("a stored plain-text request from before HTML support is sent without rewriting its bytes", async (t) => {
  const f = await fixture(t), item = await f.seed(), row = await f.row(item.id);
  const request = prepareNotificationRequest("email", item.address, { title: "Legacy notice", body: "Original plain-text notice" }, item.id);
  const legacy = JSON.parse(request.body);
  delete legacy.html;
  request.body = JSON.stringify(legacy);
  request.bodyHash = digest(request.body);
  await f.db.query("UPDATE notification_deliveries SET request_cipher=$2,request_body_hash=$3,request_prepared_at=$4 WHERE id=$1", [item.id, sealNotificationRequest(request, row), request.bodyHash, request.preparedAt]);
  await deliverNotifications(f.db, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body, request.body);
  assert.equal(JSON.parse(f.calls[0].body).html, undefined);
  assert.equal((await f.row(item.id)).state, "accepted");
});

for (const kind of ["hash", "cipher", "expired", "wrong delivery"] as const)
  test(`${kind} request is held without reconstructing current input`, async (t) => {
    const f = await fixture(t), item = await f.seed();
    f.respond(async () => { throw new TypeError("fixture unknown response"); });
    await deliverNotifications(f.db, 1);
    if (kind === "hash") await f.db.query("UPDATE notification_deliveries SET request_body_hash=$2 WHERE id=$1", [item.id, "0".repeat(64)]);
    if (kind === "cipher") await f.db.query("UPDATE notification_deliveries SET request_cipher='{}' WHERE id=$1", [item.id]);
    if (kind === "expired") await f.rewriteRequest(item.id, (r) => { r.preparedAt = new Date(Date.now() - notificationRetryWindowMs - 1000).toISOString(); });
    if (kind === "wrong delivery") {
      const original = await f.row(item.id), other = await f.seed();
      await f.db.query("UPDATE notification_deliveries SET request_cipher=$2,request_body_hash=$3,request_prepared_at=$4 WHERE id=$1", [other.id, original.request_cipher, original.request_body_hash, original.request_prepared_at]);
      await f.db.query("UPDATE notification_deliveries SET state='unknown' WHERE id=$1", [item.id]);
      await deliverNotifications(f.db, 1);
      assert.equal((await f.row(other.id)).last_error, "notification_request_unreadable");
    } else {
      await f.ready(item.id);
      await deliverNotifications(f.db, 1);
      const row = await f.row(item.id);
      assert.equal(row.state, "unknown");
      assert.equal(row.last_error, kind === "hash" ? "notification_request_invalid" : kind === "cipher" ? "notification_request_unreadable" : "notification_request_expired");
    }
    assert.equal(f.calls.length, 1);
  });

test("legacy attempted deliveries without snapshots stay unknown, with original IDs/attempts/receipts", async (t) => {
  const f = await fixture(t);
  const a = await f.seed("email", "pending", 2), b = await f.seed();
  await f.db.query("UPDATE notification_deliveries SET started_at=now(),provider_id='historical-receipt',last_error='provider_outcome_unknown' WHERE id=$1", [a.id]);
  await f.db.query("UPDATE notification_deliveries SET started_at=now() WHERE id=$1", [b.id]);
  await deliverNotifications(f.db);
  for (const item of [a, b]) {
    const r = await f.row(item.id);
    assert.equal(r.state, "unknown");
    assert.equal(r.last_error, "notification_request_missing");
    assert.equal(r.request_cipher, null);
  }
  assert.equal((await f.row(a.id)).attempts, 2);
  assert.equal((await f.row(a.id)).provider_id, "historical-receipt");
  assert.equal(f.calls.length, 0);
});

test("a failed durable claim suppresses POST and rolls back the snapshot", async (t) => {
  const f = await fixture(t), item = await f.seed();
  const realConnect = f.db.connect.bind(f.db);
  const broken = { connect: async () => {
    const client = await realConnect();
    return { query: (sql: string, values?: unknown[]) => {
      if (sql === "COMMIT") throw new Error("fixture commit unavailable");
      return client.query(sql, values);
    }, release: () => client.release() };
  }, query: f.db.query.bind(f.db) } as unknown as pg.Pool;
  await assert.rejects(deliverNotifications(broken, 1), /fixture commit unavailable/);
  const row = await f.row(item.id);
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.request_cipher, null);
  assert.equal(f.calls.length, 0);
  await deliverNotifications(f.db, 1);
  assert.equal(f.calls.length, 1);
});

for (const savedReceipt of [false, true]) test(`provider acceptance with a ${savedReceipt ? "committed but unacknowledged" : "failed"} DB receipt write retries only the frozen request`, async (t) => {
  const f = await fixture(t), item = await f.seed();
  let loseReceipt = true;
  const uncertain = {
    connect: f.db.connect.bind(f.db),
    query: async (sql: string, values?: unknown[]) => {
      if (loseReceipt && sql.includes("provider_id=$3") && values?.[1] === "accepted") {
        loseReceipt = false;
        if (savedReceipt) await f.db.query(sql, values);
        throw new Error("fixture receipt write acknowledgement lost");
      }
      return f.db.query(sql, values);
    },
  } as unknown as pg.Pool;
  await deliverNotifications(uncertain, 1);
  const pending = await f.row(item.id);
  assert.equal(pending.state, "pending");
  assert.equal(pending.last_error, "provider_outcome_unknown");
  assert.equal(pending.provider_id, savedReceipt ? "fixture-provider-receipt" : null);
  process.env.NOTIFICATION_FROM = "Changed sender <changed@example.org>";
  await f.ready(item.id);
  await deliverNotifications(f.db, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body, f.calls[0].body);
  assert.equal(f.calls[1].headers.get("Idempotency-Key"), f.calls[0].headers.get("Idempotency-Key"));
  assert.equal((await f.row(item.id)).provider_id, "fixture-provider-receipt");
  assert.equal((await f.row(item.id)).state, "accepted");
});

test("credential change after claim commit is held before provider POST", async (t) => {
  const f = await fixture(t), item = await f.seed();
  const realConnect = f.db.connect.bind(f.db);
  const changed = {
    connect: async () => {
      const client = await realConnect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql === "COMMIT") process.env.RESEND_API_KEY = "fixture-only-new-account-key";
        return result;
      }, release: () => client.release() };
    },
    query: f.db.query.bind(f.db),
  } as unknown as pg.Pool;
  await deliverNotifications(changed, 1);
  const row = await f.row(item.id);
  assert.equal(row.state, "unknown");
  assert.equal(row.last_error, "notification_provider_changed");
  assert.equal(row.attempts, 1);
  assert.ok(row.request_cipher);
  assert.equal(f.calls.length, 0);
});

test("a reported successful provider response requires a nonempty receipt ID", async (t) => {
  const f = await fixture(t);
  for (const channel of ["email", "sms", "push"]) {
    const address = channel === "email" ? "fixture@example.org" : channel === "sms" ? "+263771234567" : "ExpoPushToken[fixture]";
    for (const id of [undefined, null, 0, {}, "", " ", "bad\nreceipt"]) {
      f.respond(async () => Response.json(channel === "push" ? { data: { status: "ok", id } } : { id, status: "accepted" }));
      await assert.rejects(dispatchNotification(channel, address, { title: "fixture", body: "fixture" }, randomUUID()), { code: "invalid_provider_response" });
    }
    // Keep IDs opaque; do not invent a UUID-only provider or gateway contract.
    f.respond(async () => Response.json(channel === "push" ? { data: { status: "ok", id: "opaque:valid-id" } } : { id: "opaque:valid-id", status: "accepted" }));
    assert.equal((await dispatchNotification(channel, address, { title: "fixture", body: "fixture" }, randomUUID())).providerId, "opaque:valid-id");
  }
  const item = await f.seed("push");
  f.respond(async () => Response.json({ data: { status: "ok" } }));
  await deliverNotifications(f.db, 1);
  assert.equal((await f.row(item.id)).state, "unknown");
  assert.equal((await f.row(item.id)).provider_id, null);
});

test("concurrent workers claim one delivery, and a later receipt resolves only that request", async (t) => {
  const f = await fixture(t), item = await f.seed();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async () => { entered(); await waiting; return Response.json({ id: "one-receipt" }); });
  const first = deliverNotifications(f.db, 1);
  await started;
  assert.equal(await deliverNotifications(f.db, 1), 0);
  release();
  await first;
  assert.equal(f.calls.length, 1);
  assert.equal((await f.row(item.id)).attempts, 1);
  assert.equal((await f.row(item.id)).state, "accepted");
});

test("opt-out, revoked membership, disabled/unverified channels and acknowledgement still cancel pending retries", async (t) => {
  for (const kind of ["opt-out", "membership", "disabled", "unverified", "acknowledged"] as const) await t.test(kind, async (child) => {
    const f = await fixture(child), item = await f.seed();
    f.respond(async () => { throw new TypeError("fixture unknown response"); });
    await deliverNotifications(f.db, 1);
    if (kind === "opt-out") await f.db.query("UPDATE notification_preferences SET email=false");
    if (kind === "membership") await f.db.query("DELETE FROM memberships WHERE user_id=$1", [f.userId]);
    if (kind === "disabled") await f.db.query("UPDATE notification_channels SET disabled_at=now() WHERE id=$1", [item.channelId]);
    if (kind === "unverified") await f.db.query("UPDATE notification_channels SET verified_at=NULL WHERE id=$1", [item.channelId]);
    if (kind === "acknowledged") await f.db.query("UPDATE notifications SET acknowledged_at=now() WHERE id=$1", [item.notificationId]);
    await f.ready(item.id);
    await deliverNotifications(f.db, 1);
    const row = await f.row(item.id);
    assert.equal(row.state, "cancelled");
    assert.equal(row.last_error, "provider_outcome_unknown"); // cancellation is not evidence the earlier POST failed
    assert.equal(f.calls.length, 1);
  });
});

test("known rate limiting cannot erase a previous unknown outcome at the retry bound", async (t) => {
  const f = await fixture(t), item = await f.seed();
  f.respond(async () => { throw new TypeError("fixture unknown response"); });
  await deliverNotifications(f.db, 1);
  f.respond(async () => Response.json({ error: "fixture rate limit" }, { status: 429 }));
  for (let n = 0; n < 5; n++) { await f.ready(item.id); await deliverNotifications(f.db, 1); }
  const row = await f.row(item.id);
  assert.equal(row.state, "unknown");
  assert.equal(row.last_error, "provider_outcome_unknown");
  assert.equal(f.calls.length, 6);
  assert.equal(new Set(f.calls.map((c) => c.body)).size, 1);
});

test("SMS uses the frozen body and push ambiguity is never automatically resent", async (t) => {
  const f = await fixture(t), sms = await f.seed("sms");
  f.respond(async () => { throw new TypeError("fixture unknown response"); });
  await deliverNotifications(f.db, 1);
  await f.db.query("UPDATE notifications SET arguments='{}' WHERE id=$1", [sms.notificationId]);
  await f.ready(sms.id);
  f.respond(async () => Response.json({ id: "sms-receipt", status: "delivered" }));
  await deliverNotifications(f.db, 1);
  assert.equal(f.calls[0].body, f.calls[1].body);
  assert.equal(f.calls[1].headers.get("Idempotency-Key"), sms.id);
  assert.equal((await f.row(sms.id)).state, "provider_delivered");
  const push = await f.seed("push");
  f.respond(async () => { throw new TypeError("fixture unknown push response"); });
  await deliverNotifications(f.db, 1);
  await f.ready(push.id);
  await deliverNotifications(f.db, 1);
  assert.equal((await f.row(push.id)).state, "unknown");
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.parse(f.calls[2].body).title, "Smart Farmer");
  assert.ok(!f.calls[2].body.includes("Original private note"));
});

test("an interrupted sending row stays unknown even with a valid frozen request", async (t) => {
  const f = await fixture(t), item = await f.seed();
  await deliverNotifications(f.db, 1);
  await f.db.query("UPDATE notification_deliveries SET state='sending',started_at=now()-interval '3 minutes',provider_id=NULL WHERE id=$1", [item.id]);
  const client = await f.db.connect();
  try { await queueNotifications(client); } finally { client.release(); }
  await deliverNotifications(f.db);
  assert.equal((await f.row(item.id)).state, "unknown");
  assert.equal((await f.row(item.id)).last_error, "worker_interrupted");
  assert.equal(f.calls.length, 1);
});

test("009 upgrades existing delivery records without inventing snapshots or changing receipts, and reruns cleanly", async (t) => {
  const f = await fixture(t, "008");
  for (const state of ["pending", "sending", "unknown", "accepted", "provider_delivered", "failed", "unconfigured", "simulated", "cancelled"])
    await f.seed("email", state, state === "pending" ? 0 : 2);
  await f.db.query("UPDATE notification_deliveries SET provider_id='existing-receipt',last_error='existing-evidence',started_at=now() WHERE state='unknown'");
  const before = (await f.db.query("SELECT to_jsonb(d) AS record FROM notification_deliveries d ORDER BY id")).rows;
  const url = new URL(f.url!);
  url.searchParams.set("options", `-c search_path=${f.schema}`);
  const options = { cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: url.toString() } };
  const first = await execute(process.execPath, ["--import", "tsx", "src/migrate.ts"], options);
  assert.match(first.stdout, /Applied 009_notification_delivery_requests.sql/);
  assert.deepEqual((await f.db.query("SELECT to_jsonb(d)-'request_cipher'-'request_body_hash'-'request_prepared_at' AS record FROM notification_deliveries d ORDER BY id")).rows, before);
  assert.equal((await f.db.query("SELECT count(*)::int AS count FROM notification_deliveries WHERE request_cipher IS NOT NULL")).rows[0].count, 0);
  const again = await execute(process.execPath, ["--import", "tsx", "src/migrate.ts"], options);
  assert.ok(!again.stdout.includes("Applied"));
  const id = (await f.db.query("SELECT id FROM notification_deliveries LIMIT 1")).rows[0].id;
  await assert.rejects(f.db.query("UPDATE notification_deliveries SET request_body_hash=$2 WHERE id=$1", [id, "0".repeat(64)]), { code: "23514" });
  assert.equal(f.calls.length, 0);
});

test("verification request replay never resends an old identity; explicit resend creates a fresh code/key after cooldown", async (t) => {
  const f = await fixture(t), app = buildApp(f.db, "http://localhost:5173");
  app.log.level = "silent";
  const credential = token();
  await f.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(credential), f.userId]);
  const id = randomUUID(), path = `/v1/farms/${f.farmId}/notification-channels`;
  const headers = { authorization: "Bearer " + credential };
  f.respond(async () => { throw new TypeError("fixture unknown verification outcome"); });
  try {
    const create = () => app.inject({ method: "POST", url: path, headers, payload: { id, channel: "email", address: "verification@example.org" } });
    assert.equal((await create()).statusCode, 503);
    const replay = await create();
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(f.calls.length, 1);
    const resend = () => app.inject({ method: "POST", url: `${path}/${id}/resend`, headers, payload: {} });
    assert.equal((await resend()).statusCode, 429);
    await f.db.query("UPDATE notification_channels SET verification_sent_at=now()-interval '61 seconds' WHERE id=$1", [id]);
    assert.equal((await resend()).statusCode, 503);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].headers.get("Idempotency-Key"), "verify:" + id);
    assert.notEqual(f.calls[1].headers.get("Idempotency-Key"), f.calls[0].headers.get("Idempotency-Key"));
    assert.equal((await resend()).statusCode, 429);
    assert.equal(f.calls.length, 2);
  } finally { await app.close(); }
});
