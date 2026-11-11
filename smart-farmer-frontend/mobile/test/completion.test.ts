import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { ApiError, type ApiClient } from '../src/api';
import { allPages, parseFields, type FormField } from '../src/product';
import { LocalRepository } from '../src/repository';
import { mutationRequest, Synchronizer } from '../src/sync';
import { label, textFor } from '../src/i18n';
import { completionMessages } from '../src/completion-i18n';
import { TestDatabase, activity, attachment } from './helpers';
import type { Attachment, Mutation } from '../src/types';

const transport = (request: ApiClient['request'], upload: ApiClient['upload'] = async <T>() => ({} as T)): ApiClient => ({ request, upload });

test('typed forms preserve unknowns, normalize currency, reject bad dates and validate only the chosen control representation', () => {
  const fields: FormField[] = [
    { key: 'name', required: true }, { key: 'quantity', type: 'number' }, { key: 'currency' }, { key: 'sourceDate', type: 'date' }, { key: 'observedAt', type: 'datetime' },
    { key: 'valueType', type: 'choice', required: true, options: [{ value: 'boolean', label: 'Yebo' }, { value: 'integer', label: 'Inombolo' }] },
    { key: 'value', type: 'integer', required: true, maximum: 65535, when: { key: 'valueType', equals: 'integer' } },
    { key: 'booleanValue', type: 'boolean', when: { key: 'valueType', equals: 'boolean' } },
  ];
  const parsed = parseFields(fields, { name: '  Recorded fact  ', quantity: '', currency: 'usd', sourceDate: '2026-11-03', observedAt: '2026-11-03T10:00', valueType: 'boolean', booleanValue: false, value: 'not-used', amount: 999 }, 'Africa/Harare');
  assert.deepEqual(parsed, { name: 'Recorded fact', currency: 'USD', sourceDate: '2026-11-03', observedAt: '2026-11-03T08:00:00.000Z', valueType: 'boolean', booleanValue: false });
  assert.throws(() => parseFields(fields, { name: 'x', valueType: 'integer', value: '65536' }, 'Africa/Harare'), /invalid_number/);
  assert.throws(() => parseFields(fields, { name: 'x', valueType: 'boolean', currency: 'US' }, 'Africa/Harare'), /invalid_currency/);
  assert.throws(() => parseFields(fields, { name: 'x', valueType: 'boolean', sourceDate: '2026-02-30' }, 'Africa/Harare'), /invalid_date/);
  assert.equal(parseFields([{ key: 'amount', type: 'number', minimum: 0.01 }], { amount: '12,50' }, 'Africa/Harare').amount, 12.5);
  assert.throws(() => parseFields([{ key: 'quantity', type: 'number' }], { quantity: 'Infinity' }, 'Africa/Harare'), /invalid_number/);
});

test('cursor reads include later records, preserve filters, and reject a repeated cursor instead of caching an incomplete history', async () => {
  const calls: string[] = [];
  const api = transport(async <T>(path: string) => { calls.push(path); return (calls.length === 1 ? { items: [{ id: 1 }], nextCursor: 'a/b' } : { items: [{ id: 2 }], nextCursor: null }) as T; });
  assert.deepEqual(await allPages(api, '/v1/farms/f/records?type=soil_test'), [{ id: 1 }, { id: 2 }]);
  assert.equal(calls[1], '/v1/farms/f/records?type=soil_test&limit=100&cursor=a%2Fb');
  const looping = transport(async <T>() => ({ items: [], nextCursor: 'same-cursor' } as T));
  await assert.rejects(allPages(looping, '/v1/farms/f/records'), /request_failed/);
});

test('an asset PDF survives restart, waits for explicit save and media consent, and retries exactly the same private parent and bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-asset-document-')); const file = join(directory, 'account.db');
  let repository = new LocalRepository(new TestDatabase(file)); await repository.initialize();
  try {
    const source = activity(); const assetId = randomUUID(); const raw = Buffer.from('%PDF-1.7\nIsolated acceptance document');
    const document: Attachment = { ...attachment(source), activityId: undefined, assetId, financial: true, mimeType: 'application/pdf', filename: 'private-invoice.pdf', dataBase64: raw.toString('base64'), sizeBytes: raw.length };
    await repository.attach(document); await repository.close(); repository = new LocalRepository(new TestDatabase(file)); await repository.initialize();
    let uploads = 0; let payload: unknown;
    const api = transport(async <T>() => { throw new Error('Asset upload must not fabricate an activity'); }, async <T>(_path: string, body: unknown) => { uploads++; if (!payload) { payload = body; throw new ApiError(503, 'network_error'); } assert.deepEqual(body, payload); return { id: document.id, status: 'stored' } as T; });
    const sync = new Synchronizer(repository, api);
    await sync.flush(source.farmId, { media: true }); assert.equal(uploads, 0, 'Unsaved attachment must remain a draft');
    await repository.queueAssetAttachments(source.farmId, assetId);
    await sync.flush(source.farmId, { media: false }); assert.equal(uploads, 0, 'Data saving must defer the file');
    await sync.flush(source.farmId, { media: true }); await sync.flush(source.farmId, { media: true });
    assert.equal(uploads, 2); assert.deepEqual(payload, { id: document.id, assetId, mimeType: document.mimeType, filename: document.filename, dataBase64: document.dataBase64, financial: true });
    assert.equal((await repository.attachments(source.farmId, `asset:${assetId}`))[0]!.state, 'synced');
    assert.deepEqual(await repository.mutations(source.farmId), []);
    assert.throws(() => repository.attach({ ...document, id: randomUUID(), activityId: randomUUID() }), /invalid_record/);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('role revocation removes cached reads, retains unsent typed drafts, and blocks independent asset uploads without another request', async () => {
  const repository = new LocalRepository(new TestDatabase(':memory:')); await repository.initialize();
  try {
    const source = activity(); const assetId = randomUUID();
    const draft = { id: randomUUID(), values: { finding: 'Prior sourced assessment', source: 'Farm notebook' } };
    await repository.saveFormDraft(source.farmId, 'assessment', draft);
    await repository.setPreference(`farm:${source.farmId}:panel:private`, { title: 'Old private cached context' });
    await repository.attach({ ...attachment(source), activityId: undefined, assetId }); await repository.queueAssetAttachments(source.farmId, assetId);
    await repository.revokeFarm(source.farmId);
    assert.deepEqual(await repository.formDraft(source.farmId, 'assessment'), draft);
    assert.equal(await repository.preference(`farm:${source.farmId}:panel:private`), null);
    assert.equal((await repository.attachments(source.farmId))[0]!.lastError, 'access_revoked');
    await new Synchronizer(repository, transport(async <T>() => { throw new Error('No revoked work may be sent'); }, async <T>() => { throw new Error('No revoked attachment may be sent'); })).flush(source.farmId, { media: true });
  } finally { await repository.close(); }
});

test('new append-only offline observations do not add any commerce, payment, approval or actuator queue path', () => {
  const base = activity();
  for (const kind of ['equipment-command', 'market-order', 'service-booking', 'payment', 'commissioning', 'plan-approval', 'expense-correction']) assert.throws(() => mutationRequest({ ...base, kind } as Mutation), /unsafe_offline_action/);
  for (const [kind, suffix, resource] of [['project-record', '/records', true], ['weather-observation', '/weather/observations', false], ['asset-usage', '/usage', true], ['incident-create', '/incidents', false]] as const) {
    const request = mutationRequest({ ...base, kind, ...(resource ? { resourceId: randomUUID() } : {}) }); assert.ok(request.path.endsWith(suffix)); assert.equal(request.method, 'POST');
  }
});

test('every static native form label and completion navigation label has Shona and Northern Ndebele text', async () => {
  const directory = new NodeURL('../src/screens/', import.meta.url); const files = (await readdir(directory)).filter(file => file.endsWith('.tsx'));
  const required = new Set<string>(); const add = (value: string, field = false) => required.add(field ? value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) : value);
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(new NodeURL(file, directory), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source); const index = ['c', 'options'].includes(name) ? 1 : 0;
        if (['c', 'options', 'textField', 'numericField', 'dateField', 'selectField'].includes(name)) {
          const arg = node.arguments[index]; if (arg && ts.isStringLiteral(arg)) add(arg.text);
          if (arg && ts.isArrayLiteralExpression(arg)) for (const entry of arg.elements) if (ts.isStringLiteral(entry)) add(entry.text);
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'fields' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrayLiteralExpression(node.initializer.expression)) for (const entry of node.initializer.expression.elements) if (ts.isStringLiteral(entry)) add(entry.text, true);
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'key' && ts.isStringLiteral(node.initializer)) add(node.initializer.text);
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  for (const language of ['sn', 'nd'] as const) {
    for (const key of required) if (key !== 'unknown') assert.notEqual(label(language, key), textFor(language).unknown, `Missing ${language} label: ${key}`);
    for (const [key, values] of Object.entries(completionMessages)) { assert.equal(values.length, 2, key); assert.ok(values[language === 'sn' ? 0 : 1].trim(), key); }
  }
});
