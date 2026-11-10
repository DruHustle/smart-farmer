/** Focused Forum acceptance; the ordinary browser suite also runs these same journeys. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {catalog} from '../src/locales.ts';
import {forumJourneys} from './browser-forum.mjs';

if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL must identify an isolated disposable database.');
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),backend=resolve(web,'../../smart-farmer-backend');
const api='http://127.0.0.1:3000',ui='http://127.0.0.1:4173';
const artifacts=process.env.TEST_ARTIFACTS_DIR||resolve(web,'test-artifacts/forum');await mkdir(artifacts,{recursive:true});
const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,WEB_ORIGIN:ui,PORT:'3000',HOST:'127.0.0.1',LOG_LEVEL:'warn'};
const children=[],passed=[],errors=[];let browser,page,stage='setup';
function spawnCommand(command,args,cwd){const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',part=>{log+=part;});child.stderr.on('data',part=>{log+=part;});children.push({child,log:()=>log});return {child,log:()=>log};}
async function command(command,args,cwd){const item=spawnCommand(command,args,cwd);await new Promise((ok,fail)=>{item.child.once('error',fail);item.child.once('close',code=>code===0?ok():fail(new Error(`${command} failed (${code})\n${item.log()}`)));});}
async function waitUrl(url){for(let n=0;n<100;n++){try{if((await fetch(url,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`Not ready: ${url}`);}
async function apiCall(path,body,token='',method=body===undefined?'GET':'POST'){
  const response=await fetch(api+path,{method,signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=response.status===204?null:await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;
}
const watchdog=setTimeout(()=>{for(const {child} of children)child.kill('SIGTERM');console.error(`Forum browser exceeded 240 seconds at ${stage}`);process.exit(1);},240000);watchdog.unref();
try{
  await command('npm',['run','build'],backend);await command('npm',['run','migrate'],backend);await command('npm',['run','build'],web);
  spawnCommand(process.execPath,['dist/server.js'],backend);spawnCommand(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173','--strictPort'],web);
  await Promise.all([waitUrl(api+'/ready'),waitUrl(ui)]);
  const unique=Date.now().toString(36),username='forum_owner_'+unique,password='Forum-owner-fixture-2026';
  await apiCall('/v1/register',{username,password,language:'sn',farmName:'Private Forum owner farm'});
  const session=await apiCall('/v1/sessions',{username,password}),farm=(await apiCall('/v1/farms',undefined,session.token)).items[0];
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:existsSync(chromium.executablePath())?{}:existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{}),args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:390,height:844}});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(ui);await page.getByLabel(catalog.sn.username,{exact:true}).fill(username);await page.getByLabel(catalog.sn.password,{exact:true}).fill(password);await page.getByRole('button',{name:catalog.sn.continue,exact:true}).click();await page.locator('.farm-switch').waitFor({state:'visible'});
  await forumJourneys({page,context,apiCall,farm,token:session.token,sn:catalog.sn,nd:catalog.nd,unique,artifacts,checkpoint:value=>{stage=value;console.log('STEP: '+value);},pass:value=>{passed.push(value);console.log('PASS: '+value);}});
  assert.deepEqual(errors,[]);await writeFile(resolve(artifacts,'results.json'),JSON.stringify({status:'passed',passed,backend:'real isolated PostgreSQL',generatedAt:new Date().toISOString()},null,2));
  console.log('Forum browser evidence: '+artifacts);
}catch(error){
  await writeFile(resolve(artifacts,'results.json'),JSON.stringify({status:'failed',stage,passed,error:String(error)},null,2));
  await writeFile(resolve(artifacts,'failure.log'),[String(error),...children.map(item=>item.log())].join('\n\n'));
  if(page){await page.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(artifacts,'failure.txt'),await page.locator('body').innerText().catch(()=>''));}
  console.error(error);process.exitCode=1;
}finally{if(browser)await browser.close();for(const {child} of children)child.kill('SIGTERM');clearTimeout(watchdog);}
