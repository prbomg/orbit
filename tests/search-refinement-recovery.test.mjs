import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { performSearchAndClick } from '../worker/search.mjs';
import { TaskStoppedError } from '../worker/behavior.mjs';

async function fixture(run, { failRecovery = false, stopOnRetry = false, failInitial = false } = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    const requests = [], events = [], evidence = []; let homes = 0, active = true, clock = 0;
    await context.addCookies([{ name: 'session', value: 'retained', domain: 'search.test', path: '/' }]);
    await context.route('http://search.test/**', async route => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (url.pathname === '/') homes++;
      const ignored = url.pathname !== '/' || failInitial || (failRecovery && homes > 1);
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <form action="/search" ${ignored ? 'onsubmit="event.preventDefault()"' : ''}><input name="text" value="${url.searchParams.get('text') ?? ''}"><button>Найти</button></form>
        ${url.pathname === '/' ? '' : '<div class="serp-item"><h2><a href="http://other.test/article">Other result</a></h2></div>'}` });
    });
    const page = await context.newPage();
    const execute = () => performSearchAndClick(page, { id: 'fixture', searchEngine: 'yandex', searchQueries: ['qa'], vitalPhrases: ['brand'], targetDomain: 'target.test' }, {
      engines: { yandex: { home: 'http://search.test/', domains: ['search.test'] } },
      navigationTimeoutMs: 500, now: () => clock, waitFor: async ms => { clock += ms; },
      shouldContinue: async () => active,
      captureFailure: async (page, details) => { evidence.push({ url: page.url(), ...details }); throw new Error("evidence failure must not replace original error"); },
      log: (event, data) => { events.push({ event, ...data }); if (stopOnRetry && event === 'search_refinement_retry') active = false; },
    });
    await run({ execute, context, requests, events, evidence, homes: () => homes });
  } finally { await browser.close(); }
}

test('unresponsive mobile refinement retries the exact query once from home and retains the session', async () => {
  await fixture(async ({ execute, context, requests, events, homes }) => {
    const result = await execute();
    assert.equal(result.refined, true);
    assert.equal(result.found, false); // A recovered search never invents a successful visit.
    assert.equal(homes(), 2);
    assert.deepEqual(requests.filter(url => url.pathname === '/search').map(url => url.searchParams.get('text')), ['qa', 'qa brand']);
    assert.equal(events.filter(row => row.event === 'search_refinement_retry').length, 1);
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'session')?.value, 'retained');
  });
});

test('refinement recovery is bounded when the home form also ignores submission', async () => {
  await fixture(async ({ execute, events, homes }) => {
    await assert.rejects(execute(), error => error.code === 'search_results_timeout');
    assert.equal(homes(), 2);
    assert.equal(events.filter(row => row.event === 'search_refinement_retry').length, 1);
  }, { failRecovery: true });
});

test('a stopped task cannot navigate home for refinement recovery', async () => {
  await fixture(async ({ execute, homes }) => {
    await assert.rejects(execute(), TaskStoppedError);
    assert.equal(homes(), 1);
  }, { stopOnRetry: true });
});

test('an initial search timeout is not retried as refinement', async () => {
  await fixture(async ({ execute, events, evidence, homes }) => {
    await assert.rejects(execute(), error => error.code === 'search_results_timeout');
    assert.equal(evidence.length, 1); assert.equal(evidence[0].stage, 'search_submit_completed'); assert.equal(evidence[0].status, 200); assert.ok(evidence[0].elapsedMs >= 0);
    assert.equal(homes(), 1);
    assert.ok(!events.some(row => row.event === 'search_refinement_retry'));
  }, { failInitial: true });
});
