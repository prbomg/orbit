import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { submitSearch } from '../worker/search.mjs';

test('clicks the visible Find button when Enter is ignored by the form', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('http://search.test/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/search' ? '<h1>Results</h1>' : '<form action="/search"><input name="text" onkeydown="if(event.key === \'Enter\') event.preventDefault()"><button type="submit">Найти</button></form>' });
    });
    const page = await context.newPage();
    await page.goto('http://search.test/');
    const input = page.locator('input[name="text"]');
    await input.fill('test query');
    const methods = [];
    assert.equal(await submitSearch(input, 5000, method => methods.push(method)), 'button');
    assert.deepEqual(methods, ['button']);
    await page.waitForURL('http://search.test/search?text=test+query');
    await context.close();
  } finally { await browser.close(); }
});

test('uses Enter when a search form has no submit button', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('http://search.test/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/search' ? '<h1>Results</h1>' : '<form action="/search"><input name="text"></form>' });
    });
    const page = await context.newPage();
    await page.goto('http://search.test/');
    const input = page.locator('input[name="text"]');
    await input.fill('fallback');
    const methods = [];
    assert.equal(await submitSearch(input, 5000, method => methods.push(method)), 'enter');
    assert.deepEqual(methods, ['enter']);
    await page.waitForURL('http://search.test/search?text=fallback');
    await context.close();
  } finally { await browser.close(); }
});
