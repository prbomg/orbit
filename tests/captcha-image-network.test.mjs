import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { detectYandexImagePuzzle, solveYandexImagePuzzle, startCaptchaImageCapture } from '../worker/captcha-image.mjs';

const mainImage = readFileSync(new URL('./fixtures/captcha-main.png', import.meta.url));
const instructionImage = readFileSync(new URL('./fixtures/captcha-instruction.png', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

for (const scenario of ['redirect', 'fragment', 'history', 'reload', 'no-content', 'iframe', 'many-images']) {
  test(`Original captcha image responses survive ${scenario}`, async () => {
    const imageRequests = []; const tasks = []; const events = [];
    const images = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.endsWith('.png')) {
        imageRequests.push(path);
        if (scenario === 'redirect' && path === '/main.png') {
          response.writeHead(302, { location: '/redirected.png' }); response.end(); return;
        }
        if (scenario === 'redirect' && path === '/redirected.png') {
          response.writeHead(307, { location: '/original.png' }); response.end(); return;
        }
        response.setHeader('content-type', path.startsWith('/icon-') ? 'image/svg+xml' : 'image/png');
        response.end(path.startsWith('/icon-') ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>'
          : path === '/instruction.png' ? instructionImage : mainImage);
      } else if (path === '/createTask') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          tasks.push(JSON.parse(body));
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ errorId: 0, taskId: 1 }));
        });
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { coordinates: [{ x: 80, y: 90 }] } }));
      }
    });
    await listen(images);
    const imageOrigin = `http://127.0.0.1:${images.address().port}`;
    const pages = createServer((request, response) => {
      if (request.url === '/no-content') { response.writeHead(204); response.end(); return; }
      response.setHeader('content-type', 'text/html');
      response.setHeader('Content-Security-Policy', `img-src ${imageOrigin}; script-src 'unsafe-inline'; frame-src 'self'`);
      if (request.url === '/search/') { response.end('<h1>Results</h1>'); return; }
      if (scenario === 'iframe' && request.url === '/showcaptcha') {
        response.end('<iframe src="/frame" style="width:380px;height:600px"></iframe>'); return;
      }
      response.end(`<img id="main" src="${imageOrigin}/main.png${scenario === 'fragment' ? '#display' : ''}" style="width:240px;height:135px">
        <img src="${imageOrigin}/instruction.png" style="width:120px;height:20px">
        <button onclick="top.location.href='/search/'">Submit</button>
        ${scenario === 'many-images' ? Array.from({ length: 40 }, (_, index) => `<img src="${imageOrigin}/icon-${index}.png" width="1" height="1">`).join('') : ''}`);
    });
    await listen(pages);
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const stop = startCaptchaImageCapture(context);
      const page = await context.newPage();
      const challengeUrl = `http://127.0.0.1:${pages.address().port}/showcaptcha`;
      await page.goto(challengeUrl);
      if (scenario === 'history') await page.evaluate(() => history.replaceState({}, '', '/showcaptcha#challenge'));
      if (scenario === 'reload') await page.reload();
      if (scenario === 'no-content') await assert.rejects(page.goto(new URL('/no-content', challengeUrl).href));
      const puzzle = await detectYandexImagePuzzle(page);
      assert.ok(puzzle);
      if (scenario === 'redirect') assert.equal(await puzzle.main.evaluate(image => new URL(image.currentSrc).pathname), '/main.png');
      await solveYandexImagePuzzle(page, puzzle, {
        prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
        config: { captchaV2BaseUrl: imageOrigin, captchaPollingMs: 50, captchaTimeoutMs: 5000, navigationTimeoutMs: 2000 },
        shouldContinue: async () => true, taskId: 'fixture',
        log: (event, details) => events.push({ event, ...details }),
        navigationPolicy: { clearCaptchaPost() {} },
      });
      assert.equal(new URL(page.url()).pathname, '/search/');
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].task.type, 'SmartCaptchaTask');
      const bitmap = Buffer.from(tasks[0].task.image, 'base64');
      assert.equal(bitmap.readUInt32BE(16), 320);
      assert.equal(bitmap.readUInt32BE(20), 180);
      assert.equal(imageRequests.filter(path => path === '/main.png').length, scenario === 'reload' ? 2 : 1, 'Capture must not repeat the challenge request');
      assert.equal(events.filter(item => item.event === 'captcha_image_ready' && item.method === 'network_bitmap').length, 2);
      stop();
      await context.close();
    } finally {
      await browser?.close();
      await Promise.all([close(images), close(pages)]);
    }
  });
}
