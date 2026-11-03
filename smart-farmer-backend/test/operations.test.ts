import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { runMaintenance } from "../src/worker.js";
import { getObjectStore } from "../src/integrations/object-store.js";
import { collectGarbage } from "../src/operations/retention.js";
import {
  dispatchNotification,
  isQuiet,
} from "../src/operations/notifications.js";
import { scheduleActive } from "../src/operations/cameras.js";
async function fixture() {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = "operations_" + randomUUID().replaceAll("-", ""),
    admin = new pg.Pool({ connectionString: url });
  await admin.query("CREATE SCHEMA " + schema);
  const db = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema,
  });
  for (const f of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await db.query(
      await readFile(new URL("../migrations/" + f, import.meta.url), "utf8"),
    );
  const directory = await mkdtemp(join(tmpdir(), "smart-farmer-ops-"));
  process.env.MEDIA_ROOT = directory;
  process.env.NODE_ENV = "test";
  const app = buildApp(db, "http://localhost:5173");
  app.log.level = process.env.DEBUG_OPERATIONS ? "error" : "silent";
  const password = "Operations-fixture-password!";
  async function register() {
    const username = "ops_" + randomUUID().slice(0, 10);
    const r = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: {
        username,
        password,
        farmName: "Operational fixture",
        language: "nd",
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const s = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { username, password },
    });
    return {
      ...r.json(),
      headers: { authorization: "Bearer " + s.json().token },
    };
  }
  const owner = await register(),
    prefix = "/v1/farms/" + owner.farmId;
  const request = (method: any, url: string, payload?: any, actor = owner) =>
    app.inject({
      method,
      url,
      headers: actor.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  async function ok(
    method: any,
    url: string,
    payload?: any,
    status = 200,
    actor = owner,
  ) {
    const r = await request(method, url, payload, actor);
    assert.equal(r.statusCode, status, r.body);
    return r.json();
  }
  return {
    app,
    db,
    prefix,
    owner,
    password,
    register,
    request,
    ok,
    close: async () => {
      await app.close();
      await db.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("farm locations, observed weather, owner settings and sourced read-only Companion preserve unknowns and tenant boundaries", async () => {
  const f = await fixture();
  let server: any;
  try {
    const id = randomUUID();
    const location = { id, name: "Recorded plot", kind: "plot", areaHa: 2 };
    await f.ok("POST", f.prefix + "/locations", location, 201);
    await f.ok("POST", f.prefix + "/locations", location);
    assert.equal(
      (
        await f.request("POST", f.prefix + "/locations", {
          ...location,
          name: "changed",
        })
      ).statusCode,
      409,
    );
    const outsider = await f.register();
    assert.equal(
      (
        await f.request(
          "POST",
          `/v1/farms/${outsider.farmId}/locations`,
          { id: randomUUID(), name: "Cross farm", kind: "plot", parentId: id },
          outsider,
        )
      ).statusCode,
      404,
    );
    const obs = {
      id: randomUUID(),
      kind: "rainfall",
      value: 12,
      unit: "mm",
      source: "gauge",
      locationId: id,
      observedAt: new Date().toISOString(),
      instrument: "fixture gauge",
      calibration: "fixture date",
    };
    await f.ok("POST", f.prefix + "/weather/observations", obs, 201);
    await f.ok("POST", f.prefix + "/weather/observations", obs);
    assert.equal((await f.ok("GET", f.prefix + "/weather")).forecast, null);
    await f.ok("PATCH", f.prefix + "/settings", {
      confirmed: true,
      latitude: -17.87,
      longitude: 31.4,
      weatherEnabled: true,
    });
    server = createServer((req, res) => {
      const u = new URL(req.url!, "http://localhost");
      assert.equal(u.searchParams.get("latitude"), "-17.87");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          hourly: {
            time: [1793700000],
            temperature_2m: [25],
            relative_humidity_2m: [40],
            precipitation: [1],
            wind_speed_10m: [6],
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.WEATHER_PROVIDER = "open-meteo";
    process.env.WEATHER_API_URL =
      "http://127.0.0.1:" + server.address().port + "/forecast";
    const weather = await f.ok("POST", f.prefix + "/weather/refresh", {});
    assert.equal(weather.forecast.kind, "forecast");
    assert.equal(weather.observations[0].source, "gauge");
    assert.equal(weather.observations.length, 1);
    const project = await f.ok(
      "POST",
      f.prefix + "/projects",
      {
        id: randomUUID(),
        name: "Known maize",
        crop: "maize",
        irrigation: true,
      },
      201,
    );
    const reference = {
      id: randomUUID(),
      title: "Reviewed local record",
      sourceUrl: "https://example.org/fixture-guidance",
      publishedOn: "2026-01-01",
      version: "fixture-1",
      language: "nd",
      content: "Fixture source text, not actual agronomic advice.",
      reviewedBy: "Fixture operator",
    };
    await f.ok("POST", f.prefix + "/references", reference, 201);
    const response = await f.ok(
      "POST",
      f.prefix + "/projects/" + project.id + "/companion/chat",
      {
        question: "Describe recorded facts",
        referenceIds: [reference.id],
        language: "nd",
      },
    );
    assert.equal(response.mode, "record_based");
    assert.deepEqual(response.proposals, []);
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM equipment_commands")).rows[0]
        .n,
      "0",
    );
    assert.equal(
      (await f.ok("GET", f.prefix + "/settings")).dataSharingEnabled,
      false,
    );
  } finally {
    delete process.env.WEATHER_PROVIDER;
    delete process.env.WEATHER_API_URL;
    if (server) await new Promise<void>((r) => server.close(r));
    await f.close();
  }
});

test("real equipment requires known mapping and observed hardware before commissioning; changes revoke commands and credentials", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.ok(
      "POST",
      f.prefix + "/assets",
      {
        id,
        name: "Protocol fixture pump",
        category: "pump",
        model: "HTTP test fixture",
        protocol: "http",
      },
      201,
    );
    const config = {
      version: 1,
      protocol: "http",
      connectionRef: "fixture",
      telemetry: [
        { name: "running", unit: "boolean", address: "/running" },
        { name: "interlock_ok", unit: "boolean", address: "/interlock_ok" },
      ],
      commands: [
        { name: "start", address: "/start", value: true },
        { name: "stop", address: "/stop", value: false },
      ],
      reason: "Isolated protocol test",
    };
    const configured = await f.ok(
      "POST",
      f.prefix + "/assets/" + id + "/integration",
      config,
    );
    const commissioning = {
      id: randomUUID(),
      version: 2,
      mode: "control",
      confirmed: true,
      password: f.password,
      checks: {
        identityVerified: true,
        mappingVerified: true,
        localInterlocksVerified: true,
        manualOverrideVerified: true,
        networkLossVerified: true,
        feedbackVerified: true,
      },
      evidence: "Isolated fixture only. No real farm equipment commissioned.",
    };
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/assets/" + id + "/commissioning",
          commissioning,
        )
      ).json().error,
      "fresh_hardware_feedback_required",
    );
    const credential = await f.ok(
      "POST",
      f.prefix + "/assets/" + id + "/gateway-token",
      {},
    );
    const edge = { headers: { authorization: "Bearer " + credential.token } };
    const telemetry = {
      id: randomUUID(),
      configurationHash: configured.configuration_hash,
      observedAt: new Date().toISOString(),
      measurements: { running: false, interlock_ok: true },
    };
    await f.ok("POST", "/v1/edge/telemetry", telemetry, 200, edge);
    await f.ok(
      "POST",
      f.prefix + "/assets/" + id + "/commissioning",
      commissioning,
    );
    const command = {
      id: randomUUID(),
      command: "start",
      confirmed: true,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    await f.ok("POST", f.prefix + "/assets/" + id + "/commands", command, 201);
    await f.ok("PATCH", f.prefix + "/assets/" + id, {
      version: 3,
      model: "Changed fixture",
      reason: "Model changed; must reverify",
    });
    assert.equal(
      (
        await f.db.query("SELECT status FROM equipment_commands WHERE id=$1", [
          command.id,
        ])
      ).rows[0].status,
      "rejected",
    );
    assert.equal(
      (await f.request("POST", "/v1/edge/commands/next", {}, edge)).statusCode,
      401,
    );
    assert.equal(
      (
        await f.request("POST", f.prefix + "/assets/" + id + "/commands", {
          ...command,
          id: randomUUID(),
        })
      ).json().error,
      "control_not_commissioned",
    );
  } finally {
    await f.close();
  }
});

test("maintenance completion posts one expense and one recurring occurrence; observation retries preserve event identity", async () => {
  const f = await fixture();
  try {
    const assetId = randomUUID(),
      project = await f.ok(
        "POST",
        f.prefix + "/projects",
        { name: "Maintenance project", crop: "maize", irrigation: true },
        201,
      );
    await f.ok(
      "POST",
      f.prefix + "/assets",
      { id: assetId, name: "Farm tractor", category: "other" },
      201,
    );
    const id = randomUUID(),
      plan = {
        id,
        title: "Recorded maintenance",
        dueAt: new Date().toISOString(),
        intervalDays: 7,
        projectId: project.id,
      };
    await f.ok(
      "POST",
      f.prefix + "/assets/" + assetId + "/maintenance",
      plan,
      201,
    );
    const completed = {
      version: 1,
      status: "completed",
      performedAt: new Date().toISOString(),
      hours: 2,
      amount: 25,
      currency: "USD",
      note: "Test replacement",
    };
    const done = await f.ok(
      "PATCH",
      f.prefix + "/maintenance/" + id,
      completed,
    );
    await f.ok("PATCH", f.prefix + "/maintenance/" + id, completed);
    assert.ok(done.next_occurrence_id);
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM asset_maintenance")).rows[0]
        .n,
      "2",
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*) AS n FROM financial_entries WHERE source_type='asset_maintenance'",
        )
      ).rows[0].n,
      "1",
    );
    const usage = {
      id: randomUUID(),
      kind: "fuel",
      quantity: 5,
      unit: "L",
      observedAt: new Date().toISOString(),
      projectId: project.id,
      note: "Measured refill",
    };
    await f.ok("POST", f.prefix + "/assets/" + assetId + "/usage", usage, 201);
    await f.ok("POST", f.prefix + "/assets/" + assetId + "/usage", usage);
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM asset_usage")).rows[0].n,
      "1",
    );
  } finally {
    await f.close();
  }
});

test("camera HLS and snapshots require current grants, use private expiring credentials, distinguish person capability and retain event clips", async () => {
  const f = await fixture();
  try {
    const assetId = randomUUID(),
      worker = await f.register();
    await f.db.query(
      "INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'worker')",
      [worker.userId, f.owner.farmId],
    );
    await f.ok(
      "POST",
      f.prefix + "/assets",
      {
        id: assetId,
        name: "Camera simulator",
        category: "camera",
        protocol: "simulator",
      },
      201,
    );
    await f.ok("POST", f.prefix + "/cameras/" + assetId + "/configure", {
      version: 1,
      provider: "simulator",
      retentionDays: 2,
      eventsEnabled: true,
      liveEnabled: true,
    });
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/cameras/" + assetId + "/sessions",
          { confirmed: true },
          worker,
        )
      ).statusCode,
      404,
    );
    await f.ok("POST", f.prefix + "/cameras/" + assetId + "/access", {
      userId: worker.userId,
    });
    const session = await f.ok(
      "POST",
      f.prefix + "/cameras/" + assetId + "/sessions",
      { confirmed: true },
      200,
      worker,
    );
    assert.equal(session.mode, "simulated");
    const headers = { authorization: "Bearer " + session.token };
    const playlist = await f.app.inject({ url: session.playlistPath, headers });
    assert.equal(playlist.statusCode, 200, playlist.body);
    assert.ok(playlist.body.startsWith("#EXTM3U"));
    assert.ok(!playlist.body.includes(session.token));
    const segment = playlist.body.split("\n").find((x) => x.endsWith(".ts"))!;
    const clip = await f.app.inject({
      url: session.playlistPath.replace("index.m3u8", segment),
      headers,
    });
    assert.equal(clip.statusCode, 200);
    assert.equal(clip.rawPayload[0], 0x47);
    const cookie = await f.app.inject({
      url: session.playlistPath,
      headers: { cookie: "sf_cam_" + session.id + "=" + session.token },
    });
    assert.equal(cookie.statusCode, 200);
    const snapshot = await f.request(
      "GET",
      f.prefix + "/cameras/" + assetId + "/snapshot",
      undefined,
      worker,
    );
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.headers["x-media-source"], "simulator");
    const event = {
      id: randomUUID(),
      assetId,
      kind: "motion",
      observedAt: new Date().toISOString(),
    };
    await f.ok("POST", f.prefix + "/camera-events", event, 201);
    const dedup = await f.ok("POST", f.prefix + "/camera-events", {
      ...event,
      id: randomUUID(),
    });
    assert.equal(dedup.status, "deduplicated");
    assert.equal(
      (
        await f.request("POST", f.prefix + "/camera-events", {
          ...event,
          id: randomUUID(),
          kind: "person",
        })
      ).json().error,
      "unsupported_detection",
    );
    const playback = await f.ok(
      "POST",
      f.prefix + "/camera-events/" + event.id + "/session",
      { confirmed: true },
      200,
      worker,
    );
    assert.equal(playback.mode, "event");
    await f.db.query(
      "UPDATE camera_events SET received_at=now()-interval '6 minutes' WHERE id=$1",
      [event.id],
    );
    await runMaintenance(f.db);
    await runMaintenance(f.db);
    const escalations = (
      await f.ok("GET", f.prefix + "/notifications")
    ).items.filter((n: any) => n.message_key === "camera_escalation");
    assert.equal(escalations.length, 1);
    const followup = {
      id: randomUUID(),
      title: "Review camera event",
      description: "Manager to check the event in person.",
      severity: "medium",
      confirmed: true,
    };
    await f.ok(
      "POST",
      f.prefix + "/camera-events/" + event.id + "/incident",
      followup,
      201,
    );
    await f.ok(
      "POST",
      f.prefix + "/camera-events/" + event.id + "/incident",
      followup,
    );
    assert.equal((await f.ok("GET", f.prefix + "/incidents")).items.length, 1);
    await f.ok(
      "POST",
      f.prefix + "/camera-events/" + event.id + "/acknowledge",
      {},
    );
    assert.equal(
      (await f.ok("GET", f.prefix + "/notifications")).items.filter(
        (n: any) => n.kind === "camera" && !n.acknowledged_at,
      ).length,
      0,
    );

    await f.ok(
      "DELETE",
      f.prefix + "/cameras/" + assetId + "/access/" + worker.userId,
    );
    assert.equal(
      (await f.app.inject({ url: session.playlistPath, headers })).statusCode,
      404,
    );
    assert.equal(
      (
        await f.ok("GET", f.prefix + "/notifications", undefined, 200, worker)
      ).items.filter((n: any) => n.kind === "camera").length,
      0,
    );
    const usage = await f.ok("GET", f.prefix + "/media-policy");
    process.env.CAMERA_FARM_QUOTA_BYTES = String(usage.cameraUsedBytes);
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/cameras/" + assetId + "/sessions",
          { confirmed: true },
        )
      ).json().error,
      "camera_quota_exceeded",
    );
    delete process.env.CAMERA_FARM_QUOTA_BYTES;
    const ownerSession = await f.ok(
      "POST",
      f.prefix + "/cameras/" + assetId + "/sessions",
      { confirmed: true },
    );
    await f.db.query(
      "UPDATE camera_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [ownerSession.id],
    );
    assert.equal(
      (
        await f.app.inject({
          url: ownerSession.playlistPath,
          headers: { authorization: "Bearer " + ownerSession.token },
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("notification channel ownership, durable deduplication, quiet hours and revoked access remain separate from delivery acknowledgement", async () => {
  const f = await fixture();
  process.env.NOTIFICATION_MODE = "simulated";
  process.env.PROVIDER_SECRET_KEY = randomBytes(32).toString("hex");
  try {
    const channel = {
      id: randomUUID(),
      channel: "email",
      address: "test@example.org",
    };
    const created = await f.ok(
      "POST",
      f.prefix + "/notification-channels",
      channel,
      201,
    );
    assert.equal(created.state, "simulated");
    const duplicate = await f.ok("POST", f.prefix + "/notification-channels", {
      ...channel,
      id: randomUUID(),
    });
    assert.equal(duplicate.id, channel.id);
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/notification-channels/" + channel.id + "/resend",
        )
      ).statusCode,
      429,
    );
    await f.db.query(
      "UPDATE notification_channels SET verification_expires_at=now()-interval '1 second',verification_sent_at=now()-interval '2 minutes' WHERE id=$1",
      [channel.id],
    );
    const resent = await f.ok(
      "POST",
      f.prefix + "/notification-channels/" + channel.id + "/resend",
    );
    created.verificationCode = resent.verificationCode;
    assert.ok(created.verificationCode);
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/notification-channels/" + channel.id + "/verify",
          { code: "000000" },
        )
      ).statusCode,
      400,
    );
    await f.ok(
      "POST",
      f.prefix + "/notification-channels/" + channel.id + "/verify",
      { code: created.verificationCode },
    );
    await f.ok("PATCH", f.prefix + "/notification-preferences", {
      inApp: true,
      push: false,
      email: true,
      sms: false,
    });
    const n = {
      id: randomUUID(),
      audience: "members",
      kind: "reminder",
      title: "Fixture reminder",
    };
    await f.ok("POST", f.prefix + "/notifications", n, 201);
    await f.ok("POST", f.prefix + "/notifications", n);
    await runMaintenance(f.db);
    await runMaintenance(f.db);
    let inbox = await f.ok("GET", f.prefix + "/notifications");
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].deliveries[0].state, "simulated");
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM notification_deliveries"))
        .rows[0].n,
      "1",
    );
    assert.equal(inbox.items[0].acknowledged_at, null);
    await f.ok(
      "POST",
      f.prefix + "/notifications/" + inbox.items[0].id + "/ack",
      {},
    );
    inbox = await f.ok("GET", f.prefix + "/notifications");
    assert.ok(inbox.items[0].acknowledged_at);
    await f.ok("DELETE", f.prefix + "/notification-channels/" + channel.id);
    assert.equal(
      (
        await f.request(
          "POST",
          f.prefix + "/notification-channels/" + channel.id + "/verify",
          { code: created.verificationCode },
        )
      ).statusCode,
      400,
    );
    await f.db.query(
      "UPDATE notification_channels SET verification_sent_at=now()-interval '2 minutes' WHERE id=$1",
      [channel.id],
    );
    const reactivate = await f.ok(
      "POST",
      f.prefix + "/notification-channels/" + channel.id + "/resend",
    );
    await f.ok(
      "POST",
      f.prefix + "/notification-channels/" + channel.id + "/verify",
      { code: reactivate.verificationCode },
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT disabled_at FROM notification_channels WHERE id=$1",
          [channel.id],
        )
      ).rows[0].disabled_at,
      null,
    );
    const stored = (
      await f.db.query("SELECT address_cipher FROM notification_channels")
    ).rows[0].address_cipher;
    assert.ok(!JSON.stringify(stored).includes("test@example.org"));
    assert.ok(
      isQuiet(
        new Date("2026-01-01T21:00:00Z"),
        "Africa/Harare",
        "22:00",
        "06:00",
      ),
    );
    assert.ok(
      !isQuiet(
        new Date("2026-01-01T12:00:00Z"),
        "Africa/Harare",
        "22:00",
        "06:00",
      ),
    );
    assert.ok(
      scheduleActive(
        [{ days: [4], start: "22:00", end: "06:00" }],
        "2026-01-02T02:00:00Z",
        "Africa/Harare",
      ),
    );
  } finally {
    delete process.env.NOTIFICATION_MODE;
    delete process.env.PROVIDER_SECRET_KEY;
    await f.close();
  }
});

test("garbage collector respects backup lock and active references before removing only journalled objects", async () => {
  const f = await fixture();
  let locker: pg.PoolClient | undefined;
  try {
    const bytes = Buffer.from("journalled orphan"),
      digest = createHash("sha256").update(bytes).digest("hex"),
      key = f.owner.farmId + "/" + randomUUID() + "-" + digest;
    await getObjectStore().put(key, bytes);
    await f.db.query(
      "INSERT INTO object_garbage(object_key,farm_id,reason,eligible_at) VALUES($1,$2,'test_orphan',now()-interval '1 hour')",
      [key, f.owner.farmId],
    );
    locker = await f.db.connect();
    await locker.query("SELECT pg_advisory_lock(928175)");
    assert.equal(await collectGarbage(f.db), 0);
    assert.deepEqual(await getObjectStore().get(key), bytes);
    await locker.query("SELECT pg_advisory_unlock(928175)");
    assert.equal(await collectGarbage(f.db), 1);
    await assert.rejects(getObjectStore().get(key));
  } finally {
    if (locker) {
      await locker.query("SELECT pg_advisory_unlock_all()");
      locker.release();
    }
    await f.close();
  }
});

test("configured email adapter uses provider idempotency and reports acceptance without claiming human delivery", async () => {
  const previous = { ...process.env };
  const sent: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    sent.push({ key: req.headers["idempotency-key"], body: JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    res.end('{"id":"provider-fixture"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    process.env.NODE_ENV = "test";
    process.env.NOTIFICATION_MODE = "live";
    process.env.PROVIDER_SECRET_KEY = randomBytes(32).toString("hex");
    process.env.RESEND_API_KEY = "fixture-only";
    process.env.NOTIFICATION_FROM = "fixture@example.org";
    process.env.RESEND_API_URL =
      "http://127.0.0.1:" + (server.address() as any).port + "/emails";
    const r = await dispatchNotification(
      "email",
      "recipient@example.org",
      { title: "Fixture", body: "No real message sent" },
      "stable-id",
    );
    assert.equal(r.state, "accepted");
    assert.equal(sent[0].key, "stable-id");
    assert.deepEqual(sent[0].body.to, ["recipient@example.org"]);
  } finally {
    for (const k of [
      "NODE_ENV",
      "NOTIFICATION_MODE",
      "PROVIDER_SECRET_KEY",
      "RESEND_API_KEY",
      "NOTIFICATION_FROM",
      "RESEND_API_URL",
    ]) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    await new Promise<void>((r) => server.close(() => r()));
  }
});
