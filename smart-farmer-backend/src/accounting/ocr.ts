import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 6;
const MAX_TEXT = 80_000;
const MAX_PIXELS = 24_000_000;
const JOB_MS = 90_000;
export type DocumentMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
export type ScanSuggestions = {
  party: { name: string } | null;
  reference: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  lines: { description: string; quantity: string; unitPrice: string }[];
  reportedTotal: string | null;
};
export type InvoiceExtraction = {
  schemaVersion: 1;
  engine: "local_tesseract" | "pdf_text" | "mixed";
  language: "eng";
  pageCount: number;
  text: string;
  confidence: number | null;
  suggestions: ScanSuggestions;
  warnings: string[];
};
export class ExtractionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function validDocumentSignature(type: DocumentMime, bytes: Buffer) {
  if (bytes.length < 12 || bytes.length > MAX_DOCUMENT_BYTES) return false;
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return /^%PDF-(1\.[0-9]|2\.0)/.test(bytes.toString("ascii", 0, 8)) && bytes.subarray(-1024).includes(Buffer.from("%%EOF"));
}

// execFile receives a fixed binary and argument vector, never a shell command or
// arguments taken from document text. Native parsers and output are bounded.
async function command(binary: string, args: string[], deadline: number) {
  const timeout = Math.min(20_000, deadline - Date.now());
  if (timeout <= 0) throw new ExtractionError("scan_timeout");
  return new Promise<string>((resolve, reject) => {
    execFile(binary, args, {
      timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, OMP_THREAD_LIMIT: "1", LC_ALL: "C" },
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      reject(new ExtractionError(e.code === "ENOENT" ? "scan_unavailable" : e.killed ? "scan_timeout" : "document_unreadable"));
    });
  });
}

/** TSV word confidences are an OCR quality hint, not accounting correctness. */
export function parseTsv(tsv: string) {
  const lines = new Map<string, string[]>();
  let weight = 0, weightedConfidence = 0;
  for (const row of tsv.split(/\r?\n/).slice(1, 30_001)) {
    const cells = row.split("\t");
    if (cells[0] !== "5" || cells.length < 12) continue;
    const word = cells.slice(11).join(" ").trim().slice(0, 500);
    if (!word) continue;
    const key = cells.slice(1, 5).join(":");
    const words = lines.get(key) ?? [];
    words.push(word); lines.set(key, words);
    const confidence = Number(cells[10]);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 100) {
      weight += word.length; weightedConfidence += word.length * confidence;
    }
  }
  return {
    text: [...lines.values()].map(words => words.join(" ")).join("\n").slice(0, MAX_TEXT),
    confidence: weight ? Math.round(weightedConfidence / weight) : null,
  };
}

const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function validDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
function dateSuggestion(value: string) {
  let match = value.match(/\b(20\d{2}|19\d{2}|21\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) return validDate(+match[1], +match[2], +match[3]);
  match = value.match(/\b(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})\b/);
  if (match && months[match[2].slice(0, 3).toLowerCase()]) return validDate(+match[3], months[match[2].slice(0, 3).toLowerCase()], +match[1]);
  match = value.match(/\b([A-Za-z]{3,9})[\s-]+(\d{1,2}),?[\s-]+(\d{4})\b/);
  if (match && months[match[1].slice(0, 3).toLowerCase()]) return validDate(+match[3], months[match[1].slice(0, 3).toLowerCase()], +match[2]);
  // 04/05 is ambiguous: never silently choose a locale.
  match = value.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (match && +match[1] > 12) return validDate(+match[3], +match[2], +match[1]);
  if (match && +match[2] > 12) return validDate(+match[3], +match[1], +match[2]);
  return null;
}
function decimal(value: string): string | null {
  const cleaned = value.trim().replace(/^(?:[A-Z]{3}\s*|[$€£]\s*)/, "").replace(/[\s]+/g, "");
  // A comma is accepted only as an unambiguous thousands separator. Decimal
  // commas, parentheses and OCR letter substitutions require human review.
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/.test(cleaned)) return null;
  const normalized = cleaned.replaceAll(",", "");
  if (normalized.length > 22) return null;
  return normalized.replace(/^0+(?=\d)/, "");
}
function millionths(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/** Conservative suggestions from printed invoices; every field stays unposted. */
export function suggestInvoice(raw: string): { suggestions: ScanSuggestions; warnings: string[] } {
  const text = raw.replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "").slice(0, MAX_TEXT);
  const rows = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const warnings = new Set<string>(["review_required"]);
  const codes = new Set(Intl.supportedValuesOf("currency"));
  // Recognize explicit codes only. A dollar sign does not identify a currency.
  const currencies = [...new Set((text.match(/\b[A-Z]{3}\b/g) ?? []).filter(x => codes.has(x)))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  if (!currency) warnings.add(currencies.length > 1 ? "multiple_currencies" : "currency_missing");
  const reference = text.match(/(?:invoice|bill)\s*(?:no\.?|number|#|ref(?:erence)?\.?)?\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,69})/i)?.[1]
    ?? text.match(/(?:invoice|bill)\s+(?:no\.?|number|#)\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,69})/i)?.[1] ?? null;
  if (!reference) warnings.add("reference_missing");
  const dated = rows.find(x => /^(?:invoice\s+date|date\s+issued|issue\s+date|date)\b/i.test(x));
  const due = rows.find(x => /^(?:due\s+date|payment\s+due|due)\b/i.test(x));
  const issueDate = dated ? dateSuggestion(dated) : null;
  const dueDate = due ? dateSuggestion(due) : null;
  if (!issueDate) warnings.add(dated ? "date_ambiguous" : "date_missing");
  if (due && !dueDate) warnings.add("due_date_ambiguous");
  const explicitSupplier = rows.find(x => /^(?:supplier|seller|from)\s*:/i.test(x))?.replace(/^[^:]+:\s*/, "");
  const heading = rows.slice(0, 3).find(x => x.length >= 3 && x.length <= 160 && /[A-Za-z]{3}/.test(x) && !/invoice|\bbill\b|\breceipt\b|\bdate\b|\btotal\b|\bpage\b|\bto\s*:/i.test(x) && !/^[\d\W]+$/.test(x));
  const name = (explicitSupplier ?? heading)?.slice(0, 160);
  if (!name) warnings.add("supplier_missing");
  const totals = rows.filter(x => /^(?:grand\s+total|invoice\s+total|total\s+(?:due|amount)|amount\s+due|total)\b/i.test(x) && !/^total\s+(?:tax|discount|items|qty|quantity)\b/i.test(x));
  const totalRow = totals.at(-1);
  const reportedTotal = totalRow ? decimal(totalRow.match(/(?:[A-Z]{3}\s*|[$€£]\s*)?\d[\d,]*(?:\.\d{1,6})?\s*$/)?.[0] ?? "") : null;
  if (!reportedTotal) warnings.add("total_missing");
  const lines: ScanSuggestions["lines"] = [];
  for (const row of rows) {
    if (/^(?:sub\s*total|total|grand|tax|vat|discount|balance|amount|invoice|date|due|payment|bank|account)\b/i.test(row)) continue;
    const match = row.match(/^(.{2,200}?)\s+(\d+(?:\.\d{1,6})?)\s+(?:[A-Z]{3}\s*|[$€£]\s*)?(\d[\d,]*(?:\.\d{1,6})?)\s+(?:[A-Z]{3}\s*|[$€£]\s*)?(\d[\d,]*(?:\.\d{1,6})?)$/);
    if (!match) continue;
    const quantity = decimal(match[2]), unitPrice = decimal(match[3]), total = decimal(match[4]);
    if (!quantity || !unitPrice || !total || millionths(quantity) <= 0n) continue;
    const calculated = millionths(quantity) * millionths(unitPrice) / 1_000_000n;
    const difference = calculated - millionths(total);
    if (difference < -10_000n || difference > 10_000n) { warnings.add("line_amount_uncertain"); continue; }
    if (lines.length < 100) lines.push({ description: match[1].trim(), quantity, unitPrice });
  }
  if (!lines.length) warnings.add("line_items_missing");
  if (/\b(?:tax|VAT|GST)\b/i.test(text)) warnings.add("tax_review_required");
  if (/\bdiscount\b/i.test(text)) warnings.add("discount_review_required");
  return { suggestions: { party: name ? { name } : null, reference, issueDate, dueDate, currency, lines, reportedTotal }, warnings: [...warnings] };
}

async function ocrImage(bytes: Buffer, path: string, deadline: number) {
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new ExtractionError("document_unreadable");
    await image.rotate().resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }).flatten({ background: "white" }).grayscale().normalize().png().toFile(path);
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("image_unreadable_or_too_large");
  }
  return parseTsv(await command("tesseract", [path, "stdout", "-l", "eng", "--psm", "3", "tsv"], deadline));
}

export async function extractInvoice(bytes: Buffer, mimeType: DocumentMime): Promise<InvoiceExtraction> {
  if (!validDocumentSignature(mimeType, bytes)) throw new ExtractionError("invalid_document");
  const directory = await mkdtemp(join(tmpdir(), "farmer-invoice-"));
  const deadline = Date.now() + JOB_MS;
  const pages: { text: string; confidence: number | null; ocr: boolean }[] = [];
  try {
    if (mimeType !== "application/pdf") {
      pages.push({ ...(await ocrImage(bytes, join(directory, "image.png"), deadline)), ocr: true });
    } else {
      const path = join(directory, "source.pdf");
      await writeFile(path, bytes, { mode: 0o600 });
      const info = await command("pdfinfo", [path], deadline);
      const count = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
      if (!Number.isInteger(count) || count < 1) throw new ExtractionError("document_unreadable");
      if (count > MAX_DOCUMENT_PAGES) throw new ExtractionError("document_too_many_pages");
      if (/^Encrypted:\s+yes/im.test(info)) throw new ExtractionError("document_encrypted");
      for (let page = 1; page <= count; page++) {
        const text = await command("pdftotext", ["-f", String(page), "-l", String(page), "-layout", "-enc", "UTF-8", path, "-"], deadline);
        if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 40 && !text.includes("\uFFFD")) {
          pages.push({ text: text.slice(0, MAX_TEXT), confidence: null, ocr: false });
        } else {
          const image = join(directory, `page-${page}`);
          await command("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "2400", "-png", path, image], deadline);
          pages.push({ ...(await ocrImage(await readFile(`${image}.png`), join(directory, "normalized.png"), deadline)), ocr: true });
          await rm(`${image}.png`, { force: true });
        }
      }
    }
    const text = pages.map(x => x.text).join("\n\n").replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "").slice(0, MAX_TEXT);
    if (!text.trim()) throw new ExtractionError("no_text_detected");
    const result = suggestInvoice(text);
    const confidences = pages.map(x => x.confidence).filter((x): x is number => x !== null);
    const confidence = confidences.length ? Math.round(confidences.reduce((sum, x) => sum + x, 0) / confidences.length) : null;
    if (confidence !== null && confidence < 80) result.warnings.push("low_ocr_confidence");
    if (text.length === MAX_TEXT) result.warnings.push("text_truncated");
    const ocrCount = pages.filter(x => x.ocr).length;
    return { schemaVersion: 1, engine: ocrCount === 0 ? "pdf_text" : ocrCount === pages.length ? "local_tesseract" : "mixed", language: "eng", pageCount: pages.length, text, confidence, ...result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
