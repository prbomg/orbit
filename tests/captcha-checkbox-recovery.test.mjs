import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createCaptchaHandler} from '../worker/captcha-page.mjs';
import {TaskStoppedError} from '../worker/behavior.mjs';

const home='https://ya.ru/showcaptcha';
const head='<meta name="viewport" content="width=device-width,initial-scale=1">';
async function fixture(html,run){
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 try{
  const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});
  await context.route(home,route=>route.fulfill({contentType:'text/html',body:head+html}));
  const page=await context.newPage();await page.goto(home);
  const events=[];let reads=0;
  const options={prisma:{settings:{findUnique:async()=>{reads++;return {rucaptchaApiKey:null};}}},config:{captchaWidgetWaitMs:700,captchaMaxSolves:3,navigationTimeoutMs:1500},shouldContinue:async()=>true,taskId:'fixture',log:(event,details)=>events.push({event,...details}),navigationPolicy:{clearCaptchaPost(){}}};
  await run({page,context,events,options,reads:()=>reads});
 }finally{await browser.close();}
}

test('an ignored first mobile tap is retried once and the newly rendered widget is recognized',async()=>{
 await fixture(`<form id="checkbox-captcha-form"><input type="button" role="checkbox" class="CheckboxCaptcha-Button" value="Я не робот" style="width:340px;height:100px" onclick="window.n=(window.n||0)+1;if(window.n===2)document.body.insertAdjacentHTML('beforeend','<div class=smart-captcha data-sitekey=fixture-smartcaptcha-sitekey></div>')"></form><script>window.pointers=[];document.addEventListener('pointerdown',e=>pointers.push({type:e.pointerType,trusted:e.isTrusted}))</script>`,async({page,events,options,reads})=>{
  await assert.rejects(createCaptchaHandler(options)(page),e=>{assert.equal(e.code,'missing_api_key');return true;});
  assert.equal(await page.evaluate(()=>window.n),2);assert.equal(reads(),1);
  assert.deepEqual(await page.evaluate(()=>window.pointers),[{type:'touch',trusted:true},{type:'touch',trusted:true}]);
  assert.equal(events.filter(e=>e.event==='captcha_checkbox_retrying').length,1);
  assert.ok(events.some(e=>e.event==='captcha_detected'));assert.ok(!events.some(e=>e.event==='captcha_requested'));
 });
});

test('a pending verification POST is awaited beyond the widget timeout without a duplicate submission',async()=>{
 await fixture('<form id="checkbox-captcha-form" action="/checkcaptcha" method="post"><input type="submit" role="checkbox" value="Я не робот"></form>',async({page,context,events,options})=>{
  let posts=0;options.config.captchaWidgetWaitMs=250;
  await context.route('https://ya.ru/checkcaptcha',async route=>{
   posts++;await new Promise(resolve=>setTimeout(resolve,700));
   await route.fulfill({contentType:'text/html',body:'<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey"></div>'}).catch(()=>{});
  });
  await assert.rejects(createCaptchaHandler(options)(page),e=>e.code==='missing_api_key');
  assert.equal(posts,1);assert.equal(events.filter(e=>e.event==='captcha_checkbox_clicked').length,1);
  assert.ok(events.some(e=>e.event==='captcha_widget_wait'&&e.reason==='navigation_pending'));
 });
});

test('a checkbox-only verification that opens the results is success without calling a provider',async()=>{
 await fixture('<form id="checkbox-captcha-form" action="/search/" method="post"><input type="submit" role="checkbox" value="Я не робот"></form>',async({page,context,events,options,reads})=>{
  await context.route('https://ya.ru/search/',route=>route.fulfill({contentType:'text/html',body:'<h1>Results</h1>'}));
  const check=createCaptchaHandler(options);
  assert.equal(await check(page),true);
  assert.equal(new URL(page.url()).pathname,'/search/');assert.equal(reads(),0);
  assert.ok(events.some(e=>e.event==='captcha_checkbox_completed'));
  assert.equal(await check(page),false);
  assert.equal(events.filter(e=>e.event==='captcha_checkbox_completed').length,1);
 });
});

test('an unresponsive checkbox fails after two taps with a specific reason and cleans up its listener',async()=>{
 await fixture('<form id="checkbox-captcha-form"><input type="button" role="checkbox" value="Я не робот" onclick="window.n=(window.n||0)+1"></form>',async({page,events,options,reads})=>{
  const before=page.listenerCount('request');
  await assert.rejects(createCaptchaHandler(options)(page),e=>e.code==='checkbox_not_completed');
  assert.equal(await page.evaluate(()=>window.n),2);assert.equal(page.listenerCount('request'),before);assert.equal(reads(),0);
  assert.equal(events.filter(e=>e.event==='captcha_checkbox_retrying').length,1);
 });
});

test('a stalled checkbox navigation times out once instead of clicking again',async()=>{
 await fixture('<form id="checkbox-captcha-form" action="/checkcaptcha" method="post"><input type="submit" role="checkbox" value="Я не робот"></form>',async({page,context,options})=>{
  options.config.captchaWidgetWaitMs=150;options.config.navigationTimeoutMs=500;let posts=0;
  await context.route('https://ya.ru/checkcaptcha',async route=>{posts++;await new Promise(resolve=>setTimeout(resolve,1800));await route.fulfill({body:'late'}).catch(()=>{});});
  await assert.rejects(createCaptchaHandler(options)(page),e=>e.code==='checkbox_navigation_timeout');assert.equal(posts,1);
 });
});

test('pausing while the widget is loading prevents a second tap and any provider request',async()=>{
 await fixture('<form id="checkbox-captcha-form"><input type="button" role="checkbox" value="Я не робот" onclick="window.n=(window.n||0)+1"></form>',async({page,options,reads})=>{
  let continuing=true;options.shouldContinue=async()=>continuing;
  options.log=event=>{if(event==='captcha_widget_wait')continuing=false;};
  const before=page.listenerCount('request');
  await assert.rejects(createCaptchaHandler(options)(page),e=>e instanceof TaskStoppedError);
  assert.equal(await page.evaluate(()=>window.n),1);assert.equal(reads(),0);assert.equal(page.listenerCount('request'),before);
 });
});

test('a new checkbox document at the same URL has its own bounded click budget',async()=>{
 await fixture('<form id="checkbox-captcha-form"><input type="button" role="checkbox" value="Я не робот" onclick="window.n=(window.n||0)+1"></form>',async({page,context,options})=>{
  const check=createCaptchaHandler(options);
  await assert.rejects(check(page),e=>e.code==='checkbox_not_completed');
  await context.unroute(home);
  await context.route(home,route=>route.fulfill({contentType:'text/html',body:head+'<form id="checkbox-captcha-form"><input type="button" role="checkbox" value="Я не робот" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<div class=smart-captcha data-sitekey=fixture-smartcaptcha-sitekey></div>\')"></form>'}));
  await page.reload();
  await assert.rejects(check(page),e=>e.code==='missing_api_key');
 });
});
