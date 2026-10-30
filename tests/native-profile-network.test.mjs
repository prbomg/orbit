import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage, mobileContextOptions } from '../worker/profiles.mjs';
import { persistentLaunchOptions } from '../worker/persistent-cache.mjs';
import { buildHttpClientHints } from '../worker/client-hints.mjs';

const launch = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH };
const hints = 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-WoW64';
const workerIdentity = `async function identity(kind){return {ua:navigator.userAgent,headers:await(await fetch('/echo?from='+kind,{cache:'no-store'})).json()};}`;

for (const storageMode of ['snapshot', 'persistent']) test(`native profile requests need no header routes: documents, popup, assets and workers (${storageMode})`, { timeout: 60000 }, async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url, 'http://fixture.test').pathname;
    if (path === '/echo') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); return; }
    if (path === '/asset.js') { res.setHeader('Content-Type', 'application/javascript'); res.setHeader('Cache-Control', 'public, max-age=3600'); res.end('window.assetLoaded=true;'); return; }
    if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      const source = path === '/dedicated.js' ? `onmessage=()=>identity('dedicated').then(value=>postMessage(value));`
        : path === '/shared.js' ? `onconnect=e=>{const port=e.ports[0];port.onmessage=()=>identity('shared').then(value=>port.postMessage(value));port.start();};`
        : `oninstall=e=>e.waitUntil(skipWaiting());onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.waitUntil(identity('service').then(value=>e.ports[0].postMessage(value)));`;
      res.end(workerIdentity + source); return;
    }
    if (path === '/opt-in') res.setHeader('Accept-CH', hints);
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><script>window.firstUserAgent=navigator.userAgent;</script><script src="/asset.js"></script><body>Owned native network fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, dir = await mkdtemp(join(tmpdir(), 'orbit-native-headers-'));
  let browser, context;
  try {
    browser = await chromium.launch(launch);
    const passport = fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: browser.version(), templateId: 's23_android14' });
    const profile = fp.profileFromPassport('native-network', passport);
    // Legacy persisted CH must not override Chromium's per-origin negotiation.
    profile.headers['SEC-CH-UA-MODEL'] = '"stale-model"';
    profile.headers['x-owned-fixture'] = 'retained-static-header';
    if (storageMode === 'persistent') {
      await browser.close();
      context = await chromium.launchPersistentContext(dir, { ...persistentLaunchOptions(launch, profile), ...mobileContextOptions(profile) });
      browser = context.browser();
      const browserSession = await browser.newBrowserCDPSession();
      assert.equal((await browserSession.send('Browser.getVersion')).userAgent, profile.fingerprint.navigator.userAgent, 'persistent browser starts with the profile UA');
      await browserSession.detach();
    }
    const originalPassport = JSON.stringify(profile);
    // Fail at registration time if setup tries to restore global routing.
    const appliedStaticHeaders = [];
    const guard = target => {
      target.route = async () => { throw new Error('profile setup must not register request routes'); };
      const setHeaders = target.setExtraHTTPHeaders.bind(target);
      target.setExtraHTTPHeaders = async headers => { appliedStaticHeaders.push(headers); return setHeaders(headers); };
      return target;
    };
    if (context) await createMobileContext(browser, profile, undefined, guard(context));
    else {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => guard(await newContext(options));
      try { context = await createMobileContext(browser, profile); } finally { browser.newContext = newContext; }
    }
    assert.equal(appliedStaticHeaders.length, 1);
    assert.ok(Object.keys(appliedStaticHeaders[0]).every(key => key.toLowerCase() !== 'user-agent' && !key.toLowerCase().startsWith('sec-ch-ua')));
    const page = await createMobilePage(context, profile);
    await page.goto(origin + '/cold');
    assert.equal(await page.evaluate(() => window.firstUserAgent), passport.fingerprint.navigator.userAgent);
    const cold = requests.find(r => r.path === '/cold').headers;
    assert.equal(cold['sec-ch-ua-model'], undefined);
    for (const [key, value] of Object.entries(buildHttpClientHints(profile))) assert.equal(cold[key.toLowerCase()], value);
    await page.goto(origin + '/opt-in'); await page.goto(origin + '/warm');
    const warm = requests.find(r => r.path === '/warm').headers;
    for (const [key, value] of Object.entries(buildHttpClientHints(profile, true))) assert.equal(warm[key.toLowerCase()], value, key);
    assert.equal(warm['x-owned-fixture'], 'retained-static-header');
    const popupEvent = page.waitForEvent('popup');
    await page.evaluate(url => window.open(url), origin + '/popup');
    const popup = await popupEvent; await popup.waitForLoadState('load');
    // No prepareMobilePage(popup) call: first navigation must use the native context patch.
    assert.equal(await popup.evaluate(() => window.firstUserAgent), passport.fingerprint.navigator.userAgent);
    await popup.close();
    for (const kind of ['dedicated', 'shared', 'service']) {
      const result = await page.evaluate(async kind => {
        const value = new Promise(async (resolve, reject) => {
          const timer = setTimeout(() => reject(Error('native_worker_timeout:' + kind)), 10000);
          const receive = event => { clearTimeout(timer); resolve(event.data); };
          try {
            if (kind === 'dedicated') { const worker = new Worker('/dedicated.js'); worker.onmessage = event => { worker.terminate(); receive(event); }; worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('dedicated_failed')); }; worker.postMessage('probe'); }
            else if (kind === 'shared') { const worker = new SharedWorker('/shared.js'); worker.port.onmessage = event => { worker.port.close(); receive(event); }; worker.onerror = () => { clearTimeout(timer); reject(Error('shared_failed')); }; worker.port.start(); worker.port.postMessage('probe'); }
            else {
              await navigator.serviceWorker.register('/service.js'); const registration = await navigator.serviceWorker.ready;
              const channel = new MessageChannel(); channel.port1.onmessage = event => { channel.port1.close(); receive(event); };
              registration.active.postMessage('probe', [channel.port2]);
            }
          } catch (error) { clearTimeout(timer); reject(error); }
        });
        return value;
      }, kind);
      assert.equal(result.ua, passport.fingerprint.navigator.userAgent, kind);
      assert.equal(result.headers['user-agent'], passport.fingerprint.navigator.userAgent, kind);
      // Worker CH availability is a Chromium capability. Check values when emitted,
      // rather than forcing absent headers via extraHTTPHeaders or Fetch.
      for (const [key, value] of Object.entries(buildHttpClientHints(profile, true))) {
        if (result.headers[key.toLowerCase()] !== undefined) assert.equal(result.headers[key.toLowerCase()], value, `${kind}: ${key}`);
      }
    }
    for (const path of ['/cold', '/popup', '/dedicated.js', '/shared.js']) {
      const observed = requests.find(r => r.path === path); assert.ok(observed, path);
      assert.equal(observed.headers['user-agent'], passport.fingerprint.navigator.userAgent, path);
    }
    const bootstrap = requests.find(r => r.path === '/service.js');
    assert.ok(bootstrap, 'the native Service Worker bootstrap reaches the server');
    // The browser-process bootstrap precedes the worker CDP session.
    await t.test('Service Worker bootstrap request uses profile UA', () => {
      assert.equal(bootstrap.headers['user-agent'], passport.fingerprint.navigator.userAgent);
    });
    assert.equal(requests.filter(r => r.path === '/asset.js').length, 1, 'native HTTP caching stays enabled');
    assert.equal(JSON.stringify(profile), originalPassport, 'context setup must preserve the saved identity');
  } finally {
    await context?.close(); await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});

// Same script URL in concurrently active contexts must never share an identity.
test('ServiceWorker bootstrap UA is scoped to each context through registration and replacement', { timeout: 60000 }, async () => {
  const requests = [];
  let revision = 1, browser;
  const contexts = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/service.js')) {
      requests.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      res.end(`// revision ${revision}\noninstall=e=>e.waitUntil(skipWaiting());onactivate=e=>e.waitUntil(clients.claim());`);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body>Context isolation</body>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch(launch);
    const expected = [];
    const pages = [];
    for (let i = 0; i < 3; i++) {
      let context, page;
      if (i === 2) {
        // An unmarked context remains native even after marked contexts opt in.
        context = await browser.newContext(); page = await context.newPage();
        expected.push(await page.evaluate(() => navigator.userAgent));
      } else {
        const profile = fp.profileFromPassport(`bootstrap-${i}`, fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: browser.version() }));
        profile.fingerprint.navigator.userAgent += ` OrbitFixture/${i}`;
        expected.push(profile.fingerprint.navigator.userAgent);
        context = await createMobileContext(browser, profile); page = await createMobilePage(context, profile);
      }
      contexts.push(context); pages.push(page);
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
    }
    const register = page => page.evaluate(async () => {
      await navigator.serviceWorker.register('/service.js'); await navigator.serviceWorker.ready;
    });
    await Promise.all(pages.map(register));
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(headers => headers['user-agent']).sort(), [...expected].sort());
    revision++;
    await Promise.all(pages.map(page => page.evaluate(async () => {
      await navigator.serviceWorker.register('/service.js?revision=2');
    })));
    assert.equal(requests.length, 6);
    assert.deepEqual(requests.slice(3).map(headers => headers['user-agent']).sort(), [...expected].sort());
    // Browser-level interception outlives a context without retaining its UA.
    await contexts.shift().close();
    const replacement = await browser.newContext(); contexts.push(replacement);
    const page = await replacement.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await register(page);
    assert.equal(requests.at(-1)['user-agent'], expected[2]);
  } finally {
    await Promise.all(contexts.map(context => context.close())); await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('persistent launch pins the browser-process UA without mutating launch arguments', () => {
  const profile = { fingerprint: { navigator: { userAgent: 'profile-UA' } } };
  const options = { args: ['--no-sandbox', '--user-agent=stale', '--disk-cache-size=123'] };
  assert.deepEqual(persistentLaunchOptions(options, profile).args, ['--no-sandbox', '--disk-cache-size=123', '--user-agent=profile-UA']);
  assert.deepEqual(options.args, ['--no-sandbox', '--user-agent=stale', '--disk-cache-size=123']);
  assert.ok(persistentLaunchOptions({}, profile).args.includes('--user-agent=profile-UA'));
});

test('native storage origin discovery is request-scoped and installs no marker on subsequent pages', async () => {
  const { verifyRestoredSession } = await import('../worker/profiles.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'orbit-origins-request-'));
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<body>Owned storage fixture</body>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, launch);
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(() => localStorage.setItem('fixture', 'retained'));
    const saved = { ...(await context.storageState()), savedAt: new Date().toISOString() };
    await context.close(); context = await chromium.launchPersistentContext(dir, launch);
    await context.setOffline(true);
    let scriptCalls = 0;
    const addInitScript = context.addInitScript.bind(context);
    context.addInitScript = (...args) => { scriptCalls++; return addInitScript(...args); };
    await assert.rejects(context.storageState({ orbitOrigins: ['file:///invalid'] }), /Invalid storage origin/);
    assert.equal((await verifyRestoredSession(context, saved, { discoverOrigins: true })).status, 'passed');
    assert.equal(scriptCalls, 0);
    assert.equal((await context.storageState()).origins.find(row => row.origin === origin).localStorage[0].value, 'retained');
    const next = await context.newPage(); await next.goto('data:text/html,<body>Next document</body>');
    assert.equal(scriptCalls, 0);
    assert.equal(await next.locator('body').textContent(), 'Next document');
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
