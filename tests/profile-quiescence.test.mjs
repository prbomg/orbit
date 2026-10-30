import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { quiesceProfilePages } from '../worker/profile-quiescence.mjs';
import { createMobileContext,stageMobileProfile } from '../worker/profiles.mjs';
import { verifySessionAfterRestart } from '../worker/session-restart-check.mjs';
import { mobileProfileFixture } from './helpers/mobile-profile-fixture.mjs';
import { inspectReadingBlock } from '../worker/reading-semantics.mjs';
const launch={headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH};

test('reading a document without a body gives no content instead of terminating warmup',async()=>{
 const browser=await chromium.launch(launch);
 try{const page=await browser.newPage();await page.setContent('<body>Temporary</body>');await page.evaluate(()=>document.body.remove());assert.deepEqual(await inspectReadingBlock(page),{words:0,kind:'text'});}finally{await browser.close();}
});
test('terminal snapshot stops live documents and verifies native storage without running the installed ServiceWorker', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-quiescence-'));let context;
 const requests=[];
 const server=createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/sw.js') {res.setHeader('Content-Type','text/javascript');res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(new Response('<script>localStorage.setItem("unexpected-worker-script","executed")</script>',{headers:{'Content-Type':'text/html'}}));});`);return;}
  res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','public,max-age=86400');res.end('<main>Local saved content</main><script>localStorage.setItem("donor-script","executed")</script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try {
  const profile=mobileProfileFixture('quiescence-fixture');
  context=await chromium.launchPersistentContext(join(dir,'native'),launch);
  await createMobileContext(context.browser(),profile,undefined,context,true);
  const page=await context.newPage();await page.goto(origin);
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;await new Promise(resolve=>navigator.serviceWorker.controller?resolve():navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));localStorage.setItem('retained','yes');addEventListener('pagehide',()=>{localStorage.setItem('lifecycle-state','closed');navigator.sendBeacon('/unexpected-close-beacon');});setInterval(()=>{const value=String(Date.now());localStorage.setItem('clock',value);document.cookie='clock='+value+';path=/';},5);});
  await quiesceProfilePages(context);
  assert.equal(page.isClosed(),false,'original Network target must remain attached until browser closes');assert.ok(context.pages().every(p=>p.url()==='about:blank'));
  const staged=await stageMobileProfile(dir,profile,context,{storageMode:'persistent'});
  await context.close();context=null;const before=requests.length;
  const report=await verifySessionAfterRestart(staged,{launchOptions:{...launch,proxy:{server:origin}},persistentPath:join(dir,'native'),onBrowser:async browser=>{
   const probe=await browser.contexts()[0].newPage();
   // This callback precedes context.setOffline. The inherited proxy must still
   // receive no request, including before target-level offline is installed.
   try{await probe.goto('http://network-escape.fixture.test',{timeout:2000});}catch{}
   finally{await probe.close();}
  }});
  assert.equal(report.status,'passed');assert.equal(requests.length,before,'verification must not contact the donor');
  const snapshotReport=await verifySessionAfterRestart(staged,{launchOptions:{...launch,proxy:{server:origin}},onBrowser:async browser=>{
   const probe=await browser.contexts()[0].newPage();
   try{await probe.goto('http://network-escape.fixture.test',{timeout:2000});}catch{}
   finally{await probe.close();}
  }});
  assert.equal(snapshotReport.status,'passed');assert.equal(requests.length,before,'snapshot startup must never use the inherited proxy');
  assert.ok(!staged.snapshot.origins.some(o=>o.localStorage.some(e=>e.name==='unexpected-worker-script')));
  assert.ok(!requests.includes('/unexpected-close-beacon'));
  assert.equal(report.missingLocalStorageEntries,0);
  context=await chromium.launchPersistentContext(join(dir,'native'),launch);const check=await context.newPage();await check.goto(origin);
  assert.equal(await check.evaluate(()=>localStorage.getItem('retained')),'yes');
  assert.equal(await check.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistrations()).length)),true,'verification must retain installed registrations');
  await staged.discard();
 }finally{await context?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('cancelled terminal save never creates a page',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(quiesceProfilePages({newPage:async()=>assert.fail('cancelled save created a page')},{signal:controller.signal}),{name:'AbortError'});
});
test('storage read diagnostics expose a phase but never the underlying URL or token',async()=>{
 const {verifyRestoredSession}=await import('../worker/profiles.mjs');
 await assert.rejects(verifyRestoredSession({storageState:async()=>{throw Error('https://secret.test/?token=private-fixture');}},mobileProfileFixture('diagnostics')),error=>{
  assert.equal(error.code,'profile_session_verification_failed');assert.equal(error.diagnostics.readStage,'export');
  assert.ok(!JSON.stringify(error.diagnostics).includes('private-fixture'));assert.ok(!JSON.stringify(error.diagnostics).includes('secret.test'));return true;
 });
});

test('native origin discovery uses internal collectors, ignores cached navigation scripts and never launches donor pages', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-native-origins-'));let context;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','public,max-age=86400');res.end('<body>Saved<script>localStorage.setItem("cached-script","ran");location.hash="redirect"</script></body>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  const profile=mobileProfileFixture('origin-collector');
  context=await chromium.launchPersistentContext(join(dir,'native'),launch);await createMobileContext(context.browser(),profile,undefined,context,true);
  const page=await context.newPage();await page.goto(origin);await page.evaluate(()=>{localStorage.removeItem('cached-script');localStorage.setItem('retained','yes');});
  await quiesceProfilePages(context);const staged=await stageMobileProfile(dir,profile,context,{storageMode:'persistent'});await context.close();context=null;
  context=await chromium.launchPersistentContext(join(dir,'native'),launch);await createMobileContext(context.browser(),staged.snapshot,undefined,context,false);await context.setOffline(true);
  await context.addInitScript(()=>localStorage.setItem('unexpected-init-script','ran'));
  context.newPage=async()=>assert.fail('origin discovery must use the internal storage collector');
  const {verifyRestoredSession}=await import('../worker/profiles.mjs');assert.equal((await verifyRestoredSession(context,staged.snapshot,{discoverOrigins:true})).status,'passed');
  const state=await context.storageState();const stored=state.origins.find(o=>o.origin===origin).localStorage;
  assert.ok(!stored.some(e=>['cached-script','unexpected-init-script'].includes(e.name)));
  await staged.discard();
 }finally{await context?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('snapshot cookies are sampled after origin collection instead of retaining the early cookie read',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-cookie-last-'));
 const cookie={name:'fixture',value:'before-origin-export',domain:'fixture.test',path:'/',expires:Math.floor(Date.now()/1000)+3600,httpOnly:true,secure:true,sameSite:'Lax'};
 try{
  const profile=mobileProfileFixture('cookie-last'),early=Object.freeze({cookies:[cookie],origins:[]});
  const final={...cookie,value:'after-origin-export',expires:cookie.expires+10};
  const staged=await stageMobileProfile(dir,profile,{storageState:async()=>early,cookies:async()=>[final]});
  assert.deepEqual(staged.snapshot.cookies,[final]);assert.equal(early.cookies[0].value,'before-origin-export');await staged.discard();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failure of the final cookie read prevents publishing a stale snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-cookie-read-error-'));
 try{
  await assert.rejects(stageMobileProfile(dir,mobileProfileFixture('cookie-read-error'),{storageState:async()=>({cookies:[],origins:[]}),cookies:async()=>{throw Error('fixture read failed');}}),{code:'profile_storage_failed'});
  const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
