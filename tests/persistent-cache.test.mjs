import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { preparePersistentProfile, persistentStorageStats } from '../worker/persistent-profile.mjs';
import { persistentLaunchOptions } from '../worker/persistent-cache.mjs';
import { createMobileContext, createMobilePage, mobileContextOptions, stageMobileProfile } from '../worker/profiles.mjs';
import { verifySessionAfterRestart } from '../worker/session-restart-check.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';
import { restrictNavigation } from '../worker/action-executor.mjs';

const launchOptions = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH };

test('native copies retain network/site/code state, discard shader junk, and reject mismatched backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-native-state-'));
  try {
    const protectedFiles = ['Default/Cache/cache-data', 'Default/Code Cache/js/code', 'Default/Network/Cookies', 'Default/Network/Network Persistent State', 'Default/TransportSecurity', 'Default/Service Worker/Database/state', 'Default/Service Worker/CacheStorage/entry', 'Default/Local Storage/leveldb/state', 'Default/IndexedDB/state', 'Local State'];
    const disposableFiles = ['Default/GPUCache/junk', 'ShaderCache/junk', 'GrShaderCache/junk', 'GraphiteDawnCache/junk', 'Crashpad/junk'];
    const first = await preparePersistentProfile(dir, 'native');
    for (const name of [...protectedFiles, ...disposableFiles]) { await mkdir(join(first.path, name, '..'), { recursive: true }); await writeFile(join(first.path, name), `first:${name}`); }
    await first.publish('first-time', 'first-id');
    const second = await preparePersistentProfile(dir, 'native');
    for (const name of protectedFiles) assert.equal(await readFile(join(second.path, name), 'utf8'), `first:${name}`);
    for (const name of disposableFiles) await assert.rejects(stat(join(second.path, name)), e => e.code === 'ENOENT');
    await writeFile(join(second.path, 'Default/Network/Cookies'), 'second-cookies');
    await second.publish('second-time', 'second-id');
    const failed = await preparePersistentProfile(dir, 'native');
    await writeFile(join(failed.path, 'Default/Cache/cache-data'), 'failed-attempt');
    await failed.discard();
    assert.equal(await readFile(join(dir, 'browser-data/native/current/Default/Cache/cache-data'), 'utf8'), 'first:Default/Cache/cache-data');
    await assert.rejects(preparePersistentProfile(dir, 'native', { source: 'previous', expectedSnapshotId: 'wrong-id' }), e => e.code === 'profile_storage_version_mismatch');
    const restored = await preparePersistentProfile(dir, 'native', { source: 'previous', expectedSnapshotId: 'first-id' });
    assert.equal(await readFile(join(restored.path, 'Default/Network/Cookies'), 'utf8'), 'first:Default/Network/Cookies');
    for (const name of protectedFiles) {
      if (/^Default\/(Cache|Code Cache)\//.test(name)) await assert.rejects(stat(join(restored.path, name)), { code: 'ENOENT' });
      else assert.equal(await readFile(join(restored.path, name), 'utf8'), `first:${name}`);
    }
    const size = await persistentStorageStats(restored.path);
    assert.equal(size.cacheBytes, 0);
    assert.ok(size.dataBytes > 0);
    await restored.discard();
    await assert.rejects(preparePersistentProfile(dir, 'no-backup', { source: 'previous', expectedSnapshotId: 'missing' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persistent browser retains HTTP cache, conditional validators, cookies, IndexedDB and ServiceWorker across restart and publication', { timeout: 60000 }, async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'application/javascript' : 'text/html');
    if (request.url === '/fresh.js' || request.url === '/stale.js') {
      const fresh = request.url === '/fresh.js';
      response.setHeader('Cache-Control', fresh ? 'public, max-age=3600' : 'public, max-age=0, must-revalidate');
      response.setHeader('ETag', fresh ? '"fresh-v1"' : '"stale-v1"');
      if (!fresh && request.headers['if-none-match'] === '"stale-v1"') { response.writeHead(304); response.end(); return; }
      response.end(fresh ? 'globalThis.freshLoaded=true;' : 'globalThis.staleLoaded=true;'); return;
    }
    if (request.url === '/sw.js') {
      response.setHeader('Cache-Control', 'no-cache');
      response.end(`oninstall=e=>e.waitUntil((async()=>{const c=await caches.open('native-test');await c.put('/sw-owned',new Response('persistent-cache-storage'));await skipWaiting();})());onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.waitUntil((async()=>{const r=await(await caches.open('native-test')).match('/sw-owned');e.ports[0].postMessage(await r.text());})());`); return;
    }
    response.setHeader('Cache-Control', request.url === '/cached-document' ? 'public,max-age=3600' : 'no-store');
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/fresh.js"></script><script src="/stale.js"></script><body>Owned cache fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'orbit-native-cache-'));
  let context, staged, run;
  try {
    const runtime = await chromium.launch(launchOptions);
    const passport = fp.localPassport({ fingerprintMode: 'local', fingerprintDevicePreset: 's23_android14' }, { seed: '1234567890abcdef1234567890abcdef', runtimeVersion: runtime.version() });
    await runtime.close();
    let profile = fp.profileFromPassport('native-cache', passport);
    run = await preparePersistentProfile(dir, profile.profileId);
    context = await chromium.launchPersistentContext(run.path, { ...persistentLaunchOptions(launchOptions, profile), ...mobileContextOptions(profile) });
    await createMobileContext(context.browser(), profile, undefined, context, true);
    let page = await createMobilePage(context, profile);
    await page.goto(origin); await page.waitForFunction(() => globalThis.freshLoaded && globalThis.staleLoaded);
    await context.addCookies([{ name: 'native-durable', value: 'retained', url: origin, expires: Date.now() / 1000 + 3600 }]);
    await page.evaluate(async () => {
      localStorage.setItem('native-item', 'retained');
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('native-db', 1); open.onupgradeneeded = () => open.result.createObjectStore('items'); open.onerror = reject;
        open.onsuccess = () => { const tx = open.result.transaction('items', 'readwrite'); tx.objectStore('items').put('retained', 'native-key'); tx.oncomplete = () => { open.result.close(); resolve(); }; };
      });
      const registration = await navigator.serviceWorker.register('/sw.js');
      if (!registration.active) await new Promise(resolve => registration.installing.addEventListener('statechange', () => { if (registration.active) resolve(); }));
      await navigator.serviceWorker.ready;
    });
    await page.goto(origin + '/cached-document');
    const first = await stageMobileProfile(dir, profile, context, { storageMode: 'persistent' }); staged = first;
    await context.close(); context = null;
    const attestation = await verifySessionAfterRestart(first, { launchOptions, persistentPath: run.path });
    assert.equal(attestation.status, 'passed');
    assert.equal(attestation.storageCoverage.httpCache, 'native_allowed_unverified');
    assert.equal(attestation.storageCoverage.tlsResumption, 'not_verified');
    await run.publish(first.snapshot.savedAt, first.snapshot.snapshot.id); await first.publish(); staged = null;
    profile = first.snapshot;
    run = await preparePersistentProfile(dir, profile.profileId);
    context = await chromium.launchPersistentContext(run.path, { ...persistentLaunchOptions(launchOptions, profile), ...mobileContextOptions(profile) });
    await createMobileContext(context.browser(), profile, undefined, context, false);
    page = await createMobilePage(context, profile);
    // Real production qualification temporarily changes routes; it must not
    // disable cache after its offline documents/workers have been removed.
    const quality = await inspectFingerprint(page, profile, undefined, context.browser().version());
    assert.equal(quality.status, 'passed');
    await page.goto(origin); await page.waitForFunction(() => globalThis.freshLoaded && globalThis.staleLoaded);
    assert.equal(requests.filter(r => r.path === '/fresh.js').length, 1, 'fresh script must survive a real process restart without a network download');
    assert.ok(requests.filter(r => r.path === '/stale.js').some(r => r.headers['if-none-match'] === '"stale-v1"'), 'stale script must use the saved validator');
    assert.equal(await page.evaluate(() => localStorage.getItem('native-item')), 'retained');
    assert.ok((await context.cookies(origin)).some(c => c.name === 'native-durable' && c.value === 'retained'));
    assert.equal(await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('native-db'); open.onsuccess = () => { const q = open.result.transaction('items').objectStore('items').get('native-key'); q.onsuccess = () => { open.result.close(); resolve(q.result); }; }; })), 'retained');
    const workerState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) return { registration: false };
      const cached = await (await caches.open('native-test')).match('/sw-owned');
      return { registration: Boolean(reg.active), cache: await cached?.text() };
    });
    assert.deepEqual(workerState, { registration: true, cache: 'persistent-cache-storage' });
    // Cached documents must still be subject to navigation policy.
    const guard = await restrictNavigation(context, 'http://different-origin.invalid');
    try { await assert.rejects(page.goto(origin + '/cached-document'), /ERR_BLOCKED_BY_CLIENT|ERR_FAILED/); }
    finally { await guard.dispose(); }
    await context.close(); context = null;
    await run.publish(new Date().toISOString(), 'second-id'); run = null;
    run = await preparePersistentProfile(dir, profile.profileId, { source: 'previous', expectedSnapshotId: first.snapshot.snapshot.id });
    for (const name of ['Cache', 'Code Cache']) await assert.rejects(stat(join(run.path, 'Default', name)), { code: 'ENOENT' });
    const coldRestore = await verifySessionAfterRestart({ ...first, temporary: join(dir, `${profile.profileId}.json`) }, { launchOptions, persistentPath: run.path });
    assert.equal(coldRestore.status, 'passed', 'cacheless backup restores native cookies, localStorage and IndexedDB');
    await run.discard(); run = null;
  } finally {
    await context?.close(); await staged?.discard(); await run?.discard();
    await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
