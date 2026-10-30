import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { performWarmup } from '../worker/warmup.mjs';
import { visitCompetitors } from '../worker/search.mjs';

const launch = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH };
const content = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><main style="height:10000px">Local reading fixture</main>';

for (const bias of [0, .9]) test(`warmup starts each page downward, reads between moves and only re-reads at the end (${bias})`, async t => {
  const browser = await chromium.launch(launch);
  try {
    const context = await browser.newContext(), page = await context.newPage(), events = [];
    const sites = ['http://one.test/', 'http://two.test/', 'http://three.test/'];
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: content }));
    await performWarmup(page, { random: () => bias, sites, chooseSites: () => sites, waitFor: async () => {}, log: (event, data) => events.push({ event, ...data }) });
    for (let step = 1; step <= 3; step++) {
      const moves = events.filter(event => event.event === 'warmup_scroll' && event.step === step);
      const down = moves.filter(event => event.pixels > 0), up = moves.filter(event => event.pixels < 0);
      assert.equal(down.length, bias === 0 ? 2 : 4);
      assert.equal(up.length, bias === 0 ? 1 : 0);
      assert.ok(moves[0].pixels > 0);
      assert.ok(down.every(event => event.pixels >= 220 && event.pixels <= 680));
      if (up.length) { assert.equal(moves.at(-1), up[0]); assert.ok(up[0].pixels >= -280 && up[0].pixels <= -120); }
    }
    const pauses = events.filter(event => event.event === 'warmup_wait' && event.phase === 'after_scroll');
    assert.equal(pauses.length, events.filter(event => event.event === 'warmup_scroll').length);
    assert.ok(pauses.every(event => event.plannedMs >= 1800 && event.plannedMs <= 4200));
    assert.equal(events.filter(event => event.event === 'warmup_site_completed').length, 3);
  } finally { await browser.close(); }
});

test('warmup cancellation during reading prevents the next scroll', async t => {
  const browser = await chromium.launch(launch), controller = new AbortController(), stopped = new Error('reading_stopped');
  try {
    const context = await browser.newContext(), page = await context.newPage(), events = [];
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: content }));
    await assert.rejects(performWarmup(page, {
      random: () => .1, sites: ['http://one.test/'], requiredSites: 1, chooseSites: pool => pool, signal: controller.signal,
      log: (event, data) => events.push({ event, ...data }),
      waitFor: async (ms, signal) => {
        if (events.some(event => event.event === 'warmup_scroll')) controller.abort(stopped);
        signal.throwIfAborted();
      },
    }), error => error === stopped);
    assert.equal(events.filter(event => event.event === 'warmup_scroll').length, 1);
    assert.ok(!events.some(event => event.event === 'warmup_site_completed'));
  } finally { await browser.close(); }
});

async function competitorFixture(t, bias, run) {
  const browser = await chromium.launch(launch);
  try {
    const context = await browser.newContext(), page = await context.newPage(), child = await context.newPage();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: route.request().url().includes('search.test') ? '<!doctype html><ul><li class="serp-item"><h2><a href="http://competitor.test/article">Competitor</a></h2></li></ul>' : content }));
    await page.goto('http://search.test/'); await child.goto('http://competitor.test/article');
    let clock = 0;
    const moves = [], pauses = [], controller = new AbortController();
    const session = {
      random: () => bias, timeout: 2000, searchDomains: ['search.test'], signal: controller.signal, now: () => clock,
      check: async () => controller.signal.throwIfAborted(),
      openResult: async () => child, setOutbound: () => {}, document: async () => {},
      log: event => { if (event === 'visit_scroll') moves.push(clock); },
      pause: async (ms, current) => {
        controller.signal.throwIfAborted();
        if (current === child) { pauses.push(ms); clock += ms; }
      },
    };
    const visit = () => visitCompetitors(page, [{ domain: 'competitor.test', destination: 'http://competitor.test/article' }], null, { targetDomain: 'target.test' }, session);
    await run({ page, child, moves, pauses, session, controller, visit, advance: ms => { clock += ms; }, now: () => clock });
  } finally { await browser.close(); }
}

for (const bias of [0, .1, .6]) test(`competitor scrolls span the dwell window with 3–4 bounded reading intervals (${bias})`, async t => {
  await competitorFixture(t, bias, async ({ child, moves, pauses, visit, now }) => {
    assert.equal(await visit(), 1);
    const dwell = 10000 + Math.floor(bias * 10001);
    assert.equal(now(), dwell);
    assert.ok(moves.length >= 3 && moves.length <= 4);
    assert.equal(moves.length, pauses.length);
    assert.ok(pauses.every(ms => ms >= 2500 && ms <= 5000));
    assert.equal(moves[0], 0);
    assert.ok(moves.at(-1) >= dwell * .6, 'activity continues in the latter part of the visit');
    assert.ok(moves.every((at, i) => i === 0 || at - moves[i - 1] >= 2500));
    assert.equal(child.isClosed(), true);
  });
});

test('competitor checks that consume the visit budget do not dispatch a late scroll or add a dwell wait', async t => {
  await competitorFixture(t, .1, async ({ child, moves, pauses, session, advance, visit }) => {
    let checks = 0;
    session.check = async current => { if (current === child && ++checks === 1) advance(25000); };
    assert.equal(await visit(), 1);
    assert.equal(checks, 1);
    assert.deepEqual(moves, []); assert.deepEqual(pauses, []);
  });
});

test('a slow competitor check skips elapsed intervals instead of a burst of catch-up scrolls', async t => {
  await competitorFixture(t, .1, async ({ child, moves, pauses, session, advance, visit, now }) => {
    let first = true;
    session.check = async current => { if (current === child && first) { first = false; advance(7000); } };
    assert.equal(await visit(), 1);
    assert.deepEqual(moves, [7000]); assert.deepEqual(pauses, [4000]);
    assert.equal(now(), 11000);
  });
});

test('competitor cancellation during a reading interval stops further viewport activity', async t => {
  await competitorFixture(t, .1, async ({ child, moves, session, controller, visit }) => {
    const stopped = new Error('competitor_stopped');
    session.pause = async (ms, current) => { if (current === child) controller.abort(stopped); controller.signal.throwIfAborted(); };
    await assert.rejects(visit(), error => error === stopped);
    assert.equal(moves.length, 1);
  });
});
