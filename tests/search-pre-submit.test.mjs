import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { performSearchAndClick, submitSearch, typeTextHumanLike, waitForSearchInputReady } from '../worker/search.mjs';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await run({ page, context });
  } finally { await browser.close(); }
}
const form = '<meta name="viewport" content="width=device-width,initial-scale=1"><form onsubmit="event.preventDefault();window.submitted=true"><input name="text" value="qa"><button>Найти</button></form>';

test('changed text or replaced editor blocks submission before any tap on Find', async () => {
  await fixture(async ({ page }) => {
    for (const replace of [false, true]) {
      await page.setContent(form);
      const input = page.locator('input'), inputElement = await input.elementHandle();
      const formElement = await inputElement.evaluateHandle(el => el.form);
      await page.evaluate(replace => {
        document.querySelector('button').addEventListener('touchstart', () => window.tapped = true);
        if (replace) document.querySelector('form').outerHTML = document.querySelector('form').outerHTML;
        else document.querySelector('input').value = 'changed';
      }, replace);
      const events = [];
      try {
        await assert.rejects(submitSearch(input, 2000, () => events.push('started'), { expected: 'qa', inputElement, formElement, log: event => events.push(event) }), error => error.code === 'search_query_mismatch');
        assert.deepEqual(events, ['search_submit_blocked']);
        assert.equal(await page.evaluate(() => Boolean(window.submitted || window.tapped)), false);
      } finally { await formElement.dispose(); await inputElement.dispose(); }
    }
  });
});

test('moving the same editor to a different form cannot redirect submission', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form);
    const input = page.locator('input'), inputElement = await input.elementHandle();
    const formElement = await inputElement.evaluateHandle(el => el.form);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.onsubmit = event => { event.preventDefault(); window.submitted = true; };
        form.append(document.querySelector('input'), document.querySelector('button'));
        document.body.append(form);
      });
      await assert.rejects(submitSearch(input, 2000, undefined, { expected: 'qa', inputElement, formElement }), error => error.code === 'search_query_mismatch');
      assert.equal(await page.evaluate(() => Boolean(window.submitted)), false);
    } finally { await formElement.dispose(); await inputElement.dispose(); }
  });
});

test('readiness waits for an editable, focused and uncovered field; stop is propagated', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form + '<div id="cover" style="position:fixed;inset:0;background:white"></div>');
    const input = page.locator('input');
    await input.focus();
    await input.evaluate(el => { el.readOnly = true; setTimeout(() => { el.readOnly = false; document.querySelector('#cover').remove(); }, 150); });
    await waitForSearchInputReady(input, { timeout: 2000, check: async () => {} });
    assert.equal(await input.evaluate(el => el === document.activeElement && !el.readOnly), true);
    const stopped = new Error('stopped');
    await assert.rejects(waitForSearchInputReady(input, { timeout: 2000, check: async () => { throw stopped; } }), error => error === stopped);
  });
});

test('typing measurements separate checks from total elapsed time without storing the query', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form);
    const events = [];
    await typeTextHumanLike(page.locator('input'), 'личное', { timeout: 2000, check: () => new Promise(resolve => setTimeout(resolve, 20)), log: (event, data) => events.push({ event, ...data }) });
    const metrics = events.find(e => e.event === 'search_input_metrics');
    assert.equal(metrics.characters, 6);
    assert.equal(metrics.intervalCount, 5);
    assert.ok(metrics.checksMs >= 100 && metrics.elapsedMs > metrics.checksMs);
    assert.ok(metrics.intervalMaxMs >= metrics.intervalMedianMs);
    assert.ok(!JSON.stringify(events).includes('личное'));
  });
});

test('query completion precedes submission and changes during the final check cannot be sent', async () => {
  await fixture(async ({ page, context }) => {
    let requests = 0;
    await context.route('http://search.test/**', route => {
      const results = new URL(route.request().url()).pathname === '/search';
      if (results) requests++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta name="viewport" content="width=device-width,initial-scale=1">' + (results ? '<div class="serp-item"><h2><a href="http://other.test/">Result</a></h2></div>' : '<form action="/search"><input name="text"><button>Найти</button></form>') });
    });
    for (const mutate of [false, true]) {
      const events = []; let entered = false, changed = false;
      const options = {
        engines: { yandex: { home: 'http://search.test/', domains: ['search.test'] } }, navigationTimeoutMs: 3000, ownedOnly: true, waitFor: async () => {},
        log: event => { events.push(event); if (event === 'search_query_entered') entered = true; },
        createCheckCaptcha: () => async child => {
          if (mutate && entered && !changed) { changed = true; await child.locator('input').evaluate(el => { el.value = 'unexpected'; }); }
          return false;
        },
      };
      const work = performSearchAndClick(page, { id: 'test', searchEngine: 'yandex', searchQueries: ['qa'], vitalPhrases: [], targetDomain: 'target.test' }, options);
      if (mutate) {
        await assert.rejects(work, error => error.code === 'search_query_mismatch');
        assert.ok(events.includes('search_submit_blocked'));
        assert.ok(!events.includes('search_submit_started'));
      } else {
        assert.equal((await work).found, false);
        const stages = ['search_home_ready', 'search_pre_input_pause', 'search_input_activated', 'search_input_metrics', 'search_query_entered', 'search_submit_started', 'search_submit_completed', 'search_results_ready'];
        assert.deepEqual(events.filter(e => stages.includes(e)), stages);
      }
    }
    assert.equal(requests, 1);
  });
});
