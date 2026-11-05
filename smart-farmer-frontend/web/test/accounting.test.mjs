import {test} from 'node:test';
import assert from 'node:assert/strict';
import {amountToMinor, minorToInput, invoiceMoney, decimalInput, percentageToBps, validateInvoiceFile} from '../src/lib/accounting.ts';
import {AccountingIntent, accountingDataAfterRoleChange, clearAccountingRequest, definiteAccountingRejection, pendingAccountingRequests, persistAccountingRequest} from '../src/lib/accounting-intent.ts';
import {Vault} from '../src/lib/vault.ts';
import {emptyFarmData} from '../src/types.ts';

test('an interrupted financial request survives encrypted restart with its exact key/body and stays outside the offline outbox', async () => {
  const values = new Map();
  const storage = {async get(key) {return structuredClone(values.get(key));}, async set(key, value) {values.set(key, structuredClone(value));}, async remove(key) {values.delete(key);}};
  const farm = {id: 'farm', name: 'Fixture', timezone: 'Africa/Harare', role: 'owner'};
  const snapshot = {version: 1, identity: {userId: 'person', username: 'person', token: 'fixture-token', language: 'sn', expiresAt: '2099-01-01T00:00:00Z'}, language: 'sn', farms: [farm], currentFarmId: farm.id, data: {[farm.id]: emptyFarmData()}, outbox: []};
  let vault = await Vault.unlock('https://fixture.invalid', 'person', 'temporary-accounting-password', snapshot, storage);
  const intent = new AccountingIntent();
  const payload = {id: intent.id, currency: 'USD', description: 'PRIVATE-JOURNAL-CANARY', lines: [{accountCode: '1000', debitMinor: '5000', creditMinor: '0'}, {accountCode: '3000', debitMinor: '0', creditMinor: '5000'}], confirmed: true};
  const pending = {id: intent.id, path: '/v1/farms/farm/accounting/journals', method: 'POST', payload, createdAt: '2026-11-05T12:00:00Z'};
  await persistAccountingRequest(vault, farm, pending);
  assert.deepEqual(vault.snapshot().outbox, []);
  const encrypted = values.get('https://fixture.invalid|person');
  assert.equal(Buffer.from(encrypted.bytes).includes(Buffer.from('PRIVATE-JOURNAL-CANARY')), false);
  vault = await Vault.unlock('https://fixture.invalid', 'person', 'temporary-accounting-password', undefined, storage);
  const restored = pendingAccountingRequests(vault.snapshot(), farm);
  assert.deepEqual(restored, [pending]);
  const resumed = new AccountingIntent(restored[0]);
  assert.equal(resumed.id, intent.id);
  assert.deepEqual(resumed.retry(), payload);
  assert.throws(() => resumed.prepare({...payload, description: 'Different journal'}), /accounting_pending_intent/);
  await assert.rejects(persistAccountingRequest(vault, farm, {...pending, id: crypto.randomUUID()}), /accounting_pending_intent/);
  await clearAccountingRequest(vault, farm, {...pending, id: crypto.randomUUID()});
  assert.equal(pendingAccountingRequests(vault.snapshot(), farm).length, 1, 'another completed action cannot erase the unresolved request');
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), {...farm, role: 'worker'}), []);
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), {...farm, id: 'other-farm'}), []);
  await clearAccountingRequest(vault, farm, pending);
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), farm), []);
  await persistAccountingRequest(vault, farm, pending);
  await vault.mutate(next => {next.farms[0].role = 'worker';});
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), farm), []);
  await assert.rejects(persistAccountingRequest(vault, farm, pending), /forbidden/);
});

test('finance-role changes retain encrypted exact intent across restart, while ordinary caches and financial revocation remain purged', async () => {
  const values = new Map();
  const storage = {async get(key) {return structuredClone(values.get(key));}, async set(key, value) {values.set(key, structuredClone(value));}, async remove(key) {values.delete(key);}};
  const farm = {id: 'farm', name: 'Fixture', timezone: 'Africa/Harare', role: 'manager'};
  const snapshot = {version: 1, identity: {userId: 'person', username: 'person', token: 'fixture-token', language: 'sn', expiresAt: '2099-01-01T00:00:00Z'}, language: 'sn', farms: [farm], currentFarmId: farm.id, data: {[farm.id]: emptyFarmData()}, outbox: []};
  let vault = await Vault.unlock('https://promotion.invalid', 'person', 'temporary-accounting-password', snapshot, storage);
  const id = crypto.randomUUID();
  const pending = {id, path: '/v1/farms/farm/accounting/invoices/invoice/payments', method: 'POST', payload: {id, version: 3, amountMinor: '1250', currency: 'USD', reference: 'ENCRYPTED-PROMOTION-CANARY', confirmed: true}, createdAt: '2026-11-05T12:00:00Z'};
  await persistAccountingRequest(vault, farm, pending);
  await vault.mutate(next => {
    next.data.farm.projects = [{id: 'old-project'}];
    next.data.farm.resources['/v1/farms/farm/accounting/invoices'] = {role: 'manager', value: {private: 'old invoice cache'}, savedAt: pending.createdAt};
    next.data.farm.resources['accounting-pending:stale-role'] = {role: 'worker', value: pending, savedAt: pending.createdAt};
    next.data.farm = accountingDataAfterRoleChange(next.data.farm, 'manager', 'owner');
    next.farms[0].role = 'owner';
  });
  assert.equal(Buffer.from(values.get('https://promotion.invalid|person').bytes).includes(Buffer.from('ENCRYPTED-PROMOTION-CANARY')), false);
  vault = await Vault.unlock('https://promotion.invalid', 'person', 'temporary-accounting-password', undefined, storage);
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), {...farm, role: 'owner'}), [pending]);
  assert.deepEqual(vault.snapshot().data.farm.projects, []);
  assert.deepEqual(Object.keys(vault.snapshot().data.farm.resources), [`accounting-pending:POST:${pending.path}`]);
  assert.deepEqual(vault.snapshot().outbox, []);
  const replay = new AccountingIntent(pendingAccountingRequests(vault.snapshot(), {...farm, role: 'owner'})[0]);
  assert.equal(replay.id, id); assert.deepEqual(replay.retry(), pending.payload);
  assert.throws(() => replay.prepare({...pending.payload, amountMinor: '2500'}), /accounting_pending_intent/);
  await vault.mutate(next => {next.data.farm = accountingDataAfterRoleChange(next.data.farm, 'owner', 'manager'); next.farms[0].role = 'manager';});
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), farm), [pending], 'the reverse finance-role change preserves the same intent too');
  await vault.mutate(next => {
    const retained = accountingDataAfterRoleChange(next.data.farm, 'manager', 'worker');
    assert.equal(retained, undefined); delete next.data.farm; next.farms[0].role = 'worker';
  });
  vault = await Vault.unlock('https://promotion.invalid', 'person', 'temporary-accounting-password', undefined, storage);
  assert.equal(vault.snapshot().data.farm, undefined);
  assert.deepEqual(pendingAccountingRequests(vault.snapshot(), {...farm, role: 'worker'}), []);
  assert.equal(accountingDataAfterRoleChange(emptyFarmData(), 'worker', 'owner'), undefined, 'a new financial grant cannot resurrect a revoked private cache');
});

test('only definitive input/version rejection releases a financial intent; authorization, throttling and uncertain failures keep it', () => {
  for (const status of [400, 409, 422]) assert.equal(definiteAccountingRejection(Object.assign(new Error('invalid_input'), {status})), true);
  for (const status of [0, 401, 403, 404, 429, 500, 503]) assert.equal(definiteAccountingRejection(Object.assign(new Error('network_error'), {status})), false);
  assert.equal(definiteAccountingRejection(Object.assign(new Error('idempotency_conflict'), {status: 409})), false);
  assert.equal(definiteAccountingRejection(Object.assign(new Error('retry_transaction'), {status: 409})), false);
  assert.equal(definiteAccountingRejection(Object.assign(new Error('invalid_response'), {status: 400})), false);
  assert.equal(definiteAccountingRejection(Object.assign(new Error('invalid_response'), {status: 200})), false);
});

test('lost-response reconciliation replays the original financial request exactly once without accepting changed intent', async () => {
  const intent = new AccountingIntent();
  const originalId = intent.id;
  const payload = {id: originalId, version: 3, amountMinor: '1250', currency: 'USD', confirmed: true};
  const records = new Map();
  let lost = true;
  const server = async request => {
    if (!records.has(request.id)) records.set(request.id, structuredClone(request));
    else assert.deepEqual(request, records.get(request.id));
    if (lost) {lost = false; throw new Error('network_error');}
    return {id: request.id, paidMinor: request.amountMinor};
  };
  const submitted = intent.prepare(payload);
  await assert.rejects(server(submitted), /network_error/);
  intent.responseLost(submitted);
  payload.amountMinor = '2500';
  assert.throws(() => intent.prepare(payload), /accounting_pending_intent/);
  const replayed = intent.retry();
  assert.equal(replayed.id, originalId);
  assert.equal(replayed.amountMinor, '1250', 'later form edits cannot alter the saved uncertain intent');
  assert.deepEqual(await server(replayed), {id: originalId, paidMinor: '1250'});
  assert.equal(records.size, 1, 'there is one committed payment, even though the first response was lost');
  intent.accepted();
  assert.notEqual(intent.id, originalId);
  assert.throws(() => intent.retry(), /accounting_no_pending_intent/);
});

test('invoice amounts preserve exact digits above the safe Number range across all supported precisions', () => {
  assert.equal(amountToMinor('9007199254740993.09', 2), '900719925474099309');
  assert.equal(minorToInput('900719925474099309', 2), '9007199254740993.09');
  assert.equal(amountToMinor('12.345', 3), '12345');
  assert.equal(amountToMinor('12', 0), '12');
  assert.equal(amountToMinor('00012.4', 2), '1240');
  assert.equal(minorToInput('-1', 2), '-0.01');
  assert.equal(minorToInput('0', 3), '0.000');
  for (const scale of [-1, 4, 1.5, NaN]) assert.throws(() => amountToMinor('12', scale), /accounting_invalid_precision/);
});

test('invoice inputs reject missing values, exponents, negative money and precision loss rather than silently rounding', () => {
  for (const value of ['', ' ', '-1', '+1', '1e3', 'NaN', '1,200', '.5', '0x10']) assert.throws(() => decimalInput(value), /accounting_invalid_decimal/, value);
  assert.throws(() => amountToMinor('1.001', 2), /accounting_invalid_decimal/);
  assert.throws(() => amountToMinor('1.0', 0), /accounting_invalid_decimal/);
  assert.equal(decimalInput(' 001.123456 '), '1.123456');
  assert.throws(() => decimalInput('1.1234567'), /accounting_invalid_decimal/);
});

test('tax needs an explicit finite percentage and produces exact basis points', () => {
  assert.equal(percentageToBps('0'), 0);
  assert.equal(percentageToBps('15.5'), 1550);
  assert.equal(percentageToBps('100.00'), 10000);
  assert.throws(() => percentageToBps(''), /accounting_invalid_decimal/);
  assert.throws(() => percentageToBps('15.555'), /accounting_invalid_decimal/);
  assert.throws(() => percentageToBps('100.01'), /accounting_invalid_tax/);
});

test('money display never converts unknown amounts to zero and preserves currency and significant digits', () => {
  for (const language of ['sn', 'nd']) {
    assert.equal(invoiceMoney(null, 'USD', 2, language), '—');
    assert.equal(invoiceMoney('123', null, 2, language), '—');
    assert.match(invoiceMoney('0', 'USD', 2, language), /^USD 0\.00$/);
    assert.match(invoiceMoney('-1', 'USD', 2, language), /^USD -0\.01$/);
    assert.equal(invoiceMoney('900719925474099309', 'USD', 2, language).replace(/,/g, ''), 'USD 9007199254740993.09');
    assert.equal(invoiceMoney('123', 'JPY', 0, language), 'JPY 123');
  }
});

test('invoice upload accepts only bounded original image/PDF files with safe filenames', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) assert.doesNotThrow(() => validateInvoiceFile({type, size: 5 * 1024 * 1024, name: 'supplier-invoice.pdf'}));
  assert.throws(() => validateInvoiceFile({type: 'text/html', size: 12, name: 'invoice.html'}), /accounting_document_type/);
  assert.throws(() => validateInvoiceFile({type: 'application/pdf', size: 5 * 1024 * 1024 + 1, name: 'large.pdf'}), /attachment_too_large/);
  assert.throws(() => validateInvoiceFile({type: 'application/pdf', size: 0, name: 'empty.pdf'}), /attachment_too_large/);
  for (const name of ['', '../invoice.pdf', 'folder\\invoice.pdf', 'invoice\n.pdf', 'invoice\x7f.pdf', 'x'.repeat(151)]) assert.throws(() => validateInvoiceFile({type: 'application/pdf', size: 12, name}), /accounting_document_name/);
});
