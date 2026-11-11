import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { runMaintenance } from '../src/worker.js';
import { collectGarbage, retireExpiredObjects } from '../src/operations/retention.js';
// The host verifier is exercised against a real API/queue; this is not OS picker coverage.
import { assertExtraction, assertNoMoney, assertPosted, client, invoiceImage, moneySnapshot, reviewedBill, SCAN_REFERENCE, SCAN_SUPPLIER, verifySource } from '../../smart-farmer-frontend/mobile/acceptance/accounting-intake-fixture.mjs';

test('native intake fixture survives JPEG conversion, actual worker OCR, reviewed posting and private source retention', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required for real native-intake fixture verification');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `native_intake_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const media = await mkdtemp(join(tmpdir(), 'native-intake-'));
  const oldMedia = process.env.MEDIA_ROOT; process.env.MEDIA_ROOT = media;
  const app = buildApp(db, 'http://localhost:5173'); app.log.level = 'silent';
  try {
    for (const name of (await readdir(new URL('../migrations', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const password = 'synthetic-native-intake-password'; const username = `intake_${randomUUID().slice(0, 8)}`;
    const anonymous = client(origin);
    const created = await anonymous('/v1/register', { username, password, farmName: 'Synthetic native intake validation', language: 'sn' });
    const { token } = await anonymous('/v1/sessions', { username, password });
    const api = client(origin, token); const base = `/v1/farms/${created.farmId}`;
    await api(`${base}/accounting/settings`, { id: randomUUID(), version: 0, business: { legalName: 'Synthetic review farm', tradingName: '', address: '', email: '', phone: '', registrationNumber: '', taxNumber: '' }, defaultCurrency: 'USD', invoicePrefix: 'NATIVE', startingNumber: 1, taxRates: [], lockedThrough: null, reason: 'Synthetic fixture verification' }, 'PUT');
    const before = await moneySnapshot(api, base, '2026-11-05');
    assert.deepEqual((await api(`${base}/accounting/documents`)).items, []);

    // Exercise two JPEG passes; the hosted journey verifies the actual OS conversion.
    const initialJpeg = await sharp(await invoiceImage()).jpeg({ quality: 90 }).toBuffer();
    const jpeg = await sharp(initialJpeg).jpeg({ quality: 85 }).toBuffer();
    const documentId = randomUUID();
    const upload = await api(`${base}/accounting/documents`, { id: documentId, mimeType: 'image/jpeg', filename: `invoice-${documentId}.jpg`, dataBase64: jpeg.toString('base64') });
    assert.equal(upload.document.state, 'queued');
    assertNoMoney(before, await moneySnapshot(api, base, '2026-11-05'));
    const maintenance = await runMaintenance(db);
    assert.equal(maintenance.accountingScan?.processed, 1);
    const { document } = await api(`${base}/accounting/documents/${documentId}`);
    assertExtraction(document);
    const source = await verifySource(origin, token, base, document);
    assert.equal(source.sizeBytes, jpeg.length);
    assertNoMoney(before, await moneySnapshot(api, base, '2026-11-05'));

    const draft = await api(`${base}/accounting/invoices`, { id: randomUUID(), kind: 'purchase', party: { name: SCAN_SUPPLIER, address: '', email: '', phone: '', taxNumber: '' }, currency: 'USD', reference: SCAN_REFERENCE, issueDate: '2026-11-05', dueDate: null, notes: '', terms: '', documentId, sourceEntryId: null, lines: [{ id: randomUUID(), description: 'Poultry feed', quantity: '2', unitPrice: '12.25', discountMinor: '0', taxRateBps: 0, accountCode: '5000', projectId: null }] });
    const afterDraft = await moneySnapshot(api, base, '2026-11-05');
    assert.equal(reviewedBill(afterDraft.invoices, documentId, 'draft').id, draft.id);
    assertNoMoney(before, afterDraft, draft.id);
    const rejected = await fetch(`${origin}${base}/accounting/invoices/${draft.id}/post`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), version: draft.version, reviewed: false, confirmed: true }) });
    assert.equal(rejected.status, 400, 'Unreviewed OCR bill cannot post');
    assertNoMoney(before, await moneySnapshot(api, base, '2026-11-05'), draft.id);

    await api(`${base}/accounting/invoices/${draft.id}/post`, { id: randomUUID(), version: draft.version, reviewed: true, confirmed: true });
    assert.equal(assertPosted(before, await moneySnapshot(api, base, '2026-11-05'), documentId).id, draft.id);
    await db.query("UPDATE accounting_documents SET created_at=now()-interval '3 days' WHERE id=$1", [documentId]);
    await retireExpiredObjects(db); await collectGarbage(db);
    assert.deepEqual(await verifySource(origin, token, base, document), source, 'Posted original survives ordinary retention with the same content hash');
  } finally {
    await app.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(media, { recursive: true, force: true });
    if (oldMedia === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = oldMedia;
  }
});
