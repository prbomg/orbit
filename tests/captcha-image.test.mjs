import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createCaptchaHandler } from '../worker/captcha-page.mjs';

for (const failures of [0, 1, 3]) test(`Yandex image solving preserves source detail and bounds retries (${failures} provider failures)`, async () => {
  const requests = [];
  const provider = createServer((request, response) => {
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
    const image = (width, height) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="2" height="1"><rect width="2" height="1" fill="white"/><rect width="1" height="1" fill="red"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`).toString('base64')}`;
    const main = image(320, 180); const instruction = image(480, 80);
    await context.route('https://ya.ru/showcaptcha', route => route.fulfill({ contentType: 'text/html', body: `
      <form id="checkbox-captcha-form"><button type="button" role="checkbox" onclick="document.getElementById('puzzle').hidden=false">I'm not a robot</button></form>
      <div id="puzzle" hidden>
        <div style="position:relative;width:240px;height:135px;margin:25px">
          <img id="main" src="${main}" style="width:100%;height:100%;pointer-events:none">
          <div id="input-layer" style="position:absolute;inset:0" onclick="window.receivedPoint={x:event.offsetX,y:event.offsetY};window.clicked=(window.clicked||0)+1"></div>
        </div>
        <img src="${instruction}" style="width:120px;height:20px">
        <button onclick="if(window.clicked === 1) location.href='/search/?clicked=1&x='+window.receivedPoint.x+'&y='+window.receivedPoint.y">Continue</button>
      </div>` }));
    await context.route('https://ya.ru/search/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Results</h1>' }));
    const page = await context.newPage();
    await page.goto('https://ya.ru/showcaptcha');
    const events = [];
    const check = createCaptchaHandler({
      prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
      config: { captchaWidgetWaitMs: 1000, captchaMaxSolves: 3, captchaBaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaV2BaseUrl: `http://127.0.0.1:${provider.address().port}`, captchaPollingMs: 50, captchaTimeoutMs: 5000, navigationTimeoutMs: 2000 },
      shouldContinue: async () => true, taskId: 'fixture', log: event => events.push(event), navigationPolicy: { clearCaptchaPost() {} },
    });
    if (failures >= 3) {
      await assert.rejects(check(page), error => error.code === 'solve_limit');
      assert.equal(requests.length, 3);
      assert.equal(events.filter(event => event === 'captcha_retrying').length, 2);
      await context.close();
      return;
    }
    assert.equal(await check(page), true);
    assert.equal(new URL(page.url()).pathname, '/search/');
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
    assert.ok(events.includes('captcha_coordinates_applied'));
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => provider.close(resolve));
  }
});
