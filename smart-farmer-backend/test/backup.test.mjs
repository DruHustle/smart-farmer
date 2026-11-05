import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "../src/app.ts";
import { copyIntoEmptyMediaDirectory } from "../scripts/backup-media.mjs";

test("restore media copy accepts missing or empty directories and refuses existing content", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "smart-farmer-media-copy-"));
  try {
    const source = join(temporary, "source");
    await mkdir(join(source, "farm"), { recursive: true });
    await writeFile(join(source, "farm", "object"), "immutable attachment");
    for (const name of ["missing", "empty"]) {
      const destination = join(temporary, name);
      if (name === "empty") await mkdir(destination);
      await copyIntoEmptyMediaDirectory(source, destination);
      assert.equal(
        await readFile(join(destination, "farm", "object"), "utf8"),
        "immutable attachment",
      );
    }
    const occupied = join(temporary, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "existing"), "preserve me");
    await assert.rejects(
      copyIntoEmptyMediaDirectory(source, occupied),
      /must be empty/,
    );
    assert.deepEqual(await readdir(occupied), ["existing"]);
    assert.equal(
      await readFile(join(occupied, "existing"), "utf8"),
      "preserve me",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("encrypted PostgreSQL and private media backup restores to an empty isolated database; tampering cannot restore", async () => {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL required");
  const base = process.env.TEST_DATABASE_URL;
  const suffix = randomBytes(5).toString("hex");
  const names = [
    `smart_farmer_backup_test_${suffix}`,
    `smart_farmer_restore_${suffix}`,
    `smart_farmer_restore_bad_${suffix}`,
  ];
  const connection = (name) => {
    const value = new URL(base);
    value.pathname = "/" + name;
    return value.href;
  };
  const admin = new pg.Pool({ connectionString: base });
  const temporary = await mkdtemp(join(tmpdir(), "smart-farmer-restore-test-"));
  const key = join(temporary, "backup.key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const sourceMedia = join(temporary, "source-media"),
    restoredMedia = join(temporary, "restored-media");
  const backup = join(temporary, "test.sfbak");
  let source;
  const run = (argv, env = {}) =>
    spawnSync(process.execPath, argv, {
      env: { ...process.env, LOG_LEVEL: "silent", ...env },
      encoding: "utf8",
    });
  try {
    for (const name of names) await admin.query("CREATE DATABASE " + name);
    const env = {
      DATABASE_URL: connection(names[0]),
      MEDIA_ROOT: sourceMedia,
      BACKUP_KEY_FILE: key,
    };
    let result = run(["--import", "tsx", "src/migrate.ts"], env);
    assert.equal(result.status, 0, result.stderr);
    process.env.MEDIA_ROOT = sourceMedia;
    source = new pg.Pool({ connectionString: env.DATABASE_URL });
    const app = buildApp(source, "http://localhost:5173");
    app.log.level = "silent";
    let mediaId, invoiceDocumentId, invoiceId, objectKey;
    try {
      const register = await app.inject({
        method: "POST",
        url: "/v1/register",
        payload: {
          username: "backup_fixture",
          password: "fixture-restore-password",
          language: "sn",
          farmName: "Restore fixture",
        },
      });
      assert.equal(register.statusCode, 201, register.body);
      const sign = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: {
          username: "backup_fixture",
          password: "fixture-restore-password",
        },
      });
      assert.equal(sign.statusCode, 200);
      const headers = { authorization: `Bearer ${sign.json().token}` },
        prefix = `/v1/farms/${register.json().farmId}`;
      const project = await app.inject({
        method: "POST",
        url: prefix + "/projects",
        headers,
        payload: { name: "Recorded maize", crop: "maize", irrigation: true },
      });
      assert.equal(project.statusCode, 201);
      const id = crypto.randomUUID();
      await app.inject({
        method: "POST",
        url: prefix + "/activities",
        headers,
        payload: {
          id,
          projectId: project.json().id,
          kind: "observation",
          observedAt: new Date().toISOString(),
          note: "Restore evidence",
        },
      });
      mediaId = crypto.randomUUID();
      const dataBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD0cAAAAASUVORK5CYII=";
      const media = await app.inject({
        method: "POST",
        url: prefix + "/media",
        headers,
        payload: {
          id: mediaId,
          activityId: id,
          mimeType: "image/png",
          filename: "field.png",
          dataBase64,
        },
      });
      assert.equal(media.statusCode, 201, media.body);
      // Financial originals have their own private reference table. Exercise the
      // real upload/post/payment APIs so a restore must recover both books and
      // source bytes, not merely a synthetic database row.
      invoiceDocumentId = crypto.randomUUID();
      const invoiceSource = await app.inject({
        method: "POST", url: prefix + "/accounting/documents", headers,
        payload: { id: invoiceDocumentId, mimeType: "image/png", filename: "supplier-original.png", dataBase64 },
      });
      assert.equal(invoiceSource.statusCode, 201, invoiceSource.body);
      // This 1px fixture has no printed text; manual review remains possible.
      await source.query("UPDATE accounting_documents SET state='failed',error_code='no_text_detected',attempts=1 WHERE id=$1", [invoiceDocumentId]);
      const settings = await app.inject({ method: "PUT", url: prefix + "/accounting/settings", headers,
        payload: { id: crypto.randomUUID(), version: 0, business: { legalName: "Restore fixture farm", tradingName: "", address: "", email: "", phone: "", registrationNumber: "", taxNumber: "" }, defaultCurrency: "USD", invoicePrefix: "TEST", startingNumber: 1, taxRates: [], lockedThrough: null, reason: "Isolated restore verification" },
      });
      assert.ok([200,201].includes(settings.statusCode), settings.body);
      invoiceId = crypto.randomUUID();
      const draft = await app.inject({ method: "POST", url: prefix + "/accounting/invoices", headers,
        payload: { id: invoiceId, kind: "purchase", party: { name: "Restore fixture supplier", address: "", email: "", phone: "", taxNumber: "" }, currency: "USD", reference: "SUP-RESTORE", issueDate: "2026-11-05", documentId: invoiceDocumentId,
          lines: [{ id: crypto.randomUUID(), description: "Recorded feed", quantity: "2", unitPrice: "12.50", discountMinor: "0", taxRateBps: 0 }] },
      });
      assert.equal(draft.statusCode, 201, draft.body);
      const posted = await app.inject({ method: "POST", url: prefix + `/accounting/invoices/${invoiceId}/post`, headers, payload: { id: crypto.randomUUID(), version: draft.json().version, confirmed: true, reviewed: true } });
      assert.ok([200,201].includes(posted.statusCode), posted.body);
      const paid = await app.inject({ method: "POST", url: prefix + `/accounting/invoices/${invoiceId}/payments`, headers, payload: { id: crypto.randomUUID(), version: posted.json().version, amountMinor: "1000", currency: "USD", paidOn: "2026-11-05", method: "cash", reference: "Restore fixture payment", note: "Manually recorded test payment", confirmed: true } });
      assert.ok([200,201].includes(paid.statusCode), paid.body);
      assert.equal(paid.json().balanceMinor, "1500");
      const cameraId = crypto.randomUUID();
      const camera = await app.inject({
        method: "POST",
        url: prefix + "/assets",
        headers,
        payload: {
          id: cameraId,
          name: "Backup camera fixture",
          category: "camera",
          protocol: "simulator",
        },
      });
      assert.equal(camera.statusCode, 201, camera.body);
      const configure = await app.inject({
        method: "POST",
        url: prefix + "/cameras/" + cameraId + "/configure",
        headers,
        payload: {
          version: 1,
          provider: "simulator",
          retentionDays: 7,
          eventsEnabled: true,
          liveEnabled: true,
        },
      });
      assert.equal(configure.statusCode, 200, configure.body);
      const event = await app.inject({
        method: "POST",
        url: prefix + "/camera-events",
        headers,
        payload: {
          id: crypto.randomUUID(),
          assetId: cameraId,
          kind: "motion",
          observedAt: new Date().toISOString(),
        },
      });
      assert.equal(event.statusCode, 201, event.body);
    } finally {
      await app.close();
      await source.end();
      source = undefined;
    }
    result = run(["scripts/backup.mjs", "create", "--output", backup], env);
    assert.equal(result.status, 0, result.stderr);
    const restoreEnv = { ...env, RESTORE_DATABASE_URL: connection(names[1]) };
    result = run(
      [
        "scripts/backup.mjs",
        "restore",
        "--archive",
        backup,
        "--media-dir",
        restoredMedia,
        "--confirm-empty-target",
      ],
      restoreEnv,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).verifiedMediaFiles, 3);
    const restored = new pg.Pool({
      connectionString: restoreEnv.RESTORE_DATABASE_URL,
    });
    try {
      for (const table of [
        "farms",
        "users",
        "projects",
        "activities",
        "private_media",
        "camera_segments",
        "camera_events",
        "accounting_documents",
        "accounting_settings",
        "accounting_invoices",
        "accounting_payments",
      ])
        assert.equal(
          (await restored.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]
            .n,
          "1",
        );
      const media = (
        await restored.query(
          "SELECT object_key,content_hash FROM private_media WHERE id=$1",
          [mediaId],
        )
      ).rows[0];
      const segment = (await restored.query("SELECT * FROM camera_segments"))
        .rows[0];
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(restoredMedia, segment.object_key)))
          .digest("hex"),
        segment.content_hash,
      );
      objectKey = media.object_key;
      const invoiceSource = (await restored.query("SELECT * FROM accounting_documents WHERE id=$1", [invoiceDocumentId])).rows[0];
      assert.equal(createHash("sha256").update(await readFile(join(restoredMedia, invoiceSource.object_key))).digest("hex"), invoiceSource.content_hash);
      const invoice = (await restored.query("SELECT * FROM accounting_invoices WHERE id=$1", [invoiceId])).rows[0];
      assert.equal(invoice.status, "posted");
      assert.equal(invoice.snapshot.totals.totalMinor, "2500");
      assert.equal(invoice.snapshot.party.name, "Restore fixture supplier");
      assert.equal((await restored.query("SELECT sum(amount_minor) AS paid FROM accounting_payments WHERE invoice_id=$1", [invoiceId])).rows[0].paid, "1000");
      const journals = (await restored.query("SELECT journal_id,sum(debit_minor) AS debit,sum(credit_minor) AS credit FROM accounting_journal_lines GROUP BY journal_id")).rows;
      assert.equal(journals.length, 2);
      for (const journal of journals) assert.equal(journal.debit, journal.credit);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(restoredMedia, media.object_key)))
          .digest("hex"),
        media.content_hash,
      );
      assert.equal(
        (await restored.query("SELECT count(*) AS n FROM schema_migrations"))
          .rows[0].n,
        String(
          (await readdir(new URL("../migrations", import.meta.url))).filter(
            (n) => n.endsWith(".sql"),
          ).length,
        ),
      );
    } finally {
      await restored.end();
    }
    result = run(
      [
        "scripts/backup.mjs",
        "restore",
        "--archive",
        backup,
        "--media-dir",
        join(temporary, "second"),
        "--confirm-empty-target",
      ],
      restoreEnv,
    );
    assert.notEqual(
      result.status,
      0,
      "nonempty target must not be overwritten",
    );
    const corrupt = await readFile(backup);
    corrupt[24] ^= 0xff;
    const tampered = join(temporary, "tampered.sfbak");
    await writeFile(tampered, corrupt);
    result = run(
      [
        "scripts/backup.mjs",
        "restore",
        "--archive",
        tampered,
        "--media-dir",
        join(temporary, "tampered-media"),
        "--confirm-empty-target",
      ],
      { ...env, RESTORE_DATABASE_URL: connection(names[2]) },
    );
    assert.notEqual(result.status, 0);
    const empty = new pg.Pool({ connectionString: connection(names[2]) });
    try {
      assert.equal(
        (
          await empty.query(
            "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'",
          )
        ).rows[0].n,
        "0",
      );
      await empty.query("CREATE SEQUENCE existing_state");
      result = run(
        [
          "scripts/backup.mjs",
          "restore",
          "--archive",
          backup,
          "--media-dir",
          join(temporary, "sequence-target"),
          "--confirm-empty-target",
        ],
        { ...env, RESTORE_DATABASE_URL: connection(names[2]) },
      );
      assert.notEqual(result.status, 0, "a sequence-only target is not empty");
      assert.equal(
        (
          await empty.query(
            "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'",
          )
        ).rows[0].n,
        "0",
      );
      assert.equal(
        (
          await empty.query(
            "SELECT count(*) AS n FROM pg_class WHERE relname='existing_state' AND relkind='S'",
          )
        ).rows[0].n,
        "1",
      );
    } finally {
      await empty.end();
    }
    await writeFile(
      join(sourceMedia, objectKey),
      Buffer.from("corrupted source object"),
    );
    result = run(
      [
        "scripts/backup.mjs",
        "create",
        "--output",
        join(temporary, "corrupt-source.sfbak"),
      ],
      env,
    );
    assert.notEqual(
      result.status,
      0,
      "corrupt referenced source media must not produce a successful backup",
    );
  } finally {
    if (source) await source.end();
    for (const name of names)
      await admin.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
