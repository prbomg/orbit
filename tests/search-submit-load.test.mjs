import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { submitSearch, waitForSerpChange } from '../worker/search.mjs';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await run({ context, page });
  } finally { await browser.close(); }
}

test('mobile Find receives touch events, including inside an iframe', async () => {
  await fixture(async ({ context, page }) => {
    const form = `<meta name="viewport" content="width=device-width,initial-scale=1"><form onsubmit="event.preventDefault();window.submitted=true"><input name="text"><button type="submit">Найти</button></form><script>window.events=[];for(const type of ['touchstart','touchend','keydown'])document.addEventListener(type,e=>events.push(e.type));</script>`;
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().endsWith('/frame') ? form : `<iframe src="/frame" width="350" height="300"></iframe>` }));
    await page.goto('http://search.test/');
    const input = page.frameLocator('iframe').locator('input');
    await input.fill('test');
    const methods = [];
    assert.equal(await submitSearch(input, 5000, method => methods.push(method)), 'touch');
    assert.deepEqual(methods, ['touch']);
    assert.deepEqual(await input.evaluate(() => window.events), ['touchstart', 'touchend']);
    assert.equal(await input.evaluate(() => window.submitted), true);
  });
});

test('mobile search without a submit button never sends Enter', async () => {
  await fixture(async ({ page }) => {
    await page.setContent('<form onsubmit="event.preventDefault();window.submitted=true"><input onkeydown="window.key=event.key"></form>');
    await assert.rejects(submitSearch(page.locator('input'), 500), error => error.code === 'search_submit_timeout');
    assert.equal(await page.evaluate(() => window.key ?? window.submitted), undefined);
  });
});

async function pendingDocument(context, page) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('http://search.test/**', async route => {
    if (route.request().url().endsWith('/slow.png')) {
      await gate;
      await route.fulfill({ status: 204 }).catch(() => {});
    } else await route.fulfill({ contentType: 'text/html', body: '<div class="serp-item">Result</div><img src="/slow.png">' });
  });
  await page.goto('http://search.test/results', { waitUntil: 'domcontentloaded' });
  return release;
}

test('changed URL and parsed results do not bypass full document load', async () => {
  await fixture(async ({ context, page }) => {
    const release = await pendingDocument(context, page);
    let completed = false, checks = 0;
    const waiting = waitForSerpChange(page, 'http://search.test/', [], 5000, async () => {
      if (++checks === 3) {
        assert.equal(completed, false);
        assert.equal(await page.evaluate(() => document.readyState), 'interactive');
        release();
      }
    }).then(() => { completed = true; });
    try {
      await waiting;
      assert.ok(checks >= 3);
      assert.equal(await page.evaluate(() => document.readyState), 'complete');
    } finally { release(); }
  });
});

test('a stalled resource has a bounded load timeout', async () => {
  await fixture(async ({ context, page }) => {
    const release = await pendingDocument(context, page);
    try {
      await assert.rejects(waitForSerpChange(page, 'http://search.test/', [], 250), error => error.code === 'search_results_timeout');
    } finally { release(); }
  });
});

test('stop checks remain active while document resources load', async () => {
  await fixture(async ({ context, page }) => {
    const release = await pendingDocument(context, page);
    const stopped = new Error('stopped');
    let checks = 0;
    try {
      await assert.rejects(waitForSerpChange(page, 'http://search.test/', [], 5000, async () => { if (++checks === 3) throw stopped; }), error => error === stopped);
    } finally { release(); }
  });
});

test('AJAX result updates work without a new document load', async () => {
  await fixture(async ({ page }) => {
    await page.setContent('<div class="serp-item">New results</div>');
    await waitForSerpChange(page, page.url(), ['Old results'], 1000);
    assert.equal(await page.locator('.serp-item').textContent(), 'New results');
  });
});
