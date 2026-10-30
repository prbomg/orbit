import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { findInSerpOrPaginate, performSearchAndClick } from '../worker/search.mjs';
import { installSearchFixture } from './fixtures/search-pages.mjs';

const launch = () => chromium.launch({ headless: true,
  executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });

test('pagination respects per-task depth, default three, early match and end of results', { timeout: 90_000 }, async () => {
  const browser = await launch();
  try {
    for (const scenario of [
      { searchDepth: 1, expected: 1 }, { searchDepth: 3, expected: 3 },
      { expected: 3 }, { searchDepth: 10, expected: 10 },
      { searchDepth: 10, expected: 1, targetPage: 1 },
      { searchDepth: 10, expected: 2, lastPage: 2 },
    ]) {
      const context = await browser.newContext();
      try {
        const fixture = await installSearchFixture(context, {
          targetPage: scenario.targetPage ?? null, lastPage: scenario.lastPage ?? 12,
        });
        const page = await context.newPage(), scanned = [];
        await page.goto('http://search.test/search?text=fixture&p=1');
        const result = await findInSerpOrPaginate(page,
          { targetDomain: 'target.test', searchDepth: scenario.searchDepth },
          { timeout: 4000, ownedOnly: true, searchDomains: ['search.test'], document: async () => {},
            check: async () => {}, pause: async () => {},
            log: (event, data) => { if (event === 'search_page_scanned') scanned.push(data.page); } });
        assert.equal(result.pagesVisited, scenario.expected);
        assert.equal(Boolean(result.target), Boolean(scenario.targetPage));
        assert.deepEqual(scanned, Array.from({ length: scenario.expected }, (_, i) => i + 1));
        assert.ok(fixture.visits.every(url => Number(new URL(url).searchParams.get('p') || 1) <= scenario.expected));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('refinement restarts pagination with the same configured depth', { timeout: 30_000 }, async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext();
    const fixture = await installSearchFixture(context, { targetPage: null, lastPage: 12 });
    const page = await context.newPage(), scanned = [];
    let clock = 0;
    const result = await performSearchAndClick(page, {
      id: 'depth-fixture', searchEngine: 'yandex', searchQueries: ['qa'],
      vitalPhrases: ['brand'], targetDomain: 'target.test', searchDepth: 2,
    }, {
      engines: { yandex: { home: 'http://search.test/', domains: ['search.test'] } },
      ownedOnly: true, navigationTimeoutMs: 4000, now: () => clock, waitFor: async ms => { clock += ms; },
      log: (event, data) => { if (event === 'search_page_scanned') scanned.push(data.page); },
    });
    assert.equal(result.found, false);
    assert.equal(result.refined, true);
    assert.equal(result.pagesVisited, 4);
    assert.deepEqual(scanned, [1, 2, 1, 2]);
    assert.ok(fixture.visits.every(url => new URL(url).hostname === 'search.test'));
  } finally { await browser.close(); }
});
