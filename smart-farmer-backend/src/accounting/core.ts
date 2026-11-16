import type pg from 'pg';
import { ApiError } from '../context.js';
import { calculateLines } from './money.js';
import type { AccountingBusiness, AccountingInvoiceDetail, AccountingInvoiceSnapshot, AccountingPayment, AccountingSettings } from './types.js';

export type AccountingDb = pg.Pool | pg.PoolClient;
export const emptyBusiness: AccountingBusiness = { legalName: '', tradingName: '', address: '', email: '', phone: '', registrationNumber: '', taxNumber: '' };
export const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;
export const normalizeReference = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
export function settingsDto(row: any): AccountingSettings {
  return { version: row.version, business: row.business, defaultCurrency: row.default_currency, invoicePrefix: row.invoice_prefix, nextNumber: Number(row.next_number), taxRates: row.tax_rates, lockedThrough: row.locked_through ? String(row.locked_through).slice(0,10) : null };
}
export async function readSettings(db: AccountingDb, farmId: string, lock: '' | 'share' | 'update' = '') {
  const row = (await db.query(`SELECT *,locked_through::text AS locked_through FROM accounting_settings WHERE farm_id=$1${lock ? ` FOR ${lock.toUpperCase()}` : ''}`, [farmId])).rows[0];
  return row ? settingsDto(row) : null;
}
export async function requireSettings(db: AccountingDb, farmId: string, lock: '' | 'share' | 'update' = 'share') {
  const settings = await readSettings(db, farmId, lock);
  if (!settings) throw new ApiError('accounting_unconfigured', 409);
  return settings;
}
export async function invoiceRow(db: AccountingDb, farmId: string, id: string, lock = false) {
  const row = (await db.query(`SELECT *,issue_date::text AS issue_date,due_date::text AS due_date FROM accounting_invoices WHERE farm_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [farmId,id])).rows[0];
  if (!row) throw new ApiError('not_found',404);
  return row;
}
export function previewInvoice(row: any, settings: AccountingSettings | null): AccountingInvoiceSnapshot {
  if (row.snapshot) return row.snapshot;
  const input = row.content;
  const calculated = calculateLines(input.lines, row.minor_unit, row.kind.startsWith('purchase') ? '5000' : '4000');
  return {
    schemaVersion: 1, id: row.id, farmId: row.farm_id, kind: row.kind, number: row.number ?? null,
    reference: input.reference ?? '', issuer: settings?.business ?? emptyBusiness, party: input.party,
    currency: row.currency, minorUnit: row.minor_unit, issueDate: input.issueDate, postingDate: input.issueDate, dueDate: input.dueDate ?? null,
    notes: input.notes ?? '', terms: input.terms ?? '', ...calculated, rounding: 'line_half_up',
    documentId: row.document_id ?? null, sourceEntryId: row.source_entry_id ?? null,
    correctsInvoiceId: row.corrects_invoice_id ?? null, finalizedAt: row.finalized_at ? iso(row.finalized_at) : null,
  };
}
export async function invoiceBalances(db: AccountingDb, farmId: string, invoiceId: string, asOf: string | null = null) {
  const paid = (await db.query('SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM accounting_payments WHERE farm_id=$1 AND invoice_id=$2 AND ($3::date IS NULL OR paid_on<=$3)',[farmId,invoiceId,asOf])).rows[0].amount;
  const credited = (await db.query("SELECT COALESCE(sum(total_minor),0)::text AS amount FROM accounting_invoices WHERE farm_id=$1 AND corrects_invoice_id=$2 AND status IN('posted','issued') AND ($3::date IS NULL OR issue_date<=$3)",[farmId,invoiceId,asOf])).rows[0].amount;
  return { paid: BigInt(paid), credited: BigInt(credited) };
}
export async function duplicateCandidates(db: AccountingDb, row: any): Promise<AccountingInvoiceDetail['duplicateCandidates']> {
  const candidates = (await db.query(`SELECT id,number,content,currency,total_minor::text,status,document_id,source_entry_id FROM accounting_invoices
    WHERE farm_id=$1 AND id<>$2 AND status<>'void' AND kind IN('purchase','sale') AND
    (($3::uuid IS NOT NULL AND document_id=$3) OR ($4::uuid IS NOT NULL AND source_entry_id=$4) OR
     ($5='purchase' AND kind='purchase' AND $6<>'' AND $7<>'' AND supplier_key=$6 AND reference_key=$7))
    ORDER BY created_at DESC,id DESC LIMIT 25`,[row.farm_id,row.id,row.document_id,row.source_entry_id,row.kind,row.supplier_key,row.reference_key])).rows;
  return candidates.map(other => ({ id: other.id, number: other.number, reference: other.content.reference ?? '', partyName: other.content.party.name, totalMinor: other.total_minor, currency: other.currency, status: other.status,
    reason: row.document_id && other.document_id===row.document_id ? 'document' : row.source_entry_id && other.source_entry_id===row.source_entry_id ? 'source_entry' : 'supplier_reference' }));
}
export async function loadInvoiceDetail(db: AccountingDb, farmId: string, id: string): Promise<AccountingInvoiceDetail> {
  const row = await invoiceRow(db, farmId, id);
  const preview = previewInvoice(row, row.snapshot ? null : await readSettings(db,farmId));
  const { paid, credited } = await invoiceBalances(db,farmId,id);
  const regular = row.kind==='purchase' || row.kind==='sale';
  const outstanding = regular && row.finalized_at && row.status!=='void' ? BigInt(row.total_minor)-paid-credited : 0n;
  if (outstanding<0n) throw new ApiError('accounting_balance_invariant',500);
  const payments: AccountingPayment[] = (await db.query(`SELECT p.*,p.paid_on::text AS paid_on,(SELECT r.id FROM accounting_payments r WHERE r.reversal_of=p.id) AS reversed_by FROM accounting_payments p WHERE p.farm_id=$1 AND p.invoice_id=$2 ORDER BY p.paid_on,p.created_at,p.id`,[farmId,id])).rows.map(p => ({ id:p.id, invoiceId:id, amountMinor:p.amount_minor, currency:p.currency, paidOn:p.paid_on, method:p.method, reference:p.reference, note:p.note, origin:p.origin, reversalOf:p.reversal_of, reversedBy:p.reversed_by, createdAt:iso(p.created_at) }));
  const credits = (await db.query('SELECT id,number,total_minor::text AS "totalMinor",status FROM accounting_invoices WHERE farm_id=$1 AND corrects_invoice_id=$2 ORDER BY created_at,id',[farmId,id])).rows;
  const history = (await db.query("SELECT id,action,reason,actor_id AS \"actorId\",created_at FROM audit_events WHERE farm_id=$1 AND entity_type='accounting_invoice' AND entity_id=$2 ORDER BY created_at,id",[farmId,id])).rows.map(h=>({id:h.id,action:h.action,reason:h.reason,actorId:h.actorId,at:iso(h.created_at)}));
  return { ...preview, status:row.status, version:row.version,
    paymentStatus:row.finalized_at && row.status!=='void' && outstanding===0n ? 'paid' : paid>0n ? 'partial' : 'unpaid',
    paidMinor:paid.toString(),creditedMinor:credited.toString(),balanceMinor:outstanding.toString(),
    snapshot:row.snapshot ?? null, preview, payments, credits, duplicateCandidates:await duplicateCandidates(db,row), history,
    createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
  };
}
export function expectVersion(row: any, version: number) {
  if (row.version!==version) throw new ApiError('version_conflict',409,{details:{currentVersion:row.version}});
}
export function expectOpenPeriod(settings: AccountingSettings, postedOn: string) {
  if (settings.lockedThrough && postedOn<=settings.lockedThrough) throw new ApiError('period_locked',409,{details:{lockedThrough:settings.lockedThrough}});
}
