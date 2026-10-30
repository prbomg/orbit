import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mobileProfileFixture } from './helpers/mobile-profile-fixture.mjs';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { restrictNavigation } from '../worker/action-executor.mjs';

test('browser redirect guard and first ServiceWorker script passport coexist',async()=>{
 const requests=[];
 const server=createServer((req,res)=>{
  if(req.url==='/sw.js'){
   requests.push(req.headers['user-agent']);res.setHeader('Content-Type','application/javascript');
   res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");
  }else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><h1>Owned fixture</h1>');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const profile=mobileProfileFixture('guard-network-fixture');
  const context=await createMobileContext(browser,profile),page=await createMobilePage(context,profile);
  await page.goto(origin);const policy=await restrictNavigation(context,origin);
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
  assert.deepEqual(requests,[profile.fingerprint.navigator.userAgent]);await policy.dispose();
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
