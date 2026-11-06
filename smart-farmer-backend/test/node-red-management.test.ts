import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {ApiError} from '../src/context.js';
import {NodeRedClient} from '../src/node-red/client.js';
import {NodeRedPackageService} from '../src/node-red/service.js';
import {nodeRedConfigurations,NodeRedError} from '../src/node-red/configuration.js';
import {packageSelection} from '../src/node-red/types.js';
import {actor,gateway,selection,enrollment,environment,configurations,memoryStore,runtimeFixture,waitForOutcome,installBody} from './node-red-fixture.js';

test('registry selection rejects path, archive, alias, command, tag and range forms',()=>{
  for(const module of ['../private','/tmp/nodes','file:./nodes','https://bad.test/p.tgz','git+ssh://bad.test/repo','npm:other','package@latest','@scope/../package','pkg;id','pkg%2fother','node-red','--help'])
    assert.equal(packageSelection.safeParse({...selection,module}).success,false,module);
  for(const version of ['latest','next','^1.2.3','~1.2.3','1.x','1.2','>=1.2.3','1.2.3 || 2.0.0','v1.2.3','01.2.3','1.2.3-01','1.2.3;id','npm:alias@1.2.3'])
    assert.equal(packageSelection.safeParse({...selection,version}).success,false,version);
  assert.equal(packageSelection.safeParse({...selection,version:'1.2.3-rc.1+build.7'}).success,true);
  for(const extra of [{url:'https://bad.test/file.tgz'},{path:'/tmp/module'},{command:'id'}])
    assert.equal(packageSelection.safeParse({...selection,...extra}).success,false);
});
test('enrollment is optional, private, farm-derived, exact-version and unique by runtime and route',()=>{
  assert.deepEqual(nodeRedConfigurations({}),[]);
  assert.equal(configurations()[0].farmId,actor.farmId);
  for(const adminUrl of ['http://localhost:1880/admin','http://192.168.1.2:1880/admin','https://bad.test/admin','http://u:p@127.0.0.1:1880/admin','http://127.0.0.1:1880/admin?token=x','http://127.0.0.1:1880/flows'])
    assert.throws(()=>nodeRedConfigurations(environment({[gateway]:{...enrollment,adminUrl}})),NodeRedError);
  assert.throws(()=>nodeRedConfigurations(environment({[gateway]:{...enrollment,version:'4.1.5'}})),NodeRedError);
  assert.throws(()=>nodeRedConfigurations(environment({missing:enrollment})),NodeRedError);
  const farms={[gateway]:actor.farmId,other:randomUUID()};
  assert.throws(()=>nodeRedConfigurations(environment({[gateway]:enrollment,other:{...enrollment,runtimeId:enrollment.runtimeId.toUpperCase(),adminUrl:'http://127.0.0.1:18881/admin'}},farms)),NodeRedError);
  assert.throws(()=>nodeRedConfigurations(environment({[gateway]:enrollment,other:{...enrollment,runtimeId:randomUUID()}},farms)),NodeRedError);
  const next=nodeRedConfigurations(environment({[gateway]:enrollment},{[gateway]:randomUUID()}));
  assert.notEqual(next[0].target.revision,configurations()[0].target.revision);
});
test('status uses only pinned no-redirect requests and never exposes server credentials or routes',async()=>{
  const {store}=memoryStore(),runtime=runtimeFixture();
  const service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const status=await service.status(actor,gateway);
  assert.equal(status.state,'ready');
  for(const secret of [enrollment.token,actor.sessionHash,'127.0.0.1'])assert.ok(!JSON.stringify(status).includes(secret));
  for(const {init} of runtime.calls){assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);}
});
test('runtime identity, version, permissions and add-only policy are mandatory',async()=>{
  for(const change of [
    {runtimeId:randomUUID()},{runtimeVersion:'4.1.5'},{permissions:['*']},
    {palette:{allowInstall:true,allowUpdate:true,allowUpload:false}},
    {palette:{allowInstall:true,allowUpdate:false,allowUpload:true}}
  ]){
    const runtime=runtimeFixture();Object.assign(runtime.state,change);
    await assert.rejects(new NodeRedClient(configurations()[0],runtime.fetcher).checkRuntime(),NodeRedError);
    assert.equal(runtime.state.posts,0);
  }
});
test('streamed management responses are bounded without content-length',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(600_000));},cancel(){cancelled=true;}});
  const fetcher:typeof fetch=async()=>new Response(body,{headers:{'content-type':'application/json','x-smart-farmer-node-red-runtime':enrollment.runtimeId}});
  await assert.rejects(new NodeRedClient(configurations()[0],fetcher).checkRuntime(),/size limit/);
  assert.equal(cancelled,true);
});
test('general npm dependencies and mismatched registry names are refused before installation',async()=>{
  for(const metadata of [{name:selection.module,version:selection.version},{name:'different',version:selection.version,'node-red':{nodes:{test:'node.js'}}}]){
    const runtime=runtimeFixture();runtime.state.metadata=metadata;
    const {store}=memoryStore(),service=new NodeRedPackageService(store,configurations,runtime.fetcher);
    await assert.rejects(service.review(actor,gateway,selection),/Node-RED node library/);
    assert.equal(runtime.state.posts,0);
  }
});
for(const pluginOnly of [false,true])test('one exact installation with durable replay, plugin-only='+pluginOnly,async()=>{
  const {store}=memoryStore(),runtime=runtimeFixture();runtime.state.pluginOnly=pluginOnly;
  const service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection),request=installBody(review.reviewToken);
  assert.equal((await service.install(actor,gateway,request)).state,'installing');
  assert.equal((await waitForOutcome(store)).state,'installed');
  assert.equal(runtime.state.posts,1);
  const post=runtime.calls.find(call=>call.init.method==='POST')!;
  assert.equal(post.url,enrollment.adminUrl+'/nodes');
  assert.deepEqual(JSON.parse(String(post.init.body)),selection);
  const registry=runtime.calls.find(call=>call.url.startsWith('https://registry.npmjs.org/'))!;
  assert.equal(new Headers(registry.init.headers).has('Authorization'),false);
  const replay=await service.install(actor,gateway,request);
  assert.equal(replay.state,'installed');assert.equal(runtime.state.posts,1);
  for(const secret of [actor.sessionHash,enrollment.token,'/private/'])assert.ok(!JSON.stringify({review,replay}).includes(secret));
});
test('review is bound to actor, opaque session, farm, gateway and configuration',async()=>{
  const {store,control}=memoryStore(),runtime=runtimeFixture(),service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection),request=installBody(review.reviewToken);
  for(const who of [{...actor,id:randomUUID()},{...actor,sessionHash:'c'.repeat(64)},{...actor,farmId:randomUUID()}])
    await assert.rejects(service.install(who,gateway,request),NodeRedError);
  await assert.rejects(service.install(actor,'other-gateway',request),NodeRedError);
  const changed=new NodeRedPackageService(store,()=>nodeRedConfigurations(environment({[gateway]:{...enrollment,adminUrl:'http://127.0.0.1:18881/admin'}})),runtime.fetcher);
  await assert.rejects(changed.install(actor,gateway,request),/no longer matches/);
  assert.equal(control.claims,0);assert.equal(runtime.state.posts,0);
});
test('acknowledgement, authentic review signature and expiry are required',async()=>{
  const {store,control}=memoryStore(),runtime=runtimeFixture(),service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection),request=installBody(review.reviewToken);
  await assert.rejects(service.install(actor,gateway,{...request,acknowledgeCodeExecution:false} as never));
  for(const token of [request.reviewToken+'extra',request.reviewToken.split('.')[0]+'.'+'é'.repeat(43)])
    await assert.rejects(service.install(actor,gateway,{...request,reviewToken:token}),/invalid/);
  const payload=JSON.parse(Buffer.from(review.reviewToken.split('.')[0],'base64url').toString());payload.expires=Date.now()-1;
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature=createHmac('sha256',enrollment.token).update(actor.sessionHash).update('.').update(body).digest('base64url');
  await assert.rejects(service.install(actor,gateway,{...request,reviewToken:body+'.'+signature}),/expired/);
  assert.equal(control.claims,0);
});
test('a package appearing after review is never upgraded or reinstalled',async()=>{
  const {store}=memoryStore(),runtime=runtimeFixture(),service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection);
  runtime.state.installed=true;runtime.state.wrongVersion=true;
  await service.install(actor,gateway,installBody(review.reviewToken));
  assert.equal((await waitForOutcome(store)).state,'failed');assert.equal(runtime.state.posts,0);
});
for(const path of ['settings','nodes','plugins'] as const)test('accepted POST followed by '+path+' 401 stays unconfirmed and blocks another install',async()=>{
  const {store}=memoryStore(),runtime=runtimeFixture();runtime.state.failReadback=path;
  const service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection),request=installBody(review.reviewToken);
  await service.install(actor,gateway,request);
  const outcome=await waitForOutcome(store);
  assert.equal(outcome.state,'unconfirmed');assert.equal(runtime.state.posts,1);
  await assert.rejects(service.install(actor,gateway,{...request,requestId:randomUUID()}),/pending or unconfirmed/);
  assert.ok(!JSON.stringify(outcome).includes('secret-value'));
});
test('only authoritative POST auth refusal fails; lost response survives restart without replay',async()=>{
  for(const postFailure of ['refused','lost'] as const){
    const {store}=memoryStore(),runtime=runtimeFixture();runtime.state.postFailure=postFailure;
    const service=new NodeRedPackageService(store,configurations,runtime.fetcher);
    const review=await service.review(actor,gateway,selection),request=installBody(review.reviewToken);
    await service.install(actor,gateway,request);
    assert.equal((await waitForOutcome(store)).state,postFailure==='refused'?'failed':'unconfirmed');
    if(postFailure==='lost'){
      const restarted=new NodeRedPackageService(store,configurations,runtime.fetcher);
      assert.equal((await restarted.status(actor,gateway)).operation?.id,request.requestId);
      assert.equal((await restarted.reconcile(actor,gateway))?.state,'unconfirmed');
      await assert.rejects(restarted.install(actor,gateway,{...request,requestId:randomUUID()}),/pending or unconfirmed/);
      runtime.state.installed=true;
      assert.equal((await restarted.reconcile(actor,gateway))?.state,'installed');
    }
    assert.equal(runtime.state.posts,1);
  }
});
test('wrong installed version, pending version and reported load errors keep uncertainty',async()=>{
  for(const problem of [{wrongVersion:true},{pendingVersion:'1.2.3'},{loadError:true}]){
    const {store}=memoryStore(),runtime=runtimeFixture();Object.assign(runtime.state,problem);
    const service=new NodeRedPackageService(store,configurations,runtime.fetcher);
    const review=await service.review(actor,gateway,selection);
    await service.install(actor,gateway,installBody(review.reviewToken));
    assert.equal((await waitForOutcome(store)).state,'unconfirmed');
  }
});
test('owner authority revoked after durable reservation prevents the remote POST',async()=>{
  const {store,control}=memoryStore(),runtime=runtimeFixture(),service=new NodeRedPackageService(store,configurations,runtime.fetcher);
  const review=await service.review(actor,gateway,selection);
  runtime.state.beforeRequest=async()=>{control.authorizationError=new ApiError('owner_required',403);};
  await service.install(actor,gateway,installBody(review.reviewToken));
  assert.equal((await waitForOutcome(store)).state,'failed');assert.equal(runtime.state.posts,0);
});
