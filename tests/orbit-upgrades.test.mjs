import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import fp from '../utils/fingerprint.js';
import {passportValidation} from '../worker/passport-validation.mjs';
import {createMobileContext,createMobilePage} from '../worker/profiles.mjs';

test('saved local-v6 passports without GPU alias and legacy runtime GREASE retain their identity',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/local-v6-pre-audit-passport.json',import.meta.url)));
 const before=JSON.stringify(fixture.passport);
 assert.equal(passportValidation(fixture.passport).status,'passed');assert.equal(fp.legacyIdentityHash(fixture.profileId,fixture.passport),fixture.identityHash);assert.equal(fp.matchesIdentityHash(fixture.profileId,fixture.passport,fixture.identityHash),true);assert.equal(JSON.stringify(fixture.passport),before);
 const p=structuredClone(JSON.parse(readFileSync(new URL('./fixtures/local-v5-passport.json',import.meta.url))).passport);
 const old=p.fingerprint.navigator.userAgentData,brands=structuredClone(old.brands),full=structuredClone(old.fullVersionList);
 fp.chromeMetadata(p.fingerprint,p.headers,'154.0.0.1',old.model,old.platformVersion,{legacy:true});
 const next=p.fingerprint.navigator.userAgentData;
 for(let i=0;i<brands.length;i++){
  assert.equal(next.brands[i].brand,brands[i].brand);
  if(!['Chromium','Google Chrome','HeadlessChrome'].includes(brands[i].brand)){assert.deepEqual(next.brands[i],brands[i]);assert.deepEqual(next.fullVersionList[i],full[i]);}
 }
 assert.equal(passportValidation(p).status,'passed');
});

test('allowed Service Worker registers, controls a page and serves its cached response',{timeout:20000},async()=>{
 const {chromium}=await import('playwright');
 const server=createServer((req,res)=>{
  if(req.url==='/sw.js'){
   res.setHeader('Content-Type','text/javascript');res.end(`self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open('audit');await c.put('/cached',new Response('worker-cache'));await self.skipWaiting();})()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/cached')e.respondWith(caches.match('/cached'));});`);
  }else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Orbit SW fixture</title>');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  const p=fp.localPassport({fingerprintMode:'local'},{runtimeVersion:browser.version()}),profile=fp.profileFromPassport('sw-audit',p),context=await createMobileContext(browser,profile);
  try{
   const page=await createMobilePage(context,profile);await page.goto(`http://127.0.0.1:${server.address().port}/`);
   const result=await page.evaluate(async()=>{
    await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    return {controlled:Boolean(navigator.serviceWorker.controller),body:await(await fetch('/cached')).text()};
   });
   assert.deepEqual(result,{controlled:true,body:'worker-cache'});
  }finally{await context.close();}
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
