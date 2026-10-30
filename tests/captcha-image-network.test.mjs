import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { detectYandexImagePuzzle, solveYandexImagePuzzle, startCaptchaImageCapture } from '../worker/captcha-image.mjs';
import { createCaptchaHandler } from '../worker/captcha-page.mjs';
import { restrictNavigation } from '../worker/action-executor.mjs';

const mainImage = readFileSync(new URL('./fixtures/captcha-main.png', import.meta.url));
const instructionImage = readFileSync(new URL('./fixtures/captcha-instruction.png', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

for (const ignoredTap of [false, true]) test(`verification submission handles ${ignoredTap ? 'an ignored tap without another paid solution' : 'a rejected POST with fresh GET instead of resubmission'}`, async () => {
  let paid = 0, posts = 0, gets = 0;
  const provider = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/createTask') {
      request.resume();request.on('end', () => response.end(JSON.stringify({ errorId: 0, taskId: ++paid })));
    } else response.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { coordinates: [{ x: 80, y: 90 }] } }));
  });
  await listen(provider);let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    await context.route('https://ya.ru/showcaptcha', route => {
      if (route.request().method() === 'POST') {
        posts++;
        return route.fulfill({ contentType: 'text/html', body: posts === 1 && !ignoredTap ? '<h1>Проверка не завершена</h1>' : '<script>location.replace("/search/")</script>' });
      }
      gets++;
      return route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1">
        <form method="post" action="/showcaptcha"><div style="position:relative;width:240px;height:135px">
        <img src="data:image/png;base64,${mainImage.toString('base64')}" style="width:240px;height:135px">
        <div style="position:absolute;inset:0" onclick="window.pointReceived=true"></div></div>
        <img src="data:image/png;base64,${instructionImage.toString('base64')}" style="width:120px;height:20px">
        <button type="submit" ${ignoredTap ? 'onclick="window.taps=(window.taps||0)+1;if(window.taps===1)event.preventDefault()"' : ''}>Подтвердить</button></form>` });
    });
    await context.route('https://ya.ru/search/', route => route.fulfill({ contentType: 'text/html', body: '<h1>Results</h1>' }));
    const page = await context.newPage();await page.goto('https://ya.ru/showcaptcha');
    page.reload = () => { assert.fail('A verification POST must not be repeated by reload'); };
    const endpoint = `http://127.0.0.1:${provider.address().port}`;
    const events = [];
    const check = createCaptchaHandler({ prisma: { settings: { findUnique: async () => ({ rucaptchaApiKey: 'synthetic-key' }) } },
      config: { captchaWidgetWaitMs: 500, captchaMaxSolves: 2, captchaV2BaseUrl: endpoint, captchaPollingMs: 20, captchaTimeoutMs: 5000, navigationTimeoutMs: 800 },
      shouldContinue: async () => true, taskId: 'fixture', log: (event, details) => events.push({ event, ...details }),
      navigationPolicy: await restrictNavigation(context, 'https://ya.ru') });
    assert.equal(await check(page), true);
    assert.equal(await check(page), false);
    assert.equal(page.url(), 'https://ya.ru/search/');
    assert.equal(gets, ignoredTap ? 1 : 2);assert.equal(posts, ignoredTap ? 1 : 2);assert.equal(paid, ignoredTap ? 1 : 2);
    if (ignoredTap) {
      assert.ok(events.some(row => row.event === 'captcha_submitting' && row.attempt === 2 && row.reason === 'no_response'));
      assert.ok(!events.some(row => row.event === 'captcha_retrying'));
    } else assert.ok(events.some(row => row.event === 'captcha_retrying' && row.code === 'submission_rejected'));
  } finally { await browser?.close();await close(provider); }
});

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
