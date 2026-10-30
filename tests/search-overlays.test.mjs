import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { dismissSearchOverlays } from '../worker/search-overlays.mjs';
import { performSearchAndClick } from '../worker/search.mjs';

const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
const style = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>.cover{position:fixed;inset:0;background:#0009;z-index:100}.sheet{position:absolute;bottom:0;left:0;right:0;background:#eee;padding:20px;height:300px}button{min-width:40px;min-height:40px}</style>';
const popup = (button, action = 'document.querySelector(".cover").remove()') => `<div class="cover"><div role="dialog" class="sheet"><h2>Сделайте Яндекс основным поиском в Chrome</h2><button onclick="window.accepted=true">Продолжить</button>${button === 'inside' ? `<button aria-label="Закрыть окно" onclick='${action}'>×</button>` : ''}</div>${button === 'outside' ? `<button class="Promo-Close" style="position:absolute;top:20px;left:20px" onclick='${action}'>×</button>` : ''}</div>`;
async function fixture(html, run) {
 const browser = await launch();
 try {
  const context = await browser.newContext({ isMobile:true,hasTouch:true,viewport:{width:390,height:844} });
  await context.route('http://search.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:style+html}));
  const page=await context.newPage(); await page.goto('http://search.test/');
  const events=[];
  const options={allowedHost:host=>host==='search.test',timeout:800,log:event=>events.push(event)};
  await run(page,options,events);
 } finally { await browser.close(); }
}

test('slow document replacement during inspection is not reported as a blocked popup', async () => {
 await fixture('<h1>Old document</h1>', async (page, options, events) => {
  const evaluate = page.evaluateHandle.bind(page); let interrupted = false;
  await page.context().route('http://search.test/ready', route => route.fulfill({contentType:'text/html',body:style+'<form><input name="text"></form>'}));
  page.evaluateHandle = async (...args) => {
   if (!interrupted) {
    interrupted = true;
    // Reproduce a pending evaluation invalidated by a navigation after its
    // previous document's recognition deadline has already elapsed.
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.goto('http://search.test/ready');
    throw new Error('Execution context was destroyed, most likely because of a navigation');
   }
   return evaluate(...args);
  };
  assert.equal(await dismissSearchOverlays(page,{...options,timeout:100}),false);
  assert.ok(events.includes('search_document_changed'));
  assert.ok(!events.includes('search_popup_detected'));
  assert.ok(!events.includes('search_popup_blocked'));
 });
});

test('a real prompt on the replacement document is still checked and closed', async () => {
 await fixture('<h1>Old document</h1>', async (page, options, events) => {
  const evaluate = page.evaluateHandle.bind(page); let interrupted = false;
  await page.context().route('http://search.test/ready', route => route.fulfill({contentType:'text/html; charset=utf-8',body:style+popup('inside')}));
  page.evaluateHandle = async (...args) => {
   if (!interrupted) {
    interrupted = true;
    await new Promise(resolve => setTimeout(resolve, 450));
    await page.goto('http://search.test/ready');
    throw new Error('Cannot find context with specified id');
   }
   return evaluate(...args);
  };
  assert.equal(await dismissSearchOverlays(page,{...options,timeout:400}),true);
  assert.equal(await page.locator('.cover').count(),0);
  assert.ok(events.includes('search_document_changed'));
  assert.ok(events.includes('search_popup_closed'));
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
 });
});

test('repeated document changes are bounded and classified separately; stop takes priority', async () => {
 let calls = 0;
 const page = { url: () => 'http://search.test/', evaluate: async()=>{}, evaluateHandle: async () => { calls++; throw new Error('Execution context was destroyed'); } };
 const events = [];
 const options = { allowedHost: () => true, timeout: 100, log: event => events.push(event) };
 await assert.rejects(dismissSearchOverlays(page,options),error=>error.code==='search_navigation_unstable');
 assert.equal(calls,4);
 assert.ok(!events.includes('search_popup_blocked'));
 const controller = new AbortController(), stopped = new Error('stopped');
 page.evaluateHandle = async () => { controller.abort(stopped); throw new Error('Execution context was destroyed'); };
 await assert.rejects(dismissSearchOverlays(page,{...options,signal:controller.signal}),error=>error===stopped);
});

test('bottom sheet closes by detached top-left cross with touch; Continue and search-clear are untouched',async()=>{
 await fixture('<form><input name="text" value="запрос с пробелами"><button type="reset" aria-label="Очистить">×</button></form>'+popup('outside'),async(page,options,events)=>{
  await page.evaluate(()=>{window.pointers=[];document.addEventListener('pointerdown',e=>window.pointers.push(e.pointerType));});
  assert.equal(await dismissSearchOverlays(page,options),true);
  assert.equal(await page.locator('.cover').count(),0);
  assert.equal(await page.locator('input').inputValue(),'запрос с пробелами');
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
  assert.deepEqual(await page.evaluate(()=>window.pointers),['touch']);
  assert.deepEqual(events,['search_popup_detected','search_popup_closed']);
 });
});

test('inside cross waits for closing animation before returning',async()=>{
 await fixture(popup('inside','setTimeout(()=>document.querySelector(".cover").remove(),200)'),async(page,options)=>{
  assert.equal(await dismissSearchOverlays(page,options),true);
  assert.equal(await page.locator('.cover').count(),0);
 });
});

test('closing a prompt may replace its document; the new document is checked again',async()=>{
 await fixture(popup('inside','setTimeout(()=>location.assign("/results"),40)'),async(page,options,events)=>{
  await page.context().route('http://search.test/results',route=>route.fulfill({contentType:'text/html',body:style+'<h1>Results</h1>'}));
  assert.equal(await dismissSearchOverlays(page,options),true);
  assert.equal(new URL(page.url()).pathname,'/results');
  assert.ok(!events.includes('search_popup_blocked'));
 });
});

test('a prompt on the replacement document is not mistaken for a closed prompt',async()=>{
 await fixture(popup('inside','setTimeout(()=>location.assign("/results"),40)'),async(page,options,events)=>{
  await page.context().route('http://search.test/results',route=>route.fulfill({contentType:'text/html',body:style+popup('none')}));
  await assert.rejects(dismissSearchOverlays(page,{...options,timeout:800}),e=>e.code==='search_overlay_blocked');
  assert.equal(new URL(page.url()).pathname,'/results');
  assert.equal(await page.locator('[role=dialog]').count(),1);
 });
});

test('an ignored first close tap is retried without accepting the promotion',async()=>{
 await fixture(popup('inside','window.closeTaps=(window.closeTaps||0)+1;if(window.closeTaps===2)document.querySelector(".cover").remove()'),async(page,options,events)=>{
  assert.equal(await dismissSearchOverlays(page,{...options,timeout:800}),true);
  assert.equal(await page.evaluate(()=>window.closeTaps),2);
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
  assert.ok(events.includes('search_popup_retry'));
 });
});

test('Yandex DistributionPopup close button with Button_view_clear is tapped instead of its OK action',async()=>{
 const html=`<form><input name="text" value="занятие мама и малыш"><button type="reset" class="Button Button_view_clear" aria-label="Очистить запрос">×</button></form>
 <div role="dialog" aria-modal="true" aria-label="Выбрать поиск" class="DistributionPopup" style="position:fixed;inset:0;background:#222;z-index:100">
 <div class="DistributionActions"><button type="button" role="button" aria-label="Закрыть" class="Button DistributionButtonClose DistributionButtonClose_view_cross Button_view_clear Button_size_m" onclick="window.closed=true;document.querySelector('.DistributionPopup').remove()"></button>
 <span>Выбрать поиск</span><a role="link" class="Button DistributionButtonOk Button_view_clear" href="#" onclick="window.accepted=true">ОК</a></div>
 <p>Поисковые системы</p><p>Яндекс</p></div>`;
 await fixture(html,async(page,options,events)=>{
  await page.evaluate(()=>{window.pointers=[];document.addEventListener('pointerdown',e=>window.pointers.push(e.pointerType));});
  assert.equal(await dismissSearchOverlays(page,options),true);
  assert.equal(await page.locator('.DistributionPopup').count(),0);
  assert.equal(await page.locator('input').inputValue(),'занятие мама и малыш');
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
  assert.deepEqual(await page.evaluate(()=>window.pointers),['touch']);
  assert.deepEqual(events,['search_popup_detected','search_popup_closed']);
 });
});

test('search-clear labels remain excluded even when their classes contain close',async()=>{
 const html=popup('none').replace('</div></div>','<button type="button" class="Button ButtonClose Button_view_clear" aria-label="Очистить запрос" onclick="window.cleared=true">×</button></div></div>');
 await fixture(html,async(page,options)=>{
  await assert.rejects(dismissSearchOverlays(page,{...options,timeout:200}),e=>e.code==='search_overlay_blocked');
  assert.equal(await page.evaluate(()=>Boolean(window.cleared)),false);
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
 });
});

test('blocked dialog without a cross fails instead of accepting the offer or continuing',async()=>{
 await fixture(popup('none'),async(page,options,events)=>{
  await assert.rejects(dismissSearchOverlays(page,{...options,timeout:200}),e=>e.code==='search_overlay_blocked');
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);
  assert.ok(events.includes('search_popup_blocked'));
 });
});

test('ineffective close button is an explicit failure',async()=>{
 await fixture(popup('inside','window.clicked=true'),async(page,options)=>{
  // Budget a complete native tap plus actionability before testing the unchanged overlay.
  await assert.rejects(dismissSearchOverlays(page,options),e=>e.code==='search_overlay_blocked');
  assert.equal(await page.evaluate(()=>window.clicked),true);
 });
});

test('ordinary page controls, hidden prompts, captcha dialogs and other domains are ignored',async()=>{
 const html='<button aria-label="Закрыть">×</button><form><input name="text"><button type="reset">×</button></form><div class="Popup" style="display:none">Сделайте Яндекс основным поиском</div><div role="dialog" class="smart-captcha">Подтвердите, что вы не робот</div>';
 await fixture(html,async(page,options)=>{assert.equal(await dismissSearchOverlays(page,options),false);});
 await fixture(popup('inside'),async(page,options)=>{assert.equal(await dismissSearchOverlays(page,{...options,allowedHost:()=>false}),false);assert.equal(await page.locator('.cover').count(),1);});
});

test('three successive prompts are closed with a bounded loop',async()=>{
 const html=popup('inside','window.n=(window.n||0)+1;if(window.n===3)document.querySelector(".cover").remove();else document.querySelector(".cover").outerHTML=document.querySelector(".cover").outerHTML');
 await fixture(html,async(page,options,events)=>{
  assert.equal(await dismissSearchOverlays(page,options),true);
  assert.equal(await page.evaluate(()=>window.n),3);
  assert.equal(events.filter(e=>e==='search_popup_closed').length,3);
 });
});

test('prompt appearing during typing is closed before the full spaced query is submitted',async()=>{
 const browser=await launch();
 try {
  const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});let submitted;
  await context.route('http://search.test/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/search'){submitted=url.searchParams.get('text');return route.fulfill({contentType:'text/html',body:style+'<div class="serp-item"><h2><a href="http://other.test/">Result</a></h2></div>'});}
   const markup=popup('outside');
   const body=style+`<form action="/search"><input name="text"><button>Найти</button></form><script>document.querySelector('input').addEventListener('input',()=>{if(!window.shown){window.shown=true;document.body.insertAdjacentHTML('beforeend',${JSON.stringify(markup)});}});</script>`;
   return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  const page=await context.newPage(),events=[];let clock=0;
  const query='мама и малыш';
  const result=await performSearchAndClick(page,{id:'test',searchEngine:'yandex',searchQueries:[query],vitalPhrases:[],targetDomain:'target.test'},{engines:{yandex:{home:'http://search.test/',domains:['search.test']}},navigationTimeoutMs:4000,now:()=>clock,waitFor:async ms=>{clock+=ms;},log:event=>events.push(event)});
  assert.equal(result.found,false);assert.equal(submitted,query);
  assert.ok(events.indexOf('search_popup_closed')<events.indexOf('search_submit_started'));
 } finally {await browser.close();}
});
