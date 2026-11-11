export type InvoiceExtraction = {
  schemaVersion: 1;
  engine: 'local_tesseract' | 'pdf_text' | 'mixed';
  language: 'eng';
  pageCount: number;
  text: string;
  confidence: number | null;
  suggestions: {
    party: {name: string} | null;
    reference: string | null;
    issueDate: string | null;
    dueDate: string | null;
    currency: string | null;
    lines: Array<{description: string; quantity: string; unitPrice: string}>;
    reportedTotal: string | null;
  };
  warnings: string[];
};

export type InvoiceDocument = {
  id: string;
  farmId: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  contentHash: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  extraction: InvoiceExtraction | null;
  errorCode: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

// Independent client DTOs; keep aligned with backend docs/accounting-api.md.
export type CurrencyScale = 0 | 1 | 2 | 3;
export type InvoiceKind = 'purchase' | 'sale' | 'purchase_credit' | 'sale_credit';
export type InvoiceStatus = 'draft' | 'posted' | 'issued' | 'void';
export type AccountingBusiness = {legalName: string; tradingName: string; address: string; email: string; phone: string; registrationNumber: string; taxNumber: string};
export type AccountingParty = {name: string; address: string; email: string; phone: string; taxNumber: string};
export type AccountingLineInput = {id: string; description: string; quantity: string; unitPrice: string; discountMinor: string; taxRateBps: number; accountCode?: string; projectId?: string | null};
export type AccountingLine = AccountingLineInput & {accountCode: string; projectId: string | null; netMinor: string; taxMinor: string; totalMinor: string};
export type AccountingTotals = {subtotalMinor: string; discountMinor: string; netMinor: string; taxMinor: string; totalMinor: string};
export type AccountingInvoiceSnapshot = {
  schemaVersion: 1; id: string; farmId: string; kind: InvoiceKind; number: string | null; reference: string;
  issuer: AccountingBusiness; party: AccountingParty; currency: string; minorUnit: CurrencyScale;
  issueDate: string; postingDate?: string; dueDate: string | null; notes: string; terms: string; lines: AccountingLine[];
  totals: AccountingTotals; taxBreakdown: Array<{rateBps: number; taxableMinor: string; taxMinor: string}>;
  rounding: 'line_half_up' | 'credit_proportional'; documentId: string | null; sourceEntryId: string | null;
  correctsInvoiceId: string | null; finalizedAt: string | null;
};
export type AccountingInvoiceDraft = {
  id: string; kind: 'purchase' | 'sale'; party: AccountingParty; currency: string; issueDate: string;
  dueDate?: string | null; reference?: string; notes?: string; terms?: string;
  documentId?: string | null; sourceEntryId?: string | null; lines: AccountingLineInput[];
};
export type AccountingPayment = {id: string; invoiceId: string; amountMinor: string; currency: string; paidOn: string; method: 'cash' | 'bank' | 'mobile_money' | 'other'; reference: string; note: string; origin: 'accounting' | 'legacy'; reversalOf: string | null; reversedBy: string | null; createdAt: string};
export type AccountingInvoiceDetail = AccountingInvoiceSnapshot & {
  status: InvoiceStatus; version: number; paymentStatus: 'unpaid' | 'partial' | 'paid';
  paidMinor: string; creditedMinor: string; balanceMinor: string;
  snapshot: AccountingInvoiceSnapshot | null; preview: AccountingInvoiceSnapshot;
  payments: AccountingPayment[];
  credits: Array<{id: string; number: string | null; totalMinor: string; status: InvoiceStatus}>;
  duplicateCandidates: Array<{id: string; number: string | null; reference: string; partyName: string; totalMinor: string; currency: string; status: InvoiceStatus; reason: 'document' | 'supplier_reference' | 'source_entry'}>;
  history: Array<{id: string; action: string; reason: string; actorId: string; at: string}>;
  createdAt: string; updatedAt: string;
};
export type AccountingSettings = {version: number; business: AccountingBusiness; defaultCurrency: string; invoicePrefix: string; nextNumber: number; taxRates: Array<{name: string; rateBps: number}>; lockedThrough: string | null};
export type SettingsResponse = {configured: boolean; settings: AccountingSettings | null; currencies: Array<{code: string; minorUnit: CurrencyScale}>};
export type AccountingCurrencySummary = {
  currency: string; minorUnit: CurrencyScale; salesMinor: string; expensesMinor: string;
  taxCollectedMinor: string; taxOnPurchasesMinor: string; cashReceivedMinor: string; cashPaidMinor: string;
  receivableMinor: string; payableMinor: string; overdueReceivableMinor: string; overduePayableMinor: string;
};
export type AccountingSummary = {from: string | null; to: string | null; asOf: string; byCurrency: AccountingCurrencySummary[]; draftCount: number; unlinkedLegacyEntries: number; scope: 'accounting_postings'; exchangeRatesApplied: false};
export type AccountingAccount = {code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; system: boolean; active: boolean};
export type AccountingReportsResponse = {
  summary: AccountingSummary;
  trialBalance: Array<{currency: string; minorUnit: CurrencyScale; accounts: Array<{code: string; name: string; type: AccountingAccount['type']; debitMinor: string; creditMinor: string; balanceMinor: string}>; totalDebitMinor: string; totalCreditMinor: string}>;
  profitLoss: Array<{currency: string; minorUnit: CurrencyScale; incomeMinor: string; expenseMinor: string; resultMinor: string}>;
  balanceSheet: Array<{currency: string; minorUnit: CurrencyScale; assetsMinor: string; liabilitiesMinor: string; equityMinor: string}>;
  aging: Array<{kind: 'purchase' | 'sale'; currency: string; minorUnit: CurrencyScale; currentMinor: string; days1To30Minor: string; days31To60Minor: string; days61To90Minor: string; over90Minor: string}>;
};
export type AccountingJournal = {
  id: string; currency: string; minorUnit: CurrencyScale; postedOn: string; description: string; reason: string;
  sourceType: string; sourceId: string | null; reversalOf: string | null; reversedBy: string | null;
  lines: Array<{accountCode: string; debitMinor: string; creditMinor: string; description: string; projectId: string | null}>;
};
