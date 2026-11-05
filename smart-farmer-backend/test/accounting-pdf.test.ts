import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { printedMoney, renderInvoicePdf } from "../src/accounting/invoice-pdf.js";
import type { AccountingInvoiceSnapshot } from "../src/accounting/types.js";
const exec = promisify(execFile);

export function sampleInvoice(lineCount = 2): AccountingInvoiceSnapshot {
  const lines = Array.from({ length: lineCount }, (_, index) => ({ id: randomUUID(), description: index % 2 ? "Fresh farm eggs / Amaqanda amasha — tray of 30" : "Maize meal / Hupfu hwechibage — 10 kg", quantity: "2", unitPrice: "12.50", discountMinor: "0", taxRateBps: 1500, accountCode: "4000", projectId: null, netMinor: "2500", taxMinor: "375", totalMinor: "2875" }));
  return { schemaVersion: 1, id: randomUUID(), farmId: randomUUID(), kind: "sale", number: "GVF-000042", reference: "PO-1098", issuer: { legalName: "Green Valley Farm", tradingName: "Green Valley Produce", address: "12 Valley Road\nBulawayo", email: "farm@example.test", phone: "+263 00 000 0000", registrationNumber: "EXAMPLE-001", taxNumber: "TEST-123" }, party: { name: "Harvest Market", address: "8 Market Street\nBulawayo", email: "accounts@example.test", phone: "", taxNumber: "" }, currency: "USD", minorUnit: 2, issueDate: "2026-11-05", dueDate: "2026-12-05", notes: "Thank you for buying from our farm.\nThis is a synthetic invoice used for software verification.", terms: "Payment due by the date shown above. Quote the invoice number with your payment.", lines,
    totals: { subtotalMinor: String(2500 * lineCount), discountMinor: "0", netMinor: String(2500 * lineCount), taxMinor: String(375 * lineCount), totalMinor: String(2875 * lineCount) }, taxBreakdown: [{ rateBps: 1500, taxableMinor: String(2500 * lineCount), taxMinor: String(375 * lineCount) }], rounding: "line_half_up", documentId: null, sourceEntryId: null, correctsInvoiceId: null, finalizedAt: "2026-11-05T10:00:00.000Z" };
}

test("PDF money formatting preserves large exact and zero/three-decimal currency values", () => {
  assert.equal(printedMoney("100000000000001", 2), "1,000,000,000,000.01");
  assert.equal(printedMoney("1", 0), "1");
  assert.equal(printedMoney("1", 3), "0.001");
  assert.equal(printedMoney("-12345", 2), "-123.45");
});

test("issued and draft PDFs contain authoritative totals, Unicode identity and visible status across pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farmer-invoice-pdf-"));
  try {
    for (const draft of [false, true]) {
      const invoice = sampleInvoice(draft ? 2 : 32);
      if (draft) { invoice.number = null; invoice.finalizedAt = null; }
      const bytes = await renderInvoicePdf(invoice, { draft, voided: false });
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      const path = join(dir, draft ? "draft.pdf" : "invoice.pdf"); await writeFile(path, bytes);
      const { stdout: text } = await exec("pdftotext", ["-layout", path, "-"]);
      assert.match(text, /Green Valley Farm/); assert.match(text, /Harvest Market/);
      assert.match(text, /Amaqanda amasha/); assert.match(text, /2026-12-05/);
      assert.match(text, new RegExp(printedMoney(invoice.totals.totalMinor, 2).replaceAll(".", "\\.")));
      assert.match(text, draft ? /DRAFT/ : /GVF-000042/);
      assert.match(text, /Amounts are rounded per line/);
      const { stdout: info } = await exec("pdfinfo", [path]);
      const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      assert.ok(draft ? pageCount === 1 : pageCount > 1);
      for (let page = 1; page <= pageCount; page++) assert.ok(text.includes(`Page ${page} of ${pageCount}`));
    }
    const voidPath = join(dir, "void.pdf"); await writeFile(voidPath, await renderInvoicePdf(sampleInvoice(), { draft: false, voided: true }));
    assert.match((await exec("pdftotext", [voidPath, "-"])).stdout, /VOID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("long valid descriptions and identities fit pages; void labels repeat and supplier bills never promise sales numbering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farmer-invoice-layout-"));
  try {
    const snapshot = sampleInvoice(24);
    snapshot.issuer.tradingName = "Very long registered farm trading name ".repeat(4).trim().slice(0, 152);
    snapshot.lines[0].description = "x\n".repeat(249) + "z";
    const path = join(dir, "long-void.pdf"); await writeFile(path, await renderInvoicePdf(snapshot, { draft: false, voided: true }));
    const { stdout: content } = await exec("pdftotext", ["-layout", path, "-"]);
    for (const page of content.split("\f").filter(x => x.trim())) { assert.match(page, /VOID/); assert.match(page, /Page \d+ of \d+/); }
    const { stdout: boxes } = await exec("pdftotext", ["-bbox", path, "-"]);
    for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)) {
      assert.ok(+word[1] >= 41 && +word[3] <= 554, `horizontal overflow ${word[0]}`);
      assert.ok(+word[2] >= 40 && +word[4] <= 834, `vertical overflow ${word[0]}`);
    }
    const purchase = sampleInvoice(); purchase.kind = "purchase"; purchase.number = null; purchase.reference = "SUP-10";
    const purchasePath = join(dir, "purchase.pdf"); await writeFile(purchasePath, await renderInvoicePdf(purchase, { draft: false, voided: false }));
    const purchaseText = (await exec("pdftotext", [purchasePath, "-"])).stdout;
    assert.match(purchaseText, /Supplier reference: SUP-10/); assert.doesNotMatch(purchaseText, /assigned on issue/);
    const credit = sampleInvoice(1); credit.kind = "sale_credit"; credit.rounding = "credit_proportional"; credit.reference = "GVF-000041"; credit.correctsInvoiceId = randomUUID();
    const creditPath = join(dir, "credit.pdf"); await writeFile(creditPath, await renderInvoicePdf(credit, { draft: false, voided: false }));
    const creditText = (await exec("pdftotext", [creditPath, "-"])).stdout;
    assert.match(creditText, /Credit components are apportioned/); assert.match(creditText, /Original rate 15.00%/); assert.doesNotMatch(creditText, /Amounts are rounded per line/);
    const maximum = sampleInvoice(1); const maxMinor = "999999999999999";
    maximum.lines = [{ ...maximum.lines[0], quantity: "1", unitPrice: "9999999999999.99", taxRateBps: 0, netMinor: maxMinor, taxMinor: "0", totalMinor: maxMinor }];
    maximum.totals = { subtotalMinor: maxMinor, discountMinor: "0", netMinor: maxMinor, taxMinor: "0", totalMinor: maxMinor };
    maximum.taxBreakdown = [{ rateBps: 0, taxableMinor: maxMinor, taxMinor: "0" }];
    const maxPath = join(dir, "max-amount.pdf"); await writeFile(maxPath, await renderInvoicePdf(maximum, { draft: false, voided: false }));
    const maxText = (await exec("pdftotext", ["-layout", maxPath, "-"])).stdout;
    assert.ok(maxText.split("\n").find(line => line.includes("TOTAL USD"))?.includes(printedMoney(maxMinor, 2)), "largest permitted total stays on the labeled total line");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
