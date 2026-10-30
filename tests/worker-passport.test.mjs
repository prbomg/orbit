import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { sampleContext, compareContext } from '../worker/context-matrix.mjs';
import { buildHttpClientHints } from '../worker/client-hints.mjs';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'https://orbit-worker-test.invalid';
const launch = (options = {}) => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH, ...options });
const snapshot = `const snapshot=(${sampleContext.toString()})();snapshot.catch(()=>{});`;
const dedicatedSource = `${snapshot}snapshot.then(value=>postMessage(value),error=>postMessage({probeError:String(error)}));`;

async function setup(browser, templateId, fixtureOrigin = origin, { native = false } = {}) {
  const profile = fp.profileFromPassport(templateId, fp.localPassport({ fingerprintMode: 'local' }, {
    templateId, runtimeVersion: browser.version(), seed: '1234567890abcdef1234567890abcdef',
  }));
  const context = native ? await browser.newContext() : await createMobileContext(browser, profile);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/echo') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(await route.request().allHeaders()) });
    let body = '<!doctype html><body>Worker fixture</body>';
    if (url.pathname === '/probe.js' || url.pathname === '/imported.js') body = dedicatedSource;
    if (url.pathname === '/module.js') body = `import './imported.js';`;
    if (url.pathname === '/nested.js') body = `const child=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(dedicatedSource)}],{type:'application/javascript'})));child.onmessage=e=>{postMessage(e.data);child.terminate();};`;
    if (url.pathname === '/shared.js') body = `${snapshot}globalThis.onconnect=e=>{snapshot.then(async value=>e.ports[0].postMessage({value,headers:await(await fetch('${fixtureOrigin}/echo')).json()}));};`;
    if (url.pathname === '/service-imported.js') body = `globalThis.importedIdentity={platform:navigator.platform,cpu:navigator.hardwareConcurrency,ua:navigator.userAgent};`;
    if (url.pathname === '/service.js') body = `import './service-imported.js';${snapshot}globalThis.oninstall=()=>skipWaiting();globalThis.onactivate=e=>e.waitUntil(clients.claim());globalThis.onmessage=e=>e.waitUntil(snapshot.then(async value=>e.ports[0].postMessage({value,importedIdentity,revision:${JSON.stringify(url.search)},headers:await(await fetch('${origin}/echo')).json()})));`;
    return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html',
      headers: { 'accept-ch': 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List' }, body });
  });
  const page = native ? await context.newPage() : await createMobilePage(context, profile); await page.goto(`${fixtureOrigin}/`);
  const main = await page.evaluate(sampleContext);
  return { context, profile, page, main };
}

function assertPassport(scene, value, state) {
  const report = compareContext(scene, value, state.profile, state.main);
  assert.equal(report.status, 'passed', JSON.stringify(report.checks.filter(c => c.status === 'failed')));
}

test('classic, blob, module imports, nested and frame/popup workers match from their first script', { timeout: 60000 }, async () => {
  const browser = await launch();
  try {
    const state = await setup(browser, 's23_android14');
    try {
      const read = (frame, kind) => frame.evaluate(({ kind, origin, source }) => new Promise((resolve, reject) => {
        let url = `${origin}/${kind === 'module' ? 'module' : kind === 'nested' ? 'nested' : 'probe'}.js`;
        if (kind === 'blob') url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const worker = new Worker(url, { type: kind === 'module' ? 'module' : 'classic' });
        const timer = setTimeout(() => { worker.terminate(); reject(Error(`worker_timeout:${kind}`)); }, 5000);
        worker.onmessage = e => { clearTimeout(timer); worker.terminate(); if (kind === 'blob') URL.revokeObjectURL(url); resolve(e.data); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('worker_failed')); };
      }), { kind, origin: new URL(frame.url()).origin, source: dedicatedSource });
      for (const kind of ['classic', 'blob', 'module', 'nested']) assertPassport(kind, await read(state.page, kind), state);
      for (const host of [origin, 'https://orbit-worker-frame.invalid']) {
        await state.page.evaluate(url => new Promise(resolve => { const f = document.createElement('iframe'); f.src = url; f.onload = resolve; document.body.append(f); }), `${host}/frame`);
        const frame = state.page.frames().find(frame => frame.url() === `${host}/frame`);
        assertPassport('iframe-worker', await read(frame, 'classic'), state);
      }
      const popupPromise = state.page.waitForEvent('popup'); await state.page.evaluate(url => window.open(url), `${origin}/popup`);
      const popup = await popupPromise; await popup.waitForLoadState();
      try { assertPassport('popup-worker', await read(popup, 'classic'), state); } finally { await popup.close(); }
    } finally { await state.context.close(); }
  } finally { await browser.close(); }
});

test('simultaneous BrowserContexts keep SharedWorker identity and HTTP hints isolated', { timeout: 30000 }, async () => {
  // Playwright has no public SharedWorker network router. Measure its native
  // HTTP headers at an owned loopback server instead of faking a routed fetch.
  const directory = await mkdtemp(join(tmpdir(), 'orbit-loopback-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `https://127.0.0.1:${server.address().port}`;
  const browser = await launch({ args: ['--ignore-certificate-errors'] });
  try {
    const nativeContext = await browser.newContext();
    let nativeHeaders;
    try {
      await nativeContext.route('**/*', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'application/javascript' : 'text/html',
        body: route.request().url().endsWith('.js') ? `onconnect=e=>fetch('${fixtureOrigin}/echo').then(r=>r.json()).then(headers=>e.ports[0].postMessage(headers));` : '<body>Native SharedWorker capability</body>' }));
      const nativePage = await nativeContext.newPage(); await nativePage.goto(fixtureOrigin);
      nativeHeaders = await nativePage.evaluate(origin => new Promise((resolve, reject) => {
        const worker = new SharedWorker(`${origin}/native-shared.js`), timer = setTimeout(() => reject(Error('native_shared_timeout')), 5000);
        worker.port.onmessage = e => { clearTimeout(timer); worker.port.close(); resolve(e.data); }; worker.port.start();
      }), fixtureOrigin);
    } finally { await nativeContext.close(); }
    const states = await Promise.all(['s23_android14', 'a54_android14'].map(id => setup(browser, id, fixtureOrigin)));
    try {
      const results = await Promise.all(states.map(state => state.page.evaluate(origin => new Promise((resolve, reject) => {
        const worker = new SharedWorker(`${origin}/shared.js`, { name: 'same-name-in-distinct-contexts', type: 'module' });
        const timer = setTimeout(() => { worker.port.close(); reject(Error('shared_timeout')); }, 5000);
        worker.port.onmessage = e => { clearTimeout(timer); worker.port.close(); resolve(e.data); };
        worker.onerror = () => { clearTimeout(timer); reject(Error('shared_failed')); }; worker.port.start();
      }), fixtureOrigin)));
      results.forEach((result, i) => {
        assertPassport('shared-module', result.value, states[i]);
        const expected = buildHttpClientHints(states[i].profile, true);
        assert.equal(result.headers['user-agent'], states[i].profile.fingerprint.navigator.userAgent);
        // Chromium does not emit CH on all kinds of Worker fetch. Preserve its
        // native capability; compare values wherever that binary sends them.
        for (const key of ['Sec-CH-UA', 'Sec-CH-UA-Mobile', 'Sec-CH-UA-Platform']) assert.equal(result.headers[key.toLowerCase()], nativeHeaders[key.toLowerCase()] === undefined ? undefined : expected[key], key);
      });
      assert.notEqual(results[0].value.offscreen.webgl.renderer, results[1].value.offscreen.webgl.renderer);
    } finally { await Promise.all(states.map(state => state.context.close())); }
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); }
});

test('ServiceWorker keeps its passport and HTTP identity after a cold restart and update', { timeout: 60000 }, async () => {
  const browser = await launch();
  try {
    const state = await setup(browser, 's23_android14');
    try {
      const cdp = await state.context.newCDPSession(state.page), versions = new Map();
      cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const v of event.versions) versions.set(v.versionId, v); });
      await cdp.send('ServiceWorker.enable');
      const read = (revision, page = state.page) => page.evaluate(async ({ origin, revision }) => {
        const registration = revision === null ? await navigator.serviceWorker.getRegistration('/') : await navigator.serviceWorker.register(`${origin}/service.js?revision=${revision}`, { type: 'module' });
        const active = revision === null ? registration.active : registration.installing || registration.waiting || registration.active;
        if (active.state !== 'activated') await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('activation_timeout')), 8000);
          active.addEventListener('statechange', () => { if (active.state === 'activated') { clearTimeout(timer); resolve(); } });
          if (active.state === 'activated') { clearTimeout(timer); resolve(); }
        });
        return new Promise((resolve, reject) => {
          const channel = new MessageChannel(), timer = setTimeout(() => reject(Error('sw_timeout')), 8000);
          channel.port1.onmessage = e => { clearTimeout(timer); channel.port1.close(); resolve(e.data); };
          active.postMessage('probe', [channel.port2]);
        });
      }, { origin, revision });
      const native = await setup(browser, 's23_android14', origin, { native: true });
      let nativeHeaders;
      try { nativeHeaders = (await read(1, native.page)).headers; }
      finally { await native.context.close(); }
      const first = await read(1); assertPassport('service-first', first.value, state);
      const version = [...versions.values()].find(v => v.scriptURL === `${origin}/service.js?revision=1` && v.runningStatus === 'running');
      assert.ok(version, JSON.stringify([...versions.values()]));
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      const cold = await read(null); assertPassport('service-cold', cold.value, state);
      assert.deepEqual(cold.value, first.value);
      const updated = await read(2); assertPassport('service-update', updated.value, state);
      assert.equal(updated.revision, '?revision=2');
      for (const result of [first, cold, updated]) {
        assert.deepEqual(result.importedIdentity, { platform: state.profile.fingerprint.navigator.platform, cpu: state.profile.fingerprint.navigator.hardwareConcurrency, ua: state.profile.fingerprint.navigator.userAgent });
        assert.equal(result.headers['user-agent'], state.profile.fingerprint.navigator.userAgent);
        assert.equal(result.headers['accept-language'], state.profile.headers['accept-language']);
        const expected = buildHttpClientHints(state.profile, true);
        for (const key of ['Sec-CH-UA', 'Sec-CH-UA-Mobile', 'Sec-CH-UA-Platform']) {
          const name = key.toLowerCase();
          // Chromium may omit UA-CH on SW fetches. Match its native policy,
          // rather than demanding headers previously forced by extraHTTPHeaders.
          assert.equal(Object.hasOwn(result.headers, name), Object.hasOwn(nativeHeaders, name), key);
          if (Object.hasOwn(result.headers, name)) assert.equal(result.headers[name], expected[key], key);
        }
      }
      await state.page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
      await cdp.detach();
    } finally { await state.context.close(); }
  } finally { await browser.close(); }
});
