import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allPages} from '../src/lib/pages.ts';
import {displayDate, displayTime, displayNumber, displayMoney} from '../src/lib/time.ts';
import {catalog, errorLabel} from '../src/locales.ts';
import {isQueueable, drainOutbox} from '../src/lib/sync.ts';
import {Vault} from '../src/lib/vault.ts';

test('working lists follow every cursor and reject a repeated cursor instead of silently truncating', async () => {
 const called=[];
 const items=await allPages(async path=>{called.push(path);return path.includes('cursor=')?{items:[{id:'b'}],nextCursor:null}:{items:[{id:'a'}],nextCursor:'after first'};},'/v1/farms/one/stock?projectId=project');
 assert.deepEqual(items.map(item=>item.id),['a','b']);assert.equal(called.length,2);assert.ok(called[1].includes('&cursor=after%20first'));
 await assert.rejects(allPages(async()=>({items:[],nextCursor:'same'}),'/v1/farms/one/activities'),/pagination_failed/);
});

test('both supported languages use farm-zone numeric dates without English month fallback and keep missing money unknown',()=>{
 for(const lang of ['sn','nd']){
  assert.equal(displayTime('2026-11-03T23:30:00Z',lang,'Africa/Harare'),'04/11/2026 01:30');
  assert.equal(displayDate('2026-11-03',lang),'03/11/2026');assert.equal(displayDate('2026-02-30',lang),'—');
  assert.equal(displayMoney(null,'USD',lang),'—');assert.equal(displayNumber(undefined,lang),'—');assert.ok(displayMoney(0,'USD',lang).includes('0.00'));
  for(const code of ['schedule_preview_required','payment_exceeds_balance','historical_record_required','verification_retry_later','animal_identity_reserved','stock_reconciliation_required'])assert.notEqual(errorLabel(catalog[lang],new Error(code)),code);
 }
});

test('sourced observations may queue; approval, stock transfer, financial valuation and camera sessions never queue',()=>{
 for(const path of ['/v1/farms/f/projects/p/records','/v1/farms/f/weather/observations','/v1/farms/f/assets/a/usage'])assert.equal(isQueueable(path,'POST'),true,path);
 for(const path of ['/v1/farms/f/projects/p/plans','/v1/farms/f/projects/p/plans/a/approve','/v1/farms/f/stock/s/transfers','/v1/farms/f/stock/s/valuations','/v1/farms/f/cameras/c/sessions','/v1/farms/f/bookings/b/payments','/v1/farms/f/node-red/gateways/g/packages/install','/v1/farms/f/node-red/gateways/g/packages/review','/v1/farms/f/node-red/gateways/g/packages/reconcile'])assert.equal(isQueueable(path,'POST'),false,path);
});

test('transient transaction retry stays queued while a version conflict preserves the server record for human review',async()=>{
 const values=new Map();const store={async get(key){return structuredClone(values.get(key));},async set(key,value){values.set(key,structuredClone(value));},async remove(key){values.delete(key);}};
 const snapshot={version:1,identity:{userId:'person',username:'person',token:'test-token',language:'sn',expiresAt:'2099-01-01T00:00:00Z'},language:'sn',farms:[],currentFarmId:'farm',data:{},outbox:[]};
 const vault=await Vault.unlock('https://fixture.invalid','person','temporary-test-password',snapshot,store);
 await vault.mutate(next=>next.outbox.push({id:'record',farmId:'farm',path:'/v1/farms/farm/activities',method:'POST',payload:{id:'record'},label:'observation',status:'pending',attempts:0,createdAt:new Date().toISOString()}));
 await drainOutbox(vault,async()=>{throw Object.assign(new Error('retry_transaction'),{status:409});},false,()=>1000);assert.equal(vault.snapshot().outbox[0].status,'pending');
 const current={id:'task',version:3,status:'started',evidence:'Other worker evidence'};
 await drainOutbox(vault,async()=>{throw Object.assign(new Error('version_conflict'),{status:409,details:{current}});},false,()=>999999);assert.equal(vault.snapshot().outbox[0].status,'conflict');assert.deepEqual(vault.snapshot().outbox[0].conflictCurrent,current);
});
