import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { domainMatches, findInSerpOrPaginate, performSearchAndClick, SearchError, typeTextHumanLike } from '../worker/search.mjs';
import searchTasks from '../utils/searchTask.js';
import { installSearchFixture } from './fixtures/search-pages.mjs';

const engines = Object.fromEntries(['yandex', 'mail', 'dzen'].map(name => [name, { home: 'http://search.test/', domains: ['search.test'] }]));
const task = { id: 'fixture', searchEngine: 'yandex', searchQueries: ['qa'], vitalPhrases: [], targetDomain: 'target.test' };
const fastOptions = () => {
  let clock = 0;
  return { engines, navigationTimeoutMs: 5000, now: () => clock, waitFor: async ms => { clock += ms; }, targetDurationMs: 60_000 };
};

test('hostname/IDN validation and phrase arrays reject malformed values', () => {
  assert.equal(domainMatches('www.target.test', 'target.test'), true);
  assert.equal(domainMatches('target.test.evil', 'target.test'), false);
  assert.equal(searchTasks.normalizeTargetDomain('ПРИМЕР.РФ'), 'xn--e1afmkfd.xn--p1ai');
  for (const value of ['https://example.com', 'example.com/path', 'example.com:443', '../escape', 'user@example.com']) assert.throws(() => searchTasks.normalizeTargetDomain(value));
  for (const searchQueries of [[], 'qa', [''], ['qa\nsubmit'], [1]]) assert.throws(() => searchTasks.searchTaskConfig({ ...task, searchQueries }));
  assert.deepEqual(searchTasks.searchTaskConfig({ ...task, searchQueries: [' qa ', 'qa'] }).searchQueries, ['qa']);
});

test('search home timeout is reported before typing or submitting a query', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.route('http://search.test/', async route => {
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ contentType: 'text/html', body: '<form><input name="text"></form>' }).catch(() => {});
    });
    const page = await context.newPage(); const events = [];
    await assert.rejects(performSearchAndClick(page, task, { ...fastOptions(), navigationTimeoutMs: 100, log: event => events.push(event) }), error => error instanceof SearchError && error.code === 'search_home_timeout');
    assert.ok(events.includes('search_home_opening'));
    assert.ok(events.includes('search_home_failed'));
    assert.ok(!events.includes('search_submit_started'));
    await context.close();
  } finally { await browser.close(); }
});

test('engine adapters handle iframe input, optional competitors, native popups, target depth and final dwell', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    for (const engine of ['yandex', 'mail', 'dzen']) {
      const context = await browser.newContext();
      try {
        const fixture = await installSearchFixture(context, { iframe: engine !== 'yandex', canonicalRoot: engine === 'dzen', competitorPopup: engine !== 'yandex', ajax: engine === 'yandex' });
        const page = await context.newPage(); const events = [];
        let selections = 0;
        const result = await performSearchAndClick(page, { ...task, searchEngine: engine, searchQueries: ['wrong', 'qa'] }, { ...fastOptions(), selectQuery: async queries => { selections++; assert.deepEqual(queries, ['wrong', 'qa']); return 'qa'; }, log: (event, data) => events.push({ event, ...data }) });
        assert.equal(selections, 1);
        assert.equal(result.found, true); assert.equal(result.pagesVisited, 2);
        assert.ok([0,1,2].includes(result.competitorVisits)); assert.ok(result.linksFollowed >= 1); assert.equal(result.durationMs, 60_000);
        assert.equal(result.domain, engine === 'dzen' ? 'target.test' : 'www.target.test');
        assert.equal(context.pages().length, 1);
        assert.deepEqual(fixture.typed.slice(0, 2), ['q', 'qa']);
        assert.ok(!fixture.visits.some(url => new URL(url).pathname === '/paid'));
        const previews=events.filter(row=>row.event==='competitor_visit_started');
        assert.equal(previews.length,result.competitorVisits);
        assert.ok(previews.every(row=>row.popup===(row.domain==='competitor.test'&&engine!=='yandex')));
        assert.equal(events.filter(row=>row.event==='competitor_returned').length,result.competitorVisits);
        if(!result.competitorVisits)assert.ok(events.some(row=>row.event==='competitor_preview_skipped'));
        assert.ok(events.some(row => row.event === 'target_visit_finished'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('vital phrase appends after five pages and restarts pagination at one', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext(); const fixture = await installSearchFixture(context, { refinement: true });
    const page = await context.newPage(); const events = [], visits = [];
    const result = await performSearchAndClick(page, { ...task, vitalPhrases: ['brand'] }, { ...fastOptions(), onTargetVisit: value => visits.push(value), log: (event, data) => events.push({ event, ...data }) });
    assert.equal(visits.length,1);assert.equal(visits[0].query,'qa');assert.equal(visits[0].actualQuery,'qa brand');
    assert.equal(result.found, true); assert.equal(result.pagesVisited, 7); assert.equal(result.refined, true);
    assert.deepEqual(events.filter(row => row.event === 'search_page_scanned').map(row => row.page), [1, 2, 3, 4, 5, 1, 2]);
    assert.ok(fixture.typed.includes('qa brand')); assert.ok(events.some(row => row.event === 'search_vital_refinement'));
  } finally { await browser.close(); }
});

test('absent target with/without refinement never visits a competitor or marks a target visit', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    for (const vitalPhrases of [[], ['brand']]) {
      const context = await browser.newContext(); const fixture = await installSearchFixture(context, { targetPage: null }); const page = await context.newPage();
      try {
        let visits=0;const result = await performSearchAndClick(page, { ...task, vitalPhrases }, {...fastOptions(),onTargetVisit:()=>visits++});assert.equal(visits,0);
        assert.equal(result.found, false); assert.equal(result.pagesVisited, vitalPhrases.length ? 10 : 5);
        assert.ok(fixture.visits.every(url => new URL(url).hostname === 'search.test'));
        assert.ok(!fixture.visits.some(url => new URL(url).searchParams.get('p') === '6'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('missing pagination means end of results; failed destination responses remain errors', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    for (const options of [{ targetPage: null, noNext: true }, { targetPage: 1, failure: true }]) {
      const context = await browser.newContext(); await installSearchFixture(context, options); const page = await context.newPage();
      try {
        if (options.noNext) {
          const events = [];
          const result = await performSearchAndClick(page, task, { ...fastOptions(), log: event => events.push(event) });
          assert.equal(result.found, false); assert.equal(result.pagesVisited, 1);
          assert.ok(events.includes('search_pagination_unavailable'));
        } else await assert.rejects(performSearchAndClick(page, task, fastOptions()), error => error instanceof SearchError && error.code === 'search_http_error');
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('desktop search input retypes after a live suggestion field drops a space once', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.route('http://search.test/', route => route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><form action="/search"><input name="text" oninput="if(event.data === ' ' && !window.normalized) { window.normalized=true;this.value=this.value.replaceAll(' ',''); }"><button>Найти</button></form>` }));
    await context.route('http://search.test/search?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Results</h1>' }));
    const page = await context.newPage(); await page.goto('http://search.test/');
    const query = 'занятие мама и малыш 1 год', input = page.locator('input[name="text"]');
    const result = await typeTextHumanLike(input, query, { check: async () => {}, timeout: 5000 });
    assert.equal(result.corrected, true); assert.equal(await input.inputValue(), query);
    await input.locator('xpath=ancestor::form[1]').locator('button').click();
    await page.waitForURL('http://search.test/search?text=*');
    assert.equal(new URL(page.url()).searchParams.get('text'), query);
    await context.close();
  } finally { await browser.close(); }
});

test('a search result URL with a different query is retried once with the exact phrase', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext();
    const query = 'занятие мама и малыш 1 год'; let submissions = 0;
    await context.route('http://search.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/search' && url.searchParams.get('text') === query && submissions++ === 0)
        return route.fulfill({ contentType: 'text/html', body: '<meta charset=\"utf-8\"><script>history.replaceState({},\"\",\"/search?text=wrong\")</script><form action=\"/search\"><input name=\"text\" value=\"wrong\"><button>Найти</button></form><div class=\"serp-item\"><h2><a href=\"http://other.test/\">Other result</a></h2></div>' });
      const value = url.searchParams.get('text') ?? '';
      return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><form action="/search"><input name="text" value="${value}"><button>Найти</button></form>${url.pathname === '/search' ? '<div class="serp-item"><h2><a href="http://other.test/">Other result</a></h2></div>' : ''}` });
    });
    const page = await context.newPage(); const events = [];
    const result = await performSearchAndClick(page, { ...task, searchQueries: [query] }, { ...fastOptions(), log: event => events.push(event) });
    assert.equal(result.found, false); assert.equal(result.pagesVisited, 1); assert.equal(submissions, 2);
    assert.equal(new URL(page.url()).searchParams.get('text'), query);
    assert.ok(events.includes('search_query_retry'));
    await context.close();
  } finally { await browser.close(); }
});

test('mobile Show more pagination is followed, and missing control ends the scan without a task error', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('http://search.test/search?*', route => {
      const number = Number(new URL(route.request().url()).searchParams.get('p') ?? 1);
      const result = number === 2 ? '<a href="http://target.test/">Target</a>' : '<a href="http://other.test/">Other</a>';
      return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div class="serp-item"><h2>${result}</h2></div>${number === 1 ? '<div class="SearchMore"><button onclick="location.href=\'/search?text=qa&p=2\'">Показать ещё</button></div>' : ''}` });
    });
    const page = await context.newPage(); await page.goto('http://search.test/search?text=qa');
    const events = [], session = { document: async () => {}, timeout: 5000, searchDomains: ['search.test'], pause: async () => {}, check: async () => {}, log: event => events.push(event) };
    const found = await findInSerpOrPaginate(page, { targetDomain: 'target.test' }, session);
    assert.equal(found.pagesVisited, 2); assert.equal(found.target.domain, 'target.test');
    assert.ok(!events.includes('search_pagination_unavailable'));
    await context.close();
  } finally { await browser.close(); }
});


test('final target popup retains cookies/localStorage after closing and no further competitor opens', { timeout: 15_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext(); const fixture = await installSearchFixture(context, { targetPage: 1, competitorPopup: true, targetPopup: true });
    const page = await context.newPage(); const events = [];
    const result = await performSearchAndClick(page, task, { ...fastOptions(), log: event => events.push(event) });
    assert.equal(result.found, true); assert.equal(context.pages().length, 1);
    const state = await context.storageState();
    assert.ok(state.origins.some(origin => origin.origin === 'http://www.target.test' && origin.localStorage.some(item => item.name === 'synthetic_search_session')));
    assert.ok(events.indexOf('competitor_returned') < events.indexOf('search_target_clicked'));
    const targetStart = fixture.visits.findIndex(url => new URL(url).hostname === 'www.target.test');
    assert.ok(fixture.visits.slice(targetStart).every(url => new URL(url).hostname === 'www.target.test'));
  } finally { await browser.close(); }
});

test('mobile search uses touch through iframe submission, pagination and popup results', { timeout: 40_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const inputs=[];
    await context.exposeBinding('recordPointer',(_source,pointer)=>inputs.push(pointer));
    await context.addInitScript(()=>document.addEventListener('pointerdown',event=>void window.recordPointer(event.pointerType),{passive:true}));
    const fixture = await installSearchFixture(context, { iframe:true, competitorPopup:true, targetPopup:true, destinationHeight:1800 });
    const page=await context.newPage();const events=[];
    const result=await performSearchAndClick(page,{...task,searchEngine:'mail',visitSettings:{minSeconds:15,maxSeconds:15,maxInternalTransitions:1,allowedSections:[]}},{...fastOptions(),targetDurationMs:15000,log:(event,data)=>events.push({event,...data})});
    assert.equal(result.found,true);assert.equal(result.pagesVisited,2);assert.ok(result.linksFollowed>=1);
    assert.ok(inputs.length>=5);assert.ok(inputs.every(pointer=>pointer==='touch'));
    assert.ok(events.some(event=>event.event==='visit_scroll'&&event.inputMethod==='touch'));
    assert.deepEqual([...new Set(fixture.typed)].slice(0,2),['q','qa']);assert.equal(context.pages().length,1);
  } finally { await browser.close(); }
});
