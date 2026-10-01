import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createCaptchaHandler } from '../worker/captcha-page.mjs';
import { restrictNavigation } from '../worker/action-executor.mjs';

for (const { failures, crossOrigin, downloadStatus = 200, formPost = false, submitLabel = 'Continue', autoSubmit = false } of [
  { failures: 0 }, { failures: 1 }, { failures: 3 },
  { failures: 0, crossOrigin: true }, { failures: 0, crossOrigin: true, downloadStatus: 403 },
  { failures: 0, formPost: true },
  { failures: 0, formPost: true, submitLabel: 'Подтвердить выбор' },
  { failures: 0, submitLabel: 'Далее' },
  { failures: 0, formPost: true, autoSubmit: true },
]) test(`Yandex image solving preserves source detail and bounds retries (${failures} provider failures, cross-origin: ${Boolean(crossOrigin)}, image HTTP ${downloadStatus}, POST: ${formPost}, button: ${submitLabel}, auto-submit: ${autoSubmit})`, async () => {
  const requests = [];
  const image = (width, height) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="2" height="1"><rect width="2" height="1" fill="white"/><rect width="1" height="1" fill="red"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`;
  const imageDownloads = [];
  const provider = createServer((request, response) => {
    if (request.url === '/main.svg' || request.url === '/instruction.svg') {
      imageDownloads.push({ url: request.url, referer: request.headers.referer, cookie: request.headers.cookie });
      response.statusCode = downloadStatus;
      response.setHeader('content-type', 'image/svg+xml');
      response.end(request.url === '/main.svg' ? image(320, 180) : image(480, 80));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/createTask') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { requests.push(JSON.parse(body)); response.end(JSON.stringify({ errorId: 0, taskId: requests.length })); });
    } else response.end(JSON.stringify(requests.length <= failures ? { errorId: 12, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' }
      : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 80, y: 90 }] } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const main = crossOrigin ? `${providerUrl}/main.svg` : `data:image/svg+xml;base64,${Buffer.from(image(320, 180)).toString('base64')}`;
    const instruction = crossOrigin ? `${providerUrl}/instruction.svg` : `data:image/svg+xml;base64,${Buffer.from(image(480, 80)).toString('base64')}`;
    const challengeUrl = `${crossOrigin ? 'http' : 'https'}://ya.ru/showcaptcha`;
    if (crossOrigin) {
      await context.addCookies([{ name: 'image-session', value: 'fixture', url: providerUrl }]);
      // Fulfill browser loads so private-network restrictions do not obscure
      // the canvas CORS failure. APIRequestContext still uses the real server.
      await context.route(`${providerUrl}/*.svg`, route => route.fulfill({ contentType: 'image/svg+xml',
        body: route.request().url().endsWith('/main.svg') ? image(320, 180) : image(480, 80) }));
    }
    await context.route(challengeUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <form id="checkbox-captcha-form"><button type="button" role="checkbox" onclick="document.getElementById('puzzle').hidden=false">I'm not a robot</button></form>
      <${formPost ? 'form method="post" action="/captcha-submit"' : 'div'} id="puzzle" hidden>
        <div style="position:relative;width:240px;height:135px;margin:25px">
          <img id="main" src="${main}" style="width:100%;height:100%;pointer-events:none">
          <div id="input-layer" style="position:absolute;inset:0" onclick="window.receivedPoint={x:event.offsetX,y:event.offsetY};window.clicked=(window.clicked||0)+1;${formPost ? "document.getElementById('point-x').value=event.offsetX;document.getElementById('point-y').value=event.offsetY;" + (autoSubmit ? "setTimeout(() => document.getElementById('puzzle').requestSubmit(), 50);" : "setTimeout(() => document.getElementById('submit-puzzle').disabled=false, 400);") : ''}"></div>
        </div>
        <img src="${instruction}" style="width:120px;height:20px">
        ${formPost ? `<input type="hidden" name="x" id="point-x"><input type="hidden" name="y" id="point-y"><button type="submit" id="submit-puzzle" disabled>${submitLabel}</button>` : `<button onclick="if(window.clicked === 1) location.href='/search/?clicked=1&x='+window.receivedPoint.x+'&y='+window.receivedPoint.y">${submitLabel}</button>`}
      </${formPost ? 'form' : 'div'}>` }));
    let submitted = false;
    await context.route('**://ya.ru/captcha-submit', async route => {
      assert.equal(route.request().method(), 'POST');
      const coordinates = new URLSearchParams(route.request().postData());
      submitted = true;
      // A browser redirect starts a new routed request; HTTP redirect follow-ups
      // bypass Playwright routing and would reach the real search provider.
      await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('/search/?clicked=1&x=${coordinates.get('x')}&y=${coordinates.get('y')}')</script>` });
    });
    await context.route('**://ya.ru/search/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Results</h1>' }));
    const page = await context.newPage();
    await page.goto(challengeUrl);
    const navigationPolicy = formPost ? await restrictNavigation(context, new URL(challengeUrl).origin) : { clearCaptchaPost() {} };
    if (crossOrigin) {
      assert.equal(await page.locator('#main').evaluate(async image => {
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.getContext('2d').drawImage(image, 0, 0);
        try { canvas.toDataURL(); return false; } catch (error) { return error.name === 'SecurityError'; }
      }), true);
    }
    const events = [];
    const check = createCaptchaHandler({
      prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
      config: { captchaWidgetWaitMs: 1000, captchaMaxSolves: 3, captchaBaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaV2BaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaPollingMs: 50, captchaTimeoutMs: 5000, navigationTimeoutMs: 2000 },
      shouldContinue: async () => true, taskId: 'fixture', log: event => events.push(event), navigationPolicy,
    });
    if (downloadStatus !== 200) {
      await assert.rejects(check(page), error => error.code === 'image_capture_failed');
      assert.equal(requests.length, 0);
      assert.ok(!events.includes('captcha_requested'));
      assert.ok(!events.includes('captcha_retrying'));
      await context.close();
      return;
    }
    if (failures >= 3) {
      await assert.rejects(check(page), error => error.code === 'solve_limit');
      assert.equal(requests.length, 3);
      assert.equal(events.filter(event => event === 'captcha_retrying').length, 2);
      await context.close();
      return;
    }
    let handled;
    try { handled = await check(page); }
    catch (error) { assert.fail(`${error.code}: ${new URL(page.url()).pathname}, submitted=${submitted}, events=${events.join(',')}`); }
    assert.equal(handled, true);
    assert.equal(new URL(page.url()).pathname, '/search/');
    if (formPost) assert.equal(submitted, true);
    assert.equal(new URL(page.url()).searchParams.get('clicked'), '1');
    assert.ok(Math.abs(Number(new URL(page.url()).searchParams.get('x')) - 60) <= 1);
    assert.ok(Math.abs(Number(new URL(page.url()).searchParams.get('y')) - 68) <= 1);
    assert.equal(requests.length, failures + 1);
    assert.equal(events.filter(event => event === 'captcha_retrying').length, failures);
    assert.equal(requests[0].task.type, 'SmartCaptchaTask');
    assert.equal(Buffer.from(requests[0].task.image, 'base64').readUInt32BE(16), 320);
    assert.equal(Buffer.from(requests[0].task.imgInstructions, 'base64').readUInt32BE(16), 480);
    assert.equal(Buffer.from(requests[0].task.imgInstructions, 'base64').readUInt32BE(20), 180);
    const samples = await page.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 180;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return [Array.from(context.getImageData(10, 90, 1, 1).data), Array.from(context.getImageData(11, 90, 1, 1).data)];
    }, requests[0].task.imgInstructions);
    assert.deepEqual(samples, [[255, 0, 0, 255], [255, 255, 255, 255]]);
    if (crossOrigin) {
      for (const url of ['/main.svg', '/instruction.svg']) {
        assert.ok(imageDownloads.some(item => item.url === url && item.referer === challengeUrl && item.cookie?.includes('image-session=fixture')));
      }
    }
    assert.ok(events.includes('captcha_coordinates_applied'));
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => provider.close(resolve));
  }
});
