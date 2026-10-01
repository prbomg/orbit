import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { domainMatches, performSearchAndClick, SearchError } from '../worker/search.mjs';
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
  const browser = await chromium.launch({ headless: true });
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

test('engine adapters handle iframe input, same-tab competitors, native popups, target depth and final dwell', { timeout: 35_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const engine of ['yandex', 'mail', 'dzen']) {
      const context = await browser.newContext();
      try {
        const fixture = await installSearchFixture(context, { iframe: engine !== 'yandex', canonicalRoot: engine === 'dzen', competitorPopup: engine !== 'yandex', ajax: engine === 'yandex' });
        const page = await context.newPage(); const events = [];
        const result = await performSearchAndClick(page, { ...task, searchEngine: engine }, { ...fastOptions(), log: (event, data) => events.push({ event, ...data }) });
        assert.equal(result.found, true); assert.equal(result.pagesVisited, 2);
        assert.equal(result.competitorVisits, 1); assert.ok(result.linksFollowed >= 1); assert.equal(result.durationMs, 60_000);
        assert.equal(result.domain, engine === 'dzen' ? 'target.test' : 'www.target.test');
        assert.equal(context.pages().length, 1);
        assert.deepEqual(fixture.typed.slice(0, 2), ['q', 'qa']);
        assert.ok(!fixture.visits.some(url => new URL(url).pathname === '/paid'));
        assert.ok(events.some(row => row.event === 'competitor_visit_started' && row.popup === (engine !== 'yandex')));
        assert.ok(events.some(row => row.event === 'target_visit_finished'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('vital phrase appends after five pages and restarts pagination at one', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); const fixture = await installSearchFixture(context, { refinement: true });
    const page = await context.newPage(); const events = [];
    const result = await performSearchAndClick(page, { ...task, vitalPhrases: ['brand'] }, { ...fastOptions(), log: (event, data) => events.push({ event, ...data }) });
    assert.equal(result.found, true); assert.equal(result.pagesVisited, 7); assert.equal(result.refined, true);
    assert.deepEqual(events.filter(row => row.event === 'search_page_scanned').map(row => row.page), [1, 2, 3, 4, 5, 1, 2]);
    assert.ok(fixture.typed.includes('qa brand')); assert.ok(events.some(row => row.event === 'search_vital_refinement'));
  } finally { await browser.close(); }
});

test('absent target with/without refinement never visits a competitor or marks a target visit', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vitalPhrases of [[], ['brand']]) {
      const context = await browser.newContext(); const fixture = await installSearchFixture(context, { targetPage: null }); const page = await context.newPage();
      try {
        const result = await performSearchAndClick(page, { ...task, vitalPhrases }, fastOptions());
        assert.equal(result.found, false); assert.equal(result.pagesVisited, vitalPhrases.length ? 10 : 5);
        assert.ok(fixture.visits.every(url => new URL(url).hostname === 'search.test'));
        assert.ok(!fixture.visits.some(url => new URL(url).searchParams.get('p') === '6'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('missing pagination and failed destination responses are explicit errors', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const options of [{ targetPage: null, noNext: true }, { targetPage: 1, failure: true }]) {
      const context = await browser.newContext(); await installSearchFixture(context, options); const page = await context.newPage();
      try {
        await assert.rejects(performSearchAndClick(page, task, fastOptions()), error => error instanceof SearchError &&
          error.code === (options.noNext ? 'search_pagination_not_found' : 'search_http_error'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});


test('final target popup retains cookies/localStorage after closing and no further competitor opens', { timeout: 15_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
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
