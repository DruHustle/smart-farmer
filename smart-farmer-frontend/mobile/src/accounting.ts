/** Independent mobile DTOs for docs/accounting-api.md. Amounts never use floating-point arithmetic. */
export type CurrencyScale = 0 | 1 | 2 | 3;
export type Currency = { code: string; minorUnit: CurrencyScale };
export type InvoiceKind = 'purchase' | 'sale' | 'purchase_credit' | 'sale_credit';
export type Party = { name: string; address: string; email: string; phone: string; taxNumber: string };
export type Business = Omit<Party, 'name'> & { legalName: string; tradingName: string; registrationNumber: string };
export type InvoiceLineInput = { id: string; description: string; quantity: string; unitPrice: string; discountMinor: string; taxRateBps: number; accountCode: string; projectId: string | null };
export type InvoiceLine = InvoiceLineInput & { netMinor: string; taxMinor: string; totalMinor: string };
export type InvoiceTotals = { subtotalMinor: string; discountMinor: string; netMinor: string; taxMinor: string; totalMinor: string };
export type InvoiceDraft = { id: string; kind: 'purchase' | 'sale'; party: Party; currency: string; issueDate: string; dueDate: string | null; reference: string; notes: string; terms: string; documentId: string | null; sourceEntryId: string | null; lines: InvoiceLineInput[] };
export type InvoiceSnapshot = Omit<InvoiceDraft, 'kind' | 'lines'> & { schemaVersion: 1; farmId: string; kind: InvoiceKind; number: string | null; issuer: Business; minorUnit: CurrencyScale; lines: InvoiceLine[]; totals: InvoiceTotals; taxBreakdown: { rateBps: number; taxableMinor: string; taxMinor: string }[]; rounding: 'line_half_up' | 'credit_proportional'; postingDate?: string; correctsInvoiceId: string | null; finalizedAt: string | null };
export type AccountingSource = { id: string; description: string; reference: string; postedOn: string; amountMinor: string | null; originalAmount: string; currency: string; minorUnit: CurrencyScale; sourceType: string; sourceId: string; alreadyInvoiced: boolean; invoiceId: string | null; eligible: boolean; eligibilityError: string | null; projects: { projectId: string | null; amountMinor: string | null; originalAmount: string }[] };
export type InvoicePayment = { id: string; invoiceId: string; amountMinor: string; currency: string; paidOn: string; method: 'cash' | 'bank' | 'mobile_money' | 'other'; reference: string; note: string; origin: 'accounting' | 'legacy'; reversalOf: string | null; reversedBy: string | null; createdAt: string };
export type Invoice = InvoiceSnapshot & { status: 'draft' | 'posted' | 'issued' | 'void'; version: number; paymentStatus: 'unpaid' | 'partial' | 'paid'; paidMinor: string; creditedMinor: string; balanceMinor: string; snapshot: InvoiceSnapshot | null; preview: InvoiceSnapshot; payments: InvoicePayment[]; credits: { id: string; number: string | null; totalMinor: string; status: string }[]; duplicateCandidates: { id: string; number: string | null; reference: string; partyName: string; totalMinor: string; currency: string; status: string; reason: string }[]; history: { id: string; action: string; reason: string; actorId: string; at: string }[]; createdAt: string; updatedAt: string };
export type AccountingSettings = { version: number; business: Business; defaultCurrency: string; invoicePrefix: string; nextNumber: number; taxRates: { name: string; rateBps: number }[]; lockedThrough: string | null };
export type SettingsResponse = { configured: boolean; settings: AccountingSettings | null; currencies: Currency[] };
export type Account = { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; system: boolean; active: boolean };
export type AccountingSummary = { from: string | null; to: string | null; asOf: string; byCurrency: ({ currency: string; minorUnit: CurrencyScale } & Record<'salesMinor' | 'expensesMinor' | 'taxCollectedMinor' | 'taxOnPurchasesMinor' | 'cashReceivedMinor' | 'cashPaidMinor' | 'receivableMinor' | 'payableMinor' | 'overdueReceivableMinor' | 'overduePayableMinor', string>)[]; draftCount: number; unlinkedLegacyEntries: number; scope: 'accounting_postings'; exchangeRatesApplied: false };
export type FinancialDocument = { id: string; farmId: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'; filename: string; sizeBytes: number; contentHash: string; state: 'queued' | 'processing' | 'ready' | 'failed'; extraction: { schemaVersion: 1; engine: 'local_tesseract' | 'pdf_text' | 'mixed'; language: 'eng'; pageCount: number; text: string; confidence: number | null; suggestions: { party: { name: string } | null; reference: string | null; issueDate: string | null; dueDate: string | null; currency: string | null; lines: { description: string; quantity: string; unitPrice: string }[]; reportedTotal: string | null }; warnings: string[] } | null; errorCode: string | null; attempts: number; createdAt: string; updatedAt: string };
export type EditableLine = Omit<InvoiceLineInput, 'discountMinor' | 'taxRateBps'> & { discountAmount: string; taxRateBps: number | null };
export type EditableInvoice = Omit<InvoiceDraft, 'lines'> & { lines: EditableLine[] };
/** Every new line requires an explicit tax choice, including an intentional zero rate. */
export function newInvoiceLine(kind: InvoiceDraft['kind'], id: string, projectId: string | null = null): EditableLine {
  return { id, description: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRateBps: null, accountCode: kind === 'purchase' ? '5000' : '4000', projectId };
}
export type Journal = { id: string; currency: string; minorUnit: CurrencyScale; postedOn: string; description: string; reason: string; sourceType: string; sourceId: string; reversalOf: string | null; reversedBy: string | null; lines: { accountCode: string; debitMinor: string; creditMinor: string; description: string; projectId?: string | null }[] };
export type AccountingReports = {
  summary: AccountingSummary;
  trialBalance: { currency: string; minorUnit: CurrencyScale; accounts: { code: string; name: string; type: Account['type']; debitMinor: string; creditMinor: string; balanceMinor: string }[]; totalDebitMinor: string; totalCreditMinor: string }[];
  profitLoss: { currency: string; minorUnit: CurrencyScale; incomeMinor: string; expenseMinor: string; resultMinor: string }[];
  balanceSheet: { currency: string; minorUnit: CurrencyScale; assetsMinor: string; liabilitiesMinor: string; equityMinor: string }[];
  aging: { kind: 'purchase' | 'sale'; currency: string; minorUnit: CurrencyScale; currentMinor: string; days1To30Minor: string; days31To60Minor: string; days61To90Minor: string; over90Minor: string }[];
};

export function journalLines(lines: { accountCode: string; debit: string; credit: string; description: string }[], scale: CurrencyScale): Journal['lines'] {
  if (lines.length < 2 || lines.length > 200) throw new Error('unbalanced_journal');
  let debit = 0n; let credit = 0n;
  const result = lines.map(line => {
    const debitMinor = toMinor(line.debit || '0', scale); const creditMinor = toMinor(line.credit || '0', scale);
    if (!line.accountCode || (BigInt(debitMinor) > 0n) === (BigInt(creditMinor) > 0n)) throw new Error('invalid_journal_line');
    debit += BigInt(debitMinor); credit += BigInt(creditMinor);
    return { accountCode: line.accountCode, debitMinor, creditMinor, description: line.description.trim(), projectId: null };
  });
  if (!debit || debit !== credit) throw new Error('unbalanced_journal');
  return result;
}

/** Persist the idempotency key before sending. An identical retry survives process death. */
export async function actionBody(repository: { formDraft<T>(farmId: string, key: string): Promise<T | null>; saveFormDraft(farmId: string, key: string, value: unknown): Promise<void> }, farmId: string, key: string, body: Record<string, unknown>, newId: () => string): Promise<Record<string, unknown>> {
  const storageKey = `accounting-action:${key}`;
  const saved = await repository.formDraft<{ id: string; body: string }>(farmId, storageKey);
  const serialized = JSON.stringify(body);
  if (saved && saved.body !== serialized) throw new Error('accounting_pending_review');
  const id = saved?.id || newId();
  await repository.saveFormDraft(farmId, storageKey, { id, body: serialized });
  return { ...body, id };
}

/** An unauthorized or interrupted replay cannot resolve an earlier lost response. */
export function definiteAccountingRejection(error: { status: number; code: string }): boolean {
  // Transaction retries can fail while acquiring locks, before the server checks the saved request.
  if (['invalid_response', 'idempotency_conflict', 'retry_transaction'].includes(error.code)) return false;
  return error.status === 400 || error.status === 422 || error.status === 409;
}

export function decimal(value: string, places = 6): string {
  const clean = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(clean) || clean.length > 40) throw new Error('invalid_amount');
  const [whole, fraction = ''] = clean.split('.');
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > places) throw new Error('amount_precision');
  return BigInt(whole!).toString() + (significant ? `.${significant}` : '');
}

export function toMinor(value: string, scale: CurrencyScale): string {
  if (![0, 1, 2, 3].includes(scale)) throw new Error('unsupported_currency');
  const [whole, fraction = ''] = decimal(value, scale).split('.');
  return (BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0')).toString();
}

export function fromMinor(value: string, scale: CurrencyScale): string {
  if (!/^-?\d+$/.test(value) || ![0, 1, 2, 3].includes(scale)) throw new Error('invalid_amount');
  const amount = BigInt(value); const negative = amount < 0n; const absolute = negative ? -amount : amount;
  const digits = absolute.toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

export function money(value: string, currency: string, scale: CurrencyScale): string { return `${currency} ${fromMinor(value, scale)}`; }
export function scaleFor(currencies: Currency[], code: string): CurrencyScale {
  const found = currencies.find(item => item.code === code);
  if (!found) throw new Error('unsupported_currency');
  return found.minorUnit;
}
export function calendarDate(value: string, required = true): string | null {
  if (!value && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('invalid_date');
  return value;
}
function six(value: string): bigint { const [whole, fraction = ''] = decimal(value).split('.'); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); }
function halfUp(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator / 2n) / denominator; }

/** Matches the documented line_half_up preview; the server remains authoritative. */
export function invoiceTotals(lines: InvoiceLineInput[], scale: CurrencyScale): InvoiceTotals {
  let subtotal = 0n; let discount = 0n; let tax = 0n;
  for (const line of lines) {
    const quantity = six(line.quantity); const price = six(line.unitPrice);
    if (quantity <= 0n || !/^\d+$/.test(line.discountMinor) || !Number.isInteger(line.taxRateBps) || line.taxRateBps < 0 || line.taxRateBps > 10000) throw new Error('invalid_amount');
    const gross = halfUp(quantity * price * 10n ** BigInt(scale), 1_000_000_000_000n);
    const reduction = BigInt(line.discountMinor);
    if (reduction > gross) throw new Error('discount_exceeds_line');
    subtotal += gross; discount += reduction;
    tax += halfUp((gross - reduction) * BigInt(line.taxRateBps), 10000n);
  }
  return { subtotalMinor: subtotal.toString(), discountMinor: discount.toString(), netMinor: (subtotal - discount).toString(), taxMinor: tax.toString(), totalMinor: (subtotal - discount + tax).toString() };
}

export function reviewedDraft(value: EditableInvoice, currencies: Currency[]): InvoiceDraft {
  const scale = scaleFor(currencies, value.currency);
  const issueDate = calendarDate(value.issueDate)!; const dueDate = calendarDate(value.dueDate || '', false);
  if (dueDate && dueDate < issueDate) throw new Error('invalid_date');
  if (!value.party.name.trim()) throw new Error('required');
  if (!value.lines.length || value.lines.length > 100) throw new Error('invoiceEmpty');
  const lines = value.lines.map(line => {
    if (!line.description.trim()) throw new Error('required');
    if (line.taxRateBps === null) throw new Error('tax_review_required');
    const { discountAmount, ...rest } = line;
    return { ...rest, taxRateBps: line.taxRateBps, description: line.description.trim(), quantity: decimal(line.quantity), unitPrice: decimal(line.unitPrice), discountMinor: toMinor(discountAmount || '0', scale), projectId: line.projectId || null };
  });
  invoiceTotals(lines, scale);
  return { ...value, party: Object.fromEntries(Object.entries(value.party).map(([key, item]) => [key, item.trim()])) as Party, issueDate, dueDate, reference: value.reference.trim(), notes: value.notes.trim(), terms: value.terms.trim(), lines };
}

export function editableInvoice(invoice: Invoice): EditableInvoice {
  if (invoice.kind !== 'purchase' && invoice.kind !== 'sale') throw new Error('invoice_not_draft');
  return { id: invoice.id, kind: invoice.kind, party: invoice.party, currency: invoice.currency, issueDate: invoice.issueDate, dueDate: invoice.dueDate, reference: invoice.reference, notes: invoice.notes, terms: invoice.terms, documentId: invoice.documentId, sourceEntryId: invoice.sourceEntryId, lines: invoice.lines.map(line => ({ id: line.id, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, discountAmount: fromMinor(line.discountMinor, invoice.minorUnit), taxRateBps: line.taxRateBps, accountCode: line.accountCode, projectId: line.projectId })) };
}

/** Extraction is untrusted input: missing amounts stay empty and never imply tax. */
export function extractionDraft(document: FinancialDocument, id: string, lineId: () => string, projectId: string | null = null): EditableInvoice {
  const suggestion = document.extraction?.suggestions;
  return { id, kind: 'purchase', party: { name: suggestion?.party?.name || '', address: '', email: '', phone: '', taxNumber: '' }, currency: suggestion?.currency || '', issueDate: suggestion?.issueDate || '', dueDate: suggestion?.dueDate || null, reference: suggestion?.reference || '', notes: '', terms: '', documentId: document.id, sourceEntryId: null, lines: (suggestion?.lines || []).map(line => ({ ...newInvoiceLine('purchase', lineId(), projectId), description: line.description, quantity: line.quantity, unitPrice: line.unitPrice })) };
}
