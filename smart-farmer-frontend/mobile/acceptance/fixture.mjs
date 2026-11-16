import { createServer, request } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Only a test harness. This process and these credentials are never bundled into the app.
const origin = process.env.NATIVE_API_ORIGIN || 'http://127.0.0.1:3000';
const credentials = { username: 'native_owner', password: 'NativeAcceptanceOnly!2026' };
const sellerCredentials = { username: 'native_seller', password: 'NativeAcceptanceOnly!2026' };
async function api(path, body, token, method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
  return value;
}
function fixture() {
  return JSON.parse(readFileSync(process.env.NATIVE_FIXTURE_PATH, 'utf8'));
}
if (process.argv[2] === 'seed') {
  await api('/v1/register', { ...credentials, farmName: 'Native acceptance farm', language: 'sn' });
  const session = await api('/v1/sessions', credentials);
  const { items: farms } = await api('/v1/farms', null, session.token);
  const ids = { farmId: farms[0].id, projectId: randomUUID(), templateId: randomUUID(), planId: randomUUID(), assetId: randomUUID(), cameraId: randomUUID(), cameraEventId: randomUUID(), stockId: randomUUID(), listingId: randomUUID(), serviceId: randomUUID(), purchaseInvoiceId: randomUUID() };
  const base = `/v1/farms/${ids.farmId}`;
  await api(`${base}/projects`, { id: ids.projectId, name: 'Native acceptance maize', enterpriseType: 'crop', crop: 'maize', irrigation: true }, session.token);
  await api(`${base}/accounting/settings`, { id: randomUUID(), version: 0, business: { legalName: 'Synthetic native acceptance farm', tradingName: '', address: 'Synthetic test address; not a real business', email: 'native@example.test', phone: '', registrationNumber: '', taxNumber: '' }, defaultCurrency: 'USD', invoicePrefix: 'NATIVE', startingNumber: 1, taxRates: [{ name: 'Synthetic configured test rate', rateBps: 1500 }], lockedThrough: null, reason: 'Isolated native acceptance fixture; not tax registration or a production business' }, session.token, 'PUT');
  await api(`${base}/accounting/invoices`, { id: ids.purchaseInvoiceId, kind: 'purchase', party: { name: 'Synthetic native supplier', address: '', email: '', phone: '', taxNumber: '' }, currency: 'USD', reference: 'NATIVE-BILL-100', issueDate: new Date().toISOString().slice(0, 10), dueDate: null, notes: 'Synthetic supplier draft; native UI must review and post', terms: '', documentId: null, sourceEntryId: null, lines: [{ id: randomUUID(), description: 'Synthetic feed supplies', quantity: '4', unitPrice: '5.00', discountMinor: '0', taxRateBps: 0, accountCode: '5000', projectId: ids.projectId }] }, session.token);
  await api(`${base}/templates`, { id: ids.templateId, name: 'Native sourced template', enterpriseType: 'crop', source: 'Synthetic native acceptance fixture; no agronomic advice', sourceDate: new Date().toISOString().slice(0, 10), language: 'sn', steps: [{ key: 'observe', title: 'Native approved observation task', instructions: 'Synthetic observation only', offsetDays: 1, requiredEvidence: 'Record an observation' }] }, session.token);
  await api(`${base}/projects/${ids.projectId}/plans`, { id: ids.planId, templateId: ids.templateId, templateVersion: 1, anchorAt: new Date().toISOString(), note: 'Native approval preview' }, session.token);
  await api(`${base}/assets`, { id: ids.assetId, name: 'Native acceptance simulator pump', category: 'pump', protocol: 'simulator', staleAfterSeconds: 3600 }, session.token);
  await api(`${base}/assets/${ids.assetId}/simulate`, { running: false, interlockOk: true }, session.token);
  await api(`${base}/assets`, { id: ids.cameraId, name: 'Native acceptance simulator camera', category: 'camera', protocol: 'simulator' }, session.token);
  await api(`${base}/cameras/${ids.cameraId}/configure`, { version: 1, provider: 'simulator', retentionDays: 1, eventsEnabled: true, liveEnabled: true, capabilities: { live: true, snapshot: true, motion: true, person: false, ptz: false } }, session.token);
  await api(`${base}/camera-events`, { id: ids.cameraEventId, assetId: ids.cameraId, kind: 'motion', observedAt: new Date().toISOString(), retentionDays: 1 }, session.token);
  await api('/v1/register', { ...sellerCredentials, farmName: 'Native acceptance provider farm', language: 'sn' });
  const seller = await api('/v1/sessions', sellerCredentials);
  const sellerFarms = await api('/v1/farms', null, seller.token);
  ids.sellerFarmId = sellerFarms.items[0].id;
  const sellerBase = `/v1/farms/${ids.sellerFarmId}`;
  ids.forumId = randomUUID();
  await api(`${sellerBase}/forum/discussions`, { id: ids.forumId, displayName: 'CommunityGrower', title: 'Native community discussion', topic: 'crops', body: 'Synthetic community fixture; no agronomic advice.', shareWithCommunity: true }, seller.token);
  ids.forumModerationId = randomUUID();
  await api(`${base}/forum/discussions`, { id: ids.forumModerationId, displayName: 'NativeFixtureOwner', title: 'Native moderation fixture', topic: 'general', body: 'Synthetic owner moderation fixture; no farming advice.', shareWithCommunity: true }, session.token);
  await api(`${sellerBase}/forum/entries/${ids.forumModerationId}/reports`, { id: randomUUID(), version: 1, reason: 'other', details: 'Synthetic report to exercise source-farm owner review.' }, seller.token);
  await api(`${sellerBase}/stock`, { id: ids.stockId, name: 'Native acceptance beans', quantity: 10, unit: 'kg' }, seller.token);
  await api(`${sellerBase}/listings`, { id: ids.listingId, stockItemId: ids.stockId, title: 'Native acceptance beans', quantity: 10, price: 6, priceBasis: 'bag', priceQuantity: 2, currency: 'USD', collectionArea: 'Synthetic acceptance collection area' }, seller.token);
  await api(`${sellerBase}/services`, { id: ids.serviceId, name: 'Native acceptance tractor', description: 'Synthetic acceptance service; no external provider', serviceArea: 'Synthetic acceptance area', rate: 25, currency: 'USD', rateBasis: 'hour', minimumCharge: 25, mobilisationCharge: 5, operatorIncluded: true, fuelIncluded: false }, seller.token);
  writeFileSync(process.env.NATIVE_FIXTURE_PATH, JSON.stringify(ids), { mode: 0o600 });
  console.log('Native crop, sourced plan, simulator equipment/camera, synthetic accounting settings and unposted supplier draft, and separate seller/service fixtures seeded through authenticated API.');
} else if (process.argv[2] === 'verify') {
  const session = await api('/v1/sessions', credentials);
  const { items: farms } = await api('/v1/farms', null, session.token);
  const { items } = await api(`/v1/farms/${farms[0].id}/activities`, null, session.token);
  try {
    assert.equal(items.filter(item => item.note === 'Native durable offline observation').length, 1, 'Offline record must reach the server exactly once after restart');
  } catch (error) {
    // Observe the already-fetched failed receipt without another request or raw record data.
    try {
      const ids = fixture();
      const expected = 'Native durable offline observation';
      const records = items.slice(0, 100).map(item => {
        const note = typeof item.note === 'string' ? item.note : null;
        return {
          projectMatchesSeed: item.project_id === ids.projectId,
          actorMatchesSession: item.actor_id === session.userId,
          noteType: item.note === null ? 'null' : Array.isArray(item.note) ? 'array' : typeof item.note,
          noteLength: note === null ? null : note.length,
          noteUtf8Bytes: note === null ? null : Buffer.byteLength(note, 'utf8'),
          noteSha256: note === null ? null : createHash('sha256').update(note).digest('hex'),
          exactNote: note === expected,
          caseEquivalentNote: note !== null && note.toLowerCase() === expected.toLowerCase(),
          lineEquivalentNote: note !== null && note.replace(/\n/g, ' ') === expected,
          selectorTextEquivalentNote: note !== null && note.replace(/\n/g, ' ').toLowerCase() === expected.toLowerCase(),
        };
      });
      console.error('[native-receipt-observation]', JSON.stringify({
        timestamp: new Date().toISOString(),
        returnedFarmCount: farms.length,
        selectedFarmMatchesSeed: farms[0]?.id === ids.farmId,
        returnedActivityCount: items.length,
        observedActivityCount: records.length,
        records,
      }));
    } catch { /* Diagnostic failures must not replace the original receipt assertion. */ }
    throw error;
  }
  console.log('Verified exactly one offline record after native restart and reconciliation.');
} else if (process.argv[2] === 'ids') {
  const ids = fixture();
  const values = ['projectId', 'planId', 'assetId', 'cameraId', 'cameraEventId', 'listingId', 'serviceId', 'purchaseInvoiceId'].map(key => ids[key]);
  assert.ok(values.every(value => /^[0-9a-f-]{36}$/.test(value)), 'Only fixture UUIDs may be passed into the native runner');
  console.log(values.join(' '));
} else if (process.argv[2] === 'verify-products') {
  const ids = fixture();
  const session = await api('/v1/sessions', credentials);
  const seller = await api('/v1/sessions', sellerCredentials);
  const base = `/v1/farms/${ids.farmId}`;
  const sellerBase = `/v1/farms/${ids.sellerFarmId}`;
  const [plans, tasks, expenses, orders, bookings, commands, assets, events, stock, invoices, summary, journals] = await Promise.all([
    api(`${base}/projects/${ids.projectId}/plans`, null, session.token),
    api(`${base}/tasks`, null, session.token),
    api(`${base}/expenses`, null, session.token),
    api('/v1/market/orders', null, session.token),
    api(`${base}/bookings`, null, session.token),
    api(`${base}/assets/${ids.assetId}/commands`, null, session.token),
    api(`${base}/assets`, null, session.token),
    api(`${base}/camera-events`, null, session.token),
    api(`/v1/farms/${ids.sellerFarmId}/stock`, null, seller.token),
    api(`${base}/accounting/invoices`, null, session.token),
    api(`${base}/accounting/summary`, null, session.token),
    api(`${base}/accounting/ledger`, null, session.token),
  ]);
  assert.equal(plans.items.find(item => item.id === ids.planId)?.status, 'approved', 'Native plan approval must be explicit');
  assert.equal(tasks.items.filter(item => item.title === 'Native approved observation task').length, 1, 'Plan approval must materialize exactly one task');
  const recordedExpenses = expenses.items.filter(item => item.note === 'Native accepted expense');
  assert.equal(recordedExpenses.length, 1, 'Native reviewed expense must be recorded once');
  assert.equal(Number(recordedExpenses[0].amount), 12.5);
  assert.equal(recordedExpenses[0].currency, 'USD');
  assert.equal(recordedExpenses[0].project_id, ids.projectId);
  const reservations = orders.items.filter(item => item.listing_id === ids.listingId);
  assert.equal(reservations.length, 1, 'Native reservation must be recorded once');
  assert.equal(reservations[0].status, 'reserved');
  assert.equal(Number(reservations[0].quantity), 2);
  assert.equal(Number(reservations[0].amount), 6, 'Bag price covers two base units');
  const balance = stock.items.find(item => item.id === ids.stockId);
  assert.equal(Number(balance.quantity), 10, 'Reservation does not decrement physical stock');
  assert.equal(Number(balance.reserved_quantity), 2);
  const requests = bookings.items.filter(item => item.service_id === ids.serviceId);
  assert.equal(requests.length, 1, 'Native service request must be recorded once');
  assert.equal(requests[0].status, 'requested', 'A booking request must not silently accept a quote');
  assert.equal(requests[0].note, 'Native accepted booking request');
  assert.equal(expenses.items.some(item => item.source_type === 'service_booking'), false, 'Unconfirmed requests must not create expenses');
  assert.equal(commands.items.length, 1, 'Native command confirmation must authorize exactly one command');
  assert.equal(commands.items[0].command, 'start');
  assert.ok(['authorized', 'expired'].includes(commands.items[0].status), 'Authorization cannot claim dispatch or successful actuation without feedback');
  assert.equal(assets.items.find(item => item.id === ids.assetId)?.latest_telemetry.running, false, 'The simulator stays off until explicit feedback');
  const event = events.items.find(item => item.id === ids.cameraEventId);
  assert.equal(event.kind, 'motion', 'Motion is not relabeled as a person');
  assert.ok(event.acknowledged_at, 'Native camera-event acknowledgement reaches the API');
  assert.equal(event.source, 'simulator');
  const purchase = invoices.items.find(item => item.id === ids.purchaseInvoiceId);
  assert.equal(purchase.status, 'posted', 'A supplier draft requires explicit native posting');
  assert.equal(purchase.totals.totalMinor, '2000'); assert.equal(purchase.paidMinor, '750'); assert.equal(purchase.balanceMinor, '1250'); assert.equal(purchase.paymentStatus, 'partial');
  assert.equal(purchase.payments.filter(item => !item.reversalOf).length, 1, 'Native supplier payment is recorded once');
  const sales = invoices.items.filter(item => item.party.name === 'Native accepted customer' && item.reference === 'NATIVE-SALE-UI');
  assert.equal(sales.length, 1, 'Native invoice creation must preserve one invoice identity');
  const sale = sales[0]; assert.equal(sale.status, 'issued'); assert.ok(sale.number.startsWith('NATIVE-'));
  assert.equal(sale.totals.totalMinor, '3050'); assert.equal(sale.paidMinor, '1000'); assert.equal(sale.balanceMinor, '2050'); assert.equal(sale.paymentStatus, 'partial');
  assert.equal(sale.payments.filter(item => !item.reversalOf).length, 1, 'Native customer receipt is recorded once');
  assert.equal(sale.snapshot.totals.totalMinor, '3050', 'Payment must not mutate the issued snapshot');
  const usd = summary.byCurrency.find(item => item.currency === 'USD');
  assert.equal(usd.salesMinor, '3050'); assert.equal(usd.expensesMinor, '2000'); assert.equal(usd.cashReceivedMinor, '1000'); assert.equal(usd.cashPaidMinor, '750'); assert.equal(usd.receivableMinor, '2050'); assert.equal(usd.payableMinor, '1250');
  assert.equal(summary.exchangeRatesApplied, false);
  for (const journal of journals.items) assert.equal(journal.lines.reduce((sum, line) => sum + BigInt(line.debitMinor), 0n), journal.lines.reduce((sum, line) => sum + BigInt(line.creditMinor), 0n), 'Native accounting produces balanced journals');
  const pdf = await fetch(`${origin}${base}/accounting/invoices/${sale.id}/pdf`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(pdf.status, 200); assert.ok(pdf.headers.get('content-type').startsWith('application/pdf')); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  console.log('Verified native reviewed plan, expense, bag-priced stock reservation, unconfirmed service request, explicit simulator command, private motion acknowledgement, supplier posting, issued sales invoice, exact partial payments, currency summary, balanced journals and authenticated PDF generation. Native camera/gallery/file-picker and OS sharing are not asserted by this journey.');
  const discussions = await api(`${base}/forum/discussions?mine=true&search=Native%20shared%20farming%20notes`, null, session.token);
  assert.equal(discussions.items.length, 1, 'Native sharing creates exactly one reviewed discussion');
  const discussion = discussions.items[0];
  assert.equal(discussion.title, 'Native shared farming notes');
  assert.equal(discussion.body, 'Native reviewed forum note.');
  assert.equal(discussion.displayName, 'NativeForumGrower');
  assert.equal(discussion.version, 2, 'The native author edit is persisted once');
  const thread = await api(`${base}/forum/discussions/${discussion.id}`, null, session.token);
  assert.equal(thread.replies.items.length, 1, 'Native sharing creates exactly one reply');
  assert.equal(thread.replies.items[0].status, 'deleted', 'The native author explicitly removes the one reply after displaying it');
  assert.equal(thread.replies.items[0].body, '');
  assert.equal(thread.replies.items[0].displayName, '');
  const community = await api(`${base}/forum/discussions/${ids.forumId}`, null, session.token);
  assert.equal(community.discussion.displayName, 'CommunityGrower');
  const moderation = await api(`${base}/forum/discussions/${ids.forumModerationId}`, null, session.token);
  assert.equal(moderation.discussion.status, 'visible');
  assert.equal(moderation.discussion.version, 3, 'Native owner hides and restores reviewed content once each');
  assert.equal((await api(`${base}/forum/reports`, null, session.token)).items.length, 0, 'Owner review resolves the seeded report');
  const communityReports = (await api(`${sellerBase}/forum/reports`, null, seller.token)).items;
  assert.equal(communityReports.length, 1, 'Cross-farm report is sent to the content farm owners');
  assert.equal(communityReports[0].reason, 'privacy');
  assert.equal(communityReports[0].details, 'Native synthetic privacy review.');
  for (const field of ['reporter_id', 'reporterId', 'username', 'farm_id', 'farmId']) assert.equal(Object.hasOwn(communityReports[0], field), false, `Forum report must not disclose ${field}`);
  const neverShared = await api(`${base}/forum/discussions?mine=true&search=Native%20forum%20offline%20draft%20must%20stay%20unshared`, null, session.token);
  assert.equal(neverShared.items.length, 0, 'Failed offline forum publication must not replay after native restart and reconnect');
  for (const entry of [discussion, ...thread.replies.items, community.discussion]) {
    for (const field of ['farm_id', 'farmId', 'author_id', 'authorId', 'username', 'payload_hash']) assert.equal(Object.hasOwn(entry, field), false, `Forum must not disclose ${field}`);
  }
  console.log('Verified native reviewed plan, expense, bag-priced stock reservation, unconfirmed service request, explicit simulator command, and private motion acknowledgement.');
  console.log('Verified native forum topic/search, cross-farm reading/report privacy, one explicitly shared discussion, author edit/reply/removal, owner hide/restore, and no offline publication replay after restart.');
} else if (process.argv[2] === 'proxy') {
  createServer((incoming, outgoing) => {
    // Observe only finite route templates and response metadata, never private
    // request paths, query strings, headers, account IDs or record bodies.
    const path = (incoming.url || '').split('?')[0];
    const route = path === '/v1/sessions' || path === '/v1/farms' ? path
      : /^\/v1\/farms\/[0-9a-f-]{36}\/activities$/.test(path) ? '/v1/farms/:farmId/activities'
      : /^\/v1\/farms\/[0-9a-f-]{36}\/forum\/discussions$/.test(path) ? '/v1/farms/:farmId/forum/discussions'
      : 'other';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(incoming.method) ? incoming.method : 'OTHER';
    const started = performance.now();
    const observe = status => console.log('[native-proxy]', JSON.stringify({ timestamp: new Date().toISOString(), method, route, status, elapsedMs: Math.round(performance.now() - started) }));
    observe('pending');
    let recorded = false;
    const completed = () => { if (!recorded) { recorded = true; observe(outgoing.writableFinished ? outgoing.statusCode : 'closed'); } };
    outgoing.once('finish', completed);
    outgoing.once('close', completed);
    if (existsSync(process.env.NATIVE_OFFLINE_FLAG)) { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end('{"error":"network_error"}'); return; }
    const upstream = request(origin + incoming.url, { method: incoming.method, headers: incoming.headers }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
    upstream.on('error', () => { outgoing.writeHead(503); outgoing.end(); });
    incoming.pipe(upstream);
  }).listen(3001, '127.0.0.1', () => console.log('Native acceptance network proxy ready.'));
}
