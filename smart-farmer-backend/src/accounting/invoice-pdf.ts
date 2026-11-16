import { readFile } from "node:fs/promises";
import PDFDocument from "pdfkit";
import type { FastifyInstance } from "fastify";
import { ApiError, type Context } from "../context.js";
import type { AccountingInvoiceSnapshot } from "./types.js";

let font: Promise<Buffer> | undefined;
function invoiceFont() {
  return font ??= readFile(new URL("../../fixtures/fonts/NotoSans-Regular.ttf.base64", import.meta.url), "utf8").then(value => Buffer.from(value, "base64"));
}
const clean = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function printedMoney(minor: string, scale: number) {
  const n = BigInt(minor), sign = n < 0n ? "-" : "";
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  const whole = scale ? digits.slice(0, -scale) : digits;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${scale ? "." + digits.slice(-scale) : ""}`;
}

/** Render only the immutable, server-calculated snapshot. No floating-point
 * arithmetic, linked assets, JavaScript, bank instructions or external fonts. */
export async function renderInvoicePdf(snapshot: AccountingInvoiceSnapshot, options: { draft: boolean; voided: boolean }): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margins: { top: 42, left: 42, right: 42, bottom: 54 }, bufferPages: true,
    info: { Title: `${options.draft ? "DRAFT " : ""}${snapshot.number ?? snapshot.reference ?? "Invoice"}`, Author: snapshot.issuer.legalName || "Farmer", Subject: "Farm accounting invoice", Creator: "Farmer" } });
  document.registerFont("Invoice", await invoiceFont()).font("Invoice");
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("data", chunk => chunks.push(chunk)); document.on("error", reject); document.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const left = 42, right = document.page.width - 42, width = right - left;
  const green = "#174C3C", ink = "#172A23", muted = "#52655D", border = "#CDD8D1";
  let y = 42;
  function text(value: string, x: number, top: number, w: number, size = 10, color = ink, align: "left" | "right" = "left") {
    document.fontSize(size).fillColor(color).text(clean(value), x, top, { width: w, lineGap: 2, align });
  }
  function height(value: string, w: number, size = 10) {
    return document.fontSize(size).heightOfString(clean(value || " "), { width: w, lineGap: 2 });
  }
  function line(at: number) { document.strokeColor(border).lineWidth(0.6).moveTo(left, at).lineTo(right, at).stroke(); }
  function newPage() {
    document.addPage(); y = 42;
    const heading = (snapshot.issuer.tradingName || snapshot.issuer.legalName || "Farmer").replace(/\s+/g, " ");
    const reference = `${options.voided ? "VOID · " : ""}${options.draft ? "DRAFT · " : ""}${snapshot.number ?? (snapshot.reference || "Invoice")}`.replace(/\s+/g, " ");
    text(heading, left, y, width * .60, 11, green);
    text(reference, left + width * .61, y, width * .39, 10, muted, "right");
    y += Math.max(height(heading, width * .60, 11), height(reference, width * .39, 10)) + 15; line(y); y += 18;
  }
  function ensure(space: number) { if (y + space > document.page.height - 65) newPage(); }
  function flowing(label: string, value: string) {
    if (!value.trim()) return;
    ensure(46); text(label.toUpperCase(), left, y, width, 8, muted); y += 15;
    // Chunk long user notes into measured paragraphs; repeat a page header instead
    // of letting a single block collide with the footer or hide later text.
    for (const paragraph of clean(value).split("\n")) {
      const words = paragraph.split(/\s+/).flatMap(word => word.match(/.{1,250}/g) ?? [""]); let chunk = "";
      for (const word of words) {
        const candidate = chunk ? `${chunk} ${word}` : word;
        if (height(candidate, width) > 190 && chunk) {
          const h = height(chunk, width); ensure(h + 6); text(chunk, left, y, width); y += h + 6; chunk = word;
        } else chunk = candidate;
      }
      const h = height(chunk, width); ensure(h + 4); text(chunk || " ", left, y, width); y += h + 4;
    }
    y += 6;
  }
  const purchase = snapshot.kind.startsWith("purchase"), credit = snapshot.kind.endsWith("credit");
  const proportional = snapshot.rounding === "credit_proportional";
  const title = credit ? (purchase ? "SUPPLIER CREDIT" : "CREDIT NOTE") : purchase ? "SUPPLIER BILL" : "SALES INVOICE";
  const status = options.voided ? "VOID" : options.draft ? "DRAFT · NOT ISSUED" : credit ? "CREDIT" : purchase ? "RECORDED" : "ISSUED";
  document.rect(0, 0, document.page.width, 9).fill(green);
  text(title, left, y, width * .65, 22, green);
  text(status, left + width * .66, y + 8, width * .34, 9, options.voided ? "#A12723" : muted, "right");
  y += 42;
  const seller = [snapshot.issuer.legalName || "Business details not entered", snapshot.issuer.tradingName && snapshot.issuer.tradingName !== snapshot.issuer.legalName ? snapshot.issuer.tradingName : "", snapshot.issuer.address, snapshot.issuer.email, snapshot.issuer.phone,
    snapshot.issuer.registrationNumber ? `Registration: ${snapshot.issuer.registrationNumber}` : "", snapshot.issuer.taxNumber ? `Tax registration: ${snapshot.issuer.taxNumber}` : ""].filter(Boolean).join("\n");
  const metadata = [snapshot.number ? `Number: ${snapshot.number}` : purchase ? "" : "Number: assigned on issue", snapshot.reference ? `${purchase ? "Supplier reference" : "Reference"}: ${snapshot.reference}` : "", `Date: ${snapshot.issueDate}`, snapshot.dueDate ? `Due: ${snapshot.dueDate}` : "", `Currency: ${snapshot.currency}`].filter(Boolean).join("\n");
  if (height(seller, width * .56) > 260 || height(metadata, width * .39) > 260) {
    flowing("Invoice details", metadata); flowing(purchase ? "Recorded by" : "Issued by", seller);
  } else {
    text(seller, left, y, width * .56, 9); text(metadata, left + width * .61, y, width * .39, 9, ink, "right");
    y += Math.max(height(seller, width * .56, 9), height(metadata, width * .39, 9)) + 20;
  }
  line(y); y += 18;
  const party = [snapshot.party.name, snapshot.party.address, snapshot.party.email, snapshot.party.phone, snapshot.party.taxNumber ? `Tax registration: ${snapshot.party.taxNumber}` : ""].filter(Boolean).join("\n");
  if (height(party, width) > 200) flowing(purchase ? "Supplier" : "Bill to", party || "Counterparty details not entered");
  else {
    ensure(height(party, width) + 50);
    text(purchase ? "SUPPLIER" : "BILL TO", left, y, width, 8, muted); y += 18;
    text(party || "Counterparty details not entered", left, y, width);
    y += height(party, width) + 20;
  }
  if (snapshot.correctsInvoiceId && snapshot.reference) { ensure(30); text(`Correction reference: ${snapshot.reference}`, left, y, width, 8, muted); y += 25; }
  const columns = [left, left + 225, left + 275, left + 350, left + 409];
  function tableHead() {
    ensure(48); document.rect(left, y, width, 26).fill(green);
    ["Item / description", "Qty", "Unit price", "Tax", "Amount"].forEach((label, i) => text(label, columns[i] + 7, y + 7, (i === 0 ? 211 : i === 1 ? 39 : i === 2 ? 63 : i === 3 ? 47 : width - 423), 8, "#FFFFFF", i ? "right" : "left"));
    y += 34;
  }
  tableHead();
  for (let index = 0; index < snapshot.lines.length; index++) {
    const item = snapshot.lines[index];
    // Table descriptions retain every word while collapsing arbitrary line feeds;
    // the exact original text remains in the immutable invoice snapshot.
    const detail = `${index + 1}. ${item.description.replace(/\s+/g, " ")}${BigInt(item.discountMinor) ? `\nDiscount: ${printedMoney(item.discountMinor, snapshot.minorUnit)} ${snapshot.currency}` : ""}`;
    const taxText = proportional ? printedMoney(item.taxMinor, snapshot.minorUnit) : `${(item.taxRateBps / 100).toFixed(2).replace(/\.00$/, "")}%`;
    const rowHeight = Math.max(34, height(detail, 211, 9) + 17, height(item.quantity, 39, 9) + 17, height(item.unitPrice, 63, 9) + 17, height(taxText, 47, 9) + 17, height(printedMoney(item.totalMinor, snapshot.minorUnit), width - 423, 9) + 17);
    if (y + rowHeight > document.page.height - 65) { newPage(); tableHead(); }
    text(detail, columns[0] + 7, y, 211, 9);
    text(item.quantity, columns[1] + 7, y, 39, 9, ink, "right");
    text(item.unitPrice, columns[2] + 7, y, 63, 9, ink, "right");
    text(taxText, columns[3] + 7, y, 47, 9, ink, "right");
    text(printedMoney(item.totalMinor, snapshot.minorUnit), columns[4] + 7, y, width - 423, 9, ink, "right");
    y += rowHeight; line(y - 9);
  }
  y += 9;
  const totals: [string, string][] = [["Subtotal", snapshot.totals.subtotalMinor], ["Discount", snapshot.totals.discountMinor], ["Net amount", snapshot.totals.netMinor], ["Tax", snapshot.totals.taxMinor]];
  ensure(155);
  for (const [label, amount] of totals) {
    text(label, left + 255, y, 125, 10, muted); text(printedMoney(amount, snapshot.minorUnit), left + 387, y, width - 387, 10, ink, "right"); y += 19;
  }
  document.rect(left + 245, y - 2, width - 245, 37).fill("#EAF1EC");
  text(`TOTAL ${snapshot.currency}`, left + 255, y + 7, 125, 11, green);
  const totalText = printedMoney(snapshot.totals.totalMinor, snapshot.minorUnit);
  const totalSize = Math.min(12, 12 * (width - 397) / document.fontSize(12).widthOfString(totalText));
  text(totalText, left + 387, y + 7, width - 397, totalSize, green, "right"); y += 48;
  if (snapshot.taxBreakdown.length) {
    flowing(proportional ? "Tax adjustments" : "Tax breakdown", snapshot.taxBreakdown.map(tax => proportional ? `Original rate ${(tax.rateBps / 100).toFixed(2)}%: net credit ${printedMoney(tax.taxableMinor, snapshot.minorUnit)} ${snapshot.currency}; tax credit ${printedMoney(tax.taxMinor, snapshot.minorUnit)} ${snapshot.currency}` : `${(tax.rateBps / 100).toFixed(2)}% on ${printedMoney(tax.taxableMinor, snapshot.minorUnit)} ${snapshot.currency}: ${printedMoney(tax.taxMinor, snapshot.minorUnit)} ${snapshot.currency}`).join("\n"));
  }
  flowing("Notes", snapshot.notes);
  flowing("Terms", snapshot.terms);
  ensure(38);
  text(options.draft ? "Preview only. Review all details before issuing this document." : "Keep this invoice for your records. Payment receipts are recorded separately.", left, y, width, 8, muted);
  y += 18; text(proportional ? "Credit components are apportioned from the original invoice. Tax column shows amounts." : "Amounts are rounded per line. No currency conversion has been applied.", left, y, width, 8, muted);
  const range = document.bufferedPageRange();
  for (let page = 0; page < range.count; page++) {
    document.switchToPage(page);
    const previousBottom = document.page.margins.bottom; document.page.margins.bottom = 0;
    const footerY = document.page.height - 34;
    document.strokeColor(border).lineWidth(.6).moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();
    text(`${options.voided ? "VOID · " : ""}${options.draft ? "DRAFT · " : ""}${snapshot.number ?? (snapshot.reference || "Invoice")}`.replace(/\s+/g, " "), left, footerY, width * .70, 8, muted);
    text(`Page ${page + 1} of ${range.count}`, left + width * .72, footerY, width * .28, 8, muted, "right");
    document.page.margins.bottom = previousBottom;
  }
  document.end();
  return finished;
}

export function registerAccountingPdf(app: FastifyInstance, ctx: Context) {
  for (const preview of [true, false]) {
    app.get(`/v1/farms/:farmId/accounting/invoices/:invoiceId/${preview ? "preview.pdf" : "pdf"}`, async (request, reply) => {
      const { getInvoiceDetail } = await import("./routes.js");
      const invoice = await getInvoiceDetail(ctx, request, reply);
      if (!invoice) return;
      if (!preview && !invoice.snapshot) throw new ApiError("invoice_not_finalized", 409);
      const snapshot = invoice.snapshot ?? invoice.preview;
      const draft = invoice.snapshot === null;
      const bytes = await renderInvoicePdf(snapshot, { draft, voided: invoice.status === "void" });
      const name = `${draft ? "draft-" : ""}${snapshot.number ?? "invoice"}`.replace(/[^A-Za-z0-9_-]/g, "_");
      return reply.type("application/pdf").header("Cache-Control", "private, no-store").header("Content-Security-Policy", "sandbox; default-src 'none'").header("Content-Disposition", `attachment; filename="${name}.pdf"`).send(bytes);
    });
  }
}
