import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import PDFDocument from "pdfkit";
import { buildApp } from "../src/app.js";
import { processAccountingDocument } from "../src/accounting/documents.js";
import { storageUsage } from "../src/integrations/storage-quota.js";
import { collectGarbage, reconcileOrphanObjects, retireExpiredObjects } from "../src/operations/retention.js";

async function fixture() {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL required for real accounting-document verification");
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `accounting_docs_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  for (const name of (await readdir(new URL("../migrations", import.meta.url))).filter(x => x.endsWith(".sql")).sort()) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const media = await mkdtemp(join(tmpdir(), "accounting-documents-"));
  const oldMedia = process.env.MEDIA_ROOT; process.env.MEDIA_ROOT = media;
  const app = buildApp(db, "http://localhost:5173"); app.log.level = "silent";
  async function register(name: string) {
    const username = `${name}_${randomUUID().slice(0, 8)}`, password = "private-fixture-password";
    const created = await app.inject({ method: "POST", url: "/v1/register", payload: { username, password, language: "sn", farmName: "Accounting test farm" } });
    assert.equal(created.statusCode, 201, created.body);
    const session = await app.inject({ method: "POST", url: "/v1/sessions", payload: { username, password } });
    assert.equal(session.statusCode, 200, session.body);
    return { ...created.json(), headers: { authorization: `Bearer ${session.json().token}` } };
  }
  const owner = await register("owner"), prefix = `/v1/farms/${owner.farmId}/accounting/documents`;
  async function request(method: any, suffix = "", payload?: object, actor = owner) {
    return app.inject({ method, url: prefix + suffix, headers: actor.headers, ...(payload ? { payload } : {}) });
  }
  async function source(reference = "SUP-1042") {
    const doc = new PDFDocument(), chunks: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve, reject) => { doc.on("data", x => chunks.push(x)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
    doc.fontSize(15).text(`Supplier: Green Valley Supplies\nInvoice No: ${reference}\nDate: 2026-11-05\nFeed 2 12.50 25.00\nTotal USD 25.00`); doc.end();
    return { id: randomUUID(), mimeType: "application/pdf", filename: "supplier.pdf", dataBase64: (await bytes).toString("base64") };
  }
  return { db, app, media, owner, prefix, register, request, source, async close() {
    await app.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(media, { recursive: true, force: true });
    if (oldMedia === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = oldMedia;
  } };
}

test("private supplier scans deduplicate safely, survive cleanup, and only suggest after actual worker extraction", async () => {
  const f = await fixture();
  try {
    const body = await f.source();
    const uploaded = await f.request("POST", "", body); assert.equal(uploaded.statusCode, 201, uploaded.body);
    assert.equal(uploaded.json().document.state, "queued"); assert.equal(uploaded.json().document.extraction, null);
    assert.equal((await f.request("POST", "", body)).statusCode, 200);
    const alias = { ...body, id: randomUUID() };
    const [duplicate1, duplicate2] = await Promise.all([f.request("POST", "", alias), f.request("POST", "", { ...body, id: randomUUID() })]);
    for (const response of [duplicate1, duplicate2]) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().duplicate, true); assert.equal(response.json().document.id, body.id); }
    assert.deepEqual((await f.request("POST", "", alias)).json(), duplicate1.json(), "a deduplicated upload retains its canonical response");
    assert.equal((await f.request("POST", "", { ...alias, filename: "changed-alias.pdf" })).json().error, "idempotency_conflict");
    assert.equal((await f.request("POST", "", { ...await f.source("DIFFERENT"), id: alias.id })).json().error, "idempotency_conflict", "a duplicate's alias cannot be reused for new bytes");
    assert.equal((await f.db.query("SELECT count(*) FROM product_requests WHERE id=$1", [alias.id])).rows[0].count, "1");
    assert.equal((await f.request("POST", "", { ...body, filename: "changed.pdf" })).json().error, "idempotency_conflict");
    assert.equal((await f.db.query("SELECT count(*) FROM accounting_documents")).rows[0].count, "1");
    assert.equal((await storageUsage(f.db, f.owner.farmId)).media, Buffer.from(body.dataBase64, "base64").length);
    const processed = await Promise.all([processAccountingDocument(f.db), processAccountingDocument(f.db)]);
    assert.equal(processed.reduce((total, x) => total + x.processed, 0), 1);
    const ready = (await f.request("GET", `/${body.id}`)).json().document;
    assert.equal(ready.state, "ready"); assert.equal(ready.extraction.suggestions.reference, "SUP-1042");
    assert.equal(ready.extraction.suggestions.reportedTotal, "25.00"); assert.equal(ready.attempts, 1);
    for (const table of ["accounting_invoices", "accounting_journals", "financial_entries"]) assert.equal((await f.db.query(`SELECT count(*) FROM ${table}`)).rows[0].count, "0", "scanning cannot post records");
    const content = await f.request("GET", `/${body.id}/content`); assert.equal(content.statusCode, 200);
    assert.equal(content.rawPayload.toString("base64"), body.dataBase64);
    assert.match(content.headers["content-security-policy"]!, /sandbox/);
    assert.match(content.headers["cache-control"]!, /no-store/);
    const stored = (await f.db.query("SELECT * FROM accounting_documents WHERE id=$1", [body.id])).rows[0];
    const past = new Date(Date.now() - 3 * 86400000); await utimes(join(f.media, stored.object_key), past, past);
    await f.db.query("UPDATE accounting_documents SET created_at=now()-interval '3 days' WHERE id=$1", [body.id]);
    await f.db.query("UPDATE farms SET operations_settings=jsonb_set(operations_settings,'{mediaRetentionDays}','1') WHERE id=$1", [f.owner.farmId]);
    const client = await f.db.connect(); try { await client.query("BEGIN"); await retireExpiredObjects(client); await client.query("COMMIT"); } finally { client.release(); }
    assert.equal(await reconcileOrphanObjects(f.db), 0, "invoice references are not orphans");
    await f.db.query("INSERT INTO object_garbage(object_key,farm_id,reason,eligible_at,size_bytes,media_kind) VALUES($1,$2,'test_recheck',now(),$3,'field')", [stored.object_key, f.owner.farmId, stored.size_bytes]);
    assert.equal(await collectGarbage(f.db), 0, "a referenced financial source cannot be deleted");
    assert.equal((await f.request("GET", `/${body.id}/content`)).statusCode, 200);
  } finally { await f.close(); }
});

test("scan authorization excludes other farms/workers and rechecks role changes after the farm lock", async () => {
  const f = await fixture(); let locker: pg.PoolClient | undefined;
  try {
    const body = await f.source(); assert.equal((await f.request("POST", "", body)).statusCode, 201);
    const outsider = await f.register("outsider");
    for (const suffix of ["", `/${body.id}`, `/${body.id}/content`]) assert.equal((await f.request("GET", suffix, undefined, outsider)).statusCode, 404);
    await f.db.query("INSERT INTO memberships(user_id,farm_id,role) VALUES($1,$2,'worker')", [outsider.userId, f.owner.farmId]);
    assert.equal((await f.request("POST", "", await f.source(), outsider)).statusCode, 404);
    assert.equal((await f.request("GET", `/${body.id}/content`, undefined, outsider)).statusCode, 404);
    await f.db.query("UPDATE memberships SET role='manager' WHERE user_id=$1 AND farm_id=$2", [outsider.userId, f.owner.farmId]);
    locker = await f.db.connect(); await locker.query("BEGIN"); await locker.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [f.owner.farmId]);
    const pending = f.request("GET", `/${body.id}/content`, undefined, outsider);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.db.query("SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND pid<>pg_backend_pid() LIMIT 1")).rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await locker.query("UPDATE memberships SET role='worker' WHERE user_id=$1 AND farm_id=$2", [outsider.userId, f.owner.farmId]); await locker.query("COMMIT");
    assert.equal((await pending).statusCode, 404, "revocation while a download is waiting takes effect");
    assert.equal((await f.db.query("SELECT count(*) FROM audit_events WHERE entity_type='accounting_document' AND action='content_accessed'")).rows[0].count, "0");
  } finally { if (locker) { await locker.query("ROLLBACK"); locker.release(); } await f.close(); }
});

test("failed scans retry idempotently, reclaim expired leases, stop after three attempts and retain originals", async () => {
  const f = await fixture();
  try {
    const invalid = { id: randomUUID(), mimeType: "application/pdf", filename: "unreadable.pdf", dataBase64: Buffer.from("%PDF-1.4\nmalformed PDF\n%%EOF").toString("base64") };
    assert.equal((await f.request("POST", "", invalid)).statusCode, 201);
    await processAccountingDocument(f.db);
    let failed = (await f.request("GET", `/${invalid.id}`)).json().document;
    assert.equal(failed.state, "failed"); assert.equal(failed.errorCode, "document_unreadable");
    const retry = { id: randomUUID() };
    assert.equal((await f.request("POST", `/${invalid.id}/retry`, retry)).json().document.state, "queued");
    assert.equal((await f.request("POST", `/${invalid.id}/retry`, retry)).statusCode, 200);
    await processAccountingDocument(f.db);
    assert.equal((await f.request("POST", `/${invalid.id}/retry`, { id: randomUUID() })).statusCode, 200);
    await processAccountingDocument(f.db);
    failed = (await f.request("GET", `/${invalid.id}`)).json().document;
    assert.equal(failed.attempts, 3); assert.equal((await f.request("POST", `/${invalid.id}/retry`, { id: randomUUID() })).json().error, "scan_retry_limit");
    assert.equal((await f.request("GET", `/${invalid.id}/content`)).statusCode, 200);
    const valid = await f.source("RECOVERED"); await f.request("POST", "", valid);
    const previousLease = randomUUID();
    await f.db.query("UPDATE accounting_documents SET state='processing',attempts=1,lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1", [valid.id, previousLease]);
    assert.equal((await processAccountingDocument(f.db)).processed, 1);
    const recovered = (await f.request("GET", `/${valid.id}`)).json().document;
    assert.equal(recovered.state, "ready"); assert.equal(recovered.attempts, 2);
    assert.equal((await f.db.query("UPDATE accounting_documents SET state='failed',error_code='stale_worker' WHERE id=$1 AND lease_token=$2 AND state='processing'", [valid.id, previousLease])).rowCount, 0);
    const first = (await f.request("GET", "?limit=1")).json(); const second = (await f.request("GET", `?limit=1&cursor=${first.nextCursor}`)).json();
    assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
    assert.equal((await f.request("GET", "?state=ready")).json().items.length, 1);
  } finally { await f.close(); }
});

test("financial uploads reject invalid input and enforce the shared physical storage quota", async () => {
  const f = await fixture(), quota = process.env.MEDIA_FARM_QUOTA_BYTES;
  try {
    const body = await f.source();
    assert.equal((await f.request("POST", "", { ...body, dataBase64: body.dataBase64 + "#" })).statusCode, 400);
    assert.equal((await f.request("POST", "", { ...body, filename: "../invoice.pdf" })).statusCode, 400);
    assert.equal((await f.request("POST", "", { ...body, mimeType: "text/html" })).statusCode, 400);
    process.env.MEDIA_FARM_QUOTA_BYTES = "1";
    assert.equal((await f.request("POST", "", body)).json().error, "media_quota_exceeded");
    assert.equal((await f.db.query("SELECT count(*) FROM accounting_documents")).rows[0].count, "0");
    assert.equal((await storageUsage(f.db, f.owner.farmId)).media, 0);
  } finally { if (quota === undefined) delete process.env.MEDIA_FARM_QUOTA_BYTES; else process.env.MEDIA_FARM_QUOTA_BYTES = quota; await f.close(); }
});
