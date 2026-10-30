import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { prepareSearchQuery, submitSearch } from '../worker/search.mjs';

test('reference page records browser entry and suggestion selection as separate scenarios', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.setContent(await readFile(new URL('./fixtures/search-entry-lab.html', import.meta.url), 'utf8'));
    const prepared = await prepareSearchQuery(page, 'кофе рядом', undefined, { allowedHost: () => true, home: 'about:blank', timeout: 3000, check: async () => {}, document: async () => {} });
    await submitSearch(prepared.input, 3000, undefined, { expected: prepared.expected });
    const typed = await page.evaluate(() => window.entryLabReport());
    assert.equal(typed.scenario, 'typed');
    assert.equal(typed.events.filter(e => e.type === 'compositionstart').length, 10);
    assert.equal(typed.events.filter(e => e.type === 'compositionend').length, 10);
    assert.deepEqual(typed.events.filter(e => e.type === 'input').map(e => e.valueLength), Array.from({length:10},(_,i)=>[i+1,i+1]).flat());
    assert.equal(await prepared.input.inputValue(), 'кофе рядом');
    assert.ok(typed.events.some(e => e.type === 'submitted'));
    assert.ok(!JSON.stringify(typed).includes('кофе рядом'));
    await page.selectOption('#scenario', 'suggestion');
    await page.locator('#query').tap(); await page.keyboard.insertText('коф');
    await page.getByRole('button', { name: 'кофе рядом', exact: true }).tap();
    await page.getByRole('button', { name: 'Найти', exact: true }).tap();
    const suggested = await page.evaluate(() => window.entryLabReport());
    assert.equal(suggested.scenario, 'suggestion');
    assert.ok(suggested.events.findIndex(e => e.type === 'suggestion_selected') < suggested.events.findIndex(e => e.type === 'submitted'));
    assert.equal(await page.locator('#query').inputValue(), 'кофе рядом');
  } finally { await browser.close(); }
});
