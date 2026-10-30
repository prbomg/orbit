import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { prepareSearchQuery, performSearchAndClick, submitSearch } from '../worker/search.mjs';
import { dismissSearchOverlays } from '../worker/search-overlays.mjs';
import { TaskStoppedError } from '../worker/behavior.mjs';
import { installSearchFixture } from './fixtures/search-pages.mjs';

const home = 'http://search.test/';
const allowedHost = host => host === 'search.test';
const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
const form = '<form action="/search"><input name="text"><button>Найти</button></form>';
const covered = '<div style="position:relative;width:300px;height:50px"><input name="text" value="qa" style="width:280px;height:40px"><div style="position:absolute;inset:0;background:white">Свёрнутая строка поиска</div></div>';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const events = [];
    const options = { home, allowedHost, timeout: 1000, check: () => dismissSearchOverlays(page, { allowedHost }), document: async () => {}, log: (event, data) => events.push({ event, ...data }) };
    await run({ context, page, options, events });
  } finally { await browser.close(); }
}

test('mobile search reselects the expanded editor after tapping the collapsed field', async () => {
  await fixture(async ({ context, page, options, events }) => {
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + `<input name="text" value="запрос" id="old" onclick="document.querySelector('[role=dialog]').style.display='block';document.querySelector('textarea').focus()"><div role="dialog" style="display:none;position:fixed;inset:0;background:white"><form action="/search"><textarea name="text">запрос</textarea><button>Найти</button></form></div>` }));
    await page.goto(home);
    const result = await prepareSearchQuery(page, 'запрос', 'бренд', options);
    assert.equal(await result.input.inputValue(), 'запрос бренд');
    assert.equal(await page.locator('#old').inputValue(), 'запрос');
    assert.equal(events.filter(row => row.event === 'search_input_retry').length, 0);
    await submitSearch(result.input, 1000);
    await page.waitForURL(url => url.searchParams.get('text') === 'запрос бренд');
  });
});

test('covered input recovers once from home with the exact refined query and existing storage', async () => {
  await fixture(async ({ context, page, options, events }) => {
    let homes = 0;
    await context.route('http://search.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') homes++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + (url.pathname === '/stuck' ? covered : form) });
    });
    await page.goto(home + 'stuck');
    await page.evaluate(() => localStorage.setItem('session', 'retained'));
    const result = await prepareSearchQuery(page, 'занятие мама', 'бренд', options);
    assert.equal(await result.input.inputValue(), 'занятие мама бренд');
    assert.equal(await page.evaluate(() => localStorage.getItem('session')), 'retained');
    assert.equal(homes, 1);
    assert.deepEqual(events.filter(row => row.event === 'search_input_retry'), [{ event: 'search_input_retry', code: 'search_input_activation_timeout' }]);
  });
});

test('input recovery stops after one attempt and reports the failed stage', async () => {
  await fixture(async ({ context, page, options, events }) => {
    let homes = 0;
    await context.route('http://search.test/**', route => {
      if (new URL(route.request().url()).pathname === '/') homes++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + covered });
    });
    await page.goto(home + 'stuck');
    await assert.rejects(prepareSearchQuery(page, 'qa', 'brand', { ...options, timeout: 350 }), error => error.code === 'search_input_activation_timeout');
    assert.equal(homes, 1);
    assert.equal(events.filter(row => row.event === 'search_input_retry').length, 1);
    assert.equal(events.at(-1).event, 'search_input_failed');
  });
});

test('a stop during input activation prevents recovery navigation', async () => {
  await fixture(async ({ context, page, options }) => {
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + covered }));
    await page.goto(home + 'stuck');
    let stopped = false;
    await assert.rejects(prepareSearchQuery(page, 'qa', 'brand', {
      ...options, timeout: 350,
      check: async () => { if (stopped) throw new TaskStoppedError(); },
      log: event => { if (event === 'search_input_activating') stopped = true; },
    }), error => error instanceof TaskStoppedError);
    assert.equal(page.url(), home + 'stuck');
  });
});

test('a blocking prompt is not bypassed by input recovery', async () => {
  await fixture(async ({ context, page, options }) => {
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + covered + '<div role="dialog" style="position:fixed;inset:0;background:white">Установите Яндекс основным поиском</div>' }));
    await page.goto(home + 'stuck');
    await assert.rejects(prepareSearchQuery(page, 'qa', 'brand', options), error => error.code === 'search_overlay_blocked');
    assert.equal(page.url(), home + 'stuck');
  });
});

// Pagination and the target visit now include 0.8–2.0 second swipes.
test('full search recovers a covered field after page five and preserves refinement statistics', { timeout: 60000 }, async () => {
  await fixture(async ({ context, page, events }) => {
    const fixture = await installSearchFixture(context, { refinement: true });
    let clock = 0;
    const visits = [];
    page.on('domcontentloaded', async () => {
      if (new URL(page.url()).searchParams.get('p') === '5') await page.locator('input[name=text]').evaluate(el => {
        const cover = document.createElement('div');
        const r = el.getBoundingClientRect();
        Object.assign(cover.style, { position: 'absolute', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, background: 'white' });
        document.body.append(cover);
      });
    });
    const result = await performSearchAndClick(page, { id: 'fixture', searchEngine: 'yandex', searchQueries: ['qa'], vitalPhrases: ['brand'], targetDomain: 'target.test' }, {
      engines: { yandex: { home, domains: ['search.test'] } }, navigationTimeoutMs: 1500,
      ownedOnly: true, targetDurationMs: 60000, now: () => clock, waitFor: async ms => { clock += ms; },
      onTargetVisit: value => visits.push(value), log: (event, data) => events.push({ event, ...data }),
    });
    assert.equal(result.found, true);
    assert.equal(result.refined, true);
    assert.equal(result.pagesVisited, 7);
    assert.equal(visits.length, 1);
    assert.equal(visits[0].query, 'qa');
    assert.equal(visits[0].actualQuery, 'qa brand');
    assert.equal(events.filter(row => row.event === 'search_input_retry').length, 1);
    assert.equal(fixture.visits.filter(url => url === home).length, 2);
  });
});
