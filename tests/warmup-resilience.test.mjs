import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { performWarmup } from '../worker/warmup.mjs';
import { warmupSessionBudget } from '../worker/warmup-timing.mjs';
import { clickRandomLink } from '../worker/action-executor.mjs';
async function fixture(run, html = '<main>Local fixture content</main>') {
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:typeof html==='function'?html(route.request().url()):html}));const page=await context.newPage();await page.goto('https://initial.test/');await run(page);} finally {await browser.close();}
}
test('reading target includes bounded navigation and replacement overhead; explicit hard limit remains',()=>{
 assert.equal(warmupSessionBudget({sessionMinutes:3,requiredSites:3,navigationTimeoutMs:30000}),360000);
 assert.equal(warmupSessionBudget({sessionMinutes:3,requiredSites:3,navigationTimeoutMs:30000,timeoutMs:210000}),210000);
 assert.equal(warmupSessionBudget({sessionMinutes:1000}),1200000);
 assert.throws(()=>warmupSessionBudget({timeoutMs:0}));
});
test('a transient donor failure can be replaced after the old session deadline', {timeout:10000}, async()=>fixture(async page=>{
 const goto=page.goto.bind(page);let first=true;
 page.goto=async(...args)=>{if(first){first=false;await delay(1200);const e=new Error('slow donor');e.name='TimeoutError';throw e;}return goto(...args);};
 const sites=['https://slow.test/','https://healthy.test/'],events=[];
 await performWarmup(page,{sites,requiredSites:1,requirements:'content',sessionMinutes:0.0001,navigationTimeoutMs:1000,chooseSites:()=>sites,waitFor:async()=>{},log:(event,d)=>events.push({event,...d})});
 assert.ok(events.some(e=>e.event==='warmup_site_skipped'&&e.domain==='slow.test'));
 assert.ok(events.some(e=>e.event==='warmup_site_completed'&&e.domain==='healthy.test'));
}));
test('busy reservations do not exhaust the twelve actual visit attempts', {timeout:10000},async()=>fixture(async page=>{
 const sites=Array.from({length:14},(_,i)=>`https://site${i}.test/`),events=[],released=[];
 await performWarmup(page,{sites,requiredSites:1,requirements:'content',chooseSites:()=>sites,waitFor:async()=>{},reserveSite:async url=>url===sites[13]?url:null,releaseSite:async r=>released.push(r),log:(event,d)=>events.push({event,...d})});
 assert.equal(events.filter(e=>e.event==='warmup_site_deferred').length,13);
 assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,1);assert.deepEqual(released,[sites[13]]);
}));
test('empty content is recorded as unhealthy and replaced without a reading pause', {timeout:10000},async()=>fixture(async page=>{
 const sites=['https://empty.test/','https://healthy.test/'],health=[],events=[];
 await performWarmup(page,{sites,requiredSites:1,requirements:'content',chooseSites:()=>sites,waitFor:async()=>{},reserveSite:async url=>url,finishSite:async(r,result)=>health.push({r,...result}),log:(event,d)=>events.push({event,...d})});
 assert.equal(health[0].reason,'content_unavailable');assert.equal(health[0].success,false);assert.equal(health[1].success,true);
 assert.ok(!events.some(e=>e.domain==='empty.test'&&e.phase==='reading'));
},url=>url.includes('empty.test')?'<body></body>':'<main>Real local content</main>'));
test('partial navigation quality updates donor health before releasing the reservation', {timeout:30000},async()=>fixture(async page=>{
 const sites=['https://partial.test/','https://healthy.test/'],health=[];
 await performWarmup(page,{sites,requiredSites:1,requirements:'navigation',chooseSites:()=>sites,waitFor:async()=>{},reserveSite:async url=>url,finishSite:async(r,result)=>health.push({r,...result})});
 assert.equal(health[0].reason,'navigation_not_confirmed');assert.equal(health[0].success,false);assert.equal(health[1].success,true);
},url=>url.includes('partial.test')?'<main>Static short content</main>':'<main>Healthy content</main><a href="/next">Next page</a>'));
test('link activation and result verification share one timeout; document downloads are excluded', {timeout:15000},async()=>fixture(async page=>{
 await page.setContent('<a href="https://initial.test/next" style="pointer-events:none">Next</a><main>Unchanged local content</main><script>document.querySelector("a").addEventListener("click",e=>e.preventDefault());setTimeout(()=>document.querySelector("a").style.pointerEvents="auto",1300)</script>');
 const started=performance.now();assert.equal(await clickRandomLink(page,{origin:'https://initial.test',timeout:3000}),false);assert.ok(performance.now()-started<4000);
 await page.setContent('<a href="https://initial.test/document.pdf">PDF</a><main>Content</main>');assert.equal(await clickRandomLink(page,{origin:'https://initial.test',timeout:300}),false);
}));

test('a proven reload invalidating a page API skips the donor; unrelated errors still fail', {timeout:15000},async()=>{
 for(const navigate of [true,false])await fixture(async page=>{
  const evaluate=page.evaluate.bind(page),sites=['https://changing.test/','https://healthy.test/'],health=[];let first=true;
  page.evaluate=async(...args)=>{
   if(first&&page.url().includes('changing.test')&&String(args[0]).includes('const root = document.scrollingElement')){
    first=false;if(navigate)await page.goto('https://changing.test/reloaded');throw new Error('Protocol error: Cannot find object with given id');
   }
   return evaluate(...args);
  };
  const run=()=>performWarmup(page,{sites,requiredSites:1,requirements:'content',chooseSites:()=>sites,waitFor:async()=>{},reserveSite:async url=>url,finishSite:async(r,result)=>health.push({r,...result})});
  if(navigate){await run();assert.equal(health[0].reason,'site_navigation');assert.equal(health[1].success,true);}
  else{await assert.rejects(run(),/Cannot find object/);assert.equal(health.length,0);}
 });
});

test('an uncooperative DOM lookup is bounded and another donor can finish the same session', {timeout:15000},async()=>fixture(async page=>{
 const locator=page.locator.bind(page),sites=['https://blocked.test/','https://healthy.test/'],health=[];
 page.locator=(selector,...args)=>{
  if(selector==='a[href]'&&page.url().includes('blocked.test'))return {evaluateAll:()=>new Promise(()=>{})};
  return locator(selector,...args);
 };
 await performWarmup(page,{sites,requiredSites:1,requirements:'navigation',navigationTimeoutMs:1000,chooseSites:()=>sites,waitFor:async()=>{},reserveSite:async url=>url,finishSite:async(r,result)=>health.push({r,...result})});
 assert.equal(health[0].reason,'navigation_timeout');assert.equal(health[1].success,true);assert.equal(page.isClosed(),false);
},'<main>Local content</main><a href="/next">Next</a>'));
