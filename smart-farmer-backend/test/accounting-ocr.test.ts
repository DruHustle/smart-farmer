import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { extractInvoice, ExtractionError, parseTsv, suggestInvoice, validDocumentSignature } from "../src/accounting/ocr.js";

const invoiceText = "Supplier: Green Valley Supplies\nInvoice No: SUP-1042\nDate: 2026-11-05\nDue date: 2026-12-05\nDescription Qty Unit price Amount\nPoultry feed 2 12.50 25.00\nTotal USD 25.00";
function pdf(content: string | Buffer, pages = 1) {
  const doc = new PDFDocument({ size: "A4" }), chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { doc.on("data", x => chunks.push(x)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  for (let page = 0; page < pages; page++) {
    if (page) doc.addPage();
    if (typeof content === "string") doc.fontSize(16).text(content);
    else doc.image(content, 32, 32, { width: 530 });
  }
  doc.end(); return result;
}
async function scanImage() {
  const rows = invoiceText.split("\n").map((line, i) => `<text x="70" y="${90 + i * 85}" font-size="36" font-family="DejaVu Sans">${line}</text>`).join("");
  return sharp(Buffer.from(`<svg width="1500" height="760" xmlns="http://www.w3.org/2000/svg"><rect width="1500" height="760" fill="white"/><g fill="black">${rows}</g></svg>`)).png().toBuffer();
}

test("scan suggestions preserve exact decimal strings and require review without assuming a tax rate", () => {
  const result = suggestInvoice(invoiceText);
  assert.deepEqual(result.suggestions, { party: { name: "Green Valley Supplies" }, reference: "SUP-1042", issueDate: "2026-11-05", dueDate: "2026-12-05", currency: "USD", reportedTotal: "25.00", lines: [{ description: "Poultry feed", quantity: "2", unitPrice: "12.50" }] });
  assert.deepEqual(result.warnings, ["review_required"]);
  assert.equal("taxRateBps" in result.suggestions.lines[0], false);
});

test("ambiguous symbols, dates, decimal commas, invalid calendar dates and conflicting currency codes are left for review", () => {
  const ambiguous = suggestInvoice("Supplier: Farm Supplies\nInvoice: 010\nDate: 04/05/2026\nTotal $1,25\nVAT 15%");
  assert.equal(ambiguous.suggestions.currency, null);
  assert.equal(ambiguous.suggestions.issueDate, null);
  assert.equal(ambiguous.suggestions.reportedTotal, null);
  assert.ok(ambiguous.warnings.includes("date_ambiguous"));
  assert.ok(ambiguous.warnings.includes("tax_review_required"));
  const conflict = suggestInvoice("Date: 2026-02-30\nTotal USD 20.00\nPaid ZAR 300.00");
  assert.equal(conflict.suggestions.issueDate, null);
  assert.equal(conflict.suggestions.currency, null);
  assert.ok(conflict.warnings.includes("multiple_currencies"));
  assert.equal(suggestInvoice("Date: 16/05/2026").suggestions.issueDate, "2026-05-16");
  assert.equal(suggestInvoice("Date: 5 Nov 2026").suggestions.issueDate, "2026-11-05");
});

test("unverified line arithmetic is never suggested as an exact line; OCR text is bounded", () => {
  const result = suggestInvoice("Seed bags 2 12.50 50.00\nTotal USD 50.00");
  assert.equal(result.suggestions.lines.length, 0);
  assert.ok(result.warnings.includes("line_amount_uncertain"));
  assert.equal(suggestInvoice("A".repeat(100_000)).suggestions.party, null);
  const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90\tFeed\n5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t80\t2\n";
  assert.deepEqual(parseTsv(tsv), { text: "Feed 2", confidence: 88 });
});

test("actual Tesseract recognizes an image invoice and never produces posted accounting data", async () => {
  const bytes = await scanImage();
  const extracted = await extractInvoice(bytes, "image/png");
  assert.equal(extracted.engine, "local_tesseract");
  assert.equal(extracted.pageCount, 1);
  assert.equal(extracted.suggestions.reference, "SUP-1042");
  assert.equal(extracted.suggestions.currency, "USD");
  assert.equal(extracted.suggestions.reportedTotal, "25.00");
  assert.ok(extracted.confidence !== null && extracted.confidence > 75);
  assert.ok(extracted.warnings.includes("review_required"));
  assert.equal("status" in extracted, false);
});

test("actual PDF extraction handles text PDFs and raster-scanned PDFs", async () => {
  const textResult = await extractInvoice(await pdf(invoiceText), "application/pdf");
  assert.equal(textResult.engine, "pdf_text");
  assert.equal(textResult.confidence, null);
  assert.equal(textResult.suggestions.reference, "SUP-1042");
  assert.equal(textResult.suggestions.reportedTotal, "25.00");
  const rasterResult = await extractInvoice(await pdf(await scanImage()), "application/pdf");
  assert.equal(rasterResult.engine, "local_tesseract");
  assert.equal(rasterResult.suggestions.currency, "USD");
  assert.equal(rasterResult.suggestions.reportedTotal, "25.00");
});

test("malformed content, oversized images, page bombs and unavailable engines fail with bounded codes", async () => {
  assert.equal(validDocumentSignature("image/png", Buffer.from("<script>evil</script>")), false);
  await assert.rejects(extractInvoice(Buffer.from("not an invoice"), "application/pdf"), (e: unknown) => e instanceof ExtractionError && e.code === "invalid_document");
  await assert.rejects(extractInvoice(await pdf(invoiceText, 7), "application/pdf"), (e: unknown) => e instanceof ExtractionError && e.code === "document_too_many_pages");
  const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(extractInvoice(huge, "image/png"), (e: unknown) => e instanceof ExtractionError && e.code === "image_unreadable_or_too_large");
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = "/no-invoice-binaries";
    await assert.rejects(extractInvoice(await pdf(invoiceText), "application/pdf"), (e: unknown) => e instanceof ExtractionError && e.code === "scan_unavailable");
  } finally { process.env.PATH = oldPath; }
});
