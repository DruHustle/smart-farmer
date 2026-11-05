import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { calculateLines, currencyScale, decimalFromMinor } from '../src/accounting/money.js';

const day='2026-11-01';
const party={name:'Reviewed supplier',address:'Farm road',email:'',phone:'',taxNumber:''};
const business={legalName:'Test Farm Ltd',tradingName:'Test Farm',address:'Farm road',email:'',phone:'',registrationNumber:'',taxNumber:''};
const line=(more:Record<string,unknown>={})=>({id:randomUUID(),description:'Feed',quantity:'2',unitPrice:'12.50',discountMinor:'0',taxRateBps:0,projectId:null,...more});
const draft=(more:Record<string,unknown>={})=>({id:randomUUID(),kind:'purchase',party,currency:'USD',issueDate:day,dueDate:'2026-11-30',reference:randomUUID().slice(0,8),notes:'',terms:'',documentId:null,sourceEntryId:null,lines:[line()],...more});
const action=(version:number,more:Record<string,unknown>={})=>({id:randomUUID(),version,confirmed:true,...more});
async function fixture(){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must name a disposable real PostgreSQL database');
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),schema=`accounting_core_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema} -c statement_timeout=10000`});
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const app=buildApp(db,'http://localhost:5173');app.log.level='silent';
  async function register(name:string){
    const username=name+randomUUID().slice(0,6),password='private-accounting-test-password';
    const result=await app.inject({method:'POST',url:'/v1/register',payload:{username,password,language:'sn',farmName:'Accounting farm'}});assert.equal(result.statusCode,201,result.body);
    const login=await app.inject({method:'POST',url:'/v1/sessions',payload:{username,password}});assert.equal(login.statusCode,200,login.body);
    return {...result.json(),headers:{authorization:`Bearer ${login.json().token}`}};
  }
  const owner=await register('owner'),prefix=`/v1/farms/${owner.farmId}`;
  const send=(method:any,path:string,body?:object,user=owner)=>app.inject({method,url:path.startsWith('/v1')?path:prefix+'/accounting'+path,headers:user.headers,...(body?{payload:body}:{})});
  const ok=async(method:any,path:string,body?:object,status=200)=>{const response=await send(method,path,body);assert.equal(response.statusCode,status,response.body);return response.json();};
  const setup=async(more:Record<string,unknown>={})=>ok('PUT','/settings',{id:randomUUID(),version:0,business,defaultCurrency:'USD',invoicePrefix:'INV',startingNumber:1,taxRates:[{name:'Configured fixture rate',rateBps:1500},{name:'Fixture100%',rateBps:10000}],lockedThrough:null,reason:'Explicit test setup',...more});
  const create=async(more:Record<string,unknown>={})=>ok('POST','/invoices',draft(more),201);
  const finish=async(invoice:any,more:Record<string,unknown>={})=>ok('POST',`/invoices/${invoice.id}/${invoice.kind==='purchase'?'post':'issue'}`,action(invoice.version,{reviewed:true,...more}));
  return {db,app,owner,prefix,register,send,ok,setup,create,finish,async close(){await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
}

test('exact line arithmetic handles zero/three-decimal currencies, half-up ties, discounts and overflow',()=>{
  assert.equal(currencyScale('JPY'),0);assert.equal(currencyScale('KWD'),3);
  const usd=calculateLines([line({quantity:'3',unitPrice:'0.335',discountMinor:'1',taxRateBps:1500})],2,'5000');
  assert.deepEqual(usd.totals,{subtotalMinor:'101',discountMinor:'1',netMinor:'100',taxMinor:'15',totalMinor:'115'});
  assert.equal(calculateLines([line({quantity:'1',unitPrice:'1.2345'})],3,'5000').totals.totalMinor,'1235');
  assert.equal(calculateLines([line({quantity:'1',unitPrice:'1.5'})],0,'5000').totals.totalMinor,'2');
  assert.equal(decimalFromMinor('-1235',3),'-1.235');
  assert.throws(()=>calculateLines([line({discountMinor:'2501'})],2,'5000'),/discount_exceeds_line/);
  assert.throws(()=>calculateLines([line({unitPrice:'999999999999999',quantity:'999999999999999'})],3,'5000'),/amount_too_large/);
});

test('reviewed lifecycle snapshots identities, serializes numbers, replays once and rejects cross-farm access',async()=>{
  const f=await fixture();try{
    const unconfigured=await f.ok('GET','/settings');assert.equal(unconfigured.configured,false);assert.ok(unconfigured.currencies.some((c:any)=>c.code==='KWD'&&c.minorUnit===3));
    assert.equal((await f.send('POST','/invoices',draft())).json().error,'accounting_unconfigured');
    await f.setup();
    const body=draft({kind:'sale',lines:[line({taxRateBps:1500})]});
    const one=await f.ok('POST','/invoices',body,201);
    const replay=await f.ok('POST','/invoices',body);assert.deepEqual(replay,one);
    assert.equal((await f.send('POST','/invoices',{...body,reference:'changed'})).json().error,'idempotency_conflict');
    const two=await f.create({kind:'sale'});
    const issued=await Promise.all([f.finish(one),f.finish(two)]);
    assert.deepEqual(issued.map(i=>i.number).sort(),['INV-000001','INV-000002']);
    assert.equal(issued[0].totals.totalMinor,'2875');assert.equal(issued[0].snapshot.issuer.legalName,'Test Farm Ltd');
    assert.equal((await f.send('PATCH',`/invoices/${one.id}`,{...body,id:randomUUID(),version:2,kind:undefined})).json().error,'invoice_not_draft');
    const before=issued[0].snapshot;
    await f.ok('PUT','/settings',{id:randomUUID(),version:1,business:{...business,legalName:'Changed future identity'},defaultCurrency:'KWD',invoicePrefix:'NEXT',taxRates:[],lockedThrough:null,reason:'Update future invoice identity'});
    assert.deepEqual((await f.ok('GET',`/invoices/${one.id}`)).snapshot,before);
    const outside=await f.register('outside');
    assert.equal((await f.app.inject({method:'GET',url:`${f.prefix}/accounting/invoices/${one.id}`})).statusCode,401);
    for(const suffix of [`/invoices/${one.id}`,`/invoices/${one.id}/pdf`,'/ledger','/reports'])assert.equal((await f.send('GET',suffix,undefined,outside)).statusCode,404);
    await f.db.query("INSERT INTO memberships(farm_id,user_id,role) VALUES($1,$2,'worker')",[f.owner.farmId,outside.userId]);
    assert.equal((await f.send('POST',`/invoices/${one.id}/payments`,action(2,{amountMinor:'1',currency:'USD',paidOn:day,method:'cash'}),outside)).statusCode,404);
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE source_type='accounting_invoice'")).rows[0].count,'2');
    assert.equal((await f.db.query("SELECT next_number FROM accounting_settings")).rows[0].next_number,'3');
    await assert.rejects(f.db.query("UPDATE accounting_invoices SET snapshot=jsonb_set(snapshot,'{party,name}','\"tampered\"') WHERE id=$1",[one.id]),(e:any)=>e.code==='23514');
    await assert.rejects(f.db.query('DELETE FROM accounting_invoices WHERE id=$1',[one.id]),(e:any)=>e.code==='23514');
    const journal=(await f.db.query('SELECT id FROM accounting_journals LIMIT 1')).rows[0].id;
    await assert.rejects(f.db.query("UPDATE accounting_journal_lines SET description='tampered' WHERE journal_id=$1",[journal]),(e:any)=>e.code==='23514');
    await assert.rejects(f.db.query("INSERT INTO accounting_journal_lines(id,farm_id,journal_id,position,account_code,debit_minor,description) VALUES($1,$2,$3,1000,'1000',1,'late line')",[randomUUID(),f.owner.farmId,journal]),(e:any)=>e.code==='23514');
  }finally{await f.close();}
});

test('OCR evidence stays reviewed, failed scans allow manual entry, duplicate keys and documents cannot post silently',async()=>{
  const f=await fixture();try{
    await f.setup();const documentId=randomUUID();
    await f.db.query("INSERT INTO accounting_documents(id,farm_id,actor_id,mime_type,filename,size_bytes,content_hash,object_key,state) VALUES($1,$2,$3,'application/pdf','source.pdf',10,$4,$5,'queued')",[documentId,f.owner.farmId,f.owner.userId,'a'.repeat(64),`${f.owner.farmId}/fixture.pdf`]);
    const bill=await f.create({documentId,reference:' SUP 42 '});
    assert.equal((await f.send('POST',`/invoices/${bill.id}/post`,action(1))).json().error,'invalid_input');
    assert.equal((await f.send('POST',`/invoices/${bill.id}/post`,action(1,{reviewed:true}))).json().error,'document_not_ready');
    assert.equal((await f.db.query('SELECT count(*) FROM accounting_journals')).rows[0].count,'0');
    await f.db.query("UPDATE accounting_documents SET state='failed',error_code='document_unreadable' WHERE id=$1",[documentId]);
    const posted=await f.finish(bill);assert.equal(posted.status,'posted');assert.equal(posted.balanceMinor,'2500');
    const sameDocument=await f.create({documentId,reference:'OTHER'});
    assert.equal((await f.send('POST',`/invoices/${sameDocument.id}/post`,action(1,{reviewed:true,duplicateOverrideReason:'This cannot override identical evidence'}))).json().error,'duplicate_invoice');
    const sameReference=await f.create({reference:'sup 42',party:{...party,name:'  REVIEWED   SUPPLIER '}});
    assert.equal((await f.send('POST',`/invoices/${sameReference.id}/post`,action(1,{reviewed:true}))).json().error,'duplicate_invoice');
    const intentional=await f.finish(sameReference,{duplicateOverrideReason:'Supplier reused this reference; separate reviewed bill'});assert.equal(intentional.status,'posted');
    const badRate=await f.create({lines:[line({taxRateBps:1700})]});
    assert.equal((await f.send('POST',`/invoices/${badRate.id}/post`,action(1,{reviewed:true}))).json().error,'tax_rate_unconfigured');
    const other=await f.register('other');
    assert.equal((await f.send('PUT',`/v1/farms/${other.farmId}/accounting/settings`,{id:randomUUID(),version:0,business,defaultCurrency:'USD',invoicePrefix:'OTHER',taxRates:[],lockedThrough:null,reason:'Other farm setup'},other)).statusCode,200);
    assert.equal((await f.send('POST',`/v1/farms/${other.farmId}/accounting/invoices`,draft({documentId}),other)).statusCode,404,'draft cannot attach another farm source scan');
    const discarded=await f.ok('POST',`/invoices/${badRate.id}/void`,action(1,{reason:'Discard reviewed incorrect draft'}));
    assert.equal(discarded.status,'void');assert.equal(discarded.snapshot,null);assert.equal(discarded.number,null);
    assert.equal((await f.send('GET',`/invoices/${discarded.id}/pdf`)).statusCode,409);
    assert.equal((await f.db.query('SELECT count(*) FROM accounting_journals')).rows[0].count,'2');
  }finally{await f.close();}
});

test('payments lock balances, preserve reversals and reject both backdated and future-boundary overpayment',async()=>{
  const f=await fixture();try{
    await f.setup();const invoice=await f.finish(await f.create({kind:'sale',issueDate:'2026-01-01',dueDate:null,lines:[line({quantity:'1',unitPrice:'100'})]}));
    const payment=action(invoice.version,{amountMinor:'10000',currency:'USD',paidOn:'2026-01-05',method:'bank',reference:'Reviewed bank item'});
    const [accepted,stale]=await Promise.all([f.send('POST',`/invoices/${invoice.id}/payments`,payment),f.send('POST',`/invoices/${invoice.id}/payments`,{...payment,id:randomUUID()})]);
    assert.deepEqual([accepted.statusCode,stale.statusCode].sort(),[201,409]);
    const actual=accepted.statusCode===201?accepted.json():stale.json();assert.equal(actual.balanceMinor,'0');
    const recorded=actual.payments[0];
    assert.deepEqual(await f.ok('POST',`/invoices/${invoice.id}/payments`,{...payment,id:recorded.id}),actual,'lost-response retry replays the original payment despite stale version');
    const reversed=await f.ok('POST',`/invoices/${invoice.id}/payments/${recorded.id}/reverse`,action(actual.version,{paidOn:'2026-02-01',reason:'Recorded refund from the original bank receipt'}),201);
    assert.equal(reversed.paidMinor,'0');assert.equal(reversed.balanceMinor,'10000');assert.equal(reversed.payments[0].reversedBy,reversed.payments[1].id);
    for(const date of ['2026-01-02','2026-01-10']){
      assert.equal((await f.send('POST',`/invoices/${invoice.id}/payments`,action(reversed.version,{amountMinor:'10000',currency:'USD',paidOn:date,method:'cash'}))).json().error,'posting_balance_conflict');
      assert.equal((await f.send('POST',`/invoices/${invoice.id}/credits`,action(reversed.version,{amountMinor:'10000',issueDate:date,reason:'Backdated credit must not over-settle historical periods'}))).json().error,'posting_balance_conflict');
    }
    assert.equal((await f.ok('GET','/summary?asOf=2026-01-15')).byCurrency[0].receivableMinor,'0');
    const partial=await f.ok('POST',`/invoices/${invoice.id}/payments`,action(reversed.version,{amountMinor:'4000',currency:'USD',paidOn:'2026-02-02',method:'cash'}),201);
    assert.equal(partial.balanceMinor,'6000');
    assert.equal((await f.send('POST',`/invoices/${invoice.id}/payments`,action(partial.version,{amountMinor:'6001',currency:'USD',paidOn:'2026-02-02',method:'cash'}))).json().error,'payment_exceeds_balance');
    const credit=await f.ok('POST',`/invoices/${invoice.id}/credits`,action(partial.version,{amountMinor:'6000',issueDate:'2026-02-02',reason:'Correct unsupplied quantity'}),201);
    assert.equal(credit.correctsInvoiceId,invoice.id);assert.equal(credit.reference,invoice.number);
    assert.equal((await f.ok('GET',`/invoices/${invoice.id}`)).balanceMinor,'0');
    assert.equal((await f.db.query('SELECT count(*) FROM accounting_payments')).rows[0].count,'3');
    assert.equal((await f.db.query('SELECT count(*) FROM accounting_journals WHERE reversal_of IS NOT NULL')).rows[0].count,'1');
  }finally{await f.close();}
});

test('successive one-minor credits at100% tax preserve each original component and full reversal equality',async()=>{
  const f=await fixture();try{
    await f.setup();let invoice=await f.finish(await f.create({kind:'sale',currency:'KWD',lines:[line({quantity:'1',unitPrice:'0.002',taxRateBps:10000})]}));
    assert.equal(invoice.totals.totalMinor,'4');
    const originalLineId=invoice.lines[0].id;let net=0n,tax=0n;
    for(let n=0;n<4;n++){
      const credit=await f.ok('POST',`/invoices/${invoice.id}/credits`,action(invoice.version,{amountMinor:'1',issueDate:day,reason:'Reviewed one-unit partial correction'}),201);
      assert.equal(credit.rounding,'credit_proportional');assert.equal(credit.lines[0].id,originalLineId);
      assert.equal(BigInt(credit.totals.totalMinor),1n);net+=BigInt(credit.totals.netMinor);tax+=BigInt(credit.totals.taxMinor);
      invoice=await f.ok('GET',`/invoices/${invoice.id}`);
    }
    assert.equal(net,2n);assert.equal(tax,2n);assert.equal(invoice.balanceMinor,'0');
    const report=await f.ok('GET',`/reports?asOf=${day}`),trial=report.trialBalance[0];assert.equal(trial.totalDebitMinor,trial.totalCreditMinor);
    assert.ok(trial.accounts.every((a:any)=>a.balanceMinor==='0'));
    assert.equal((await f.db.query("SELECT sum(amount)::text FROM financial_entries WHERE kind='revenue'")).rows[0].sum,'0.000');
    assert.equal((await f.send('POST',`/invoices/${invoice.id}/credits`,action(invoice.version,{amountMinor:'1',issueDate:day,reason:'Cannot over-credit'}))).json().error,'credit_exceeds_balance');
  }finally{await f.close();}
});

test('legacy source adoption preserves historical cash, recognition and project; guards receipts and old correction paths',async()=>{
  const f=await fixture();try{
    await f.setup();
    const project=await f.ok('POST',`${f.prefix}/projects`,{name:'Existing poultry',enterpriseType:'broiler',openingCount:10,countBasis:'verified',asOfDate:'2026-01-01'},201);
    const eventId=randomUUID();await f.ok('POST',`${f.prefix}/projects/${project.id}/events`,{id:eventId,type:'sale',count:1,amount:100,currency:'USD',observedAt:'2026-02-01T10:00:00+02:00'},201);
    const revenue=(await f.db.query("SELECT * FROM financial_entries WHERE source_id=$1 AND kind='revenue'",[eventId])).rows[0];
    const legacyPayment={id:randomUUID(),revenueId:revenue.id,amount:20,currency:'USD',observedAt:'2026-01-15T10:00:00+02:00',note:'Historical customer deposit'};
    await f.ok('POST',`${f.prefix}/projects/${project.id}/payments`,legacyPayment,201);
    const invoice=await f.create({kind:'sale',issueDate:'2026-02-05',dueDate:'2026-03-01',sourceEntryId:revenue.id,lines:[line({quantity:'1',unitPrice:'100',projectId:project.id})]});
    const issued=await f.finish(invoice);assert.equal(issued.issueDate,'2026-02-05');assert.equal(issued.postingDate,'2026-02-01');assert.equal(issued.paidMinor,'2000');assert.equal(issued.balanceMinor,'8000');assert.equal(issued.payments[0].origin,'legacy');assert.equal(issued.payments[0].paidOn,'2026-01-15');
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE kind='revenue'")).rows[0].count,'1');
    const before=await f.ok('GET','/reports?asOf=2026-01-20'),recognized=await f.ok('GET','/reports?asOf=2026-02-02');
    assert.equal(before.summary.byCurrency[0].receivableMinor,'0');assert.equal(before.balanceSheet[0].liabilitiesMinor,'2000');assert.equal(before.balanceSheet[0].assetsMinor,'2000');
    assert.equal(recognized.summary.byCurrency[0].receivableMinor,'8000');assert.equal(recognized.balanceSheet[0].liabilitiesMinor,'0');
    assert.equal((await f.send('POST',`${f.prefix}/projects/${project.id}/payments`,{...legacyPayment,id:randomUUID()})).json().error,'invoice_managed_source');
    assert.equal((await f.send('POST',`${f.prefix}/projects/${project.id}/payments`,legacyPayment)).statusCode,200,'lost-response legacy retry remains a replay');
    assert.equal((await f.send('POST',`/invoices/${issued.id}/void`,action(issued.version,{reason:'Cannot silently undo source'}))).json().error,'invoice_has_payments');
    const expenseId=randomUUID();await f.ok('POST',`${f.prefix}/expenses`,{id:expenseId,projectId:project.id,category:'feed',amount:12.5,currency:'USD',observedAt:'2026-02-01T10:00:00+02:00',note:'Already recorded supplier cost'},201);
    const wrongProject=await f.create({sourceEntryId:expenseId,issueDate:'2026-02-05',lines:[line({quantity:'1',unitPrice:'12.50'})]});
    assert.equal((await f.send('POST',`/invoices/${wrongProject.id}/post`,action(1,{reviewed:true}))).json().error,'source_project_mismatch');
    const bill=await f.finish(await f.create({sourceEntryId:expenseId,issueDate:'2026-02-05',lines:[line({quantity:'1',unitPrice:'12.50',projectId:project.id})]}));
    assert.equal(bill.postingDate,'2026-02-01');
    for(const path of ['corrections','allocations'])assert.equal((await f.send('POST',`${f.prefix}/expenses/${expenseId}/${path}`,path==='corrections'?{id:randomUUID(),reason:'Old correction must use invoice now'}:{id:randomUUID(),allocations:[{projectId:project.id,amount:1,basis:'Reviewed'}]})).json().error,'invoice_managed_source');
    assert.equal((await f.send('POST',`/invoices/${bill.id}/void`,action(bill.version,{reason:'Linked source correction'}))).json().error,'linked_source_requires_credit');
  }finally{await f.close();}
});

test('three-decimal new expenses never enter cent-only allocation and void has exactly one compensating effect',async()=>{
  const f=await fixture();try{
    await f.setup();const bill=await f.finish(await f.create({currency:'KWD',lines:[line({quantity:'1',unitPrice:'1.235'})]}));
    const entry=(await f.db.query('SELECT * FROM financial_entries WHERE source_id=$1',[bill.id])).rows[0];assert.equal(entry.amount,'1.235');
    const project=await f.ok('POST',`${f.prefix}/projects`,{name:'Crop project',crop:'maize',irrigation:false},201);
    assert.equal((await f.send('POST',`${f.prefix}/expenses/${entry.id}/allocations`,{id:randomUUID(),allocations:[{projectId:project.id,amount:1.23,basis:'Cent-only legacy allocation'}]})).json().error,'invoice_managed_source');
    const request=action(bill.version,{reason:'Void incorrect unpaid bill'});
    const voided=await f.ok('POST',`/invoices/${bill.id}/void`,request);assert.equal(voided.balanceMinor,'0');assert.deepEqual(voided.snapshot,bill.snapshot);
    assert.deepEqual(await f.ok('POST',`/invoices/${bill.id}/void`,request),voided);
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE source_type='record_correction' AND source_id=$1",[bill.id])).rows[0].count,'1');
    assert.equal((await f.db.query('SELECT sum(amount)::text FROM financial_entries')).rows[0].sum,'0.000');
    const csv=await f.send('GET','/invoices.csv');assert.equal(csv.statusCode,200);assert.match(csv.body,/1\.235/);
  }finally{await f.close();}
});

test('manual books enforce balanced immutable journals, reserved accounts and locked periods',async()=>{
  const f=await fixture();try{
    await f.setup();const journal={id:randomUUID(),currency:'JPY',postedOn:day,description:'Opening books',reason:'Reviewed opening balances',confirmed:true,lines:[{accountCode:'1000',debitMinor:'100',creditMinor:'0',description:'Counted cash'},{accountCode:'3000',debitMinor:'0',creditMinor:'100',description:'Opening equity'}]};
    const result=await f.ok('POST','/journals',journal,201);assert.equal(result.sourceType,'manual');
    assert.equal((await f.send('POST','/journals',{...journal,id:randomUUID(),lines:[journal.lines[0],{...journal.lines[1],creditMinor:'99'}]})).json().error,'unbalanced_journal');
    assert.equal((await f.send('POST','/accounts',{id:randomUUID(),code:'1000',name:'Hijacked cash',type:'income'})).json().error,'account_exists');
    const reversal=await f.ok('POST',`/journals/${result.id}/reverse`,{id:randomUUID(),postedOn:day,reason:'Correct opening entry',confirmed:true},201);assert.equal(reversal.reversalOf,result.id);
    assert.equal((await f.send('POST',`/journals/${reversal.id}/reverse`,{id:randomUUID(),postedOn:day,reason:'Cannot reverse a compensating journal',confirmed:true})).json().error,'journal_managed_source');
    await f.ok('PUT','/settings',{id:randomUUID(),version:1,business,defaultCurrency:'JPY',invoicePrefix:'INV',taxRates:[],lockedThrough:day,reason:'Close reviewed period'});
    assert.equal((await f.send('POST','/journals',{...journal,id:randomUUID()})).json().error,'period_locked');
    const client=await f.db.connect();try{await client.query('BEGIN');await client.query("INSERT INTO accounting_journals(id,farm_id,created_by,currency,minor_unit,posted_on,description,reason,source_kind,source_id) VALUES($1,$2,$3,'JPY',0,$4,'Unbalanced direct insert','Regression test','manual',$1)",[randomUUID(),f.owner.farmId,f.owner.userId,day]);await assert.rejects(client.query('COMMIT'),(e:any)=>e.code==='23514');}finally{await client.query('ROLLBACK');client.release();}
  }finally{await f.close();}
});

async function waitForBlock(db:pg.Pool,blockingPid:number){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[blockingPid])).rowCount)return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('expected request to reach the held database lock');
}
test('receipt already holding a source lock and concurrent invoice adoption complete without FK lock inversion',async()=>{
  const f=await fixture();let locker:pg.PoolClient|undefined;try{
    await f.setup();const project=await f.ok('POST',`${f.prefix}/projects`,{name:'Sale project',enterpriseType:'broiler',openingCount:10,countBasis:'verified',asOfDate:day},201);
    const eventId=randomUUID();await f.ok('POST',`${f.prefix}/projects/${project.id}/events`,{id:eventId,type:'sale',count:1,amount:100,currency:'USD',observedAt:`${day}T10:00:00+02:00`},201);
    const revenue=(await f.db.query("SELECT id FROM financial_entries WHERE source_id=$1 AND kind='revenue'",[eventId])).rows[0];
    const invoice=await f.create({kind:'sale',sourceEntryId:revenue.id,lines:[line({quantity:'1',unitPrice:'100',projectId:project.id})]});
    locker=await f.db.connect();await locker.query('BEGIN');const blocker=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT id FROM financial_entries WHERE id=$1 FOR UPDATE',[revenue.id]);
    const receipt=f.send('POST',`${f.prefix}/projects/${project.id}/payments`,{id:randomUUID(),revenueId:revenue.id,amount:20,currency:'USD',observedAt:`${day}T11:00:00+02:00`}).then(r=>r);
    await waitForBlock(f.db,blocker);
    const oldPid=(await f.db.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) LIMIT 1',[blocker])).rows[0].pid;
    const adoption=f.send('POST',`/invoices/${invoice.id}/issue`,action(1,{reviewed:true})).then(r=>r);
    await waitForBlock(f.db,oldPid);
    await locker.query('COMMIT');
    const [old,issued]=await Promise.all([receipt,adoption]);assert.equal(old.statusCode,201,old.body);assert.equal(issued.statusCode,200,issued.body);assert.equal(issued.json().paidMinor,'2000');
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE kind='payment'")).rows[0].count,'1');
    assert.equal((await f.db.query("SELECT count(*) FROM accounting_payments WHERE origin='legacy'")).rows[0].count,'1');
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE kind='revenue'")).rows[0].count,'1');
  }finally{if(locker){await locker.query('ROLLBACK');locker.release();}await f.close();}
});

test('a manager waiting to post is denied after role revocation with no financial side effects',async()=>{
  const f=await fixture();let locker:pg.PoolClient|undefined;try{
    await f.setup();const invoice=await f.create({kind:'sale'}),manager=await f.register('manager');
    await f.db.query("INSERT INTO memberships(farm_id,user_id,role) VALUES($1,$2,'manager')",[f.owner.farmId,manager.userId]);
    locker=await f.db.connect();await locker.query('BEGIN');const blocker=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT id FROM farms WHERE id=$1 FOR UPDATE',[f.owner.farmId]);
    const pending=f.send('POST',`/invoices/${invoice.id}/issue`,action(1,{reviewed:true}),manager).then(r=>r);
    await waitForBlock(f.db,blocker);
    await locker.query("UPDATE memberships SET role='worker' WHERE farm_id=$1 AND user_id=$2",[f.owner.farmId,manager.userId]);await locker.query('COMMIT');
    const denied=await pending;assert.equal(denied.statusCode,404,denied.body);
    assert.equal((await f.db.query('SELECT count(*) FROM accounting_journals')).rows[0].count,'0');
    assert.equal((await f.db.query('SELECT count(*) FROM financial_entries')).rows[0].count,'0');
    assert.equal((await f.ok('GET',`/invoices/${invoice.id}`)).status,'draft');
  }finally{if(locker){await locker.query('ROLLBACK');locker.release();}await f.close();}
});

test('historical service deposits and refunds become advances in both farms without replaying operational cash',async()=>{
  const f=await fixture();try{
    await f.setup();const buyer=await f.register('customer');
    const sendAs=async(method:any,path:string,payload:object|undefined,actor:any,status=200)=>{const response=await f.send(method,`/v1/farms/${actor.farmId}${path}`,payload,actor);assert.equal(response.statusCode,status,response.body);return response.json();};
    await sendAs('PUT','/accounting/settings',{id:randomUUID(),version:0,business:{...business,legalName:'Customer farm'},defaultCurrency:'USD',invoicePrefix:'BUY',startingNumber:1,taxRates:[],lockedThrough:null,reason:'Customer books setup'},buyer);
    const serviceId=randomUUID(),bookingId=randomUUID();
    await f.db.query("INSERT INTO service_listings(id,farm_id,created_by,name,description,service_area,rate,currency,rate_basis,operator_included,fuel_included,payload_hash) VALUES($1,$2,$3,'Historical service','Reviewed work','Local',100,'USD','job',true,true,'fixture')",[serviceId,f.owner.farmId,f.owner.userId]);
    await f.db.query("INSERT INTO service_bookings(id,service_id,farm_id,requested_by,starts_at,ends_at,status,amount,currency,payload_hash) VALUES($1,$2,$3,$4,'2026-02-01T08:00:00Z','2026-02-01T12:00:00Z','completed',100,'USD','fixture')",[bookingId,serviceId,buyer.farmId,buyer.userId]);
    const providerEntry=randomUUID(),customerEntry=randomUUID();
    for(const [id,farm,actor,kind] of [[providerEntry,f.owner.farmId,f.owner.userId,'revenue'],[customerEntry,buyer.farmId,buyer.userId,'expense']])await f.db.query("INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,100,'USD','service_booking',$5,'2026-02-01T10:00:00Z')",[id,farm,actor,kind,bookingId]);
    for(const [kind,amount,paidOn] of [['deposit',20,'2026-01-15'],['refund',5,'2026-01-20']] as const){
      const paymentId=randomUUID(),sourceType=kind==='refund'?'manual_service_refund':'manual_service_payment';
      await f.db.query("INSERT INTO service_payment_records(id,booking_id,actor_id,recorded_farm_id,kind,amount,currency,note,status,acknowledged_by,acknowledged_at) VALUES($1,$2,$3,$4,$5,$6,'USD','Historical acknowledged receipt','recorded',$3,$7)",[paymentId,bookingId,f.owner.userId,f.owner.farmId,kind,amount,`${paidOn}T10:00:00Z`]);
      for(const [farm,cashKind] of [[f.owner.farmId,'payment'],[buyer.farmId,'cash_out']])await f.db.query("INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at) VALUES($1,$2,$3,$4,$5,'USD',$6,$7,$8)",[randomUUID(),farm,f.owner.userId,cashKind,kind==='refund'?-amount:amount,sourceType,paymentId,`${paidOn}T10:00:00Z`]);
    }
    const sale=await f.finish(await f.create({kind:'sale',sourceEntryId:providerEntry,issueDate:'2026-02-05',lines:[line({quantity:'1',unitPrice:'100'})]}));
    const purchaseDraft=await sendAs('POST','/accounting/invoices',draft({sourceEntryId:customerEntry,issueDate:'2026-02-05',lines:[line({quantity:'1',unitPrice:'100'})]}),buyer,201);
    const purchase=await sendAs('POST',`/accounting/invoices/${purchaseDraft.id}/post`,action(1,{reviewed:true}),buyer);
    for(const invoice of [sale,purchase]){assert.equal(invoice.paidMinor,'1500');assert.equal(invoice.balanceMinor,'8500');assert.deepEqual(invoice.payments.map((p:any)=>p.amountMinor),['2000','-500']);}
    const providerBefore=await f.ok('GET','/reports?asOf=2026-01-21');assert.equal(providerBefore.balanceSheet[0].liabilitiesMinor,'1500');assert.equal(providerBefore.summary.byCurrency[0].receivableMinor,'0');
    const customerBefore=await sendAs('GET','/accounting/reports?asOf=2026-01-21',undefined,buyer);assert.equal(customerBefore.trialBalance[0].accounts.find((a:any)=>a.code==='1500').balanceMinor,'1500');assert.equal(customerBefore.summary.byCurrency[0].payableMinor,'0');
    const customerAfter=await sendAs('GET','/accounting/reports?asOf=2026-02-02',undefined,buyer);assert.equal(customerAfter.summary.byCurrency[0].payableMinor,'8500');assert.equal(customerAfter.trialBalance[0].accounts.find((a:any)=>a.code==='1500').balanceMinor,'0');
    const paid=await f.ok('POST',`/invoices/${sale.id}/payments`,action(sale.version,{amountMinor:'1000',currency:'USD',paidOn:'2026-02-05',method:'cash'}),201);assert.equal(paid.balanceMinor,'7500');
    const summary=await f.ok('GET',`${f.prefix}/bookings/${bookingId}/payments`);assert.equal(summary.accountingManaged,true);assert.equal(summary.accountingInvoiceId,sale.id);assert.equal(summary.manuallyRecordedPaid,25);assert.equal(summary.outstanding,75);
    const blocked=await f.send('POST',`${f.prefix}/bookings/${bookingId}/payments`,{id:randomUUID(),kind:'balance',amount:10,currency:'USD',note:'Use managed invoice instead'});assert.equal(blocked.json().error,'invoice_managed_source');assert.equal(blocked.json().details,undefined,'other farm invoice identifiers are not disclosed');
    assert.equal((await f.db.query('SELECT count(*) FROM financial_entries')).rows[0].count,'7');assert.equal((await f.db.query('SELECT count(*) FROM service_payment_records')).rows[0].count,'2');
  }finally{await f.close();}
});

test('three-decimal historical source, invoice and manual payment retain exact units in API, exports and legacy views',async()=>{
  const f=await fixture();try{
    await f.setup();const sourceId=randomUUID();
    await f.db.query("INSERT INTO financial_entries(id,farm_id,actor_id,kind,amount,currency,source_type,source_id,observed_at,note,category) VALUES($1,$2,$3,'expense',1.235,'KWD','documented_expense',$1,$4,'Exact historical expense','feed')",[sourceId,f.owner.farmId,f.owner.userId,`${day}T10:00:00Z`]);
    const source=(await f.ok('GET','/sources?kind=purchase')).items.find((row:any)=>row.id===sourceId);assert.equal(source.amountMinor,'1235');assert.equal(source.eligible,true);
    const bill=await f.finish(await f.create({sourceEntryId:sourceId,currency:'KWD',lines:[line({quantity:'1',unitPrice:'1.235'})]}));
    const paid=await f.ok('POST',`/invoices/${bill.id}/payments`,action(bill.version,{amountMinor:'1',currency:'KWD',paidOn:day,method:'bank'}),201);assert.equal(paid.balanceMinor,'1234');assert.equal(paid.payments[0].amountMinor,'1');
    assert.equal((await f.db.query("SELECT amount::text FROM financial_entries WHERE source_type='accounting_payment'")).rows[0].amount,'0.001');
    const expenses=(await f.ok('GET',`${f.prefix}/expenses`)).items;assert.equal(expenses[0].amount,'1.235');assert.equal(expenses[0].accountingInvoiceId,bill.id);assert.equal(expenses[0].accountingManaged,true);
    const csv=await f.send('GET','/ledger.csv');assert.equal(csv.statusCode,200);assert.match(csv.body,/0\.001/);assert.match(csv.body,/1\.235/);
    const invoices=await f.send('GET','/invoices.csv');assert.equal(invoices.statusCode,200);assert.match(invoices.body,/1\.234/);
    assert.equal((await f.db.query("SELECT count(*) FROM financial_entries WHERE kind='expense'")).rows[0].count,'1');
  }finally{await f.close();}
});
