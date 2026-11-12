// Close only this completed qualification page after the native tail passes.
// Keep the real OS browser, context and remembered Portal cookies for warm SSO.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openSync,readFileSync,fstatSync,closeSync,constants} from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../../web/package.json',import.meta.url))('playwright');
const [device,receiptPath]=process.argv.slice(2);
assert(/^emulator-\d+$/.test(device||''),'Use the isolated qualification emulator');
const fd=openSync(receiptPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
let receipt;
try{
  const stat=fstatSync(fd);
  assert(stat.isFile()&&stat.size<=4096&&(stat.mode&0o077)===0,'Expected bounded private target receipt');
  receipt=JSON.parse(readFileSync(fd,'utf8'));
}finally{closeSync(fd);}
const origin=process.env.FARMER_TEST_ORIGIN||'https://127.0.0.1:46502',url=new URL(origin);
assert(url.origin===origin&&url.protocol==='https:'&&url.port&&['localhost','127.0.0.1'].includes(url.hostname));
assert(receipt.version===1&&receipt.device===device&&receipt.origin===origin&&receipt.pathname==='/auth/onesa/callback');
assert(typeof receipt.targetId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(receipt.targetId));
const adb=(...args)=>execFileSync('adb',['-s',device,...args],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
let port,failed=false;
try{
  assert(/topResumedActivity=.*eu\.onesa\.smartfarmer\/\.MainActivity/.test(adb('shell','dumpsys activity activities | sed -n "/topResumedActivity=/p"')),'Native app must remain foreground after its successful tail');
  port=adb('forward','tcp:0','localabstract:chrome_devtools_remote').trim();
  assert(/^\d+$/.test(port)&&Number(port)>0&&Number(port)<65536);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  const session=await browser.newBrowserCDPSession();
  const {targetInfos}=await session.send('Target.getTargets');
  const matches=targetInfos.filter(target=>target.targetId===receipt.targetId);
  assert(matches.length<=1);
  if(matches.length){
    const target=matches[0],location=new URL(target.url);
    assert(target.type==='page'&&location.origin===origin&&location.pathname==='/auth/onesa/callback','Only the recorded completed Farmer bridge may close');
    const result=await session.send('Target.closeTarget',{targetId:receipt.targetId});
    assert.equal(result.success,true);
  }
  console.log(JSON.stringify({completedOwnedPageClosed:true,alreadyClosed:matches.length===0,browserAndCookiesPreserved:true}));
}catch{
  failed=true;console.error('Completed browser-page cleanup failed; private receipt retained');
}finally{
  if(port)try{adb('forward','--remove','tcp:'+port);}catch{failed=true;console.error('Could not remove owned Chrome debug forward');}
}
process.exit(failed?1:0);
