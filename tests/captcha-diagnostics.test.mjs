import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createCaptchaHandler, detectCaptcha } from '../worker/captcha-page.mjs';
import { CaptchaError } from '../worker/captcha-provider.mjs';
import { pollDatabase } from '../worker/runner.mjs';

test('a document replacement during captcha detection is retried', async () => {
  const frame = { evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); }, isDetached: () => false };
  const page = { frames: () => [frame], isClosed: () => false };
  assert.equal(await detectCaptcha(page), null);
});

test('Yandex full-page verification without a readable widget reports its reason', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: '<h1>Please confirm that you are not a robot</h1>' }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptcha');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => { throw new Error('Settings should not be read'); } } }, config: { captchaWidgetWaitMs: 100 }, taskId: 'test', log: (event, details) => events.push({ event, ...details }), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'widget_not_detected');
    assert.deepEqual(events.map(item => item.event), ['captcha_widget_wait', 'captcha_unrecognized']);
    await context.close();
  } finally { await browser.close(); }
});

test('Yandex redirect between challenge pages reports a captcha error rather than a browser error', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptchafast', route => route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(() => { location.href = "/showcaptcha"; }, 100)</script>' }));
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: '<h1>Verification</h1>' }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptchafast');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => { throw new Error('Settings should not be read'); } } }, config: { captchaWidgetWaitMs: 700 }, taskId: 'test', log: (event, details) => events.push({ event, ...details }), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'widget_not_detected');
    assert.equal(new URL(page.url()).pathname, '/showcaptcha');
    assert.deepEqual(events.map(item => item.event), ['captcha_widget_wait', 'captcha_unrecognized']);
    await context.close();
  } finally { await browser.close(); }
});

test('Yandex challenge waits for a widget rendered after navigation', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptchafast', route => route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(() => { document.body.innerHTML = `<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey"></div>`; }, 200)</script>' }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptchafast');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: null }) } }, config: { captchaWidgetWaitMs: 1_000, captchaMaxSolves: 3 }, taskId: 'test', log: (event, details) => events.push({ event, ...details }), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'missing_api_key');
    assert.deepEqual(events.map(item => item.event), ['captcha_widget_wait', 'captcha_detected', 'captcha_failed']);
    await context.close();
  } finally { await browser.close(); }
});

test('Yandex checkbox is opened automatically before looking for a sitekey', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: `
      <form id="checkbox-captcha-form"><button type="button" role="checkbox" onclick="setTimeout(() => { document.getElementById('widget').innerHTML = '<div class=smart-captcha data-sitekey=fixture-smartcaptcha-sitekey></div>'; }, 100)">I'm not a robot</button></form>
      <div id="widget"></div>` }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptcha');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: null }) } }, config: { captchaWidgetWaitMs: 1_000, captchaMaxSolves: 3 }, taskId: 'test', log: event => events.push(event), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'missing_api_key');
    assert.ok(events.includes('captcha_checkbox_clicked'));
    assert.ok(events.includes('captcha_detected'));
    assert.equal(await page.getByRole('checkbox').getAttribute('aria-checked'), null);
    await context.close();
  } finally { await browser.close(); }
});

test('Yandex checkbox is retried after showcaptchafast redirects to showcaptcha', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptchafast', route => route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(() => location.href = "/showcaptcha", 100)</script>' }));
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: `
      <form id="checkbox-captcha-form"><div class="CheckboxCaptcha-Button" role="checkbox" onclick="document.body.insertAdjacentHTML('beforeend', '<div class=smart-captcha data-sitekey=fixture-smartcaptcha-sitekey></div>')">I'm not a robot</div></form>` }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptchafast');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: null }) } }, config: { captchaWidgetWaitMs: 1_000, captchaMaxSolves: 3 }, taskId: 'test', log: event => events.push(event), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'missing_api_key');
    assert.equal(new URL(page.url()).pathname, '/showcaptcha');
    assert.ok(events.includes('captcha_checkbox_clicked'));
    await context.close();
  } finally { await browser.close(); }
});

test('visible browser can continue after a human completes a Yandex challenge', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: '<button id="manual" onclick="location.href = \'/search/\'">Complete check</button>' }));
    await context.route('https://ya.ru/search/', route => route.fulfill({ contentType: 'text/html', body: '<h1>Results</h1>' }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptcha');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => { throw new Error('Provider must not be called'); } } }, config: { headless: false, captchaWidgetWaitMs: 100, captchaManualWaitMs: 2_000 }, shouldContinue: async () => true, taskId: 'test', log: (event, details) => events.push({ event, ...details }), navigationPolicy: { clearCaptchaPost() {} } });
    const result = check(page);
    await new Promise(resolve => setTimeout(resolve, 300));
    await page.locator('#manual').click();
    assert.equal(await result, true);
    assert.deepEqual(events.map(item => item.event), ['captcha_widget_wait', 'captcha_manual_required', 'captcha_manual_completed']);
    await context.close();
  } finally { await browser.close(); }
});

test('missing RuCaptcha key is reported before claiming that a provider request was sent', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://owned.test/', route => route.fulfill({ contentType: 'text/html', body: '<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey"></div>' }));
    const page = await context.newPage();
    await page.goto('https://owned.test/');
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: null }) } }, config: { captchaMaxSolves: 3 }, taskId: 'test', log: (event, details) => events.push({ event, ...details }), navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.name === 'CaptchaError' && error.code === 'missing_api_key');
    assert.deepEqual(events.map(item => item.event), ['captcha_detected', 'captcha_failed']);
    await context.close();
  } finally { await browser.close(); }
});

for (const code of ['widget_not_detected', 'solve_limit', 'image_capture_failed']) test(`managed worker stops after ${code} instead of retrying the task`, async () => {
  const events = []; let attempts = 0;
  const result = await pollDatabase({
    prisma: {
      task: { findMany: async () => [{ id: 'task', taskType: 'target', searchEngine: 'yandex', currentExecutions: 0, targetExecutions: 5 }] },
      proxy: { findMany: async () => [{ id: 'proxy' }] },
    },
    config: { projectId: 'project', cooldownMs: 1, pollMs: 1 },
    signal: new AbortController().signal,
    log: (event, details) => events.push({ event, ...details }),
    runTaskRunner: async () => { attempts++; throw new CaptchaError(code); },
  });
  assert.equal(result, 1);
  assert.equal(attempts, 1);
  assert.ok(events.some(item => item.event === 'project_blocked' && item.code === code));
});
