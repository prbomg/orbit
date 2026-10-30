import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {restrictNavigation} from '../worker/action-executor.mjs';
test('a navigation without a frame retains the top-level origin and method restrictions',async()=>{
 let handler;const context={route:async(_,fn)=>{handler=fn;},unroute:async()=>{}};
 const policy=await restrictNavigation(context,'https://guard.test');
 async function outcome(url,method='GET'){
  let result;await handler({request:()=>({isNavigationRequest:()=>true,frame:()=>{throw new Error('Frame for this navigation request is not available, because the request was issued before the frame is created.');},url:()=>url,method:()=>method}),abort:async()=>{result='blocked';},fallback:async()=>{result='allowed';}});return result;
 }
 assert.equal(await outcome('https://guard.test/allowed'),'allowed');assert.equal(await outcome('https://other.test/'),'blocked');assert.equal(await outcome('https://guard.test/form','POST'),'blocked');
 policy.allowCaptchaPost('https://guard.test/form');assert.equal(await outcome('https://guard.test/form','POST'),'allowed');assert.equal(await outcome('https://guard.test/form','POST'),'blocked');await policy.dispose();
});
test('initial popup requests are safely allowed or blocked by origin',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext(),served=[];
  await context.route('**/*',async route=>{served.push(route.request().url());await route.fulfill({contentType:'text/html',body:'<h1>Allowed</h1>'});});
  const policy=await restrictNavigation(context,'https://guard.test');
  const page=await context.newPage();await page.goto('https://guard.test/');
  const allowedPromise=page.waitForEvent('popup');await page.evaluate(()=>window.open('https://guard.test/allowed'));const allowed=await allowedPromise;await allowed.waitForLoadState('domcontentloaded');assert.equal(allowed.url(),'https://guard.test/allowed');
  const blockedPromise=page.waitForEvent('popup');await page.evaluate(()=>window.open('https://other.test/blocked'));const blocked=await blockedPromise;await blocked.waitForLoadState('domcontentloaded');
  assert.deepEqual(served,['https://guard.test/','https://guard.test/allowed']);await policy.dispose();
 }finally{await browser.close();}
});
