import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "../src/app.js";

async function fixture() {
  assert.ok(process.env.TEST_DATABASE_URL);
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), schema = `books_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  for (const name of (await readdir(new URL("../migrations", import.meta.url))).filter(x => x.endsWith(".sql")).sort()) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const media = await mkdtemp(join(tmpdir(), "books-test-")); process.env.MEDIA_ROOT = media;
  const app = buildApp(db, "http://localhost:5173"); app.log.level = process.env.LOG_LEVEL ?? "silent";
  const username = `books_${randomUUID().slice(0, 8)}`, password = "isolated-books-password";
  const created = await app.inject({ method: "POST", url: "/v1/register", payload: { username, password, language: "sn", farmName: "Books fixture" } }); assert.equal(created.statusCode, 201, created.body);
  const signed = await app.inject({ method: "POST", url: "/v1/sessions", payload: { username, password } }); assert.equal(signed.statusCode, 200);
  const owner = created.json(), headers = { authorization: `Bearer ${signed.json().token}` }, farm = `/v1/farms/${owner.farmId}`, base = farm + "/accounting";
  const request = (method: any, path: string, payload?: any) => app.inject({ method, url: base + path, headers, ...(payload === undefined ? {} : { payload }) });
  const ok = async (method: any, path: string, payload?: any) => { const response = await request(method, path, payload); assert.ok([200,201].includes(response.statusCode), `${method} ${path}: ${response.statusCode} ${response.body}`); return response.json(); };
  const settings = await ok("PUT", "/settings", { id: randomUUID(), version: 0, business: { legalName: "Books fixture farm" }, defaultCurrency: "USD", invoicePrefix: "BOOK", startingNumber: 1, taxRates: [{ name: "Reviewed test rate", rateBps: 1500 }], lockedThrough: null, reason: "Isolated bookkeeping test" });
  async function invoice(kind: "purchase" | "sale", currency: string, unitPrice: string, options: { tax?: number; date?: string; due?: string; reference?: string; projectId?: string; sourceEntryId?: string; party?: string } = {}) {
    const draft = await ok("POST", "/invoices", { id: randomUUID(), kind, party: { name: options.party ?? "Recorded counterparty" }, currency, issueDate: options.date ?? "2026-11-05", dueDate: options.due ?? "2026-11-06", reference: options.reference ?? `REF-${randomUUID().slice(0,8)}`, sourceEntryId: options.sourceEntryId ?? null, lines: [{ id: randomUUID(), description: "Reviewed produce or supplies", quantity: "1", unitPrice, discountMinor: "0", taxRateBps: options.tax ?? 0, projectId: options.projectId ?? null }] });
    return ok("POST", `/invoices/${draft.id}/${kind === "sale" ? "issue" : "post"}`, { id: randomUUID(), version: draft.version, confirmed: true, reviewed: true });
  }
  return { app, db, owner, headers, farm, base, request, ok, settings, invoice, async close() { await app.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(media, { recursive: true, force: true }); } };
}

test("books reconcile exact currency-separated flows, historical aging, tax, retained equity and cash transfers", async () => {
  const f = await fixture();
  try {
    let sale = await f.invoice("sale", "USD", "25.00", { tax: 1500 });
    let purchase = await f.invoice("purchase", "USD", "10.00", { tax: 1500 });
    await f.invoice("sale", "KWD", "1.234");
    const early = await f.ok("GET", "/reports?asOf=2026-11-06");
    const earlyUsd = early.summary.byCurrency.find((x: any) => x.currency === "USD");
    assert.equal(earlyUsd.salesMinor, "2500"); assert.equal(earlyUsd.expensesMinor, "1150");
    assert.equal(earlyUsd.receivableMinor, "2875"); assert.equal(earlyUsd.payableMinor, "1150"); assert.equal(earlyUsd.overdueReceivableMinor, "0");
    sale = await f.ok("POST", `/invoices/${sale.id}/payments`, { id: randomUUID(), version: sale.version, amountMinor: "500", currency: "USD", paidOn: "2026-11-07", method: "cash", reference: "Recorded receipt", confirmed: true });
    purchase = await f.ok("POST", `/invoices/${purchase.id}/payments`, { id: randomUUID(), version: purchase.version, amountMinor: "400", currency: "USD", paidOn: "2026-11-08", method: "cash", confirmed: true });
    await f.ok("POST", "/journals", { id: randomUUID(), currency: "USD", postedOn: "2026-11-08", description: "Transfer between own cash accounts", reason: "Reviewed bank deposit", confirmed: true, lines: [{ accountCode: "1010", debitMinor: "100", creditMinor: "0", description: "Bank" }, { accountCode: "1000", debitMinor: "0", creditMinor: "100", description: "Cash" }] });
    const current = await f.ok("GET", "/reports?asOf=2026-11-08");
    const usd = current.summary.byCurrency.find((x: any) => x.currency === "USD"), kwd = current.summary.byCurrency.find((x: any) => x.currency === "KWD");
    assert.equal(usd.cashReceivedMinor, "500"); assert.equal(usd.cashPaidMinor, "400", "internal transfers do not manufacture cash flows");
    assert.equal(usd.receivableMinor, "2375"); assert.equal(usd.payableMinor, "750");
    assert.equal(kwd.minorUnit, 3); assert.equal(kwd.salesMinor, "1234"); assert.equal(kwd.receivableMinor, "1234");
    assert.equal(current.aging.find((x: any) => x.currency === "USD" && x.kind === "sale").days1To30Minor, "2375");
    assert.equal(current.aging.find((x: any) => x.currency === "USD" && x.kind === "purchase").days1To30Minor, "750");
    for (const balance of current.trialBalance) assert.equal(balance.totalDebitMinor, balance.totalCreditMinor);
    for (const balance of current.balanceSheet) assert.equal(BigInt(balance.assetsMinor), BigInt(balance.liabilitiesMinor) + BigInt(balance.equityMinor));
    const historical = await f.ok("GET", "/summary?asOf=2026-11-06");
    assert.equal(historical.byCurrency.find((x: any) => x.currency === "USD").receivableMinor, "2875");
    await f.ok("POST", `/invoices/${sale.id}/credits`, { id: randomUUID(), version: sale.version, amountMinor: "200", issueDate: "2026-11-10", reason: "Reviewed produce adjustment", confirmed: true });
    const corrected = await f.ok("GET", "/reports?asOf=2026-11-10");
    const revised = corrected.summary.byCurrency.find((x: any) => x.currency === "USD");
    assert.equal(revised.salesMinor, "2326"); assert.equal(revised.taxCollectedMinor, "349"); assert.equal(revised.receivableMinor, "2175");
    assert.equal((await f.ok("GET", "/summary?asOf=2026-11-08")).byCurrency.find((x: any) => x.currency === "USD").receivableMinor, "2375");
    const isolated = await f.ok("GET", "/summary?from=2026-11-07&to=2026-11-08&asOf=2026-11-08");
    assert.equal(isolated.byCurrency.find((x: any) => x.currency === "USD").salesMinor, "0");
    assert.equal(isolated.byCurrency.find((x: any) => x.currency === "USD").cashReceivedMinor, "500");
  } finally { await f.close(); }
});

test("legacy report, source adoption and private CSV/PDF preserve amounts without duplicate obligations", async () => {
  const f = await fixture();
  try {
    const projectResponse = await f.app.inject({ method: "POST", url: f.farm + "/projects", headers: f.headers, payload: { name: "Recorded crop", crop: "maize", irrigation: true } }); assert.equal(projectResponse.statusCode, 201);
    const projectId = projectResponse.json().id;
    await f.invoice("sale", "KWD", "1.234", { projectId });
    const summary = await f.app.inject({ method: "GET", url: f.farm + "/reports/summary?to=2026-11-07T00:00:00Z", headers: f.headers });
    assert.equal(summary.statusCode, 200, summary.body);
    const kwd = summary.json().byCurrency.find((x: any) => x.currency === "KWD");
    assert.equal(kwd.recordedSales, 1.234); assert.equal(kwd.outstandingRecordedSales, 1.234); assert.equal(kwd.exact.recordedSales, "1.234");
    const oldId = randomUUID();
    await f.db.query("INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note) VALUES($1,$2,$3,'revenue',20,'USD','animal_event',$4,'2026-11-05T10:00:00Z','Existing recorded produce sale')", [oldId, f.owner.farmId, f.owner.userId, randomUUID()]);
    let picker = await f.ok("GET", "/sources?kind=sale"); assert.equal(picker.items.find((x: any) => x.id === oldId).amountMinor, "2000");
    const adopted = await f.invoice("sale", "USD", "20", { sourceEntryId: oldId, party: "=HYPERLINK(\"example\")" });
    const combined = await f.app.inject({ method: "GET", url: f.farm + "/reports/summary?to=2026-11-07T00:00:00Z", headers: f.headers });
    const usd = combined.json().byCurrency.find((x: any) => x.currency === "USD"); assert.equal(usd.recordedSales, 20); assert.equal(usd.outstandingRecordedSales, 20);
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE kind='revenue' AND currency='USD'")).rows[0].count, "1");
    picker = await f.ok("GET", "/sources?kind=sale"); assert.equal(picker.items.find((x: any) => x.id === oldId).invoiceId, adopted.id);
    const invoiceCsv = await f.request("GET", "/invoices.csv"); assert.equal(invoiceCsv.statusCode, 200); assert.match(invoiceCsv.body, /'\=HYPERLINK/); assert.match(invoiceCsv.body, /1\.234/);
    const ledgerCsv = await f.request("GET", "/ledger.csv?currency=KWD"); assert.equal(ledgerCsv.statusCode, 200); assert.match(ledgerCsv.body, /1\.234/); assert.match(ledgerCsv.headers["cache-control"]!, /no-store/);
    const pdf = await f.request("GET", `/invoices/${adopted.id}/pdf`); assert.equal(pdf.statusCode, 200, pdf.body); assert.equal(pdf.rawPayload.subarray(0,4).toString(), "%PDF");
    assert.equal((await f.request("GET", "/reports?from=2026-11-08&to=2026-11-01")).statusCode, 400);
    const list = await f.ok("GET", "/invoices?limit=1"); const second = await f.ok("GET", `/invoices?limit=1&cursor=${list.nextCursor}`); assert.notEqual(list.items[0].id, second.items[0].id);
    const worker = randomUUID(); await f.db.query("INSERT INTO users(id,username,password_hash,language) VALUES($1,$2,'test-only','sn')", [worker, `worker_${randomUUID().slice(0,8)}`]);
    await f.db.query("UPDATE memberships SET role='worker' WHERE farm_id=$1 AND user_id=$2", [f.owner.farmId, f.owner.userId]);
    for (const path of ["/reports", "/summary", "/invoices.csv", "/ledger.csv", `/invoices/${adopted.id}/pdf`, "/sources?kind=sale"]) assert.equal((await f.request("GET", path)).statusCode, 404, path);
  } finally { await f.close(); }
});

test("voiding today preserves an earlier receivable and removes it from today's books and aging", async () => {
  const f = await fixture();
  try {
    const today = (await f.db.query("SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text AS day FROM farms WHERE id=$1", [f.owner.farmId])).rows[0].day;
    const old = new Date(Date.parse(today) - 10 * 86400000).toISOString().slice(0,10), beforeVoid = new Date(Date.parse(today) - 86400000).toISOString().slice(0,10);
    const sale = await f.invoice("sale", "USD", "10", { date: old, due: old });
    await f.ok("POST", `/invoices/${sale.id}/void`, { id: randomUUID(), version: sale.version, reason: "Duplicate reviewed sales document", confirmed: true });
    const earlier = await f.ok("GET", `/reports?asOf=${beforeVoid}`); assert.equal(earlier.summary.byCurrency[0].receivableMinor, "1000"); assert.equal(earlier.aging.find((x: any) => x.kind === "sale").days1To30Minor, "1000");
    const current = await f.ok("GET", `/reports?asOf=${today}`); assert.equal(current.summary.byCurrency[0].receivableMinor, "0"); assert.equal(current.aging.find((x: any) => x.kind === "sale").days1To30Minor, "0");
    const beforeCsv = csvObjects((await f.request("GET", `/invoices.csv?asOf=${beforeVoid}`)).body).find(row => row.Invoice === sale.id)!;
    assert.equal(beforeCsv["Status as of"], "issued"); assert.equal(beforeCsv["Balance minor"], "1000");
    const afterCsv = csvObjects((await f.request("GET", `/invoices.csv?asOf=${today}`)).body).find(row => row.Invoice === sale.id)!;
    assert.equal(afterCsv["Status as of"], "void"); assert.equal(afterCsv["Balance minor"], "0");
  } finally { await f.close(); }
});

// All test fixture cells are single-line; preserve quoted commas and escaped quotes.
function csvObjects(text: string): Record<string, string>[] {
  const rows = text.trim().split("\r\n").map(line => [...line.matchAll(/"((?:""|[^"])*)"/g)].map(match => match[1].replaceAll('""', '"')));
  return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, index) => [key, row[index]])));
}

test("historical exports honor the accounting cutoff; legacy source precision errors stay visible without blocking the picker", async () => {
  const f = await fixture();
  try {
    let sale = await f.invoice("sale", "USD", "10.00", { date: "2026-10-01", due: "2026-10-15" });
    sale = await f.ok("POST", `/invoices/${sale.id}/payments`, { id: randomUUID(), version: sale.version, amountMinor: "200", currency: "USD", paidOn: "2026-10-06", method: "cash", confirmed: true });
    await f.ok("POST", `/invoices/${sale.id}/credits`, { id: randomUUID(), version: sale.version, amountMinor: "100", issueDate: "2026-10-08", reason: "Reviewed quality adjustment", confirmed: true });
    for (const [day, paid, credited, balance] of [["2026-10-04", "0", "0", "1000"], ["2026-10-07", "200", "0", "800"], ["2026-10-09", "200", "100", "700"]]) {
      const response = await f.request("GET", `/invoices.csv?asOf=${day}`); assert.equal(response.statusCode, 200, response.body);
      const row = csvObjects(response.body).find(row => row.Invoice === sale.id)!;
      assert.equal(row["As of"], day); assert.equal(row["Paid minor"], paid); assert.equal(row["Credited minor"], credited); assert.equal(row["Balance minor"], balance);
    }
    const ledger = await f.request("GET", "/ledger.csv?asOf=2026-10-04&to=2026-10-31"); assert.equal(ledger.statusCode, 200, ledger.body);
    const rows = csvObjects(ledger.body); assert.ok(rows.length >= 2); assert.ok(rows.every(row => row.Date <= "2026-10-04" && row["As of"] === "2026-10-04"));
    assert.ok((await f.ok("GET", "/ledger?asOf=2026-10-04")).items.every((journal: any) => journal.postedOn <= "2026-10-04"));
    const invalid = randomUUID(), valid = randomUUID();
    for (const [id, amount] of [[invalid, "12.500"], [valid, "12.000"]]) await f.db.query("INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note) VALUES($1,$2,$3,'revenue',$4,'JPY','animal_event',$5,'2026-10-01T10:00:00Z','Historical JPY source')", [id, f.owner.farmId, f.owner.userId, amount, randomUUID()]);
    const sources = await f.ok("GET", "/sources?kind=sale");
    const invalidRow = sources.items.find((item: any) => item.id === invalid), validRow = sources.items.find((item: any) => item.id === valid);
    assert.equal(invalidRow.eligible, false); assert.equal(invalidRow.eligibilityError, "source_currency_precision"); assert.equal(invalidRow.amountMinor, null); assert.equal(invalidRow.originalAmount, "12.500");
    assert.equal(validRow.eligible, true); assert.equal(validRow.amountMinor, "12"); assert.equal(validRow.minorUnit, 0);
  } finally { await f.close(); }
});

test("project shares reconcile tiny partial payments, reversals and line-specific credits without manufacturing collectible debt", async () => {
  const f = await fixture();
  try {
    const projects: string[] = [];
    for (const name of ["First crop", "Second crop"]) {
      const response = await f.app.inject({ method: "POST", url: f.farm + "/projects", headers: f.headers, payload: { name, crop: "maize", irrigation: true } }); assert.equal(response.statusCode, 201, response.body); projects.push(response.json().id);
    }
    let sale = await f.ok("POST", "/invoices", { id: randomUUID(), kind: "sale", party: { name: "Shared project buyer" }, currency: "USD", issueDate: "2026-10-01", dueDate: "2026-10-10", reference: "TINY-SPLIT", lines: projects.map((projectId, index) => ({ id: randomUUID(), description: `Project ${index + 1} share`, quantity: "1", unitPrice: "0.01", discountMinor: "0", taxRateBps: 0, projectId })) });
    sale = await f.ok("POST", `/invoices/${sale.id}/issue`, { id: randomUUID(), version: sale.version, confirmed: true, reviewed: true });
    const firstPayment = randomUUID();
    for (const [id, day] of [[firstPayment, "2026-10-02"], [randomUUID(), "2026-10-03"]]) sale = await f.ok("POST", `/invoices/${sale.id}/payments`, { id, version: sale.version, amountMinor: "1", currency: "USD", paidOn: day, method: "cash", confirmed: true });
    async function summary(projectId: string | null, to: string, from?: string) {
      const query = new URLSearchParams({ to, ...(projectId ? { projectId } : {}), ...(from ? { from } : {}) });
      const response = await f.app.inject({ method: "GET", url: f.farm + `/reports/summary?${query}`, headers: f.headers }); assert.equal(response.statusCode, 200, response.body);
      if (projectId) assert.deepEqual(response.json().projectReceivables, { scope: "attributed_invoice_balance", signed: true, settlement: "invoice_only" });
      return response.json().byCurrency.find((row: any) => row.currency === "USD")?.exact ?? { cashReceived: "0.00", recordedSales: "0.00", outstandingRecordedSales: "0.00" };
    }
    const paid = await Promise.all(projects.map(project => summary(project, "2026-10-04T00:00:00Z")));
    assert.deepEqual(paid.map(row => row.cashReceived), ["0.01", "0.01"]); assert.deepEqual(paid.map(row => row.outstandingRecordedSales), ["0.00", "0.00"]);
    const secondPaymentStart = (await f.db.query("SELECT '2026-10-03'::date::timestamp AT TIME ZONE timezone AS instant FROM farms WHERE id=$1", [f.owner.farmId])).rows[0].instant.toISOString();
    assert.deepEqual((await Promise.all(projects.map(project => summary(project, "2026-10-04T00:00:00Z", secondPaymentStart)))).map(row => row.cashReceived), ["0.00", "0.01"]);
    sale = await f.ok("POST", `/invoices/${sale.id}/payments/${firstPayment}/reverse`, { id: randomUUID(), version: sale.version, paidOn: "2026-10-04", reason: "Recorded receipt was returned", confirmed: true });
    await f.ok("POST", `/invoices/${sale.id}/credits`, { id: randomUUID(), version: sale.version, amountMinor: "1", issueDate: "2026-10-05", reason: "First project produce adjusted", confirmed: true });
    const after = await Promise.all(projects.map(project => summary(project, "2026-10-06T00:00:00Z")));
    assert.deepEqual(after.map(row => row.cashReceived), ["0.01", "0.00"]); assert.deepEqual(after.map(row => row.recordedSales), ["0.00", "0.01"]);
    assert.deepEqual(after.map(row => row.outstandingRecordedSales), ["-0.01", "0.01"]);
    const farm = await summary(null, "2026-10-06T00:00:00Z"); assert.equal(farm.outstandingRecordedSales, "0.00"); assert.equal(farm.cashReceived, "0.01"); assert.equal(farm.recordedSales, "0.01");
    assert.equal((await f.ok("GET", "/summary?asOf=2026-10-05")).byCurrency[0].receivableMinor, "0");
  } finally { await f.close(); }
});
