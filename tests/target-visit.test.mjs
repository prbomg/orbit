import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { interactWithTargetSite, SearchError } from '../worker/search.mjs';

async function withVisit(html, run, { timeout = 250, destination, signal } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const requests = []; const events = []; let clock = 0; let response;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.hostname, 'target.test');
      requests.push(url.pathname);
      if (url.pathname !== '/start' && destination) return destination(route);
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${url.pathname === '/start' ? html : '<h1>Next page</h1>'}<main style="height:8000px"></main>` });
    });
    const page = await context.newPage();
    // Dwell uses a virtual clock; cursor animation is exercised by the search integration tests.
    const move = page.mouse.move.bind(page.mouse);
    page.mouse.move = (x, y) => move(x, y, { steps: 1 });
    page.on('response', value => { if (value.request().isNavigationRequest() && value.frame() === page.mainFrame()) response = value; });
    await page.goto('http://target.test/start');
    const session = {
      timeout, signal, now: () => clock,
      check: async () => { signal?.throwIfAborted(); },
      document: async () => { signal?.throwIfAborted(); if (response && !response.ok()) throw new SearchError('search_http_error'); },
      pause: async ms => { signal?.throwIfAborted(); clock += ms; },
      log: (event, details = {}) => events.push({ event, ...details }),
    };
    const visit = durationMs => interactWithTargetSite(page, { targetDomain: 'target.test' }, session, { durationMs });
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
  });
});

test('a covered link is skipped after a bounded click instead of failing the target visit', { timeout: 10_000 }, async () => {
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a><div style="position:fixed;inset:0;z-index:10">Overlay</div>', async ({ visit, requests, events }) => {
    assert.equal((await visit(60_000)).linksFollowed, 0);
    assert.deepEqual(requests, ['/start']);
    assert.ok(events.some(row => row.event === 'target_internal_link_skipped' && row.code === 'target_internal_link_unavailable'));
    assert.equal(events.filter(row => row.event === 'target_internal_link_started').length, 1);
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
  await withVisit('<a style="position:fixed;top:20px" href="/next">Next</a><div style="position:fixed;inset:0;z-index:10">Overlay</div>', async ({ session, visit, events }) => {
    const log = session.log;
    session.log = (event, details) => { log(event, details); if (event === 'target_internal_link_started') controller.abort(); };
    await assert.rejects(visit(60_000), { name: 'AbortError' });
    assert.ok(!events.some(row => row.event === 'target_visit_finished' || row.event === 'target_internal_link_skipped'));
  }, { signal: controller.signal });
});
