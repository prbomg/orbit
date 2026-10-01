import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createCaptchaHandler } from '../worker/captcha-page.mjs';

test('SmartCaptcha API flow works in a direct browser session with a local provider mock', async () => {
  const requests = []; let polls = 0;
  const provider = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/createTask') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { requests.push(JSON.parse(body)); response.end(JSON.stringify({ errorId: 0, taskId: 12345 })); });
    } else {
      polls++;
      response.end(JSON.stringify(polls < 2 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'synthetic-token' } }));
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); // Deliberately no browser proxy.
    await context.route('http://owned.test/captcha', route => route.fulfill({ contentType: 'text/html', body: '<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey" data-callback="captchaSolved"></div><script>function captchaSolved(token) { window.solvedToken = token; }</script>' }));
    const page = await context.newPage();
    await page.goto('http://owned.test/captcha');
    const events = [];
    const check = createCaptchaHandler({
      prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
      config: { captchaMaxSolves: 3, proxyScheme: 'http', captchaBaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaV2BaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaPollingMs: 50, captchaTimeoutMs: 5000, navigationTimeoutMs: 1000 },
      proxy: null, userAgent: 'Local test browser', shouldContinue: async () => true, taskId: 'fixture',
      log: event => events.push(event), navigationPolicy: { clearCaptchaPost() {} },
    });
    assert.equal(await check(page), true);
    assert.equal(await page.evaluate(() => window.solvedToken), 'synthetic-token');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].clientKey, 'synthetic-key');
    assert.equal(requests[0].task.type, 'YandexSmartCaptchaTaskProxyless');
    assert.equal(requests[0].task.websiteURL, 'http://owned.test/captcha');
    assert.equal(requests[0].task.websiteKey, 'fixture-smartcaptcha-sitekey');
    assert.equal(requests[0].task.proxyAddress, undefined);
    assert.ok(events.includes('captcha_requested'));
    assert.ok(events.includes('captcha_token_received'));
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => provider.close(resolve));
  }
});
