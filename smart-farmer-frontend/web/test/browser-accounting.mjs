/** Accounting journeys use the real PostgreSQL API, real worker and private files. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {farmDate} from '../src/lib/time.ts';

export async function accountingJourneys({page, context, browser, api, ui, apiCall, farm, project, token, sn, nd, unique, checkpoint, pass, artifacts, pace, watchContext, backend, startWorker}) {
  const base = `/v1/farms/${farm.id}/accounting`;
  const today = farmDate(new Date(), farm.timezone);
  const visible = locator => locator.waitFor({state: 'visible', timeout: 20000});
  const section = title => page.locator('section.panel').filter({has: page.getByRole('heading', {name: title, exact: true, level: 2})}).first();
  async function fill(parent, fields) {await pace(); for (const [name, value] of Object.entries(fields)) {const field = parent.locator(`[name="${name}"]`); const tag = await field.evaluate(el => el.tagName); if (tag === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));}}
  async function tab(title) {await pace(); await page.locator('.accounting-tabs').getByRole('button', {name: title, exact: true}).click();}
  async function expand(parent, title) {const details = parent.locator('details').filter({has: page.getByText(title, {exact: true})}).first(); const summary = details.locator(':scope > summary'); if (await details.getAttribute('open') === null) await summary.click(); return details;}
  async function submit(parent, path, {method = 'POST', title = sn.save} = {}) {
    await pace();
    const form = parent.locator('form').first();
    const handle = await form.elementHandle();
    assert.deepEqual(await form.evaluate(el => Array.from(el.elements).filter(field => 'validity' in field && !field.validity.valid).map(field => field.name)), [], `${path} accepts the explicit fixture inputs`);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method, {timeout: 20000});
    await form.getByRole('button', {name: title, exact: true}).click();
    const response = await pending, result = await response.json();
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
    await page.waitForFunction(el => !el?.isConnected || el.getAttribute('aria-busy') !== 'true', handle, {timeout: 20000});
    await handle.dispose();
    return result;
  }
  async function moreAccounting(p = page, words = sn) {const nav = await p.locator('.mobile-nav').isVisible() ? p.locator('.mobile-nav') : p.locator('.desktop-nav'); await nav.getByRole('button', {name: words.more, exact: true}).click(); await p.locator('.menu-panel').getByRole('button', {name: words.accounting, exact: true}).click();}
  async function newSale(reference, price = '10.00') {
    await tab(sn.salesInvoices); await page.getByRole('button', {name: sn.newSalesInvoice, exact: true}).click();
    const editor = section(sn.newSalesInvoice);
    await fill(editor, {partyName: 'Browser grain buyer', partyAddress: 'Isolated buyer fixture', reference, issueDate: today, dueDate: today, currency: 'USD'});
    const line = editor.locator('.invoice-line').first();
    await line.locator('input[name$="-description"]').fill('Farm produce');
    await line.locator('input[name$="-quantity"]').fill('1');
    await line.locator('input[name$="-unitPrice"]').fill(price);
    assert.equal(await line.locator('select[name$="-taxRateBps"]').inputValue(), '', 'tax must be explicitly selected');
    await line.locator('select[name$="-taxRateBps"]').selectOption('0');
    await line.locator('select[name$="-projectId"]').selectOption(project.id);
    return editor;
  }
  async function issue(id) {const approval = section(sn.issueSalesInvoice); await approval.locator('input[name="reviewed"]').check(); return submit(approval, `${base}/invoices/${id}/issue`, {title: sn.issueSalesInvoice});}
  async function recordPayment(id, amount, reference) {
    const detail = await expand(section(sn.invoicePayments), sn.recordInvoicePayment);
    await fill(detail, {amount, paidOn: today, method: 'bank', paymentReference: reference, paymentNote: 'Explicit isolated manual receipt'});
    await detail.locator('input[name="confirmed"]').check();
    return {detail, path: `${base}/invoices/${id}/payments`};
  }

  checkpoint('Accounting setup with explicit business identity, currency, numbering and tax');
  await moreAccounting(); await visible(page.getByRole('heading', {name: sn.accountingSetup, exact: true}));
  const setup = section(sn.accountingSetup);
  await fill(setup, {legalName: 'Browser Farm Accounting', tradingName: 'Accounting test fixture', address: 'Private isolated farm address', email: 'accounting@example.invalid', defaultCurrency: 'USD', invoicePrefix: `WEB${unique}`, startingNumber: '1000', reason: 'Owner-entered isolated bookkeeping setup'});
  await setup.getByRole('button', {name: sn.accountingAddTax, exact: true}).click();
  await setup.locator('input[name$="-name"]').fill('Fixture reviewed rate');
  await setup.locator('input[name$="-percentage"]').fill('15');
  await submit(setup, `${base}/settings`, {method: 'PUT'});
  const configuration = await apiCall(`${base}/settings`, undefined, token);
  assert.equal(configuration.settings.business.legalName, 'Browser Farm Accounting');
  assert.equal(configuration.settings.taxRates[0].rateBps, 1500);
  pass('Accounting setup requires explicit business facts, configured tax and currency; no identity inferred from the farm display name');

  checkpoint('Sales draft, server totals, reviewed issue and private draft PDF');
  let editor = await newSale(`PO-${unique}`, '10.05');
  let line = editor.locator('.invoice-line').first();
  await line.locator('input[name$="-quantity"]').fill('3');
  await line.locator('input[name$="-discount"]').fill('0.15');
  await line.locator('select[name$="-taxRateBps"]').selectOption('1500');
  await editor.getByRole('button', {name: sn.addInvoiceLine, exact: true}).click();
  line = editor.locator('.invoice-line').last();
  await line.locator('input[name$="-description"]').fill('Reusable produce crate');
  await line.locator('input[name$="-quantity"]').fill('1');
  await line.locator('input[name$="-unitPrice"]').fill('2.50');
  await line.locator('select[name$="-taxRateBps"]').selectOption('0');
  let invoice = await submit(editor, `${base}/invoices`, {title: sn.saveInvoiceDraft});
  const saleId = invoice.id;
  assert.equal(invoice.status, 'draft'); assert.equal(invoice.number, null); assert.equal(invoice.totals.totalMinor, '3700'); assert.equal(invoice.balanceMinor, '0');
  await visible(page.locator('.invoice-paper'));
  assert.ok((await page.locator('.invoice-paper').innerText()).includes('USD 37.00'));
  let download = page.waitForEvent('download', {timeout: 20000});
  await page.getByRole('button', {name: sn.invoicePreviewDownload, exact: true}).click();
  await (await download).saveAs(resolve(artifacts, 'accounting-sales-draft.pdf'));
  let issueRequests = 0;
  const countIssue = request => {if (new URL(request.url()).pathname === `${base}/invoices/${saleId}/issue` && request.method() === 'POST') issueRequests += 1;};
  page.on('request', countIssue);
  await section(sn.issueSalesInvoice).getByRole('button', {name: sn.issueSalesInvoice, exact: true}).click();
  assert.equal(issueRequests, 0, 'unchecked human review cannot issue an invoice');
  invoice = await issue(saleId); page.off('request', countIssue);
  assert.equal(invoice.status, 'issued'); assert.equal(invoice.snapshot.totals.totalMinor, '3700'); assert.ok(invoice.number.includes('1000'));
  assert.equal(await page.getByRole('button', {name: sn.editInvoiceDraft, exact: true}).count(), 0, 'issued invoice has no in-place edit action');
  download = page.waitForEvent('download', {timeout: 20000}); await page.getByRole('button', {name: sn.invoiceDownload, exact: true}).click(); await (await download).saveAs(resolve(artifacts, 'accounting-sales-issued.pdf'));
  pass('Sales draft calculates exact line discount/tax totals, remains unissued until human review, and produces distinct private draft/issued PDFs');

  checkpoint('Lost payment response reconciles exactly one partial payment');
  let payment = await recordPayment(saleId, '10.00', `PARTIAL-${unique}`);
  let lostResponse = true, paymentCalls = 0;
  const routePattern = `**${payment.path}`;
  const loseFirstResponse = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    paymentCalls += 1;
    if (lostResponse) {lostResponse = false; const realResponse = await route.fetch(); assert.ok(realResponse.ok()); await route.abort('failed');}
    else await route.continue();
  };
  await page.route(routePattern, loseFirstResponse);
  await payment.detail.getByRole('button', {name: sn.recordInvoicePayment, exact: true}).click();
  await visible(page.getByRole('button', {name: sn.accountingRetryOriginal, exact: true}));
  invoice = await apiCall(`${base}/invoices/${saleId}`, undefined, token); assert.equal(invoice.payments.length, 1); assert.equal(invoice.paidMinor, '1000');
  await payment.detail.locator('input[name="amount"]').fill('12.00');
  await payment.detail.getByRole('button', {name: sn.recordInvoicePayment, exact: true}).click();
  assert.equal(paymentCalls, 1, 'changed uncertain intent is not silently submitted with another UUID');
  const replay = page.waitForResponse(response => new URL(response.url()).pathname === payment.path && response.request().method() === 'POST', {timeout: 20000});
  await page.getByRole('button', {name: sn.accountingRetryOriginal, exact: true}).click(); assert.ok((await replay).ok());
  await page.unroute(routePattern, loseFirstResponse);
  await page.locator('.accounting-submit-state').waitFor({state: 'hidden', timeout: 20000});
  invoice = await apiCall(`${base}/invoices/${saleId}`, undefined, token); assert.equal(invoice.payments.length, 1); assert.equal(invoice.paidMinor, '1000'); assert.equal(invoice.balanceMinor, '2700');
  payment = await recordPayment(saleId, '27.00', `FINAL-${unique}`); invoice = await submit(payment.detail, payment.path, {title: sn.recordInvoicePayment}); assert.equal(invoice.paymentStatus, 'paid'); assert.equal(invoice.balanceMinor, '0');
  pass('A real committed payment with its first response dropped replays one unchanged intent; explicit partial/final payments settle the invoice once');

  checkpoint('Payment correction and linked credit preserve original invoice history');
  const firstPayment = invoice.payments.find(item => item.reference === `PARTIAL-${unique}`);
  const paymentCard = page.locator('.invoice-payment').filter({hasText: `PARTIAL-${unique}`});
  const correction = await expand(paymentCard, sn.invoiceCorrection);
  await fill(correction, {reverseDate: today, reverseReason: 'Wrong payment reference in isolated fixture'}); await correction.locator('input[name="confirmed"]').check();
  invoice = await submit(correction, `${base}/invoices/${saleId}/payments/${firstPayment.id}/reverse`, {title: sn.invoiceCorrection});
  assert.equal(invoice.paidMinor, '2700'); assert.equal(invoice.balanceMinor, '1000'); assert.ok(invoice.payments.some(item => item.reversalOf === firstPayment.id));
  const credit = await expand(section(sn.invoiceCreditNotes), sn.invoiceCredit);
  await fill(credit, {creditAmount: '10.00', creditDate: today, creditReason: 'Reviewed invoice allowance, isolated fixture'}); await credit.locator('input[name="confirmed"]').check();
  const creditInvoice = await submit(credit, `${base}/invoices/${saleId}/credits`, {title: sn.invoiceCredit});
  assert.equal(creditInvoice.kind, 'sale_credit'); assert.equal(creditInvoice.correctsInvoiceId, saleId);
  invoice = await apiCall(`${base}/invoices/${saleId}`, undefined, token); assert.equal(invoice.snapshot.totals.totalMinor, '3700'); assert.equal(invoice.creditedMinor, '1000'); assert.equal(invoice.balanceMinor, '0');
  pass('Payment reversal and issued credit retain the original payment, immutable invoice snapshot and linked correction history');

  checkpoint('Retained cancellation of an unposted draft');
  editor = await newSale(`DISCARD-${unique}`);
  const cancelledDraft = await submit(editor, `${base}/invoices`, {title: sn.saveInvoiceDraft});
  const voidForm = await expand(section(sn.invoiceCancel), sn.invoiceCancel);
  await fill(voidForm, {voidReason: 'Draft entered for the wrong customer, isolated fixture'}); await voidForm.locator('input[name="confirmed"]').check();
  const voided = await submit(voidForm, `${base}/invoices/${cancelledDraft.id}/void`, {title: sn.invoiceCancel});
  assert.equal(voided.status, 'void'); assert.equal(voided.number, null); assert.equal(voided.snapshot, null); assert.ok(voided.history.length >= 2);
  pass('Cancelling an unposted draft retains its history without allocating a number or creating a financial obligation');

  checkpoint('Independent currency precision on another sales invoice');
  editor = await newSale(`JPY-${unique}`, '1000');
  await editor.locator('select[name="currency"]').selectOption('JPY');
  const yenDraft = await submit(editor, `${base}/invoices`, {title: sn.saveInvoiceDraft});
  assert.equal(yenDraft.minorUnit, 0); assert.equal(yenDraft.totals.totalMinor, '1000');
  const yenInvoice = await issue(yenDraft.id); assert.equal(yenInvoice.currency, 'JPY'); assert.equal(yenInvoice.balanceMinor, '1000');

  checkpoint('Actual asynchronous supplier PDF scan, review and expense posting');
  const requireBackend = createRequire(resolve(backend, 'package.json'));
  const PDFDocument = requireBackend('pdfkit');
  const pdf = new PDFDocument({size: 'A4'}), chunks = [];
  const bytesPromise = new Promise((resolveBytes, reject) => {pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolveBytes(Buffer.concat(chunks))); pdf.on('error', reject);});
  pdf.fontSize(16).text(`Supplier: Browser Feed Supplier\nInvoice No: SUP-${unique}\nDate: ${today}\nDescription Qty Unit price Amount\nPoultry feed 2 12.50 25.00\nTotal USD 25.00`); pdf.end(); const bytes = await bytesPromise;
  await tab(sn.supplierInvoices);
  const upload = section(sn.newSupplierInvoice);
  assert.equal(await upload.locator('input[name="camera"]').getAttribute('capture'), 'environment');
  await upload.locator('input[name="invoiceFile"]').setInputFiles({name: 'supplier-invoice.pdf', mimeType: 'application/pdf', buffer: bytes});
  const before = await apiCall(`${base}/summary`, undefined, token);
  const uploaded = await submit(upload, `${base}/documents`, {title: sn.uploadInvoice});
  const documentId = uploaded.document.id;
  let worker = startWorker();
  try {
    await page.getByText(sn.extractionReady, {exact: true}).waitFor({state: 'visible', timeout: 30000});
    const document = (await apiCall(`${base}/documents/${documentId}`, undefined, token)).document;
    assert.equal(document.state, 'ready'); assert.equal(document.extraction.engine, 'pdf_text'); assert.equal(document.extraction.suggestions.reference, `SUP-${unique}`);
    assert.deepEqual((await apiCall(`${base}/summary`, undefined, token)).byCurrency, before.byCurrency, 'scanning alone cannot post expense or change books');
    await page.getByRole('button', {name: sn.useExtractedDraft, exact: true}).click();
    editor = section(sn.newSupplierInvoice);
    assert.equal(await editor.locator('input[name="partyName"]').inputValue(), 'Browser Feed Supplier');
    assert.equal(await editor.locator('input[name="reference"]').inputValue(), `SUP-${unique}`);
    assert.equal(await editor.locator('select[name="currency"]').inputValue(), 'USD');
    line = editor.locator('.invoice-line').first();
    assert.equal(await line.locator('select[name$="-taxRateBps"]').inputValue(), '', 'OCR must not invent a tax rate');
    await line.locator('input[name$="-quantity"]').fill('3');
    await line.locator('select[name$="-taxRateBps"]').selectOption('0');
    const purchaseDraft = await submit(editor, `${base}/invoices`, {title: sn.saveInvoiceDraft});
    assert.equal(purchaseDraft.totals.totalMinor, '3750'); assert.equal(purchaseDraft.documentId, documentId); assert.equal(purchaseDraft.status, 'draft');
    assert.deepEqual((await apiCall(`${base}/summary`, undefined, token)).byCurrency, before.byCurrency, 'a reviewed but unposted draft cannot create an expense');
    const post = section(sn.postSupplierInvoice); await post.locator('input[name="reviewed"]').check();
    const purchase = await submit(post, `${base}/invoices/${purchaseDraft.id}/post`, {title: sn.postSupplierInvoice});
    assert.equal(purchase.status, 'posted'); assert.equal(purchase.balanceMinor, '3750'); assert.equal(purchase.snapshot.totals.totalMinor, '3750');
    const receipt = await recordPayment(purchase.id, '12.50', `SUPPLIER-PAY-${unique}`); const paidPurchase = await submit(receipt.detail, receipt.path, {title: sn.recordInvoicePayment}); assert.equal(paidPurchase.balanceMinor, '2500');
    const original = await fetch(`${api}${base}/documents/${documentId}/content`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000)});
    assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control')?.includes('no-store'), true); assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    pass('Real PDF extraction preserves the private original, requires explicit human tax/quantity review, and posts one payable only after confirmation');

    checkpoint('Failed scan remains private evidence for explicit manual review');
    await tab(sn.supplierInvoices);
    const failedUpload = section(sn.newSupplierInvoice);
    await failedUpload.locator('input[name="invoiceFile"]').setInputFiles({name: 'unreadable-supplier.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic unreadable fixture\n%%EOF')});
    const failedDocument = await submit(failedUpload, `${base}/documents`, {title: sn.uploadInvoice});
    await page.getByText(sn.extractionFailed, {exact: true}).waitFor({state: 'visible', timeout: 30000});
    await page.getByRole('button', {name: sn.manualInvoice, exact: true}).click();
    editor = section(sn.newSupplierInvoice);
    assert.equal(await editor.locator('input[name="partyName"]').inputValue(), '');
    assert.equal(await editor.locator('input[name="issueDate"]').inputValue(), '');
    assert.equal(await editor.locator('select[name="currency"]').inputValue(), '', 'failed OCR cannot borrow the farm default as a claimed invoice currency');
    await fill(editor, {partyName: 'Manual source supplier', reference: `MANUAL-${unique}`, issueDate: today, currency: 'USD'});
    line = editor.locator('.invoice-line').first();
    await line.locator('input[name$="-description"]').fill('Manually reviewed supplies'); await line.locator('input[name$="-quantity"]').fill('1'); await line.locator('input[name$="-unitPrice"]').fill('5.00'); await line.locator('select[name$="-taxRateBps"]').selectOption('0');
    const manualDraft = await submit(editor, `${base}/invoices`, {title: sn.saveInvoiceDraft});
    assert.equal(manualDraft.documentId, failedDocument.document.id);
    const manualPost = section(sn.postSupplierInvoice); await manualPost.locator('input[name="reviewed"]').check();
    const manuallyPosted = await submit(manualPost, `${base}/invoices/${manualDraft.id}/post`, {title: sn.postSupplierInvoice});
    const finalVoid = await expand(section(sn.invoiceCancel), sn.invoiceCancel); await fill(finalVoid, {voidReason: 'Retained correction of the isolated manual fixture'}); await finalVoid.locator('input[name="confirmed"]').check();
    const voidedPurchase = await submit(finalVoid, `${base}/invoices/${manualDraft.id}/void`, {title: sn.invoiceCancel});
    assert.equal(voidedPurchase.status, 'void'); assert.deepEqual(voidedPurchase.snapshot, manuallyPosted.snapshot); assert.equal(voidedPurchase.balanceMinor, '0');
    pass('Failed OCR leaves business facts blank, supports reviewed manual entry with retained source, and preserves a finalized snapshot on explained void');
  } finally {worker.kill('SIGTERM');}

  checkpoint('Accounting role protection, per-currency reports, exports and responsive accessibility');
  const otherIdentity = await apiCall('/v1/sessions', {username: `web_worker_${unique}`, password: 'worker-browser-password-2026'});
  for (const path of [`${base}/summary`, `${base}/invoices/${saleId}`, `${base}/documents/${documentId}/content`, `${base}/invoices/${saleId}/pdf`]) {
    const denied = await fetch(api + path, {headers: {Authorization: `Bearer ${otherIdentity.token}`}, signal: AbortSignal.timeout(10000)}); assert.equal(denied.status, 404, `nonfinancial role denied ${path}`);
  }
  const otherContext = await browser.newContext({viewport: {width: 390, height: 844}}); watchContext(otherContext);
  try {const other = await otherContext.newPage(); await other.goto(ui); await other.getByLabel(sn.username, {exact: true}).fill(`web_worker_${unique}`); await other.getByLabel(sn.password, {exact: true}).fill('worker-browser-password-2026'); await other.getByRole('button', {name: sn.continue, exact: true}).click(); await visible(other.locator('.farm-switch')); await other.locator('.language-select').selectOption('sn'); await other.locator('.mobile-nav').getByRole('button', {name: sn.more, exact: true}).click(); assert.equal(await other.locator('.menu-panel').getByRole('button', {name: sn.accounting, exact: true}).count(), 0);} finally {await otherContext.close();}
  await tab(sn.invoiceReports);
  const manual = await expand(section(sn.accountingManualJournal), sn.accountingManualJournal);
  await fill(manual, {currency: 'USD', postedOn: today, description: `Opening cash ${unique}`, reason: 'Owner-reviewed opening cash fixture'});
  const journalLines = manual.locator('.accounting-journal-lines > fieldset');
  await journalLines.nth(0).locator('select[name$="-account"]').selectOption('1000');
  await journalLines.nth(0).locator('input[name$="-debit"]').fill('50.00');
  await journalLines.nth(1).locator('select[name$="-account"]').selectOption('3000');
  await journalLines.nth(1).locator('input[name$="-credit"]').fill('50.00');
  await manual.locator('input[name="confirmed"]').check();
  await submit(manual, `${base}/journals`, {title: sn.accountingManualJournal});
  const ledger = await apiCall(`${base}/ledger`, undefined, token);
  const opening = ledger.items.find(item => item.description === `Opening cash ${unique}`); assert.ok(opening);
  assert.equal(opening.lines.reduce((sum, item) => sum + BigInt(item.debitMinor) - BigInt(item.creditMinor), 0n), 0n);
  const journalDetails = section(sn.accountingLedger).locator('details.record-card').filter({hasText: `Opening cash ${unique}`});
  await journalDetails.locator(':scope > summary').click();
  const reverseJournal = await expand(journalDetails, sn.accountingReverseJournal);
  await fill(reverseJournal, {postedOn: today, reason: 'Reverse isolated opening journal after inspection'}); await reverseJournal.locator('input[name="confirmed"]').check();
  await submit(reverseJournal, `${base}/journals/${opening.id}/reverse`, {title: sn.accountingReverseJournal});
  download = page.waitForEvent('download', {timeout: 20000}); await page.getByRole('button', {name: sn.accountingExportInvoices, exact: true}).click(); await (await download).saveAs(resolve(artifacts, 'accounting-invoices.csv'));
  download = page.waitForEvent('download', {timeout: 20000}); await page.getByRole('button', {name: sn.accountingExportLedger, exact: true}).click(); await (await download).saveAs(resolve(artifacts, 'accounting-ledger.csv'));
  const summary = await apiCall(`${base}/summary`, undefined, token); assert.equal(summary.exchangeRatesApplied, false); assert.equal(summary.scope, 'accounting_postings'); assert.ok(summary.unlinkedLegacyEntries > 0); assert.deepEqual(summary.byCurrency.map(item => item.currency).sort(), ['JPY', 'USD']); assert.equal(summary.byCurrency.find(item => item.currency === 'JPY').receivableMinor, '1000');
  const reports = await apiCall(`${base}/reports`, undefined, token); for (const row of reports.trialBalance) assert.equal(row.totalDebitMinor, row.totalCreditMinor); for (const row of reports.balanceSheet) assert.equal(BigInt(row.assetsMinor), BigInt(row.liabilitiesMinor) + BigInt(row.equityMinor));
  await tab(sn.salesInvoices); await page.locator('.invoice-list-row').filter({hasText: `PO-${unique}`}).getByRole('button', {name: sn.review, exact: true}).click(); await visible(page.locator('.invoice-paper'));
  for (const [width, height, name] of [[320, 740, 'small-phone'], [768, 1024, 'tablet'], [1280, 900, 'desktop']]) {
    await page.setViewportSize({width, height}); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} invoice must not overflow the page`);
    await page.screenshot({path: resolve(artifacts, `accounting-${name}-sn.png`), fullPage: true});
    const axe = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); await writeFile(resolve(artifacts, `axe-accounting-${name}-sn.json`), JSON.stringify(axe, null, 2)); assert.deepEqual(axe.violations.map(item => ({id: item.id, nodes: item.nodes.map(node => node.target)})), []);
  }
  await page.getByLabel(sn.language, {exact: true}).selectOption('nd'); await visible(page.getByRole('heading', {name: nd.accounting, exact: true}));
  const axeNd = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); assert.deepEqual(axeNd.violations.map(item => item.id), []);
  await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement !== document.body));
  await page.getByLabel(nd.language, {exact: true}).selectOption('sn'); await page.setViewportSize({width: 390, height: 844});
  pass('Accounting protects records/documents from nonfinancial roles, exports explicit currencies and passes Shona/Ndebele keyboard/axe checks at phone, tablet and desktop widths');
  // Restore the baseline harness's final notification evidence page.
  const nav = page.locator('.mobile-nav'); await nav.getByRole('button', {name: sn.more, exact: true}).click(); await page.locator('.menu-panel').getByRole('button', {name: sn.notifications, exact: true}).click();
}
