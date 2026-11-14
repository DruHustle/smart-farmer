// Qualification only: operate the already-open OS Chrome tab, never inject a callback.
import assert from 'node:assert/strict';
import {waitForVisibleFixturePage} from './chrome-tab.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute,basename} from 'node:path';
const {chromium}=createRequire(new URL('../../../web/package.json',import.meta.url))('playwright');
const [role,state,ready,device,targetReceipt]=process.argv.slice(2);
assert(['cancel','member','admin'].includes(role));
assert(['cancel','cold','active'].includes(state));
assert(/^emulator-\d+$/.test(device||''),'Use the isolated qualification emulator');
assert(isAbsolute(targetReceipt||'')&&basename(targetReceipt)==='browser-target.json','Expected private phase receipt path');
const fixture=JSON.parse(readFileSync(ready,'utf8'));
function origin(name,fallback){const value=process.env[name]||fallback,url=new URL(value);assert(url.origin===value&&url.protocol==='https:'&&url.port&&['localhost','127.0.0.1'].includes(url.hostname),'Expected exact fixture HTTPS loopback origin');return value;}
const portalOrigin=origin('PORTAL_TEST_ORIGIN','https://localhost:46501');
const farmerOrigin=origin('FARMER_TEST_ORIGIN','https://127.0.0.1:46502');
const adb=(...args)=>execFileSync('adb',['-s',device,...args],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function keyboardShown(){
  const current=adb('shell','dumpsys input_method | sed -n "/mInputShown=/p"').trim();
  const match=/^mInputShown=(true|false)$/.exec(current);
  assert(match,'Expected exactly one current Android keyboard-state field');
  return match[1]==='true';
}
async function dismissObservedKeyboard(){
  if(!keyboardShown())return;
  adb('shell','input','keyevent','4');
  const until=Date.now()+5000;
  while(Date.now()<until){if(!keyboardShown())return;await pause(100);}
  throw Error('Observed Android browser keyboard did not dismiss');
}
let port;
let stage = 'connect';
async function run(){
  port=adb('forward','tcp:0','localabstract:chrome_devtools_remote').trim();
  assert(/^\d+$/.test(port)&&Number(port)>0&&Number(port)<65536);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  stage = 'visible-tab';
  const page = await waitForVisibleFixturePage(browser, [portalOrigin, farmerOrigin]);
  page.setDefaultTimeout(30000);
  const email=fixture[role==='admin'?'ADMIN_EMAIL':'MEMBER_EMAIL'];
  if(state==='cancel'){
    stage = 'cancel';
    await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
  }else if(state==='cold'){
    stage = 'credential-entry';
    await page.getByLabel('Email address',{exact:true}).fill(email);
    await page.getByLabel('Password',{exact:true}).fill(fixture.PASSWORD);
    stage = 'dismiss-keyboard';
    await dismissObservedKeyboard();
    stage = 'read-back-email';
    assert.equal(await page.getByLabel('Email address',{exact:true}).inputValue(),email);
    stage = 'remember-device';
    await page.getByLabel('Remember this browser',{exact:true}).check();
    stage = 'submit-credentials';
    await page.getByRole('button',{name:'Continue',exact:true}).click();
    if(role==='admin'){
      stage = 'mfa-entry';
      await page.getByLabel('Authenticator or recovery code',{exact:true}).fill(fixture.ADMIN_MFA);
      stage = 'mfa-keyboard';
      await dismissObservedKeyboard();
      stage = 'mfa-submit';
      await page.getByRole('button',{name:'Continue',exact:true}).click();
    }
  }else{
    stage = 'warm-account';
    const active=page.getByRole('button',{name:'Continue as '+email,exact:true});
    if(await active.isVisible())await active.click();
  }
  stage = 'return-bridge';
  const link=page.getByRole('link',{name:/^(Dzokera muSmart Farmer|Buyela ku-Smart Farmer)$/});
  await link.waitFor({state:'visible'});
  const returnLocation=new URL(page.url());
  assert.equal(returnLocation.origin,farmerOrigin);
  // Auth.tsx clears the callback URL to / before displaying the native bridge.
  assert.equal(returnLocation.pathname,'/');
  assert.equal(returnLocation.search+returnLocation.hash,'');
  stage = 'target-receipt';
  const targetSession=await page.context().newCDPSession(page);
  const {targetInfo}=await targetSession.send('Target.getTargetInfo');
  await targetSession.detach();
  // Only an opaque debugging ID is retained. Cleanup is invoked by the runner
  // after native UI, membership and stable-identity assertions have all passed.
  writeFileSync(targetReceipt,JSON.stringify({version:1,device,targetId:targetInfo.targetId,origin:farmerOrigin,pathname:returnLocation.pathname}),{mode:0o600,flag:'wx'});
  // This link hands control to another app, not a completed web navigation.
  // Older OS Chrome can keep that navigation pending after MainActivity opens.
  // The foreground-app fence below and native completion flow verify the return.
  stage = 'native-return';
  await link.click({noWaitAfter:true});
  const until=Date.now()+20000;let activated=false;
  while(Date.now()<until){
    if(/topResumedActivity=.*eu\.onesa\.smartfarmer\/\.MainActivity/.test(adb('shell','dumpsys activity activities | sed -n "/topResumedActivity=/p"'))){activated=true;break;}
    await pause(250);
  }
  assert(activated,'Actual browser link must activate the registered Farmer app');
  console.log(JSON.stringify({role,state,realOsChrome:true,browserVersion:browser.version(),credentialEntry:state==='cold',mfa:state==='cold'&&role==='admin',registeredAppActivated:true,callbackUrlInjected:false}));
}
let failed=false;
try{await run();}catch(error){
  failed=true;
  console.error('ONESA_BROWSER_FAILED_STAGE '+stage);
  let message=String(error?.message||'Browser qualification failed').replace(/(?:https?|smartfarmer):\/\/\S+/g,'[private flow URL]');
  for(const value of [fixture.MEMBER_EMAIL,fixture.ADMIN_EMAIL,fixture.PASSWORD,fixture.ADMIN_MFA])if(value)message=message.split(value).join('[synthetic fixture value]');
  console.error(message.slice(0,3000));
}finally{
  if(port)try{adb('forward','--remove','tcp:'+port);}catch{failed=true;console.error('Could not remove owned Chrome debug forward');}
}
// Disconnect this test client without closing the OS browser or its remembered session.
process.exit(failed?1:0);
