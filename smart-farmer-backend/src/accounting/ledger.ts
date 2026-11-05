import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from '../context.js';
import { expectOpenPeriod, requireSettings } from './core.js';
import { currencyScale, MAX_MINOR, minor } from './money.js';

export const systemAccounts = [
  {code:'1000',name:'Cash',type:'asset'}, {code:'1010',name:'Bank',type:'asset'},
  {code:'1020',name:'Mobile money',type:'asset'}, {code:'1030',name:'Other cash',type:'asset'},
  {code:'1100',name:'Accounts receivable',type:'asset'}, {code:'1200',name:'Tax adjustments',type:'asset'},
  {code:'1300',name:'Inventory',type:'asset'}, {code:'1400',name:'Equipment',type:'asset'},
  {code:'1500',name:'Supplier advances',type:'asset'}, {code:'2200',name:'Customer advances',type:'liability'},
  {code:'2000',name:'Accounts payable',type:'liability'}, {code:'2100',name:'Tax collected',type:'liability'},
  {code:'3000',name:'Opening equity',type:'equity'}, {code:'4000',name:'Sales',type:'income'},
  {code:'5000',name:'Expenses',type:'expense'}, {code:'5100',name:'Tax on purchases',type:'expense'},
].map(a=>({...a,system:true,active:true}));
export const cashAccounts = {cash:'1000',bank:'1010',mobile_money:'1020',other:'1030'} as const;
export async function ensureAccounts(c: PoolClient, farmId: string) {
  await c.query(`INSERT INTO accounting_accounts(farm_id,code,name,type,system) SELECT $1,x.code,x.name,x.type,true FROM jsonb_to_recordset($2::jsonb) AS x(code text,name text,type text) ON CONFLICT(farm_id,code) DO NOTHING`,[farmId,JSON.stringify(systemAccounts)]);
}
export interface JournalLine { accountCode:string; debitMinor:string; creditMinor:string; description:string; projectId?:string|null }
export async function postJournal(c: PoolClient, data: {id:string;farmId:string;actor:string;currency:string;postedOn:string;description:string;reason:string;sourceKind:string;sourceId:string;reversalOf?:string|null;lines:JournalLine[]}) {
  const scale=currencyScale(data.currency), settings=await requireSettings(c,data.farmId);
  expectOpenPeriod(settings,data.postedOn);
  if(data.lines.length<2 || data.lines.length>204) throw new ApiError('unbalanced_journal');
  let debit=0n,credit=0n;
  for(const line of data.lines){
    const d=minor(line.debitMinor),cr=minor(line.creditMinor);
    if((d>0n)===(cr>0n))throw new ApiError('invalid_journal_line');
    debit+=d;credit+=cr;
  }
  if(debit!==credit || debit===0n)throw new ApiError('unbalanced_journal');
  if(debit>MAX_MINOR)throw new ApiError('amount_too_large');
  const accounts=(await c.query('SELECT code FROM accounting_accounts WHERE farm_id=$1 AND active AND code=ANY($2::text[])',[data.farmId,[...new Set(data.lines.map(l=>l.accountCode))]])).rows;
  if(accounts.length!==new Set(data.lines.map(l=>l.accountCode)).size)throw new ApiError('account_not_found',404);
  const projects=[...new Set(data.lines.flatMap(l=>l.projectId?[l.projectId]:[]))];
  if(projects.length && (await c.query('SELECT id FROM projects WHERE farm_id=$1 AND id=ANY($2::uuid[])',[data.farmId,projects])).rowCount!==projects.length)throw new ApiError('project_not_found',404);
  await c.query('INSERT INTO accounting_journals(id,farm_id,created_by,currency,minor_unit,posted_on,description,reason,source_kind,source_id,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[data.id,data.farmId,data.actor,data.currency,scale,data.postedOn,data.description,data.reason,data.sourceKind,data.sourceId,data.reversalOf??null]);
  for(const [position,line] of data.lines.entries())await c.query('INSERT INTO accounting_journal_lines(id,farm_id,journal_id,position,account_code,project_id,debit_minor,credit_minor,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),data.farmId,data.id,position,line.accountCode,line.projectId??null,line.debitMinor,line.creditMinor,line.description]);
  return {id:data.id,currency:data.currency,minorUnit:scale,postedOn:data.postedOn,description:data.description,reason:data.reason,sourceType:data.sourceKind,sourceId:data.sourceId,reversalOf:data.reversalOf??null,reversedBy:null,lines:data.lines.map(line=>({...line,projectId:line.projectId??null}))};
}
export async function reverseJournal(c: PoolClient, farmId:string, actor:string, originalId:string, id:string, postedOn:string, reason:string, sourceKind:string, sourceId:string) {
  const original=(await c.query('SELECT * FROM accounting_journals WHERE farm_id=$1 AND id=$2',[farmId,originalId])).rows[0];
  if(!original)throw new ApiError('not_found',404);
  if((await c.query('SELECT 1 FROM accounting_journals WHERE reversal_of=$1',[originalId])).rowCount)throw new ApiError('journal_already_reversed',409);
  const lines=(await c.query('SELECT account_code AS "accountCode",credit_minor::text AS "debitMinor",debit_minor::text AS "creditMinor",description,project_id AS "projectId" FROM accounting_journal_lines WHERE farm_id=$1 AND journal_id=$2 ORDER BY position',[farmId,originalId])).rows;
  return postJournal(c,{id,farmId,actor,currency:original.currency,postedOn,description:`Reversal: ${original.description}`,reason,sourceKind,sourceId,reversalOf:originalId,lines});
}
