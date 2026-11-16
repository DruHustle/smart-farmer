import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from '../context.js';
import { decimalFromMinor, decimalScaled } from './money.js';
import type { AccountingInvoiceSnapshot } from './types.js';
import type { AccountingDb } from './core.js';

/** Only call for a farm whose private financial records the caller may already read. */
export async function managedSourceBalance(db:AccountingDb,farmId:string,sourceType:string,sourceId:string){
  const invoice=(await db.query(`SELECT i.id,i.minor_unit,i.total_minor::text,i.status,
    COALESCE((SELECT sum(p.amount_minor) FROM accounting_payments p WHERE p.farm_id=i.farm_id AND p.invoice_id=i.id),0)::text AS paid,
    COALESCE((SELECT sum(cr.total_minor) FROM accounting_invoices cr WHERE cr.farm_id=i.farm_id AND cr.corrects_invoice_id=i.id AND cr.status IN('posted','issued')),0)::text AS credited
    FROM accounting_invoices i JOIN financial_entries f ON f.farm_id=i.farm_id AND f.id=i.source_entry_id
    WHERE i.farm_id=$1 AND i.finalized_at IS NOT NULL AND i.status<>'void' AND f.source_type=$2 AND f.source_id=$3 LIMIT 1`,[farmId,sourceType,sourceId])).rows[0];
  if(!invoice)return null;
  const balance=BigInt(invoice.total_minor)-BigInt(invoice.paid)-BigInt(invoice.credited);
  if(balance<0n)throw new ApiError('accounting_balance_invariant',500);
  return {accountingInvoiceId:invoice.id as string,accountingManaged:true as const,accountingBalanceMinor:balance.toString(),paid:decimalFromMinor(invoice.paid,invoice.minor_unit),credited:decimalFromMinor(invoice.credited,invoice.minor_unit),balance:decimalFromMinor(balance,invoice.minor_unit)};
}

export async function lockAccountingSource(c:PoolClient,farmId:string,sourceType:string,sourceId:string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`accounting-source:${farmId}:${sourceType}:${sourceId}`]);
}
/** Called before an operational source row is locked, preventing lock-order inversion. */
export async function guardAccountingSource(c:PoolClient,farmId:string,sourceType:string,sourceId:string,includeInvoiceId=true) {
  await lockAccountingSource(c,farmId,sourceType,sourceId);
  const managed=(await c.query(`SELECT i.id FROM accounting_invoices i JOIN financial_entries f ON f.farm_id=i.farm_id AND f.id IN(i.source_entry_id,i.financial_entry_id)
    WHERE i.farm_id=$1 AND f.source_type=$2 AND f.source_id=$3 AND i.finalized_at IS NOT NULL LIMIT 1`,[farmId,sourceType,sourceId])).rows[0];
  if(managed)throw new ApiError('invoice_managed_source',409,includeInvoiceId?{details:{invoiceId:managed.id}}:undefined);
}
export async function guardAccountingEntry(c:PoolClient,farmId:string,entryId:string) {
  const entry=(await c.query('SELECT source_type,source_id FROM financial_entries WHERE farm_id=$1 AND id=$2',[farmId,entryId])).rows[0];
  if(entry)await guardAccountingSource(c,farmId,entry.source_type,entry.source_id);
}
export async function linkedSource(c:PoolClient,snapshot:AccountingInvoiceSnapshot) {
  if(!snapshot.sourceEntryId)return null;
  const prior=(await c.query('SELECT source_type,source_id FROM financial_entries WHERE farm_id=$1 AND id=$2',[snapshot.farmId,snapshot.sourceEntryId])).rows[0];
  if(!prior)throw new ApiError('not_found',404);
  await lockAccountingSource(c,snapshot.farmId,prior.source_type,prior.source_id);
  const entry=(await c.query('SELECT f.*,(f.observed_at AT TIME ZONE farm.timezone)::date::text AS posted_on FROM financial_entries f JOIN farms farm ON farm.id=f.farm_id WHERE f.farm_id=$1 AND f.id=$2 FOR UPDATE OF f',[snapshot.farmId,snapshot.sourceEntryId])).rows[0];
  const expected=snapshot.kind==='sale'?'revenue':'expense';
  if(entry.kind!==expected || Number(entry.amount)<=0 || ['accounting_invoice','accounting_payment','record_correction'].includes(entry.source_type) || entry.currency!==snapshot.currency || decimalScaled(entry.amount,snapshot.minorUnit)!==BigInt(snapshot.totals.totalMinor))throw new ApiError('source_mismatch',409);
  if((await c.query(`SELECT 1 FROM financial_corrections WHERE farm_id=$1 AND entry_id=$2 UNION ALL SELECT 1 FROM activity_corrections WHERE farm_id=$1 AND $4='activity' AND activity_id=$3 AND action='reverse'`,[snapshot.farmId,entry.id,entry.source_id,entry.source_type])).rowCount)throw new ApiError('source_mismatch',409);
  const managed=(await c.query("SELECT id FROM accounting_invoices WHERE farm_id=$1 AND source_entry_id=$2 AND finalized_at IS NOT NULL AND status<>'void'",[snapshot.farmId,entry.id])).rows[0];
  if(managed)throw new ApiError('source_already_invoiced',409,{details:{invoiceId:managed.id}});
  const expectedProjects=new Map<string|null,bigint>([[entry.project_id,BigInt(snapshot.totals.totalMinor)]]);
  for(const allocation of (await c.query('SELECT project_id,amount::text FROM expense_allocations WHERE farm_id=$1 AND entry_id=$2 AND reversed_at IS NULL',[snapshot.farmId,entry.id])).rows){
    const amount=decimalScaled(allocation.amount,snapshot.minorUnit);
    expectedProjects.set(entry.project_id,(expectedProjects.get(entry.project_id)??0n)-amount);
    expectedProjects.set(allocation.project_id,(expectedProjects.get(allocation.project_id)??0n)+amount);
  }
  const actualProjects=new Map<string|null,bigint>();
  for(const line of snapshot.lines)actualProjects.set(line.projectId,(actualProjects.get(line.projectId)??0n)+BigInt(line.totalMinor));
  if([...new Set([...expectedProjects.keys(),...actualProjects.keys()])].some(project=>(expectedProjects.get(project)??0n)!==(actualProjects.get(project)??0n)))throw new ApiError('source_project_mismatch',409);
  snapshot.postingDate=entry.posted_on;
  return entry;
}
export async function legacyCashEntries(c:PoolClient,farmId:string,source:any) {
  const kind=source.kind==='revenue'?'payment':'cash_out';
  return (await c.query(`SELECT cash.*, (cash.observed_at AT TIME ZONE farm.timezone)::date::text AS paid_on FROM financial_entries cash JOIN farms farm ON farm.id=cash.farm_id
    WHERE cash.farm_id=$1 AND cash.kind=$2 AND (
      (cash.source_type=$3 AND cash.source_id=$4) OR
      ($3='animal_event' AND cash.source_type='manual_animal_payment' AND EXISTS(SELECT 1 FROM manual_payment_records p WHERE p.revenue_id=$5 AND p.id=cash.source_id)) OR
      ($3='market_order' AND cash.source_type='manual_market_payment' AND EXISTS(SELECT 1 FROM commerce_payments p WHERE p.order_id=$4 AND p.id=cash.source_id)) OR
      ($3='service_booking' AND cash.source_type IN('manual_service_payment','manual_service_refund') AND EXISTS(SELECT 1 FROM service_payment_records p WHERE p.booking_id=$4 AND p.id=cash.source_id AND p.status='recorded'))
    ) ORDER BY cash.observed_at,cash.id`,[farmId,kind,source.source_type,source.source_id,source.id])).rows;
}
export async function bridgeEntry(c:PoolClient,data:{farmId:string;actor:string;kind:'expense'|'revenue'|'payment'|'cash_out';amountMinor:bigint;currency:string;minorUnit:number;sourceType:string;sourceId:string;postedOn:string;note:string;projectId?:string|null;category?:string}) {
  const id=randomUUID();
  await c.query(`INSERT INTO financial_entries(id,farm_id,project_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note,category)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date::timestamp AT TIME ZONE timezone,$11,$12 FROM farms WHERE id=$2`,
    [id,data.farmId,data.projectId??null,data.actor,data.kind,decimalFromMinor(data.amountMinor,data.minorUnit),data.currency,data.sourceType,data.sourceId,data.postedOn,data.note,data.category??'other']);
  return id;
}
export function commonProject(snapshot:AccountingInvoiceSnapshot):string|null {
  const projects=new Set(snapshot.lines.map(l=>l.projectId));
  return projects.size===1?snapshot.lines[0].projectId:null;
}
export async function farmToday(c:PoolClient,farmId:string):Promise<string> {
  return (await c.query('SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text AS today FROM farms WHERE id=$1',[farmId])).rows[0].today;
}
