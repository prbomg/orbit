import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { interactWithTargetSite, SearchError } from '../worker/search.mjs';
import { TaskStoppedError } from '../worker/behavior.mjs';

async function withVisit(html, run, { timeout = 250, destination, signal } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const requests = []; const events = []; let clock = 0; let response;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.hostname, 'target.test');
      requests.push(url.pathname);
      if (url.pathname !== '/start' && destination) return destination(route);
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${url.pathname === '/start' ? html : '<h1>Next page</h1>'}<main style="height:8000px"></main>` });
    });
    const page = await context.newPage();
    // Dwell uses a virtual clock; native mobile gestures still use real time.
    page.on('response', value => { if (value.request().isNavigationRequest() && value.frame() === page.mainFrame()) response = value; });
    await page.goto('http://target.test/start');
    const session = {
      timeout, signal, now: () => clock,
      check: async () => { signal?.throwIfAborted(); },
      document: async () => { signal?.throwIfAborted(); if (response && !response.ok()) throw new SearchError('search_http_error'); },
      pause: async ms => { signal?.throwIfAborted(); clock += ms; },
      log: (event, details = {}) => events.push({ event, ...details }),
    };
    const visit = (durationMs,visitSettings,intent) => interactWithTargetSite(page, { targetDomain: 'target.test',visitSettings,intent }, session, { durationMs });
    await run({ page, session, visit, requests, events, elapsed: () => clock });
  } finally { await browser.close(); }
}

test('a JavaScript link without navigation is attempted once and does not interrupt a 223-second visit', { timeout: 45_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next" onclick="event.preventDefault();window.clicks=(window.clicks||0)+1">Open a modal</a>', async ({ page, visit, requests, events, elapsed }) => {
    const result = await visit(223_000);
    assert.equal(result.linksFollowed, 0);
    assert.equal(result.durationMs, 223_000);
    assert.equal(elapsed(), 223_000);
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.deepEqual(requests, ['/start']);
    assert.ok(events.some(row => row.event === 'target_internal_link_skipped' && row.code === 'target_internal_no_navigation'));
    assert.equal(events.at(-1).event, 'target_visit_finished');
  // Test no-change semantics, with enough time to complete native touch input.
  }, { timeout: 1500 });
});

test('a covered link is excluded before input and the obstacle is diagnosed', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a><div style="position:fixed;inset:0;z-index:10">Overlay</div>', async ({ visit, requests, events }) => {
    assert.equal((await visit(60_000)).linksFollowed, 0);
    assert.deepEqual(requests, ['/start']);
    assert.ok(events.some(row => row.event === 'visit_obstacle' && row.reason === 'overlay'));
    assert.equal(events.filter(row => row.event === 'target_internal_link_started').length, 0);
    assert.equal(events.at(-1).event, 'target_visit_finished');
  });
});

test('hidden popup links and file links without a download attribute are excluded', { timeout: 30_000 }, async () => {
  for (const html of [
    '<div style="opacity:0;pointer-events:none"><a href="/next">Hidden popup</a></div>',
    '<a href="/presentation.PDF?version=1" target="_blank">Download presentation</a>',
    '<div aria-hidden="true"><a href="/next">Closed menu</a></div>',
  ]) {
    await withVisit(html, async ({ visit, requests, events }) => {
      assert.equal((await visit(60_000)).linksFollowed, 0);
      assert.deepEqual(requests, ['/start']);
      assert.ok(!events.some(row => row.event === 'target_internal_link_started'));
    });
  }
});

test('a slow internal document is awaited after navigation starts and is counted once', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next" target="_blank">Next</a>', async ({ page, visit, requests, events }) => {
    assert.equal((await visit(60_000)).linksFollowed, 1);
    assert.equal(page.url(), 'http://target.test/next');
    assert.equal(page.context().pages().length, 1);
    assert.deepEqual(requests, ['/start', '/next']);
    assert.ok(events.some(row => row.event === 'target_internal_navigation_started'));
    assert.ok(events.some(row => row.event === 'target_internal_link'));
  }, { timeout: 1500, destination: async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ contentType: 'text/html', body: '<h1>Delayed next page</h1><main style="height:8000px"></main>' });
  } });
});

test('a pending internal document uses stop checks without probing its replaced DOM', { timeout: 10_000 }, async () => {
  let loading = false; let activeChecks = 0;
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ session, visit, requests }) => {
    session.active = async () => { activeChecks++; };
    session.check = async () => { assert.equal(loading, false, 'Do not inspect a document while its navigation is pending'); };
    assert.equal((await visit(60_000, { maxInternalTransitions: 1 })).linksFollowed, 1);
    assert.deepEqual(requests, ['/start', '/next']);
    assert.ok(activeChecks > 0);
  }, { timeout: 1500, destination: async route => {
    loading = true;
    await new Promise(resolve => setTimeout(resolve, 400));
    loading = false;
    await route.fulfill({ contentType: 'text/html', body: '<h1>Ready page</h1>' });
  } });
});

test('a database pause stops a committed document wait promptly', { timeout: 10_000 }, async () => {
  let running = true;
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ session, visit, events }) => {
    session.active = async () => { if (!running) throw new TaskStoppedError(); };
    const original = session.log;
    session.log = (event, details) => {
      original(event, details);
      if (event === 'target_internal_navigation_started') setTimeout(() => { running = false; }, 80);
    };
    const start = performance.now();
    await assert.rejects(visit(60_000), { name: 'TaskStoppedError' });
    assert.ok(performance.now() - start < 1800);
    assert.ok(!events.some(row => row.event === 'target_visit_finished'));
  }, { timeout: 4000, destination: async route => {
    if (new URL(route.request().url()).pathname === '/slow.js') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.fulfill({ contentType: 'application/javascript', body: '' }).catch(() => {});
    } else await route.fulfill({ contentType: 'text/html', body: '<script src="/slow.js"></script><h1>Next page</h1>' });
  } });
});

test('an internal navigation failure is diagnosed and never marks the visit completed', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ visit, events }) => {
    await assert.rejects(visit(60_000), error => error instanceof SearchError && error.code === 'target_internal_navigation_failed');
    assert.ok(events.some(row => row.event === 'target_internal_link_failed' && row.code === 'target_internal_navigation_failed'));
    assert.ok(!events.some(row => row.event === 'target_visit_finished'));
  }, { destination: route => route.abort('failed') });
});

test('a committed page blocked before DOMContentLoaded reports a navigation timeout', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ visit, events }) => {
    await assert.rejects(visit(60_000), error => error instanceof SearchError && error.code === 'target_internal_navigation_timeout');
    assert.ok(events.some(row => row.event === 'target_internal_link_failed' && row.code === 'target_internal_navigation_timeout'));
    assert.ok(!events.some(row => row.event === 'target_visit_finished' || row.event === 'target_internal_link'));
  }, { timeout: 500, destination: async route => {
    if (new URL(route.request().url()).pathname === '/slow.js') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({ contentType: 'application/javascript', body: '' }).catch(() => {});
    } else await route.fulfill({ contentType: 'text/html', body: '<script src="/slow.js"></script><h1>Next page</h1>' });
  } });
});

test('an internal HTTP error is preserved instead of marking a successful visit', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ visit, events }) => {
    await assert.rejects(visit(60_000), error => error instanceof SearchError && error.code === 'search_http_error');
    assert.ok(events.some(row => row.event === 'target_internal_link_failed' && row.code === 'search_http_error'));
    assert.ok(!events.some(row => row.event === 'target_visit_finished'));
  }, { timeout: 1000, destination: route => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Unavailable</h1>' }) });
});

test('stopping a pending link action aborts the visit instead of skipping the error', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>', async ({ session, visit, events }) => {
    const log = session.log;
    session.log = (event, details) => { log(event, details); if (event === 'target_internal_link_started') controller.abort(); };
    await assert.rejects(visit(60_000), { name: 'AbortError' });
    assert.ok(!events.some(row => row.event === 'target_visit_finished' || row.event === 'target_internal_link_skipped'));
  }, { signal: controller.signal });
});


test('configured duration and zero depth keep the visit on its landing page',async()=>{
 await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a>',async({visit,requests,events})=>{
  const result=await visit(undefined,{minSeconds:15,maxSeconds:15,maxInternalTransitions:0,allowedSections:[]});
  assert.equal(result.durationMs,15000);assert.equal(result.linksFollowed,0);assert.deepEqual(requests,['/start']);assert.ok(!events.some(e=>e.event==='action_input_sent'));
 });
});
test('section list filters links and configured depth caps internal transitions',async()=>{
 await withVisit('<a style="position:fixed;top:20px" href="/catalog/item">Allowed</a><a href="/other">Other</a>',async({visit,requests})=>{
  const result=await visit(undefined,{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:['/catalog']});assert.equal(result.linksFollowed,1);assert.deepEqual(requests,['/start','/catalog/item']);
 },{timeout:1000,destination:route=>route.fulfill({contentType:'text/html',body:'<a style="position:fixed;top:20px" href="/catalog/next">Next</a><main style="height:8000px">Catalog</main>'})});
});
test('redirect outside permitted section is blocked before loading that page',async()=>{
 await withVisit('<a style="position:fixed;top:20px" href="/catalog/item">Allowed</a>',async({visit,requests})=>{
  await assert.rejects(visit(undefined,{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:['/catalog']}));assert.deepEqual(requests,['/start','/catalog/item']);
 },{timeout:500,destination:route=>route.fulfill({status:302,headers:{location:'http://target.test/other'}})});
});
test('same-URL main-content transition counts once and is diagnosed as content change',async()=>{
 await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a><main><h1>Catalog</h1></main><script>document.querySelector("a").addEventListener("click",e=>{e.preventDefault();document.querySelector("main").innerHTML="<h1>Product</h1>Product details";})</script>',async({visit,events,requests})=>{
  const result=await visit(undefined,{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:[]});assert.equal(result.linksFollowed,1);assert.deepEqual(requests,['/start']);assert.ok(events.some(e=>e.event==='action_result_verified'&&e.result==='content_changed'));
 },{timeout:700});
});


test('initial and following pages receive reading budgets instead of immediate early clicks',async()=>{
 await withVisit('<main><p>Введение в каталог оборудования</p><a style="position:fixed;top:20px" href="/catalog/pump">Промышленный насос</a></main>',async({visit,events,session})=>{
  const logged=[];const original=session.log;session.log=(event,details)=>{original(event,details);logged.push({event,...details,time:session.now()});};
  assert.equal((await visit(30000,{minSeconds:30,maxSeconds:30,maxInternalTransitions:1,allowedSections:[]},'насос')).linksFollowed,1);
  const click=logged.find(e=>e.event==='action_input_sent');assert.ok(click.time>=15000);const plans=logged.filter(e=>e.event==='visit_page_plan');assert.equal(plans.length,2);assert.equal(plans[0].budgetMs,15000);assert.ok(plans[1].budgetMs>0&&plans[1].budgetMs<=15000);
 },{timeout:1000});
});
test('a late slow internal response cannot consume the whole visit budget',async()=>{
 const start=performance.now();await withVisit('<main><p>Introduction</p><a style="position:fixed;top:20px" href="/slow">Slow page</a></main>',async({visit,events})=>{
  await assert.rejects(visit(4000,{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:[]}),error=>error instanceof SearchError&&error.code==='target_internal_navigation_timeout');assert.ok(!events.some(e=>e.event==='target_visit_finished'));
 },{timeout:30000,destination:async route=>{await new Promise(r=>setTimeout(r,2000));await route.fulfill({contentType:'text/html',body:'<main>Slow page</main>'}).catch(()=>{});}});
 assert.ok(performance.now()-start<5000);
});

test('loading content replaces stale links before any navigation is selected',{timeout:15000},async()=>{
 await withVisit('<main aria-busy="true" style="min-height:1600px"><h1>Загрузка каталога</h1><a href="/obsolete">Старая карточка</a><div class="skeleton" style="height:300px"></div></main><script>setTimeout(()=>{const main=document.querySelector("main");main.innerHTML="<h1>Каталог</h1><div data-product><a href=\\"/pump\\">Промышленный насос</a></div>";main.removeAttribute("aria-busy");},350)</script>',async({visit,requests,events})=>{
  const result=await visit(15000,{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:[]},'промышленный насос');assert.equal(result.linksFollowed,1);assert.deepEqual(requests,['/start','/pump']);assert(events.some(e=>e.event==='action_result_verified'));
 },{timeout:1000});
});
test('a link displaced after selection is re-inspected and revealed before retry',{timeout:15000},async()=>{
 await withVisit('<main style="min-height:1800px;display:flow-root"><a style="display:block" id="moving" href="/pump">Промышленный насос</a></main>',async({page,session,visit,requests,events})=>{
  const original=session.check;let shifted=false;
  session.check=async()=>{await original();if(!shifted&&events.some(e=>e.event==='target_internal_link_started')){shifted=true;await page.locator('#moving').evaluate(el=>{document.documentElement.style.overflowAnchor='none';document.body.style.overflowAnchor='none';el.style.marginTop='1000px';scrollTo(0,0);});}};
  const result=await visit(30000,{minSeconds:30,maxSeconds:30,maxInternalTransitions:1,allowedSections:[]},'насос');assert.equal(result.linksFollowed,1);assert.deepEqual(requests,['/start','/pump']);assert(events.some(e=>e.code==='internal_link_outside_viewport'),JSON.stringify({shifted,events}));assert.equal(events.filter(e=>e.event==='action_input_sent').length,1);
 },{timeout:1000});
});
