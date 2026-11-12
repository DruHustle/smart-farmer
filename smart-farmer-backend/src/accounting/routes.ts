import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, audit, manageRoles, type Context } from '../context.js';
import { auth } from '../product/common.js';
import { loadInvoiceDetail, readSettings, requireSettings } from './core.js';
import { currencyScale, supportedCurrencies } from './money.js';
import { ensureAccounts, postJournal, reverseJournal, systemAccounts } from './ledger.js';
import { accountingMutation } from './transaction.js';
import { createCredit, createDraft, editDraft, finalizeInvoice, recordPayment, reversePayment, voidInvoice } from './invoices.js';
import { registerAccountingReports } from './reports.js';
import * as s from './schema.js';

const base='/v1/farms/:farmId/accounting';
const invoiceParams=z.object({invoiceId:z.uuid()});
async function privateRead<T>(ctx:Context,req:FastifyRequest,reply:FastifyReply,action:(c:PoolClient,farmId:string)=>Promise<T>) {
  const access=await auth(ctx,req,reply,manageRoles);if(!access)return null;
  return ctx.transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('SELECT id FROM farms WHERE id=$1 FOR SHARE',[access.farmId]);
    const member=(await c.query('SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE',[access.farmId,access.actor])).rows[0];
    if(!member||!manageRoles.includes(member.role))throw new ApiError('not_found',404);
    return action(c,access.farmId);
  });
}
export async function getInvoiceDetail(ctx:Context,req:FastifyRequest,reply:FastifyReply){
  return privateRead(ctx,req,reply,(c,farmId)=>loadInvoiceDetail(c,farmId,invoiceParams.parse(req.params).invoiceId));
}
export function registerAccounting(app:FastifyInstance,ctx:Context){
  registerAccountingReports(app,ctx);
  app.get(`${base}/settings`,async(req,reply)=>privateRead(ctx,req,reply,async(c,farmId)=>{const settings=await readSettings(c,farmId);return {configured:!!settings,settings,currencies:supportedCurrencies};}));
  app.get(`${base}/accounts`,async(req,reply)=>privateRead(ctx,req,reply,async(c,farmId)=>{const rows=(await c.query('SELECT code,name,type,system,active FROM accounting_accounts WHERE farm_id=$1 ORDER BY code',[farmId])).rows;return {items:rows.length?rows:systemAccounts};}));
  app.get(`${base}/invoices/:invoiceId`,async(req,reply)=>getInvoiceDetail(ctx,req,reply));
  function mutation<B extends {id:string}>(method:'POST'|'PATCH'|'PUT',path:string,schema:z.ZodType<B>,operation:string,action:(c:PoolClient,a:{farmId:string;actor:string},body:B,params:any)=>Promise<unknown>,created=false){
    app.route({method,url:base+path,bodyLimit:262144,handler:async(req,reply)=>{
      const a=await auth(ctx,req,reply,manageRoles);if(!a)return;
      const body=schema.parse(req.body),params=req.params;
      const out=await accountingMutation(ctx,a.farmId,a.actor,body.id,{operation,params,body},c=>action(c,a,body,params));
      return reply.code(created&&!out.replayed?201:200).send(out.body);
    }});
  }
  mutation('PUT','/settings',s.settingsInput,'accounting_settings',async(c,a,b)=>{
    currencyScale(b.defaultCurrency);
    const previous=await readSettings(c,a.farmId,'update');
    if((previous?.version??0)!==b.version)throw new ApiError('version_conflict',409,{details:{currentVersion:previous?.version??0}});
    if(b.startingNumber!==undefined&&(await c.query('SELECT 1 FROM accounting_invoices WHERE farm_id=$1 AND number IS NOT NULL LIMIT 1',[a.farmId])).rowCount)throw new ApiError('numbering_already_started',409);
    const next=b.startingNumber??previous?.nextNumber??1;
    await c.query(`INSERT INTO accounting_settings(farm_id,business,default_currency,invoice_prefix,next_number,tax_rates,locked_through) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(farm_id) DO UPDATE SET version=accounting_settings.version+1,business=EXCLUDED.business,default_currency=EXCLUDED.default_currency,invoice_prefix=EXCLUDED.invoice_prefix,next_number=EXCLUDED.next_number,tax_rates=EXCLUDED.tax_rates,locked_through=EXCLUDED.locked_through,updated_at=now()`,[a.farmId,JSON.stringify(b.business),b.defaultCurrency,b.invoicePrefix,next,JSON.stringify(b.taxRates),b.lockedThrough]);
    await ensureAccounts(c,a.farmId);
    const settings=await requireSettings(c,a.farmId);
    await audit(c,a.farmId,a.actor,'accounting_settings',a.farmId,'settings_changed',b.reason,previous,settings);
    return {configured:true,settings,currencies:supportedCurrencies};
  });
  mutation('POST','/accounts',s.accountInput,'accounting_account',async(c,a,b)=>{
    await requireSettings(c,a.farmId);
    if((await c.query('SELECT code FROM accounting_accounts WHERE farm_id=$1 AND code=$2',[a.farmId,b.code])).rowCount)throw new ApiError('account_exists',409);
    const account=(await c.query('INSERT INTO accounting_accounts(farm_id,code,name,type) VALUES($1,$2,$3,$4) RETURNING code,name,type,system,active',[a.farmId,b.code,b.name,b.type])).rows[0];
    await audit(c,a.farmId,a.actor,'accounting_account',b.id,'account_created',b.name,null,account);return account;
  },true);
  mutation('POST','/journals',s.journalInput,'accounting_journal',async(c,a,b)=>{
    const journal=await postJournal(c,{...b,farmId:a.farmId,actor:a.actor,sourceKind:'manual',sourceId:b.id});
    await audit(c,a.farmId,a.actor,'accounting_journal',b.id,'posted',b.reason,null,journal);return journal;
  },true);
  mutation('POST','/journals/:journalId/reverse',s.reverseJournalInput,'accounting_journal_reversal',async(c,a,b,params)=>{
    const {journalId}=z.object({journalId:z.uuid()}).parse(params);
    const original=(await c.query('SELECT *,posted_on::text AS posted_on FROM accounting_journals WHERE farm_id=$1 AND id=$2',[a.farmId,journalId])).rows[0];
    if(!original)throw new ApiError('not_found',404);
    if(original.source_kind!=='manual'||original.reversal_of)throw new ApiError('journal_managed_source',409);
    if(b.postedOn<original.posted_on)throw new ApiError('reversal_precedes_journal',409);
    const journal=await reverseJournal(c,a.farmId,a.actor,journalId,b.id,b.postedOn,b.reason,'manual_reversal',b.id);
    await audit(c,a.farmId,a.actor,'accounting_journal',journalId,'reversed',b.reason,original,journal);return journal;
  },true);
  mutation('POST','/invoices',s.draftInput,'accounting_draft_create',(c,a,b)=>createDraft(c,a,b),true);
  mutation('PATCH','/invoices/:invoiceId',s.editInput,'accounting_draft_edit',(c,a,b,p)=>editDraft(c,a,invoiceParams.parse(p).invoiceId,b));
  mutation('POST','/invoices/:invoiceId/post',s.finalizeInput,'accounting_bill_post',(c,a,b,p)=>finalizeInvoice(c,a,invoiceParams.parse(p).invoiceId,b,'purchase'));
  mutation('POST','/invoices/:invoiceId/issue',s.finalizeInput,'accounting_sale_issue',(c,a,b,p)=>finalizeInvoice(c,a,invoiceParams.parse(p).invoiceId,b,'sale'));
  mutation('POST','/invoices/:invoiceId/payments',s.paymentInput,'accounting_payment',(c,a,b,p)=>recordPayment(c,a,invoiceParams.parse(p).invoiceId,b),true);
  mutation('POST','/invoices/:invoiceId/payments/:paymentId/reverse',s.reversePaymentInput,'accounting_payment_reverse',(c,a,b,p)=>{const params=z.object({invoiceId:z.uuid(),paymentId:z.uuid()}).parse(p);return reversePayment(c,a,params.invoiceId,params.paymentId,b);},true);
  mutation('POST','/invoices/:invoiceId/void',s.voidInput,'accounting_invoice_void',(c,a,b,p)=>voidInvoice(c,a,invoiceParams.parse(p).invoiceId,b));
  mutation('POST','/invoices/:invoiceId/credits',s.creditInput,'accounting_invoice_credit',(c,a,b,p)=>createCredit(c,a,invoiceParams.parse(p).invoiceId,b),true);
}
