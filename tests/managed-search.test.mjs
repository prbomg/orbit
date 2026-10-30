import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { restrictOwnedNavigation } from '../worker/owned-navigation.mjs';
import { performSearchAndClick, SEARCH_ENGINES } from '../worker/search.mjs';
import { startLiveView, flushLiveView } from '../worker/live-view.mjs';
import { runTask } from '../worker/runner.mjs';

const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });

test('managed tasks accept each configured engine before checking whether the task is still active', async () => {
  for (const engine of [...Object.keys(SEARCH_ENGINES), 'unknown']) {
    let checked = false;
    const task = { id: 'test', projectId: 'project', project: { targetUrl: 'https://target.test/' }, taskType: 'target', searchEngine: engine };
    await assert.rejects(runTask({ task, config: { projectId: 'project' }, checkActive: async () => { checked = true; return false; } }), { name: 'TaskStoppedError' });
    assert.equal(checked, engine !== 'unknown', engine);
  }
});

test('selected engine controls top-level navigation, including popups and legacy boolean options', async () => {
  const browser = await launch();
  try {
    for (const engine of ['dzen', 'mail', 'yandex', false, true]) {
      const context = await browser.newContext();
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture</h1>' }));
      await restrictOwnedNavigation(context, 'https://target.test/', engine);
      for (const host of ['target.test', 'sub.target.test', 'dzen.ru', 'sso.dzen.ru', 'mail.ru', 'ya.ru', 'dzen.ru.evil.test', 'unrelated.test']) {
        const page = await context.newPage();
        const expected = host.endsWith('target.test') || (host === 'ya.ru' && Boolean(engine)) || (engine === 'dzen' && ['dzen.ru', 'sso.dzen.ru'].includes(host)) || (engine === 'mail' && host === 'mail.ru');
        if (expected) await page.goto('https://' + host + '/', { timeout: 3000 });
        else await assert.rejects(page.goto('https://' + host + '/', { timeout: 3000 }), /ERR_BLOCKED_BY_CLIENT/);
        await page.close();
      }
      const page = await context.newPage();
      await page.goto('https://target.test/');
      const popupPromise = context.waitForEvent('page');
      await page.evaluate(() => window.open('https://unrelated.test/'));
      const popup = await popupPromise;
      await popup.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
      assert.notEqual(popup.url(), 'https://unrelated.test/');
      await context.close();
    }
  } finally { await browser.close(); }
});

test('Dzen iframe search reaches Yandex with the exact query and appears in live history', { timeout: 25000 }, async () => {
  const browser = await launch(), runId = randomUUID(), taskId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId);
  let stop = () => {};
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const visits = [];
    // Registered first so both production route filters must pass before this fixture responds.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); visits.push(url.href);
      let body = '<h1>Results</h1><div class="serp-item"><h2><a href="https://unrelated.test/">Another site</a></h2></div>';
      if (url.hostname === 'dzen.ru') body = '<form action="https://yandex.ru/search/"><iframe name="search_widget" src="https://suggest.sso.dzen.ru/portal/dzensearch/desktop" style="width:340px;height:100px;border:0"></iframe></form>';
      if (url.hostname === 'suggest.sso.dzen.ru') body = '<form action="https://yandex.ru/search/" target="_blank"><input name="text"><button type="submit">Найти</button></form>';
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta name="viewport" content="width=device-width,initial-scale=1">' + body });
    });
    await restrictOwnedNavigation(context, 'https://target.test/', 'dzen');
    stop = startLiveView(context, { runId, taskId, targetUrl: 'https://target.test/', searchEngine: 'dzen' });
    const page = await context.newPage(); let clock = 0;
    const result = await performSearchAndClick(page, { id: taskId, searchEngine: 'dzen', searchQueries: ['тест поиск'], vitalPhrases: [], targetDomain: 'target.test' }, {
      ownedOnly: true, navigationTimeoutMs: 5000, now: () => clock, waitFor: async ms => { clock += ms; },
    });
    assert.equal(result.found, false); assert.equal(result.pagesVisited, 1);
    assert.equal(new URL(page.url()).hostname, 'yandex.ru');
    assert.equal(new URL(page.url()).searchParams.get('text'), 'тест поиск');
    assert.equal(context.pages().length, 1);
    assert.ok(visits.includes('https://dzen.ru/'));
  await flushLiveView(runId);
    const events = (await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    for (const host of ['dzen.ru', 'yandex.ru']) assert.ok(events.some(event => event.event === 'navigation_response' && new URL(event.url).hostname === host && event.status === 200));
    assert.ok(events.every(event => !event.url?.includes('?')));
  } finally { await stop(); await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
