import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { guardNavigationRedirects } from '../worker/navigation-redirects.mjs';
import { navigationAllowed } from '../worker/navigation-site.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('redirect Location is rejected before the external request, approved redirects work and disposal restores normal routing',async()=>{
 let visits=0;const external=createServer((req,res)=>{if(req.url==='/destination')visits++;res.end('Destination');});await listen(external);
 const destination=`http://127.0.0.1:${external.address().port}/destination`;
 const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:destination});res.end();}else res.end('Source');});await listen(server);
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const context=await browser.newContext();let page=await context.newPage();await page.goto(origin);
  let dispose=await guardNavigationRedirects(context,url=>navigationAllowed(url,origin));
  await assert.rejects(page.goto(origin+'/redirect'),/BLOCKED_BY_CLIENT/);assert.equal(visits,0);
  await dispose();
  await page.close();page=await context.newPage();
  dispose=await guardNavigationRedirects(context,url=>navigationAllowed(url,origin,[destination]));
  await page.goto(origin+'/redirect');assert.equal(page.url(),destination);assert.equal(visits,1);await dispose();
  await page.goto(origin+'/redirect');assert.equal(visits,2);
 } finally {await browser.close();await close(server);await close(external);}
});

test('captcha 307 cannot replay its approved POST into a second endpoint',async()=>{
 const {restrictNavigation}=await import('../worker/action-executor.mjs');let replayed=0;
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.url==='/captcha'){req.resume();res.writeHead(307,{location:'/replay'});res.end();}
  else if(req.url==='/replay'){replayed++;res.end('Unexpected');}
  else res.end('<form method="post" action="/captcha"><button>Submit</button></form>');
 });await listen(server);const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);
  const policy=await restrictNavigation(context,origin);policy.allowCaptchaPost(origin+'/captcha');
  const failure=page.waitForEvent('requestfailed',{predicate:r=>r.isNavigationRequest(),timeout:3000});
  await Promise.all([failure,page.locator('button').click({timeout:3000}).catch(()=>{})]);
  assert.equal(replayed,0);await policy.dispose();
 }finally{await browser.close();await close(server);}
});

test('redirect guard scopes browser interception and never disables HTTP cache',async()=>{
 const {EventEmitter}=await import('node:events');const {pageSessions}=await import('../worker/page-session.mjs');
 const page={},context=new EventEmitter(),session=new EventEmitter(),calls=[];context.pages=()=>[page];context.browser=()=>({newBrowserCDPSession:async()=>session});session.detach=async()=>{};
 session.send=async(method,params)=>{calls.push({method,params});return method==='Target.getTargetInfo'?{targetInfo:{targetId:'root',type:'page',browserContextId:'fixture-context'}}:{};};
 pageSessions.set(page,session);
 try {
  const dispose=await guardNavigationRedirects(context,()=>false);
  await session.listeners('Fetch.requestPaused')[0]({requestId:'fixture',frameId:'root',responseStatusCode:302,responseHeaders:[{name:'Location',value:'https://other.test'}],request:{url:'https://example.test',method:'GET'}});
  await dispose();
  assert.ok(calls.some(c=>c.method==='Fetch.failRequest'));assert.ok(calls.some(c=>c.method==='Fetch.disable'));
  assert.ok(!calls.some(c=>c.method==='Network.setCacheDisabled'));
  assert.equal(session.listenerCount('Fetch.requestPaused'),0);assert.equal(context.listenerCount('close'),0);
 }finally{pageSessions.delete(page);}
});

test('a popup initial redirect cannot leave the approved site',async()=>{
 const {restrictNavigation}=await import('../worker/action-executor.mjs');let visits=0;
 const external=createServer((req,res)=>{if(req.url==='/outside')visits++;res.end('Outside');});await listen(external);
 const destination=`http://127.0.0.1:${external.address().port}/outside`;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/redirect'){res.writeHead(302,{location:destination});res.end();}else res.end('<h1>Source</h1>');});await listen(server);
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);const policy=await restrictNavigation(context,origin);
  const popupPromise=page.waitForEvent('popup');await page.evaluate(url=>window.open(url),origin+'/redirect');const popup=await popupPromise;
  await popup.waitForLoadState('domcontentloaded');assert.equal(visits,0);await policy.dispose();
 }finally{await browser.close();await close(server);await close(external);}
});
