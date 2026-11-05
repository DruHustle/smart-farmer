import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionBody, decimal, definiteAccountingRejection, editableInvoice, extractionDraft, fromMinor, invoiceTotals, journalLines, newInvoiceLine, reviewedDraft, scaleFor, toMinor, type EditableInvoice, type FinancialDocument, type Invoice, type InvoiceLineInput } from '../src/accounting';
import { ApiError, type ApiClient } from '../src/api';
import { LocalRepository } from '../src/repository';
import { mutationRequest, Synchronizer } from '../src/sync';
import type { Attachment, Mutation } from '../src/types';
import { TestDatabase, activity } from './helpers';

const line = (overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({ id: randomUUID(), description: 'Explicitly reviewed feed', quantity: '1', unitPrice: '0.005', discountMinor: '0', taxRateBps: 0, accountCode: '5000', projectId: null, ...overrides });
const document = (overrides: Partial<FinancialDocument> = {}): FinancialDocument => ({ id: randomUUID(), farmId: randomUUID(), mimeType: 'application/pdf', filename: 'synthetic-invoice.pdf', sizeBytes: 12, contentHash: 'test-only-hash', state: 'ready', errorCode: null, attempts: 1, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', extraction: { schemaVersion: 1, engine: 'pdf_text', language: 'eng', pageCount: 1, text: 'Synthetic Supplier\nUSD 999.00', confidence: null, suggestions: { party: { name: 'Synthetic Supplier' }, reference: 'TEST-100', issueDate: '2026-11-05', dueDate: null, currency: 'USD', lines: [{ description: 'Feed', quantity: '2', unitPrice: '12.50' }], reportedTotal: '999.00' }, warnings: ['review_required', 'tax_review_required'] }, ...overrides });

test('accounting amounts preserve large integers, authoritative precision and per-line half-up rounding', () => {
  for (const scale of [0, 1, 2, 3] as const) {
    const value = fromMinor('9007199254740993', scale);
    assert.equal(toMinor(value, scale), '9007199254740993');
    assert.equal(fromMinor('-1', scale), scale ? `-0.${'0'.repeat(scale - 1)}1` : '-1');
  }
  assert.equal(toMinor('12,50', 2), '1250'); assert.equal(decimal('0012.500000'), '12.5');
  assert.throws(() => toMinor('12.01', 0), /amount_precision/); assert.throws(() => decimal('0.0000001'), /amount_precision/);
  for (const bad of ['NaN', 'Infinity', '1e3', '-1', '12.50.1']) assert.throws(() => toMinor(bad, 2), /invalid_amount/);
  assert.equal(scaleFor([{ code: 'JPY', minorUnit: 0 }, { code: 'BHD', minorUnit: 3 }], 'BHD'), 3);
  assert.throws(() => scaleFor([{ code: 'USD', minorUnit: 2 }], 'JPY'), /unsupported_currency/);
  assert.equal(invoiceTotals([line(), line()], 2).totalMinor, '2', 'Rounding each 0.005 line differs from rounding their sum');
  assert.deepEqual(invoiceTotals([line({ quantity: '3', unitPrice: '12.50', discountMinor: '250', taxRateBps: 1500 })], 2), { subtotalMinor: '3750', discountMinor: '250', netMinor: '3500', taxMinor: '525', totalMinor: '4025' });
  assert.equal(invoiceTotals([line({ quantity: '0.5', unitPrice: '1.001', taxRateBps: 0 })], 3).totalMinor, '501');
  assert.throws(() => invoiceTotals([line({ discountMinor: '2' })], 2), /discount_exceeds_line/);
  assert.throws(() => invoiceTotals([line({ quantity: '0' })], 2), /invalid_amount/);
});

test('scan suggestions cannot silently infer tax, identity fields, a missing currency or an invoice total', () => {
  const source = document(); const draft = extractionDraft(source, randomUUID(), randomUUID);
  assert.equal(draft.documentId, source.id); assert.equal(draft.lines[0]!.taxRateBps, null);
  assert.deepEqual(draft.party, { name: 'Synthetic Supplier', address: '', email: '', phone: '', taxNumber: '' });
  assert.throws(() => reviewedDraft(draft, [{ code: 'USD', minorUnit: 2 }]), /tax_review_required/);
  draft.lines[0]!.taxRateBps = 0;
  const reviewed = reviewedDraft(draft, [{ code: 'USD', minorUnit: 2 }]);
  assert.equal(invoiceTotals(reviewed.lines, 2).totalMinor, '2500', 'OCR reported total999 is not an accounting amount');
  assert.equal(reviewed.lines[0]!.id, draft.lines[0]!.id);
  const unknown = extractionDraft(document({ state: 'failed', extraction: null, errorCode: 'no_text_detected' }), randomUUID(), randomUUID);
  assert.equal(unknown.currency, ''); assert.equal(unknown.issueDate, ''); assert.deepEqual(unknown.lines, []); assert.ok(unknown.documentId, 'A failed scan retains its source for manual review');
  assert.throws(() => reviewedDraft(unknown, [{ code: 'USD', minorUnit: 2 }]), /unsupported_currency/);
  const existing = editableInvoice({ ...reviewed, minorUnit: 2, lines: reviewed.lines.map(item => ({ ...item, taxRateBps: 1500 })) } as Invoice);
  assert.equal(existing.lines[0]!.taxRateBps, 1500, 'Editing an existing draft keeps its reviewed rate');
  assert.equal(existing.lines[0]!.discountAmount, '0.00');
});

test('new manual purchase and sale lines require explicit tax while existing reviewed rates remain intact', () => {
  const currencies = [{ code: 'USD', minorUnit: 2 as const }]; const projectId = randomUUID();
  for (const kind of ['purchase', 'sale'] as const) {
    const draft: EditableInvoice = { id: randomUUID(), kind, party: { name: 'Synthetic manual party', address: '', email: '', phone: '', taxNumber: '' }, currency: 'USD', issueDate: '2026-11-05', dueDate: null, reference: 'MANUAL-REVIEW', notes: '', terms: '', documentId: null, sourceEntryId: null, lines: [{ ...newInvoiceLine(kind, randomUUID(), projectId), description: 'Manually reviewed produce', quantity: '2', unitPrice: '12.50' }] };
    assert.equal(draft.lines[0]!.taxRateBps, null);
    assert.throws(() => reviewedDraft(draft, currencies), /tax_review_required/, 'Untouched tax must not become zero when a manual invoice is reviewed');
    for (const rateBps of [0, 1500]) {
      const reviewed = reviewedDraft({ ...draft, lines: draft.lines.map(line => ({ ...line, taxRateBps: rateBps })) }, currencies);
      assert.equal(invoiceTotals(reviewed.lines, 2).totalMinor, rateBps === 0 ? '2500' : '2875');
      const existing = editableInvoice({ ...reviewed, minorUnit: 2 } as Invoice);
      assert.equal(existing.lines[0]!.taxRateBps, rateBps, 'Editing preserves the explicit zero or configured rate');
      const added = { ...newInvoiceLine(kind, randomUUID(), projectId), description: 'Additional line', unitPrice: '1' };
      assert.throws(() => reviewedDraft({ ...existing, lines: [...existing.lines, added] }, currencies), /tax_review_required/, 'Adding a line requires its own choice instead of inheriting an earlier rate');
      assert.equal(existing.lines[0]!.taxRateBps, rateBps);
    }
  }
});

test('manual journals require balanced exact amounts with one positive side per line', () => {
  assert.deepEqual(journalLines([{ accountCode: '1000', debit: '90071992547409.93', credit: '', description: 'Cash opening' }, { accountCode: '3000', debit: '', credit: '90071992547409.93', description: 'Equity opening' }], 2).map(item => [item.debitMinor, item.creditMinor]), [['9007199254740993', '0'], ['0', '9007199254740993']]);
  assert.throws(() => journalLines([{ accountCode: '1000', debit: '10', credit: '1', description: '' }, { accountCode: '3000', debit: '', credit: '9', description: '' }], 2), /invalid_journal_line/);
  assert.throws(() => journalLines([{ accountCode: '1000', debit: '10', credit: '', description: '' }, { accountCode: '3000', debit: '', credit: '9.99', description: '' }], 2), /unbalanced_journal/);
});

test('unresolved financial intent survives restart, reuses its exact ID and refuses edited retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounting-intent-')); const file = join(directory, 'account.db');
  let repository = new LocalRepository(new TestDatabase(file)); await repository.initialize(); const farmId = randomUUID();
  const key = 'POST:/invoices/synthetic/payments'; const body = { version: 2, amountMinor: '1250', currency: 'USD', paidOn: '2026-11-05', confirmed: true };
  try {
    const first = await actionBody(repository, farmId, key, body, randomUUID); await repository.close();
    repository = new LocalRepository(new TestDatabase(file)); await repository.initialize();
    assert.deepEqual(await actionBody(repository, farmId, key, body, randomUUID), first);
    await assert.rejects(actionBody(repository, farmId, key, { ...body, amountMinor: '1500' }, randomUUID), /accounting_pending_review/);
    await assert.rejects(actionBody(repository, farmId, key, { ...body, version: 3 }, randomUUID), /accounting_pending_review/);
    await repository.saveFormDraft(farmId, `accounting-action:${key}`, null);
    assert.notEqual((await actionBody(repository, farmId, key, { ...body, version: 3 }, randomUUID)).id, first.id, 'Only resolved actions permit a new intent');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('only definitive rejections resolve an uncertain financial request', () => {
  for (const status of [400, 409, 422]) assert.equal(definiteAccountingRejection(new ApiError(status, 'invalid_input')), true);
  for (const status of [0, 401, 403, 404, 408, 413, 429, 500, 503]) assert.equal(definiteAccountingRejection(new ApiError(status, 'request_failed')), false);
  for (const code of ['idempotency_conflict', 'retry_transaction', 'invalid_response']) assert.equal(definiteAccountingRejection(new ApiError(409, code)), false, `${code} can leave the earlier request outcome unknown`);
  assert.equal(definiteAccountingRejection(new ApiError(400, 'invalid_response')), false);
});

test('standalone invoice source waits for explicit upload, survives restart, and adopts canonical duplicate ID without posting money', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounting-source-')); const file = join(directory, 'account.db');
  let repository = new LocalRepository(new TestDatabase(file)); await repository.initialize();
  const farmId = randomUUID(); const id = randomUUID(); const canonicalId = randomUUID(); const bytes = Buffer.from('%PDF-1.7\nSynthetic invoice source only');
  const attachment: Attachment = { id, farmId, accountingDocument: true, financial: true, mimeType: 'application/pdf', filename: 'synthetic-invoice.pdf', dataBase64: bytes.toString('base64'), sizeBytes: bytes.length, state: 'draft', attempts: 0, lastError: null, createdAt: new Date().toISOString() };
  let uploads = 0; let first: unknown;
  const api: ApiClient = { request: async <T>() => { throw new Error('Scanning must never create a money or field record'); }, upload: async <T>(path: string, body: unknown) => { assert.equal(path, `/v1/farms/${farmId}/accounting/documents`); uploads++; if (!first) { first = body; throw new ApiError(503, 'request_failed'); } assert.deepEqual(body, first); return { document: { id: canonicalId }, duplicate: true } as T; } };
  try {
    await repository.attach(attachment); await repository.close(); repository = new LocalRepository(new TestDatabase(file)); await repository.initialize();
    const sync = new Synchronizer(repository, api);
    await sync.flush(farmId, { media: true }); assert.equal(uploads, 0, 'Capture is not upload consent');
    await repository.queueAccountingDocument(farmId, id);
    await sync.flush(farmId, { media: false }); assert.equal(uploads, 0, 'Data saving still applies');
    await sync.flush(farmId, { media: true }); await sync.flush(farmId, { media: true });
    assert.equal(uploads, 2); assert.deepEqual(first, { id, mimeType: attachment.mimeType, filename: attachment.filename, dataBase64: attachment.dataBase64 });
    const saved = (await repository.attachments(farmId))[0]!;
    assert.equal(saved.state, 'synced'); assert.equal(saved.documentId, canonicalId); assert.equal(saved.dataBase64, '');
    assert.equal(saved.activityId, undefined); assert.equal(saved.assetId, undefined); assert.deepEqual(await repository.mutations(farmId), []);
    assert.throws(() => repository.attach({ ...attachment, id: randomUUID(), activityId: randomUUID() }), /invalid_record/);
    assert.throws(() => repository.attach({ ...attachment, id: randomUUID(), financial: false }), /invalid_record/);
    assert.throws(() => repository.attach({ ...attachment, id: randomUUID(), sizeBytes: 5 * 1024 * 1024 + 1 }), /media_too_large/);
    for (const kind of ['invoice-create', 'invoice-post', 'invoice-issue', 'invoice-payment', 'manual-journal']) assert.throws(() => mutationRequest({ ...activity(), kind } as Mutation), /unsafe_offline_action/);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('missing canonical document IDs preserve private bytes for an exact retry and revocation blocks the queue', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  const source = activity(); const bytes = Buffer.from('%PDF-1.7\nSynthetic');
  const attachment: Attachment = { id: randomUUID(), farmId: source.farmId, accountingDocument: true, financial: true, mimeType: 'application/pdf', filename: 'test.pdf', dataBase64: bytes.toString('base64'), sizeBytes: bytes.length, state: 'draft', attempts: 0, lastError: null, createdAt: new Date().toISOString() };
  let calls = 0;
  try {
    await repository.attach(attachment); await repository.queueAccountingDocument(source.farmId, attachment.id);
    const sync = new Synchronizer(repository, { request: async <T>() => ({} as T), upload: async <T>() => { calls++; return {} as T; } });
    await sync.flush(source.farmId, { media: true });
    assert.equal((await repository.attachments(source.farmId))[0]!.dataBase64, attachment.dataBase64);
    assert.equal((await repository.attachments(source.farmId))[0]!.lastError, 'invalid_response');
    await repository.revokeFarm(source.farmId); await sync.flush(source.farmId, { media: true }); assert.equal(calls, 1);
  } finally { await repository.close(); }
});
