import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {scrollPage} from '../worker/mobile-input.mjs';
import {clickRandomLink} from '../worker/action-executor.mjs';
import {actionSnapshot,waitActionResult} from '../worker/action-result.mjs';
async function fixture(html,run){const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});try{const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1">'+html}));const page=await context.newPage();await page.goto('https://fixture.test/');await run(page);}finally{await browser.close();}}
test('same-URL SPA content confirms a link, but a modal outside main does not',async()=>{
 for(const mainChange of [true,false])await fixture(`<a href="/next">Open</a><main><h1>Catalog</h1>Initial contents</main><script>document.querySelector('a').addEventListener('click',e=>{e.preventDefault();${mainChange?"setTimeout(()=>document.querySelector('main').innerHTML='<h1>Product</h1>Detailed product page',100)":"document.body.insertAdjacentHTML('beforeend','<div role=dialog>Notification</div>')"}})</script>`,async page=>{const events=[];const result=await clickRandomLink(page,{origin:'https://fixture.test',timeout:2000,log:(event,data)=>events.push({event,...data})});assert.equal(result,mainChange?'content_changed':false);assert.equal(page.url(),'https://fixture.test/');assert.ok(events.some(e=>e.event==='action_input_sent'));assert.equal(events.some(e=>e.event==='action_result_verified'),mainChange);});
});
test('changing clock in main is not proof of a page change',async()=>{await fixture('<main><h1>Catalog</h1><span id="clock">12:30:00</span></main>',async page=>{const before=await actionSnapshot(page);await page.locator('#clock').evaluate(e=>e.textContent='12:30:01');assert.equal((await waitActionResult(page,before,{timeout:200})).result,'no_change');});});
test('scroll verification distinguishes page boundary, blocked gesture and nested container',async()=>{
 await fixture('<main>Short page</main>',async page=>{assert.equal((await scrollPage(page,150,{durationMs:150})).result,'boundary');});
 await fixture('<style>html,body{overflow:hidden;margin:0}</style><main style="height:6000px">Locked page</main>',async page=>{assert.equal((await scrollPage(page,150,{durationMs:150})).result,'blocked');});
 await fixture('<style>html,body{overflow:hidden;margin:0}#box{height:100vh;overflow:auto}</style><div id="box"><main style="height:6000px">Nested page</main></div>',async page=>{const result=await scrollPage(page,200,{durationMs:150});assert.equal(result.result,'scrolled');assert.equal(result.scrollTarget,'container');assert.equal(await page.evaluate(()=>scrollY),0);assert.ok(await page.locator('#box').evaluate(e=>e.scrollTop)>0);});
});
