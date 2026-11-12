import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Synthetic native acceptance only. No app code imports this module or its credentials.
const backendRequire = createRequire(new URL('../../../smart-farmer-backend/package.json', import.meta.url));
export const SCAN_REFERENCE = 'NATIVE-GALLERY-1042';
export const SCAN_SUPPLIER = 'Synthetic Gallery Supplies';
export const SCAN_TEXT = `Supplier: ${SCAN_SUPPLIER}\nInvoice No: ${SCAN_REFERENCE}\nDate: 2026-11-05\nDescription Qty Unit price Amount\nPoultry feed 2 12.50 25.00\nTotal USD 25.00`;
const credentials = { username: 'native_owner', password: 'NativeAcceptanceOnly!2026' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = items => [...items].sort((a, b) => a.id.localeCompare(b.id));

/** This raster fixture enters the real OS library; it is not an app attachment mock. */
export async function invoiceImage() {
  const sharp = backendRequire('sharp');
  const rows = SCAN_TEXT.split('\n').map((line, index) => `<text x="70" y="${95 + index * 95}" font-size="40" font-family="sans-serif">${line}</text>`).join('');
  return sharp(Buffer.from(`<svg width="1600" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="720" fill="white"/><g fill="black">${rows}</g></svg>`)).png().toBuffer();
}

export function assertExtraction(document) {
  assert.equal(document.state, 'ready', 'The normal worker must finish extraction');
  assert.equal(document.mimeType, 'image/jpeg', 'Native image intake must store its private JPEG copy');
  assert.equal(document.attempts, 1, 'This happy path must not depend on automatic OCR retry');
  assert.equal(document.extraction?.engine, 'local_tesseract');
  assert.equal(document.extraction?.suggestions?.party?.name, SCAN_SUPPLIER);
  assert.equal(document.extraction?.suggestions?.reference, SCAN_REFERENCE);
  assert.equal(document.extraction?.suggestions?.currency, 'USD');
  assert.equal(document.extraction?.suggestions?.reportedTotal, '25.00');
  assert.deepEqual(document.extraction?.suggestions?.lines, [{ description: 'Poultry feed', quantity: '2', unitPrice: '12.50' }]);
}

export function client(origin, token) {
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20_000), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `Native intake request failed: ${response.status}`);
    return response.json();
  };
}

async function items(api, path) {
  const result = await api(path + (path.includes('?') ? '&' : '?') + 'limit=100');
  assert.equal(result.nextCursor, null, 'Synthetic intake fixture must fit one bounded verification page');
  return sorted(result.items);
}

export async function moneySnapshot(api, base, asOf) {
  const [invoices, journals, expenses] = await Promise.all([
    items(api, `${base}/accounting/invoices`), items(api, `${base}/accounting/ledger?asOf=${asOf}`), items(api, `${base}/expenses`),
  ]);
  return { invoices, journals, expenses };
}

export function assertNoMoney(before, after, draftId) {
  assert.deepEqual(after.journals, before.journals, 'Capture, extraction and draft review cannot post journals');
  assert.deepEqual(after.expenses, before.expenses, 'Capture, extraction and draft review cannot create an expense');
  assert.deepEqual(after.invoices.filter(invoice => invoice.id !== draftId), before.invoices, 'Existing invoices and their payments must stay unchanged');
}

export async function verifySource(origin, token, base, document) {
  const path = `${base}/accounting/documents/${document.id}/content`;
  const unauthenticated = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  assert.equal(unauthenticated.status, 401, 'The original must not be publicly downloadable');
  const response = await fetch(origin + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('cache-control')?.includes('no-store'));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, document.sizeBytes);
  assert.equal(sha256(bytes), document.contentHash, 'Retained original must match its immutable upload hash');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  return { contentHash: document.contentHash, sizeBytes: bytes.length };
}

export function reviewedBill(invoices, documentId, status) {
  const matches = invoices.filter(invoice => invoice.documentId === documentId);
  assert.equal(matches.length, 1, 'The selected original must produce exactly one bill');
  const invoice = matches[0];
  assert.equal(invoice.kind, 'purchase'); assert.equal(invoice.status, status);
  assert.equal(invoice.party.name, SCAN_SUPPLIER); assert.equal(invoice.reference, SCAN_REFERENCE);
  assert.equal(invoice.currency, 'USD'); assert.equal(invoice.minorUnit, 2);
  assert.equal(invoice.lines.length, 1); assert.equal(invoice.lines[0].quantity, '2');
  assert.equal(invoice.lines[0].unitPrice, '12.25', 'The operator must correct the extracted price before saving');
  assert.equal(invoice.lines[0].taxRateBps, 0, 'Zero tax must be explicitly reviewed');
  assert.equal(invoice.totals.totalMinor, '2450', 'Reviewed lines, not the OCR printed total, determine the bill');
  assert.equal(invoice.paidMinor, '0'); assert.equal(invoice.payments.length, 0);
  assert.equal(invoice.balanceMinor, status === 'draft' ? '0' : '2450');
  return invoice;
}

export function assertPosted(before, after, documentId) {
  const invoice = reviewedBill(after.invoices, documentId, 'posted');
  assert.equal(invoice.snapshot.documentId, documentId);
  assert.equal(invoice.snapshot.totals.totalMinor, '2450');
  assert.deepEqual(after.invoices.filter(item => item.id !== invoice.id), before.invoices);
  const originalJournalIds = new Set(before.journals.map(item => item.id));
  const additions = after.journals.filter(item => !originalJournalIds.has(item.id));
  assert.equal(additions.length, 1, 'Explicit posting must append exactly one journal');
  assert.deepEqual(after.journals.filter(item => originalJournalIds.has(item.id)), before.journals);
  assert.equal(additions[0].sourceType, 'invoice'); assert.equal(additions[0].sourceId, invoice.id);
  const entries = additions[0].lines.map(line => ({ code: line.accountCode, debit: line.debitMinor, credit: line.creditMinor })).sort((a, b) => a.code.localeCompare(b.code));
  assert.deepEqual(entries, [{ code: '2000', debit: '0', credit: '2450' }, { code: '5000', debit: '2450', credit: '0' }]);
  const originalExpenseIds = new Set(before.expenses.map(item => item.id));
  const expenses = after.expenses.filter(item => !originalExpenseIds.has(item.id));
  assert.equal(expenses.length, 1, 'Explicit posting must append exactly one operational expense');
  assert.deepEqual(after.expenses.filter(item => originalExpenseIds.has(item.id)), before.expenses);
  assert.equal(expenses[0].source_type, 'accounting_invoice'); assert.equal(expenses[0].source_id, invoice.id);
  assert.equal(expenses[0].amount, '24.500'); assert.equal(expenses[0].currency, 'USD');
  return invoice;
}

async function main(command, output) {
  if (command === 'image') {
    assert.ok(output, 'Pass the generated PNG path');
    const bytes = await invoiceImage(); await mkdir(dirname(output), { recursive: true }); await writeFile(output, bytes);
    console.log(JSON.stringify({ event: 'synthetic_invoice_image', sha256: sha256(bytes), sizeBytes: bytes.length })); return;
  }
  const origin = process.env.NATIVE_API_ORIGIN || 'http://127.0.0.1:3000';
  const statePath = process.env.NATIVE_INTAKE_STATE;
  assert.ok(statePath, 'NATIVE_INTAKE_STATE is required');
  const fixture = JSON.parse(await readFile(process.env.NATIVE_FIXTURE_PATH, 'utf8'));
  const base = `/v1/farms/${fixture.farmId}`;
  const { token } = await client(origin)('/v1/sessions', credentials);
  const api = client(origin, token);
  const save = state => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  if (command === 'baseline') {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Harare', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type).value;
    const asOf = `${part('year')}-${part('month')}-${part('day')}`;
    assert.deepEqual(await items(api, `${base}/accounting/documents`), [], 'This isolated fixture starts with no uploaded scans');
    await save({ asOf, before: await moneySnapshot(api, base, asOf) });
    console.log('Recorded financial baseline before real OS gallery intake.'); return;
  }
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (command === 'local') {
    assert.deepEqual(await items(api, `${base}/accounting/documents`), [], 'A captured source must remain local until explicit upload consent');
    assertNoMoney(state.before, await moneySnapshot(api, base, state.asOf));
    console.log('Verified capture and restart created no server document, invoice, expense or journal before explicit upload.');
  } else if (command === 'ready') {
    const started = Date.now(); let document;
    // Read-only state observation, never a replay of upload, extraction retry or money mutation.
    while (Date.now() - started < 120_000) {
      const documents = await items(api, `${base}/accounting/documents`);
      assert.ok(documents.length <= 1, 'One selected source must produce at most one server document');
      document = documents[0];
      if (document?.state === 'failed') assert.fail(`Synthetic gallery OCR failed: ${document.errorCode}`);
      if (document?.state === 'ready') break;
      await delay(500);
    }
    assert.ok(document, 'Explicit upload did not create a document'); assertExtraction(document);
    assertNoMoney(state.before, await moneySnapshot(api, base, state.asOf));
    const source = await verifySource(origin, token, base, document);
    await save({ ...state, documentId: document.id, ...source });
    console.log(JSON.stringify({ event: 'native_gallery_extracted_without_money', engine: document.extraction.engine, attempts: document.attempts, ...source }));
  } else if (command === 'document-id') {
    assert.match(state.documentId, /^[0-9a-f-]{36}$/); console.log(state.documentId);
  } else if (command === 'draft') {
    const after = await moneySnapshot(api, base, state.asOf);
    const invoice = reviewedBill(after.invoices, state.documentId, 'draft');
    assertNoMoney(state.before, after, invoice.id); await save({ ...state, invoiceId: invoice.id });
    console.log('Verified the reviewed native draft changes the extracted price but creates no expense, payable or journal.');
  } else if (command === 'posted') {
    const after = await moneySnapshot(api, base, state.asOf);
    const invoice = assertPosted(state.before, after, state.documentId); assert.equal(invoice.id, state.invoiceId);
    const { document } = await api(`${base}/accounting/documents/${state.documentId}`);
    const source = await verifySource(origin, token, base, document);
    assert.equal(source.contentHash, state.contentHash); assert.equal(source.sizeBytes, state.sizeBytes);
    console.log(JSON.stringify({ event: 'native_gallery_reviewed_bill_verified', totalMinor: '2450', currency: 'USD', journalsAdded: 1, expensesAdded: 1, paymentsAdded: 0, retainedSourceHash: source.contentHash }));
    console.log('Verified real OS gallery selection, encrypted local-source restart, explicit upload, actual OCR, reviewed price and tax, explicit posting and private original retention. Camera capture, PDF-picker selection and OS sharing are separate unqualified paths.');
  } else throw new Error('Unknown intake verification phase');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2], process.argv[3]);
