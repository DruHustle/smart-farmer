export type CurrencyScale = 0 | 1 | 2 | 3;
export type InvoiceKind = 'purchase' | 'sale' | 'purchase_credit' | 'sale_credit';
export type InvoiceStatus = 'draft' | 'posted' | 'issued' | 'void';
export interface AccountingBusiness {
  legalName: string;
  tradingName: string;
  address: string;
  email: string;
  phone: string;
  registrationNumber: string;
  taxNumber: string;
}
export interface AccountingParty {
  name: string;
  address: string;
  email: string;
  phone: string;
  taxNumber: string;
}
export interface AccountingLineInput {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountMinor: string;
  taxRateBps: number;
  accountCode?: string;
  projectId?: string | null;
}
export interface AccountingLine extends AccountingLineInput {
  accountCode: string;
  projectId: string | null;
  netMinor: string;
  taxMinor: string;
  totalMinor: string;
}
export interface AccountingTotals {
  subtotalMinor: string;
  discountMinor: string;
  netMinor: string;
  taxMinor: string;
  totalMinor: string;
}
export interface AccountingInvoiceSnapshot {
  schemaVersion: 1;
  id: string;
  farmId: string;
  kind: InvoiceKind;
  number: string | null;
  reference: string;
  issuer: AccountingBusiness;
  party: AccountingParty;
  currency: string;
  minorUnit: CurrencyScale;
  issueDate: string;
  /** Recognition date for linked historical records; issueDate remains the document date. */
  postingDate?: string;
  dueDate: string | null;
  notes: string;
  terms: string;
  lines: AccountingLine[];
  totals: AccountingTotals;
  taxBreakdown: { rateBps: number; taxableMinor: string; taxMinor: string }[];
  rounding: 'line_half_up' | 'credit_proportional';
  documentId: string | null;
  sourceEntryId: string | null;
  correctsInvoiceId: string | null;
  finalizedAt: string | null;
}
export interface AccountingInvoiceDraft {
  id: string;
  kind: 'purchase' | 'sale';
  party: AccountingParty;
  currency: string;
  issueDate: string;
  dueDate?: string | null;
  reference?: string;
  notes?: string;
  terms?: string;
  documentId?: string | null;
  sourceEntryId?: string | null;
  lines: AccountingLineInput[];
}
export interface AccountingPayment {
  id: string;
  invoiceId: string;
  amountMinor: string;
  currency: string;
  paidOn: string;
  method: 'cash' | 'bank' | 'mobile_money' | 'other';
  reference: string;
  note: string;
  origin: 'accounting' | 'legacy';
  reversalOf: string | null;
  reversedBy: string | null;
  createdAt: string;
}
export interface AccountingInvoiceDetail extends AccountingInvoiceSnapshot {
  status: InvoiceStatus;
  version: number;
  paymentStatus: 'unpaid' | 'partial' | 'paid';
  paidMinor: string;
  creditedMinor: string;
  balanceMinor: string;
  snapshot: AccountingInvoiceSnapshot | null;
  preview: AccountingInvoiceSnapshot;
  payments: AccountingPayment[];
  credits: { id: string; number: string | null; totalMinor: string; status: InvoiceStatus }[];
  duplicateCandidates: { id: string; number: string | null; reference: string; partyName: string; totalMinor: string; currency: string; status: InvoiceStatus; reason: 'document' | 'supplier_reference' | 'source_entry' }[];
  history: { id: string; action: string; reason: string; actorId: string; at: string }[];
  createdAt: string;
  updatedAt: string;
}
export interface AccountingSettings {
  version: number;
  business: AccountingBusiness;
  defaultCurrency: string;
  invoicePrefix: string;
  nextNumber: number;
  taxRates: { name: string; rateBps: number }[];
  lockedThrough: string | null;
}
export interface AccountingCurrencySummary {
  currency: string;
  minorUnit: CurrencyScale;
  salesMinor: string;
  expensesMinor: string;
  taxCollectedMinor: string;
  taxOnPurchasesMinor: string;
  cashReceivedMinor: string;
  cashPaidMinor: string;
  receivableMinor: string;
  payableMinor: string;
  overdueReceivableMinor: string;
  overduePayableMinor: string;
}
export interface AccountingSummary {
  from: string | null;
  to: string | null;
  asOf: string;
  byCurrency: AccountingCurrencySummary[];
  draftCount: number;
  unlinkedLegacyEntries: number;
  scope: 'accounting_postings';
  exchangeRatesApplied: false;
}
export type AccountingAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface AccountingJournal {
  id: string;
  currency: string;
  minorUnit: CurrencyScale;
  postedOn: string;
  description: string;
  reason: string;
  sourceType: string;
  sourceId: string;
  reversalOf: string | null;
  reversedBy: string | null;
  lines: { accountCode: string; debitMinor: string; creditMinor: string; description: string; projectId: string | null }[];
}
export interface AccountingReports {
  summary: AccountingSummary;
  trialBalance: { currency: string; minorUnit: CurrencyScale; accounts: { code: string; name: string; type: AccountingAccountType; debitMinor: string; creditMinor: string; balanceMinor: string }[]; totalDebitMinor: string; totalCreditMinor: string }[];
  profitLoss: { currency: string; minorUnit: CurrencyScale; incomeMinor: string; expenseMinor: string; resultMinor: string }[];
  balanceSheet: { currency: string; minorUnit: CurrencyScale; assetsMinor: string; liabilitiesMinor: string; equityMinor: string }[];
  aging: { kind: 'purchase' | 'sale'; currency: string; minorUnit: CurrencyScale; currentMinor: string; days1To30Minor: string; days31To60Minor: string; days61To90Minor: string; over90Minor: string }[];
}
