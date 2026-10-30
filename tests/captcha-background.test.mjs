import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createCaptchaHandler, detectCaptcha } from '../worker/captcha-page.mjs';

const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
const article = '<main><h1>Занятия на укулеле</h1><p>Содержимое доступной страницы сайта.</p></main>';
const widget = '<div class="g-recaptcha" data-sitekey="fixture-recaptcha-sitekey" style="width:300px;height:78px"></div>';
const anchor = '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=fixture-recaptcha-sitekey&size=invisible" style="width:0;height:0;visibility:hidden"></iframe>';
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
async function withPage(html, run, url = 'https://owned.test/article/') {
  const browser = await launch();
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + (new URL(route.request().url()).hostname === new URL(url).hostname ? html : '<p>Fixture frame</p>') }));
    const page = await context.newPage(); await page.goto(url);
    await run(page);
  } finally { await browser.close(); }
}

test('a dormant invisible reCAPTCHA does not block a visit even with an exhausted solve budget', async () => {
  await withPage(article + anchor, async page => {
    assert.equal((await detectCaptcha(page)).type, 'recaptcha');
    assert.equal(await detectCaptcha(page, { blockingOnly: true }), null);
    const events = [];
    const check = createCaptchaHandler({
      config: { captchaMaxSolves: 0 }, taskId: 'fixture', log: event => events.push(event),
      prisma: { settings: { findUnique: async () => { throw new Error('No paid request is expected'); } } },
    });
    assert.equal(await check(page), false);
    assert.deepEqual(events, []);
  });
});

test('hidden form widgets and widgets belonging to ordinary application forms are ignored', async () => {
  for (const html of [
    `<div style="display:none">${widget}</div>`,
    `<div style="opacity:0">${widget}</div>`,
    `<div hidden>${widget}</div>`,
    `<form><input name="phone" type="tel">${widget}<button>Записаться</button></form>`,
    `<form><input name="email" type="email"><div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey"></div></form>`,
  ]) await withPage(article + html, async page => {
    assert.ok(await detectCaptcha(page));
    assert.equal(await detectCaptcha(page, { blockingOnly: true }), null);
  });
});

test('a visible verification widget still blocks the visit and respects the payment limit', async () => {
  await withPage('<h1>Подтвердите, что вы не робот</h1>' + widget, async page => {
    assert.equal((await detectCaptcha(page, { blockingOnly: true })).type, 'recaptcha');
    const check = createCaptchaHandler({ config: { captchaMaxSolves: 0 }, taskId: 'fixture', log: () => {}, navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.code === 'solve_limit');
  });
});

test('an invisible widget is detected when its actual challenge iframe opens', async () => {
  const puzzle = '<iframe id="puzzle" src="https://www.google.com/recaptcha/api2/bframe?k=fixture-recaptcha-sitekey" style="position:fixed;top:100px;left:20px;width:320px;height:400px;border:0"></iframe>';
  await withPage(article + anchor + puzzle, async page => {
    assert.equal((await detectCaptcha(page, { blockingOnly: true })).type, 'recaptcha');
    await page.locator('#puzzle').evaluate(el => el.style.display = 'none');
    assert.equal(await detectCaptcha(page, { blockingOnly: true }), null);
  });
});

test('captcha markup inside an invisible child frame is ignored', async () => {
  await withPage(article + `<iframe style="opacity:0" srcdoc='${widget}'></iframe>`, async page => {
    assert.equal((await detectCaptcha(page)).type, 'recaptcha');
    assert.equal(await detectCaptcha(page, { blockingOnly: true }), null);
  });
});

test('a full-page Yandex verification still detects its hidden token widget', async () => {
  await withPage('<h1>Подтвердите, что вы не робот</h1>' + anchor, async page => {
    assert.equal((await detectCaptcha(page, { blockingOnly: true })).type, 'recaptcha');
    const check = createCaptchaHandler({ config: { captchaMaxSolves: 0 }, taskId: 'fixture', log: () => {}, navigationPolicy: { clearCaptchaPost() {} } });
    await assert.rejects(check(page), error => error.code === 'solve_limit');
  }, 'https://ya.ru/showcaptcha');
});

for (const failures of [0, 2, 3]) test(`captcha limits count paid requests separately from incorrect solutions (${failures} incorrect)`, async () => {
  let requests = 0;
  const provider = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/createTask') {
      request.resume(); request.on('end', () => response.end(JSON.stringify({ errorId: 0, taskId: ++requests })));
    } else response.end(JSON.stringify(requests <= failures ? {errorId:12,errorCode:'ERROR_CAPTCHA_UNSOLVABLE'} : { errorId: 0, status: 'ready', solution: { token: 'synthetic-token' } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const browser = await launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/verification'
        ? '<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey" data-callback="solved"></div><script>function solved(){location.href="/article"}</script>'
        : article + anchor;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: head + body });
    });
    const page = await context.newPage();
    const events = [];
    const endpoint = `http://127.0.0.1:${provider.address().port}`;
    const check = createCaptchaHandler({
      prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
      config: { captchaMaxSolves: 5, captchaMaxIncorrect: 3, captchaBaseUrl: endpoint, captchaV2BaseUrl: endpoint, captchaPollingMs: 20, captchaTimeoutMs: 5000, navigationTimeoutMs: 1000 },
      userAgent: 'Fixture browser', shouldContinue: async () => true, taskId: 'fixture', log: event => events.push(event), navigationPolicy: { clearCaptchaPost() {} },
    });
    if(failures===3){
      await page.goto('https://owned.test/verification');await assert.rejects(check(page),error=>error.code==='incorrect_limit');
      assert.equal(requests,3);assert.equal(events.filter(event=>event==='captcha_retrying').length,2);return;
    }
    for (let i = 0; i < 5-failures; i++) {
      await page.goto('https://owned.test/verification');
      assert.equal(await check(page), true);
      await page.waitForURL('https://owned.test/article');
    }
    assert.equal(await check(page), false);
    assert.equal(requests, 5);
    assert.equal(events.filter(event => event === 'captcha_requested').length, 5);
    assert.equal(events.filter(event => event === 'captcha_failed').length,failures);
    await page.goto('https://owned.test/verification');
    await assert.rejects(check(page), error => error.code === 'solve_limit');
    assert.equal(requests, 5);
  } finally { await browser.close(); await new Promise(resolve => provider.close(resolve)); }
});
