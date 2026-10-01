import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { bezierPoint } from '../worker/behavior.mjs';
import { loadConfig } from '../worker/config.mjs';
import { parseActionPlan, PlanValidationError } from '../worker/ai-plan.mjs';
import { runTask } from '../worker/runner.mjs';
import { performSearchAndClick } from '../worker/search.mjs';
import { installSearchFixture } from './fixtures/search-pages.mjs';

const root = resolve(import.meta.dirname, '..');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const actions = [
  { type: 'click_random_link' },
  { type: 'move_mouse_randomly', durationMs: 100 },
  { type: 'scroll_down', pixels: 200 },
  { type: 'scroll_up', pixels: 100 },
  { type: 'pause', durationMs: 2000 },
  ...Array.from({ length: 5 }, (_, i) => ({ type: i % 2 ? 'scroll_up' : 'scroll_down', pixels: 100 + i })),
];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-worker-'));
  const databasePath = join(dir, 'test.db');
  const database = new DatabaseSync(databasePath);
  for (const name of (await readdir(resolve(root, 'prisma/migrations'))).filter(name => /^\d/.test(name)).sort()) {
    database.exec(await readFile(resolve(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
  }
  database.close();
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
  let failHealth = false; let authenticatedRequests = 0;
  let aiContent = JSON.stringify(actions); let aiStatus = 200; let aiDelay = 0;
  let aiRequest; let proxyCountAtAiRequest; let nextVisits = 0; let redirectExternal = false;
  let captchaType; let captchaPath = '/page'; let captchaRequest; let captchaPolls = 0; let captchaNeverReady = false; let captchaProviderError = false; let autoSubmitCaptcha = false;
  let submittedToken; let rotationFailed = false; let rotatedAt; let firstBrowserTrafficAt;
  const observed = []; const cookiesOnTarget = [];
  const target = createServer(async (req, res) => {
    if (req.url === '/fingerprint-state') {
      let body = ''; for await (const chunk of req) body += chunk;
      observed.push({ headers: req.headers, data: JSON.parse(body) });
      res.writeHead(204); res.end(); return;
    }
    if (req.url?.startsWith('/rotate')) {
      rotatedAt = Date.now(); res.writeHead(rotationFailed ? 503 : 200); res.end('rotation accepted'); return;
    }
    if (req.url === captchaPath && captchaType) {
      const widget = captchaType === 'smartcaptcha'
        ? `<div class="smart-captcha" data-sitekey="fixture-smartcaptcha-sitekey" ${autoSubmitCaptcha ? 'data-callback="submitCaptcha"' : ''}></div><input type="hidden" name="smart-token">`
        : '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=fixture-recaptcha-sitekey" width="300" height="80"></iframe><textarea hidden name="g-recaptcha-response"></textarea>';
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body><form id="captcha-form" method="post" action="/captcha-submit">${widget}<button type="submit">Submit captcha</button></form><script>function submitCaptcha(token) { document.getElementById('captcha-form').submit(); }</script></body></html>`); return;
    }
    if (req.url === '/captcha-submit') {
      let body = ''; for await (const chunk of req) body += chunk;
      submittedToken = new URLSearchParams(body).get(captchaType === 'smartcaptcha' ? 'smart-token' : 'g-recaptcha-response');
      if (submittedToken !== 'synthetic-captcha-token') { res.writeHead(403); res.end('rejected'); return; }
      res.writeHead(303, { Location: '/accepted' }); res.end(); return;
    }
    if (req.url === '/health' && failHealth) { res.writeHead(503); res.end('unavailable'); return; }
    if (req.url === '/next') {
      nextVisits++;
      if (redirectExternal) { res.writeHead(302, { Location: 'https://example.org/' }); res.end(); return; }
    }
    if (req.url === '/page') cookiesOnTarget.push(req.headers.cookie ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html', ...(req.url === '/page' ? { 'Set-Cookie': 'worker_session=synthetic-persistent-cookie; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax' } : {}) });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script>
      const previousStorage = localStorage.getItem('worker_session');
      localStorage.setItem('worker_session', 'synthetic-local-storage');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0,0,64,64);
      const gl = document.createElement('canvas').getContext('webgl'); const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      fetch('/fingerprint-state', { method: 'POST', body: JSON.stringify({
        previousStorage, ua: navigator.userAgent, language: navigator.language, width: screen.width, height: screen.height,
        touch: navigator.maxTouchPoints, hardwareConcurrency: navigator.hardwareConcurrency,
        mobile: navigator.userAgentData?.mobile, hintPlatform: navigator.userAgentData?.platform,
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        canvas: canvas.toDataURL(), canvasAgain: canvas.toDataURL()
      }) });
    </script></head><body><h1>Worker fixture</h1><a href="/next">Next page</a><a href="https://example.org/">External</a><a href="/delete">Delete</a><a href="/ad" rel="sponsored">Ad</a><a href="/download" download>Download</a><main style="height:8000px">Local test page</main></body></html>`);
  });
  await listen(target);
  const port = target.address().port;
  const targetUrl = `http://127.0.0.1:${port}`;
  const username = 'synthetic-worker-test'; const password = 'synthetic-password';
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const proxy = createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== auth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="worker-test"' }); res.end(); return;
    }
    const url = new URL(req.url);
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== port) { res.writeHead(403); res.end(); return; }
    authenticatedRequests++;
    firstBrowserTrafficAt ??= Date.now();
    const headers = { ...req.headers }; delete headers['proxy-authorization'];
    const upstream = httpRequest(url, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  // Deny background external CONNECT requests: all test traffic stays local.
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await listen(proxy);
  const ai = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer synthetic-openai-key');
    let body = ''; for await (const chunk of req) body += chunk;
    aiRequest = JSON.parse(body); proxyCountAtAiRequest = authenticatedRequests;
    if (aiDelay) await new Promise(resolve => setTimeout(resolve, aiDelay));
    res.writeHead(aiStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(aiStatus === 200 ? { choices: [{ finish_reason: 'stop', message: { content: aiContent } }] } : { error: { message: 'synthetic error' } }));
  });
  await listen(ai);
  const captcha = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/createTask') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { captchaRequest = JSON.parse(body); res.end(JSON.stringify(captchaProviderError ? { errorId: 12, errorCode: 'ERROR_ZERO_BALANCE' } : { errorId: 0, taskId: 12345 })); });
      return;
    }
    if (url.pathname === '/getTaskResult') {
      captchaPolls++;
      res.end(JSON.stringify(captchaNeverReady || captchaPolls === 1 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'synthetic-captcha-token' } })); return;
    }
    if (url.pathname === '/in.php') {
      captchaRequest = Object.fromEntries(url.searchParams);
      res.end(JSON.stringify(captchaProviderError ? { status: 0, request: 'ERROR_ZERO_BALANCE' } : { status: 1, request: '12345' }));
    } else {
      captchaPolls++;
      res.end(JSON.stringify(captchaNeverReady || captchaPolls === 1 ? { status: 0, request: 'CAPCHA_NOT_READY' } : { status: 1, request: 'synthetic-captcha-token' }));
    }
  });
  await listen(captcha);
  const task = await prisma.task.create({ data: { url: `${targetUrl}/page`, targetExecutions: 100, targetKeywords: [], profile: { create: { name: 'Local test profile' } } } });
  const proxyRow = await prisma.proxy.create({ data: { host: '127.0.0.1', port: proxy.address().port, username, password, isActive: true } });
  return {
    prisma, task, proxyRow, databasePath, authCount: () => authenticatedRequests,
    failHealth: () => { failHealth = true; },
    aiRequest: () => aiRequest, proxyCountAtAiRequest: () => proxyCountAtAiRequest, nextVisits: () => nextVisits,
    setAi: ({ content = aiContent, status = 200, delay = 0 }) => { aiContent = content; aiStatus = status; aiDelay = delay; },
    redirectExternal: () => { redirectExternal = true; },
    enableRotation: async (fail = false) => {
      rotationFailed = fail;
      await prisma.proxy.update({ where: { id: proxyRow.id }, data: { rotationUrl: `${targetUrl}/rotate?token=synthetic-rotation-secret` } });
    },
    rotationWait: () => firstBrowserTrafficAt - rotatedAt,
    enableCaptcha: async (type, { missingKey = false, neverReady = false, providerError = false, late = false, autoSubmit = false } = {}) => {
      captchaType = type; captchaNeverReady = neverReady; captchaProviderError = providerError;
      captchaPath = late ? '/next' : '/page';
      autoSubmitCaptcha = autoSubmit;
      await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, rucaptchaApiKey: missingKey ? null : 'synthetic-rucaptcha-key' }, update: { rucaptchaApiKey: missingKey ? null : 'synthetic-rucaptcha-key' } });
    },
    captchaRequest: () => captchaRequest, captchaPolls: () => captchaPolls, submittedToken: () => submittedToken,
    profilePath: join(dir, 'profiles', `${task.profileId}.json`), observed, cookiesOnTarget,
    env: { ...process.env, WORKER_PROFILES_DIR: join(dir, 'profiles'), DATABASE_URL: `file:${databasePath}`, WORKER_PLAN_MODE: 'openai', OPENAI_API_KEY: 'synthetic-openai-key', OPENAI_BASE_URL: `http://127.0.0.1:${ai.address().port}/v1`, WORKER_OPENAI_TIMEOUT_MS: '15000', WORKER_CAPTCHA_BASE_URL: `http://127.0.0.1:${captcha.address().port}`, WORKER_CAPTCHA_POLL_MS: '50', WORKER_CAPTCHA_TIMEOUT_MS: '15000', WORKER_PROXY_CHECK_URL: `${targetUrl}/health`, WORKER_MIN_DWELL_MS: '3000', WORKER_MAX_DWELL_MS: '6000', WORKER_NAVIGATION_TIMEOUT_MS: '15000' },
    async cleanup() { await prisma.$disconnect(); await stop(captcha); await stop(ai); await stop(proxy); await stop(target); await rm(dir, { recursive: true, force: true }); },
  };
}

async function runWorker(env, { abort = false, abortEvent = '"action":"pause"' } = {}) {
  const child = spawn(process.execPath, ['worker/index.js', '--once'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let stderr = ''; let signalled = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
  child.stdout.on('data', data => {
    output += data;
    if (abort && !signalled && output.includes(abortEvent)) { signalled = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  return { code, output, stderr, signalled };
}

async function assertUnlocked(path) {
  await assert.rejects(access(`${path}.worker.lock`), { code: 'ENOENT' });
}

test('default dwell is 1–2 minutes and Bezier endpoints stay exact', () => {
  const config = loadConfig();
  assert.equal(config.minDwellMs, 60_000); assert.equal(config.maxDwellMs, 120_000);
  const points = [{ x: 0, y: 0 }, { x: 10, y: 50 }, { x: 70, y: 10 }, { x: 100, y: 100 }];
  assert.deepEqual(bezierPoint(0, ...points), points[0]);
  assert.deepEqual(bezierPoint(1, ...points), points[3]);
});

test('rotation waits 15 seconds before Chromium and reCAPTCHA iframe is solved and submitted', { timeout: 55_000 }, async () => {
  const f = await fixture();
  try {
    await f.enableRotation(); await f.enableCaptcha('recaptcha');
    const result = await runWorker(f.env);
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.ok(f.rotationWait() >= 15_000, `Browser traffic started after ${f.rotationWait()}ms`);
    assert.equal(f.captchaRequest().method, 'userrecaptcha');
    assert.equal(f.captchaRequest().googlekey, 'fixture-recaptcha-sitekey');
    assert.equal(f.captchaRequest().pageurl, f.task.url);
    assert.equal(f.captchaRequest().key, 'synthetic-rucaptcha-key');
    assert.equal(f.captchaRequest().proxytype, 'HTTP');
    assert.equal(f.captchaPolls(), 2);
    assert.equal(f.submittedToken(), 'synthetic-captcha-token');
    for (const secret of ['synthetic-rotation-secret', 'synthetic-rucaptcha-key', 'synthetic-captcha-token', 'synthetic-password']) assert.ok(!result.output.includes(secret));
    assert.ok(result.output.indexOf('proxy_rotation_completed') < result.output.indexOf('captcha_detected'));
    assert.ok(result.output.includes('captcha_submitted'));
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 1);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('SmartCaptcha appearing after an AI action is submitted without consuming the behavior budget', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    await f.enableCaptcha('smartcaptcha', { late: true, autoSubmit: true });
    const result = await runWorker({ ...f.env, WORKER_MIN_DWELL_MS: '3000', WORKER_MAX_DWELL_MS: '3000', WORKER_CAPTCHA_POLL_MS: '1000' });
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.equal(f.captchaRequest().task.type, 'YandexSmartCaptchaTask');
    assert.equal(f.captchaRequest().task.websiteKey, 'fixture-smartcaptcha-sitekey');
    assert.equal(f.captchaRequest().task.websiteURL, f.task.url.replace('/page', '/next'));
    assert.equal(f.submittedToken(), 'synthetic-captcha-token');
    assert.ok(result.output.includes('captcha_callback_invoked'), result.output);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 1);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('rotation failure and cancellation never start Chromium', async () => {
  for (const fail of [true, false]) {
    const f = await fixture();
    try {
      await f.enableRotation(fail);
      const result = await runWorker(f.env, fail ? {} : { abort: true, abortEvent: 'proxy_rotation_wait' });
      assert.equal(result.code, fail ? 1 : 0, result.output + result.stderr);
      assert.equal(f.authCount(), 0);
      assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
      await assertUnlocked(f.databasePath);
    } finally { await f.cleanup(); }
  }
});

test('captcha missing key, provider failure, timeout and SIGTERM leave count unchanged', { timeout: 40_000 }, async () => {
  for (const scenario of ['missingKey', 'providerError', 'neverReady', 'abort']) {
    const f = await fixture();
    try {
      await f.enableCaptcha('recaptcha', { [scenario]: true });
      const result = await runWorker({ ...f.env, ...(scenario === 'neverReady' ? { WORKER_CAPTCHA_TIMEOUT_MS: '400' } : {}) }, scenario === 'abort' ? { abort: true, abortEvent: 'captcha_requested' } : {});
      assert.equal(result.code, scenario === 'abort' ? 0 : 1, result.output + result.stderr);
      assert.equal(f.submittedToken(), undefined);
      assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
      await assertUnlocked(f.databasePath);
    } finally { await f.cleanup(); }
  }
});

test('real Chromium injects a mobile profile before document scripts and reuses fingerprint/cookies', { timeout: 50_000 }, async () => {
  const f = await fixture();
  try {
    const result = await runWorker(f.env);
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.ok(result.output.includes('session_completed'), result.output);
    assert.ok(!result.output.includes('synthetic-password'));
    assert.ok(!result.output.includes('synthetic-openai-key'));
    assert.equal(f.aiRequest().model, 'gpt-4o-mini');
    assert.ok(f.aiRequest().messages[1].content.includes(f.task.url));
    assert.equal(f.proxyCountAtAiRequest(), 0, 'Plan must be requested before browser traffic');
    assert.equal(f.nextVisits(), 1, 'Only the eligible same-origin link should be clicked');
    const logged = result.output.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(logged.filter(row => row.event === 'action_started').map(row => row.action), actions.map(action => action.type));
    assert.equal(logged.filter(row => row.event === 'action_completed').length, actions.length);
    assert.ok(f.authCount() >= 2, 'Proxy must see both health and target requests');
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 1);
    const saved = JSON.parse(await readFile(f.profilePath, 'utf8'));
    assert.ok(['android', 'ios'].includes(saved.mobileOS));
    assert.equal(saved.profileId, f.task.profileId);
    assert.ok(saved.origins.some(origin => origin.localStorage.some(item => item.name === 'worker_session' && item.value === 'synthetic-local-storage')));
    assert.ok(saved.cookies.some(cookie => cookie.name === 'worker_session'));
    assert.ok(f.observed.length >= 2);
    for (const { headers, data } of f.observed) {
      assert.equal(data.ua, saved.fingerprint.navigator.userAgent);
      assert.equal(headers['user-agent'], data.ua);
      assert.equal(data.width, saved.fingerprint.screen.width);
      assert.equal(data.height, saved.fingerprint.screen.height);
      assert.equal(data.touch, saved.fingerprint.navigator.maxTouchPoints);
      assert.equal(data.hardwareConcurrency, saved.fingerprint.navigator.hardwareConcurrency);
      assert.equal(data.canvas, data.canvasAgain);
      if (data.renderer) {
        assert.equal(data.renderer, saved.fingerprint.videoCard.renderer);
        assert.equal(data.vendor, saved.fingerprint.videoCard.vendor);
      }
      if (saved.mobileOS === 'android') {
        assert.equal(data.mobile, true); assert.equal(data.hintPlatform, 'Android');
        assert.equal(headers['sec-ch-ua-mobile'], '?1');
      } else {
        assert.equal(data.mobile, undefined); assert.equal(headers['sec-ch-ua'], undefined);
      }
    }
    const initialCanvas = f.observed[0].data.canvas;
    const observedBeforeRepeat = f.observed.length;
    const repeated = await runWorker(f.env);
    assert.equal(repeated.code, 0, repeated.output + repeated.stderr);
    assert.ok(repeated.output.includes('profile_loaded'));
    const next = JSON.parse(await readFile(f.profilePath, 'utf8'));
    assert.deepEqual(next.fingerprint, saved.fingerprint);
    assert.equal(next.canvasSeed, saved.canvasSeed);
    assert.ok(f.cookiesOnTarget[1].includes('worker_session=synthetic-persistent-cookie'));
    assert.ok(f.observed.slice(observedBeforeRepeat).every(row => row.data.previousStorage === 'synthetic-local-storage'), 'localStorage must be restored before the first document script');
    assert.ok(f.observed.every(row => row.data.canvas === initialCanvas));
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 2);
    const previousFile = await readFile(f.profilePath, 'utf8');
    f.failHealth();
    const failed = await runWorker(f.env);
    assert.equal(failed.code, 1);
    assert.equal(await readFile(f.profilePath, 'utf8'), previousFile, 'Failed sessions must preserve the last successful profile');
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('search runner saves only a found target; miss closes Chromium without changing the last successful state/count', { timeout: 35_000 }, async () => {
  const f = await fixture();
  try {
    const task = await f.prisma.task.update({ where: { id: f.task.id }, data: { url: '', searchEngine: 'yandex', searchQueries: ['qa'], project: { create: { name: 'Search fixture', targetUrl: 'https://target.test/', yandexRegionId: '213', regionName: '' } } } });
    const config = { ...loadConfig(),
      profilesDirectory: resolve(f.profilePath, '..'), headless: true,
      proxyCheckUrl: f.env.WORKER_PROXY_CHECK_URL, proxyScheme: 'http', navigationTimeoutMs: 15_000,
      openaiApiKey: f.env.OPENAI_API_KEY, openaiBaseUrl: f.env.OPENAI_BASE_URL, openaiTimeoutMs: 15_000,
      captchaBaseUrl: f.env.WORKER_CAPTCHA_BASE_URL, captchaPollingMs: 50, captchaTimeoutMs: 15_000,
      minDwellMs: 3000, maxDwellMs: 6000,
    };
    let miss = false; const browsers = []; const events = [];
    const options = { prisma: f.prisma, task, proxy: f.proxyRow, config,
      onBrowser: browser => { if (browser) browsers.push(browser); },
      log: event => events.push(event),
      searchRunner: async (page, row, params) => {
        let clock = 0;
        await installSearchFixture(page.context(), { targetPage: miss ? null : 2, competitorPopup: true, targetPopup: true });
        return performSearchAndClick(page, row, { ...params, engines: { yandex: { home: 'http://search.test/', domains: ['search.test'] } }, waitFor: async ms => { clock += ms; }, now: () => clock, targetDurationMs: 60_000 });
      },
    };
    assert.equal(await runTask(options), true);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentExecutions, 1);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, 'completed');
    const previous = await readFile(f.profilePath, 'utf8');
    assert.ok(JSON.parse(previous).origins.some(origin => origin.origin === 'http://www.target.test'));
    miss = true;
    const restart = await f.prisma.task.update({ where: { id: task.id }, data: { status: 'running' } });
    assert.equal(await runTask({ ...options, task: restart }), false);
    assert.equal(await readFile(f.profilePath, 'utf8'), previous);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentExecutions, 1);
    assert.ok(events.includes('session_search_missed'));
    assert.equal(browsers.length, 2); assert.ok(browsers.every(browser => !browser.isConnected()));
  } finally { await f.cleanup(); }
});

test('plan validation rejects unknown actions, parameters, Markdown and bad array sizes', () => {
  assert.deepEqual(parseActionPlan(JSON.stringify(actions)), actions);
  for (const plan of [
    'not JSON', '```json\n' + JSON.stringify(actions) + '\n```', JSON.stringify(actions.slice(0, 9)),
    JSON.stringify([...actions, ...actions]),
    JSON.stringify([{ type: 'evaluate', code: 'anything' }, ...actions.slice(1)]),
    JSON.stringify([{ type: 'pause', durationMs: -1 }, ...actions.slice(1)]),
    JSON.stringify([{ type: 'scroll_down', pixels: 1e9 }, ...actions.slice(1)]),
    JSON.stringify([{ type: 'click_random_link', selector: 'button' }, ...actions.slice(1)]),
  ]) assert.throws(() => parseActionPlan(plan), PlanValidationError);
  assert.throws(() => parseActionPlan(JSON.stringify(actions), 1000), PlanValidationError);
});

test('local plan completes a direct task without an OpenAI key or API call', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const result = await runWorker({ ...f.env, WORKER_PLAN_MODE: 'local', OPENAI_API_KEY: '' });
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.equal(f.aiRequest(), undefined);
    assert.ok(result.output.includes('"source":"local"'));
    assert.ok(f.authCount() > 0);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 1);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('invalid AI JSON prevents browser launch and leaves the count unchanged', async () => {
  const f = await fixture();
  try {
    f.setAi({ content: '[{"type":"unknown"}]' });
    const result = await runWorker(f.env);
    assert.equal(result.code, 1, result.output + result.stderr);
    assert.ok(result.output.includes('PlanValidationError'));
    assert.equal(f.authCount(), 0);
    assert.ok(!result.output.includes('session_started'));
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('OpenAI failure, timeout and missing key never start the browser', async () => {
  for (const scenario of ['http_429', 'timeout', 'missing_api_key']) {
    const f = await fixture();
    try {
      if (scenario === 'http_429') f.setAi({ status: 429 });
      if (scenario === 'timeout') f.setAi({ delay: 400 });
      const env = { ...f.env, ...(scenario === 'timeout' ? { WORKER_OPENAI_TIMEOUT_MS: '100' } : {}), ...(scenario === 'missing_api_key' ? { OPENAI_API_KEY: '' } : {}) };
      const result = await runWorker(env);
      assert.equal(result.code, 1, result.output + result.stderr);
      assert.ok(result.output.includes(`"code":"${scenario}"`), result.output);
      assert.equal(f.authCount(), 0);
      assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
      await assertUnlocked(f.databasePath);
    } finally { await f.cleanup(); }
  }
});

test('random links cannot redirect navigation to another origin', async () => {
  const f = await fixture();
  try {
    f.redirectExternal();
    const result = await runWorker(f.env);
    assert.equal(result.code, 1, result.output + result.stderr);
    assert.ok(result.output.includes('action_failed'), result.output);
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('a failed proxy check never increments the task', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    f.failHealth();
    const result = await runWorker(f.env);
    assert.equal(result.code, 1, result.output + result.stderr);
    assert.ok(result.output.includes('ProxyCheckError'), result.output);
    await assert.rejects(access(f.profilePath), { code: 'ENOENT' });
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});

test('SIGTERM closes the session, releases the lock and leaves count unchanged', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const result = await runWorker({ ...f.env, WORKER_MIN_DWELL_MS: '60000', WORKER_MAX_DWELL_MS: '60000' }, { abort: true });
    assert.ok(result.signalled, result.output + result.stderr);
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.ok(result.output.includes('worker_stopped'), result.output);
    await assert.rejects(access(f.profilePath), { code: 'ENOENT' });
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
    await assertUnlocked(f.databasePath);
  } finally { await f.cleanup(); }
});


test('worker reads the OpenAI key from Settings before the environment fallback', async () => {
  const f = await fixture();
  try {
    await f.prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, openaiApiKey: 'synthetic-openai-key' }, update: { openaiApiKey: 'synthetic-openai-key' } });
    f.setAi({ content: '[{"type":"unknown"}]' });
    const result = await runWorker({ ...f.env, OPENAI_API_KEY: 'wrong-environment-key' });
    assert.equal(result.code, 1); assert.ok(result.output.includes('PlanValidationError'));
    assert.ok(!result.output.includes('missing_api_key')); assert.equal(f.authCount(), 0);
  } finally { await f.cleanup(); }
});
