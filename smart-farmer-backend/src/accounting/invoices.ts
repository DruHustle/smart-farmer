import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { ApiError, audit } from '../context.js';
import { duplicateCandidates, expectOpenPeriod, expectVersion, invoiceBalances, invoiceRow, loadInvoiceDetail, normalizeReference, previewInvoice, requireSettings } from './core.js';
import { bridgeEntry, commonProject, farmToday, legacyCashEntries, linkedSource } from './bridge.js';
import { cashAccounts, postJournal, reverseJournal, type JournalLine } from './ledger.js';
import { calculateLines, currencyScale, decimalFromMinor, decimalScaled, halfUp, minor } from './money.js';
import type { creditInput, draftInput, editInput, finalizeInput, paymentInput, reversePaymentInput, voidInput } from './schema.js';
import type { AccountingInvoiceSnapshot, AccountingLine, AccountingSettings } from './types.js';

type Access={farmId:string;actor:string};
const normal = (row:any) => row.kind==='purchase'||row.kind==='sale';
function finalized(row:any) { if(!normal(row)||!row.finalized_at||row.status==='void')throw new ApiError('invoice_not_finalized',409); }
function positive(value:string) { const n=minor(value);if(n<=0n)throw new ApiError('invalid_amount');return n; }
async function references(c:PoolClient,farmId:string,content:z.infer<typeof draftInput>|z.infer<typeof editInput>) {
  if(content.documentId && !(await c.query('SELECT id FROM accounting_documents WHERE farm_id=$1 AND id=$2',[farmId,content.documentId])).rowCount)throw new ApiError('not_found',404);
  if(content.sourceEntryId && !(await c.query('SELECT id FROM financial_entries WHERE farm_id=$1 AND id=$2',[farmId,content.sourceEntryId])).rowCount)throw new ApiError('not_found',404);
  const projects=[...new Set(content.lines.flatMap(l=>l.projectId?[l.projectId]:[]))];
  if(projects.length && (await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=ANY($2::uuid[])',[farmId,projects])).rowCount!==projects.length)throw new ApiError('project_not_found',404);
}
async function validateAccounts(c:PoolClient,farmId:string,snapshot:AccountingInvoiceSnapshot) {
  const codes=[...new Set(snapshot.lines.map(l=>l.accountCode))];
  const type=snapshot.kind.startsWith('purchase')?'expense':'income';
  const found=(await c.query('SELECT code FROM accounting_accounts WHERE farm_id=$1 AND code=ANY($2::text[]) AND type=$3 AND active',[farmId,codes,type])).rows;
  if(found.length!==codes.length)throw new ApiError('invoice_account_type',409);
}
export async function createDraft(c:PoolClient,a:Access,b:z.infer<typeof draftInput>) {
  await requireSettings(c,a.farmId);
  await references(c,a.farmId,b);
  const scale=currencyScale(b.currency),calculated=calculateLines(b.lines,scale,b.kind==='purchase'?'5000':'4000');
  await c.query(`INSERT INTO accounting_invoices(id,farm_id,created_by,kind,content,currency,minor_unit,supplier_key,reference_key,issue_date,due_date,total_minor,net_minor,tax_minor,document_id,source_entry_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[b.id,a.farmId,a.actor,b.kind,JSON.stringify(b),b.currency,scale,normalizeReference(b.party.name),normalizeReference(b.reference),b.issueDate,b.dueDate,calculated.totals.totalMinor,calculated.totals.netMinor,calculated.totals.taxMinor,b.documentId,b.sourceEntryId]);
  await audit(c,a.farmId,a.actor,'accounting_invoice',b.id,'draft_created','Manual invoice draft',null,b);
  return loadInvoiceDetail(c,a.farmId,b.id);
}
export async function editDraft(c:PoolClient,a:Access,id:string,b:z.infer<typeof editInput>) {
  const row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);
  if(row.status!=='draft')throw new ApiError('invoice_not_draft',409);
  await references(c,a.farmId,b);
  const {version:_,...input}=b,content={...input,id,kind:row.kind};
  const scale=currencyScale(b.currency),calculated=calculateLines(b.lines,scale,row.kind==='purchase'?'5000':'4000');
  await c.query(`UPDATE accounting_invoices SET content=$3,currency=$4,minor_unit=$5,supplier_key=$6,reference_key=$7,issue_date=$8,due_date=$9,total_minor=$10,net_minor=$11,tax_minor=$12,document_id=$13,source_entry_id=$14,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2`,[a.farmId,id,JSON.stringify(content),b.currency,scale,normalizeReference(b.party.name),normalizeReference(b.reference),b.issueDate,b.dueDate,calculated.totals.totalMinor,calculated.totals.netMinor,calculated.totals.taxMinor,b.documentId,b.sourceEntryId]);
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,'draft_edited','Manual draft review',row.content,content);
  return loadInvoiceDetail(c,a.farmId,id);
}
async function allocateNumber(c:PoolClient,farmId:string,kind:string,settings:AccountingSettings) {
  if(!kind.startsWith('sale'))return null;
  if(settings.nextNumber>=1_000_000_000)throw new ApiError('invoice_number_limit',409);
  const number=`${settings.invoicePrefix}-${kind==='sale_credit'?'CN-':''}${String(settings.nextNumber).padStart(6,'0')}`;
  await c.query('UPDATE accounting_settings SET next_number=next_number+1,updated_at=now() WHERE farm_id=$1',[farmId]);
  return number;
}
function invoiceLines(snapshot:AccountingInvoiceSnapshot):JournalLine[] {
  const purchase=snapshot.kind.startsWith('purchase'),credit=snapshot.kind.endsWith('_credit');
  const lines:JournalLine[]=[];
  const entry=(accountCode:string,amount:string,debit:boolean,description:string,projectId:string|null=null)=>{
    if(BigInt(amount)===0n)return;
    lines.push({accountCode,debitMinor:debit?amount:'0',creditMinor:debit?'0':amount,description,projectId});
  };
  for(const line of snapshot.lines)entry(line.accountCode,line.netMinor,purchase!==credit,line.description,line.projectId);
  entry(purchase?'5100':'2100',snapshot.totals.taxMinor,purchase!==credit,purchase?'Tax on purchases':'Tax collected');
  entry(purchase?'2000':'1100',snapshot.totals.totalMinor,purchase===credit,snapshot.reference||snapshot.number||'Invoice obligation');
  return lines;
}
async function invoiceJournal(c:PoolClient,a:Access,snapshot:AccountingInvoiceSnapshot,reason:string) {
  return postJournal(c,{id:randomUUID(),farmId:a.farmId,actor:a.actor,currency:snapshot.currency,postedOn:snapshot.postingDate??snapshot.issueDate,description:`${snapshot.kind}: ${snapshot.number||snapshot.reference||snapshot.party.name}`,reason,sourceKind:snapshot.kind.endsWith('_credit')?'invoice_credit':'invoice',sourceId:snapshot.id,lines:invoiceLines(snapshot)});
}
async function paymentJournal(c:PoolClient,a:Access,snapshot:AccountingInvoiceSnapshot,data:{id:string;amount:bigint;method:keyof typeof cashAccounts;paidOn:string;note:string;origin:'accounting'|'legacy';reversalOf?:string}) {
  const amount=data.amount<0n?-data.amount:data.amount,purchase=snapshot.kind==='purchase',reverse=data.amount<0n;
  const cashDebit=purchase===reverse,controlDebit=!cashDebit;
  const advance=data.origin==='legacy'&&data.paidOn<(snapshot.postingDate??snapshot.issueDate);
  const control=advance?(purchase?'1500':'2200'):(purchase?'2000':'1100');
  const original=data.reversalOf?(await c.query("SELECT id FROM accounting_journals WHERE farm_id=$1 AND source_kind IN('payment','legacy_payment') AND source_id=$2",[a.farmId,data.reversalOf])).rows[0]:null;
  if(data.reversalOf&&!original)throw new ApiError('accounting_journal_invariant',500);
  return postJournal(c,{id:randomUUID(),farmId:a.farmId,actor:a.actor,currency:snapshot.currency,postedOn:data.paidOn,description:`${reverse?'Payment reversal':'Payment'}: ${snapshot.number||snapshot.reference||snapshot.party.name}`,reason:data.note,sourceKind:data.reversalOf?'payment_reversal':data.origin==='legacy'?'legacy_payment':'payment',sourceId:data.id,reversalOf:original?.id,lines:[
    {accountCode:cashAccounts[data.method],debitMinor:cashDebit?amount.toString():'0',creditMinor:cashDebit?'0':amount.toString(),description:data.note,projectId:commonProject(snapshot)},
    {accountCode:control,debitMinor:controlDebit?amount.toString():'0',creditMinor:controlDebit?'0':amount.toString(),description:data.note,projectId:commonProject(snapshot)},
  ]});
}
async function applyAdvances(c:PoolClient,a:Access,snapshot:AccountingInvoiceSnapshot,amount:bigint){
  if(amount===0n)return;
  const purchase=snapshot.kind==='purchase',value=amount.toString();
  await postJournal(c,{id:randomUUID(),farmId:a.farmId,actor:a.actor,currency:snapshot.currency,postedOn:snapshot.postingDate??snapshot.issueDate,description:`Apply previously recorded advances: ${snapshot.number||snapshot.reference}`,reason:'Apply recorded advances when the linked sale or expense was recognized',sourceKind:'advance_application',sourceId:snapshot.id,lines:[
    {accountCode:purchase?'2000':'2200',debitMinor:value,creditMinor:'0',description:'Advance applied',projectId:commonProject(snapshot)},
    {accountCode:purchase?'1500':'1100',debitMinor:'0',creditMinor:value,description:'Advance applied',projectId:commonProject(snapshot)},
  ]});
}
function validateTimeline(total:bigint,events:{date:string;payment:bigint;credit:bigint}[]){
  const days=new Map<string,{paid:bigint;credited:bigint}>();
  for(const event of events){const bucket=days.get(event.date)??{paid:0n,credited:0n};bucket.paid+=event.payment;bucket.credited+=event.credit;days.set(event.date,bucket);}
  let paid=0n,credited=0n;
  for(const [date,values] of [...days].sort(([a],[b])=>a.localeCompare(b))){paid+=values.paid;credited+=values.credited;if(paid<0n||paid+credited>total)throw new ApiError('posting_balance_conflict',409,{details:{date}});}
}
async function validateInvoiceTimeline(c:PoolClient,farmId:string,row:any,event:{date:string;payment:bigint;credit:bigint}){
  const events=(await c.query(`SELECT paid_on::text AS date,amount_minor::text AS payment,'0' AS credit FROM accounting_payments WHERE farm_id=$1 AND invoice_id=$2
    UNION ALL SELECT issue_date::text,'0',total_minor::text FROM accounting_invoices WHERE farm_id=$1 AND corrects_invoice_id=$2 AND status IN('posted','issued')`,[farmId,row.id])).rows;
  validateTimeline(BigInt(row.total_minor),[...events.map(e=>({date:e.date,payment:BigInt(e.payment),credit:BigInt(e.credit)})),event]);
}
async function insertPayment(c:PoolClient,a:Access,snapshot:AccountingInvoiceSnapshot,data:{id:string;amount:bigint;paidOn:string;method:keyof typeof cashAccounts;reference:string;note:string;origin:'accounting'|'legacy';legacyEntryId?:string;reversalOf?:string;bridge:boolean}) {
  await c.query('INSERT INTO accounting_payments(id,farm_id,invoice_id,created_by,amount_minor,currency,paid_on,method,reference,note,origin,legacy_entry_id,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[data.id,a.farmId,snapshot.id,a.actor,data.amount.toString(),snapshot.currency,data.paidOn,data.method,data.reference,data.note,data.origin,data.legacyEntryId??null,data.reversalOf??null]);
  await paymentJournal(c,a,snapshot,data);
  if(data.bridge)await bridgeEntry(c,{farmId:a.farmId,actor:a.actor,kind:snapshot.kind==='purchase'?'cash_out':'payment',amountMinor:data.amount,currency:snapshot.currency,minorUnit:snapshot.minorUnit,sourceType:data.amount<0n?'record_correction':'accounting_payment',sourceId:data.id,postedOn:data.paidOn,note:data.note,projectId:commonProject(snapshot)});
}
export async function finalizeInvoice(c:PoolClient,a:Access,id:string,b:z.infer<typeof finalizeInput>,kind:'purchase'|'sale') {
  const settings=await requireSettings(c,a.farmId,'update'),row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);
  if(row.status!=='draft'||row.kind!==kind)throw new ApiError('invoice_not_draft',409);
  const snapshot=previewInvoice(row,settings);positive(snapshot.totals.totalMinor);
  if(kind==='purchase'&&!snapshot.reference)throw new ApiError('supplier_reference_required');
  for(const line of snapshot.lines)if(line.taxRateBps!==0&&!settings.taxRates.some(r=>r.rateBps===line.taxRateBps))throw new ApiError('tax_rate_unconfigured',409);
  await validateAccounts(c,a.farmId,snapshot);
  if(snapshot.documentId){const doc=(await c.query('SELECT state FROM accounting_documents WHERE farm_id=$1 AND id=$2 FOR SHARE',[a.farmId,snapshot.documentId])).rows[0];if(!doc)throw new ApiError('not_found',404);if(!['ready','failed'].includes(doc.state))throw new ApiError('document_not_ready',409);}
  const duplicates=(await duplicateCandidates(c,row)).filter(other=>other.status==='posted'||other.status==='issued');
  if(duplicates.some(d=>d.reason==='document'||d.reason==='source_entry') || (duplicates.length&&!b.duplicateOverrideReason))throw new ApiError('duplicate_invoice',409,{details:{candidates:duplicates}});
  const source=await linkedSource(c,snapshot);
  expectOpenPeriod(settings,snapshot.postingDate??snapshot.issueDate);
  const legacy=source?await legacyCashEntries(c,a.farmId,source):[];
  const legacyAmounts=legacy.map(p=>{if(p.currency!==snapshot.currency)throw new ApiError('source_mismatch',409);return decimalScaled(p.amount,snapshot.minorUnit,true);});
  const paid=legacyAmounts.reduce((n,v)=>n+v,0n);
  if(paid<0n||paid>BigInt(snapshot.totals.totalMinor))throw new ApiError('source_payment_mismatch',409);
  validateTimeline(BigInt(snapshot.totals.totalMinor),legacy.map((cash,index)=>({date:cash.paid_on,payment:legacyAmounts[index],credit:0n})));
  snapshot.number=await allocateNumber(c,a.farmId,kind,settings);snapshot.finalizedAt=new Date().toISOString();
  const financialId=source?null:await bridgeEntry(c,{farmId:a.farmId,actor:a.actor,kind:kind==='purchase'?'expense':'revenue',amountMinor:BigInt(snapshot.totals.totalMinor),currency:snapshot.currency,minorUnit:snapshot.minorUnit,sourceType:'accounting_invoice',sourceId:id,postedOn:snapshot.issueDate,note:snapshot.reference||snapshot.number||snapshot.party.name,projectId:commonProject(snapshot)});
  await c.query('UPDATE accounting_invoices SET status=$3,snapshot=$4,number=$5,financial_entry_id=$6,finalized_at=$7,version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2',[a.farmId,id,kind==='purchase'?'posted':'issued',JSON.stringify(snapshot),snapshot.number,financialId,snapshot.finalizedAt]);
  await invoiceJournal(c,a,snapshot,b.duplicateOverrideReason||'Explicitly reviewed and confirmed');
  for(const [index,cash] of legacy.entries())if(legacyAmounts[index]!==0n)await insertPayment(c,a,snapshot,{id:randomUUID(),amount:legacyAmounts[index],paidOn:cash.paid_on,method:'other',reference:'Imported recorded payment',note:cash.note||'Previously recorded payment linked without duplication',origin:'legacy',legacyEntryId:cash.id,bridge:false});
  await applyAdvances(c,a,snapshot,legacy.reduce((n,cash,index)=>n+(cash.paid_on<(snapshot.postingDate??snapshot.issueDate)?legacyAmounts[index]:0n),0n));
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,kind==='purchase'?'posted':'issued',b.duplicateOverrideReason||'Explicitly reviewed and confirmed',row.content,{snapshot,legacyPaymentIds:legacy.map(p=>p.id)});
  return loadInvoiceDetail(c,a.farmId,id);
}
export async function recordPayment(c:PoolClient,a:Access,id:string,b:z.infer<typeof paymentInput>) {
  const row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);finalized(row);
  if(b.currency!==row.currency)throw new ApiError('currency_mismatch',409);
  if(b.paidOn<(row.snapshot.postingDate??row.issue_date))throw new ApiError('payment_precedes_invoice',409);
  const amount=positive(b.amountMinor),{paid,credited}=await invoiceBalances(c,a.farmId,id);
  if(amount>BigInt(row.total_minor)-paid-credited)throw new ApiError('payment_exceeds_balance',409);
  await validateInvoiceTimeline(c,a.farmId,row,{date:b.paidOn,payment:amount,credit:0n});
  await insertPayment(c,a,row.snapshot,{id:b.id,amount,paidOn:b.paidOn,method:b.method,reference:b.reference,note:b.note,origin:'accounting',bridge:true});
  await c.query('UPDATE accounting_invoices SET version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2',[a.farmId,id]);
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,'payment_recorded',b.note||'Explicit manual payment confirmation',null,b);
  return loadInvoiceDetail(c,a.farmId,id);
}
export async function reversePayment(c:PoolClient,a:Access,id:string,paymentId:string,b:z.infer<typeof reversePaymentInput>) {
  const row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);finalized(row);
  const payment=(await c.query('SELECT *,paid_on::text AS paid_on FROM accounting_payments WHERE farm_id=$1 AND invoice_id=$2 AND id=$3',[a.farmId,id,paymentId])).rows[0];
  if(!payment)throw new ApiError('not_found',404);
  if(payment.reversal_of||BigInt(payment.amount_minor)<=0n||(await c.query('SELECT 1 FROM accounting_payments WHERE farm_id=$1 AND reversal_of=$2',[a.farmId,paymentId])).rowCount)throw new ApiError('payment_already_reversed',409);
  if(b.paidOn<payment.paid_on||b.paidOn<(row.snapshot.postingDate??row.issue_date))throw new ApiError('reversal_precedes_payment',409);
  const {paid}=await invoiceBalances(c,a.farmId,id);
  if(paid<BigInt(payment.amount_minor))throw new ApiError('reversal_exceeds_paid',409);
  await validateInvoiceTimeline(c,a.farmId,row,{date:b.paidOn,payment:-BigInt(payment.amount_minor),credit:0n});
  await insertPayment(c,a,row.snapshot,{id:b.id,amount:-BigInt(payment.amount_minor),paidOn:b.paidOn,method:payment.method,reference:payment.reference,note:b.reason,origin:'accounting',reversalOf:payment.id,bridge:true});
  await c.query('UPDATE accounting_invoices SET version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2',[a.farmId,id]);
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,'payment_reversed',b.reason,payment,b);
  return loadInvoiceDetail(c,a.farmId,id);
}
export async function voidInvoice(c:PoolClient,a:Access,id:string,b:z.infer<typeof voidInput>) {
  const row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);
  if(row.status==='void')throw new ApiError('invoice_already_void',409);
  if(row.status==='draft'){
    await c.query("UPDATE accounting_invoices SET status='void',voided_at=now(),version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2",[a.farmId,id]);
  }else{
    finalized(row);
    const {paid,credited}=await invoiceBalances(c,a.farmId,id);
    if(paid!==0n)throw new ApiError('invoice_has_payments',409);
    if(credited!==0n)throw new ApiError('invoice_has_credits',409);
    if(row.source_entry_id)throw new ApiError('linked_source_requires_credit',409);
    const today=await farmToday(c,a.farmId),recognition=row.snapshot.postingDate??row.issue_date,postedOn=today<recognition?recognition:today;
    if((await c.query('SELECT 1 FROM accounting_payments WHERE farm_id=$1 AND invoice_id=$2 AND paid_on>$3 LIMIT 1',[a.farmId,id,postedOn])).rowCount)throw new ApiError('void_precedes_history',409);
    const journal=(await c.query("SELECT id FROM accounting_journals WHERE farm_id=$1 AND source_kind='invoice' AND source_id=$2",[a.farmId,id])).rows[0];
    if(!journal)throw new ApiError('accounting_journal_invariant',500);
    await reverseJournal(c,a.farmId,a.actor,journal.id,randomUUID(),postedOn,b.reason,'invoice_void',id);
    await bridgeEntry(c,{farmId:a.farmId,actor:a.actor,kind:row.kind==='purchase'?'expense':'revenue',amountMinor:-BigInt(row.total_minor),currency:row.currency,minorUnit:row.minor_unit,sourceType:'record_correction',sourceId:id,postedOn,note:b.reason,projectId:commonProject(row.snapshot)});
    await c.query("UPDATE accounting_invoices SET status='void',voided_at=now(),version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2",[a.farmId,id]);
  }
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,row.status==='draft'?'draft_discarded':'voided',b.reason,{status:row.status},{status:'void'});
  return loadInvoiceDetail(c,a.farmId,id);
}
/** Original-line order and cumulative proportional tax make repeated tiny credits exact. */
export function creditLines(original:AccountingInvoiceSnapshot,prior:bigint,amount:bigint) {
  let before=prior,after=prior+amount;
  const lines:AccountingLine[]=[];
  for(const line of original.lines){
    const total=BigInt(line.totalMinor),tax=BigInt(line.taxMinor);
    if(total===0n)continue;
    const oldPart=before>total?total:before,newPart=after>total?total:after;
    before-=oldPart;after-=newPart;
    const part=newPart-oldPart;if(part===0n)continue;
    const taxPart=halfUp(newPart*tax,total)-halfUp(oldPart*tax,total),netPart=part-taxPart;
    lines.push({...line,quantity:'1',unitPrice:decimalFromMinor(netPart,original.minorUnit),discountMinor:'0',netMinor:netPart.toString(),taxMinor:taxPart.toString(),totalMinor:part.toString()});
  }
  if(after!==0n||before!==0n||lines.reduce((s,l)=>s+BigInt(l.totalMinor),0n)!==amount)throw new ApiError('credit_amount_invariant',500);
  const net=lines.reduce((s,l)=>s+BigInt(l.netMinor),0n),tax=amount-net;
  const rates=new Map<number,{net:bigint;tax:bigint}>();
  for(const line of lines){const bucket=rates.get(line.taxRateBps)??{net:0n,tax:0n};bucket.net+=BigInt(line.netMinor);bucket.tax+=BigInt(line.taxMinor);rates.set(line.taxRateBps,bucket);}
  return {lines,totals:{subtotalMinor:net.toString(),discountMinor:'0',netMinor:net.toString(),taxMinor:tax.toString(),totalMinor:amount.toString()},taxBreakdown:[...rates].map(([rateBps,b])=>({rateBps,taxableMinor:b.net.toString(),taxMinor:b.tax.toString()}))};
}
export async function createCredit(c:PoolClient,a:Access,id:string,b:z.infer<typeof creditInput>) {
  const settings=await requireSettings(c,a.farmId,'update'),row=await invoiceRow(c,a.farmId,id,true);expectVersion(row,b.version);finalized(row);
  if(b.issueDate<row.issue_date)throw new ApiError('credit_precedes_invoice',409);
  expectOpenPeriod(settings,b.issueDate);
  const {paid,credited}=await invoiceBalances(c,a.farmId,id),amount=positive(b.amountMinor);
  if(amount>BigInt(row.total_minor)-paid-credited)throw new ApiError('credit_exceeds_balance',409);
  await validateInvoiceTimeline(c,a.farmId,row,{date:b.issueDate,payment:0n,credit:amount});
  const original=row.snapshot as AccountingInvoiceSnapshot,kind=row.kind==='purchase'?'purchase_credit':'sale_credit';
  const snapshot:AccountingInvoiceSnapshot={...original,...creditLines(original,credited,amount),id:b.id,kind,number:await allocateNumber(c,a.farmId,kind,settings),reference:original.number||original.reference,issueDate:b.issueDate,postingDate:b.issueDate,dueDate:null,notes:b.reason,terms:'',documentId:null,sourceEntryId:null,correctsInvoiceId:id,finalizedAt:new Date().toISOString(),rounding:'credit_proportional'};
  const source=(await c.query('SELECT source_type,category FROM financial_entries WHERE farm_id=$1 AND id=$2',[a.farmId,row.source_entry_id??row.financial_entry_id])).rows[0];
  const category=source&&(['stock_record','stock_pack'].includes(source.source_type)||source.category==='inventory')?'inventory':source?.category??'other';
  const financialId=await bridgeEntry(c,{farmId:a.farmId,actor:a.actor,kind:row.kind==='purchase'?'expense':'revenue',amountMinor:-amount,currency:row.currency,minorUnit:row.minor_unit,sourceType:'record_correction',sourceId:b.id,postedOn:b.issueDate,note:b.reason,projectId:commonProject(snapshot),category});
  await c.query(`INSERT INTO accounting_invoices(id,farm_id,created_by,kind,status,content,snapshot,currency,minor_unit,number,supplier_key,reference_key,issue_date,total_minor,net_minor,tax_minor,financial_entry_id,corrects_invoice_id,finalized_at)
    VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[b.id,a.farmId,a.actor,kind,row.kind==='purchase'?'posted':'issued',JSON.stringify(snapshot),row.currency,row.minor_unit,snapshot.number,normalizeReference(snapshot.party.name),normalizeReference(snapshot.reference),b.issueDate,snapshot.totals.totalMinor,snapshot.totals.netMinor,snapshot.totals.taxMinor,financialId,id,snapshot.finalizedAt]);
  await invoiceJournal(c,a,snapshot,b.reason);
  await c.query('UPDATE accounting_invoices SET version=version+1,updated_at=now() WHERE farm_id=$1 AND id=$2',[a.farmId,id]);
  await audit(c,a.farmId,a.actor,'accounting_invoice',id,'credit_applied',b.reason,null,{creditId:b.id,amountMinor:b.amountMinor});
  await audit(c,a.farmId,a.actor,'accounting_invoice',b.id,'credit_issued',b.reason,null,snapshot);
  return loadInvoiceDetail(c,a.farmId,b.id);
}
