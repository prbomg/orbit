import {mobileProfileFixture} from './helpers/mobile-profile-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createMobileContext, createMobilePage, loadMobileProfile, stageMobileProfile, verifyRestoredSession, ProfileError } from '../worker/profiles.mjs';

test('Android/iOS metadata is present in the first document, native Android Canvas and legacy iOS Canvas remain stable', { timeout: 30_000 }, async () => {
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.firstUA = navigator.userAgent; window.firstWidth = screen.width;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  const exportCanvas = page => page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return {
      png: canvas.toDataURL(), blob: Array.from(new Uint8Array(await blob.arrayBuffer())), pixels: Array.from(pixels),
      ua: window.firstUA, width: window.firstWidth, touch: navigator.maxTouchPoints,
      hints: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'uaFullVersion']) : null,
    };
  });
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const plain = await browser.newContext(); const baseline = await plain.newPage(); await baseline.goto(url);
    const native = await exportCanvas(baseline); await plain.close();
    for (const os of ['android', 'ios']) {
      const profile = mobileProfileFixture(`profile-${os}`, os);
      const context = await createMobileContext(browser, profile);
      const page = await createMobilePage(context, profile); await page.goto(url);
      const firstHeaders = headers.at(-1);
      const first = await exportCanvas(page);
      assert.equal(first.ua, profile.fingerprint.navigator.userAgent);
      assert.equal(first.width, profile.fingerprint.screen.width);
      assert.ok(first.touch > 0);
      assert.equal(firstHeaders['user-agent'], first.ua);
      if (os === 'android') {
        assert.equal(first.hints.mobile, true);
        assert.equal(first.hints.model, profile.fingerprint.navigator.userAgentData.model);
        assert.equal(firstHeaders['sec-ch-ua-platform'], '"Android"');
        assert.equal(firstHeaders['sec-ch-ua-mobile'], '?1');
      } else {
        assert.equal(first.hints, null);
        assert.ok(Object.keys(firstHeaders).every(name => !name.startsWith('sec-ch-ua')));
      }
      if (profile.fingerprint.canvas?.mode === 'native') {
        assert.equal(first.png, native.png);
        assert.deepEqual(first.pixels, native.pixels);
      } else {
        assert.notEqual(first.png, native.png);
        assert.notDeepEqual(first.pixels, native.pixels);
      }
      assert.deepEqual(Buffer.from(first.blob), Buffer.from(first.png.split(',')[1], 'base64'));
      assert.equal((await exportCanvas(page)).png, first.png, 'Repeated exports must not accumulate noise');
      await context.close();
      const repeatContext = await createMobileContext(browser, profile);
      const repeat = await createMobilePage(repeatContext, profile); await repeat.goto(url);
      assert.equal((await exportCanvas(repeat)).png, first.png, 'The same profile must preserve its Canvas across contexts');
      await repeatContext.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
});

test('profile files are private, validated and atomically published; corrupt profiles never silently regenerate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-profile-'));
  try {
    const loaded = await loadMobileProfile(dir, 'task-fixture', undefined, mobileProfileFixture('task-fixture'));
    assert.equal(loaded.reused, false);
    const context = { storageState: async () => {
      const state = { cookies: [], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'session', value: 'synthetic-value' }] }] };
      return state;
    } };
    const staged = await stageMobileProfile(dir, loaded.profile, context);
    await assert.rejects(readFile(join(dir, 'task-fixture.json')), { code: 'ENOENT' });
    await staged.publish(); await staged.discard();
    const path = join(dir, 'task-fixture.json');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const restored = await loadMobileProfile(dir, 'task-fixture', undefined, mobileProfileFixture('task-fixture'));
    assert.equal(restored.reused, true);
    assert.deepEqual(restored.profile.fingerprint, loaded.profile.fingerprint);
    assert.equal(restored.profile.canvasSeed, loaded.profile.canvasSeed);
    assert.equal(restored.profile.origins[0].localStorage[0].value, 'synthetic-value');
    assert.equal(restored.storageStatePath, path);
    await writeFile(path, '{');
    await assert.rejects(loadMobileProfile(dir, 'task-fixture'), ProfileError);
    await assert.rejects(loadMobileProfile(dir, '../escape'), ProfileError);
    const desktop = { ...loaded.profile, fingerprint: { ...loaded.profile.fingerprint,
      navigator: { ...loaded.profile.fingerprint.navigator, userAgent: 'Mozilla/5.0 Chrome/147.0 Desktop' } } };
    await writeFile(path, JSON.stringify(desktop));
    await assert.rejects(loadMobileProfile(dir, 'task-fixture'), ProfileError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing profile files do not create a second unbound identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-missing-profile-'));
  try {
    assert.deepEqual(await loadMobileProfile(dir, 'missing'), {profile:null,reused:false});
    const initial = mobileProfileFixture('missing');
    const loaded = await loadMobileProfile(dir, 'missing', undefined, initial);
    assert.deepEqual(loaded.profile.fingerprint, initial.fingerprint);
    await assert.rejects(readFile(join(dir, 'missing.json')), {code:'ENOENT'});
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('a failed profile save preserves the last successful file and reports the failing stage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-profile-failure-'));
  try {
    const profile = mobileProfileFixture('saved-profile');
    const validState = { cookies: [], origins: [] };
    const staged = await stageMobileProfile(dir, profile, { storageState: async () => validState });
    await staged.publish(); await staged.discard();
    const path = join(dir, 'saved-profile.json'); const previous = await readFile(path, 'utf8');
    await assert.rejects(stageMobileProfile(dir, profile, { storageState: async () => { throw new Error('synthetic-secret'); } }), error => error.code === 'profile_storage_failed' && !error.message.includes('synthetic-secret'));
    await assert.rejects(stageMobileProfile(dir, profile, { storageState: async () => ({ cookies: [{}], origins: [] }) }), error => error.code === 'profile_state_invalid');
    assert.equal(await readFile(path, 'utf8'), previous);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved-session verification confirms restored cookies and localStorage and rejects lost values', async () => {
  const profile = { ...mobileProfileFixture('session-check'), savedAt: new Date().toISOString(),
    cookies: [{ name: 'session', value: 'kept', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'preference', value: 'kept' }] }] };
  const exact = { storageState: async () => ({ cookies: profile.cookies, origins: profile.origins }) };
  const report = await verifyRestoredSession(exact, profile);
  assert.equal(report.status, 'passed'); assert.equal(report.activeCookiesCount, 1);
  assert.equal(report.localStorageEntriesCount, 1); assert.equal(report.sourceSavedAt, profile.savedAt);
  const missing = { storageState: async () => ({ cookies: [], origins: [] }) };
  await assert.rejects(verifyRestoredSession(missing, profile), error => error.code === 'profile_session_verification_failed');
  await assert.rejects(verifyRestoredSession(exact, { ...profile, savedAt: null }), error => error.code === 'profile_session_missing');
});

test('session verification ignores expired cookies, retains session/partitioned cookies and rejects empty snapshots', async () => {
  const cookie = { name: 'session', value: 'private-cookie-value', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' };
  const partitioned = { ...cookie, partitionKey: 'https://example.org', _crHasCrossSiteAncestor: true };
  const profile = { savedAt: new Date().toISOString(), cookies: [cookie, partitioned, { ...cookie, name: 'expired', expires: 1 }], origins: [{ origin: 'https://unused.example', localStorage: [] }] };
  const context = { storageState: async options => { assert.equal(options.indexedDB, true); return { cookies: [partitioned, cookie], origins: [] }; } };
  const report = await verifyRestoredSession(context, profile);
  assert.equal(report.status, 'passed'); assert.equal(report.expiredCookiesCount, 1); assert.equal(report.activeCookiesCount, 2);
  assert.ok(!JSON.stringify(report).includes('private-cookie-value'));
  await assert.rejects(verifyRestoredSession({ storageState: async () => ({ cookies: [cookie], origins: [] }) }, profile), error => error.diagnostics.missingCookies === 1);
  for (const cookies of [[], [{ ...cookie, expires: 1 }]]) {
    await assert.rejects(verifyRestoredSession({ storageState: async () => ({ cookies: [], origins: [] }) }, { ...profile, cookies }), error => error.code === 'profile_session_empty');
  }
  const changed = { ...cookie, httpOnly: false };
  await assert.rejects(verifyRestoredSession({ storageState: async () => ({ cookies: [changed, partitioned], origins: [] }) }, profile), error => error.diagnostics.missingCookies === 1);
});

test('IndexedDB records, schemas and encoded values survive a real browser restart', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-indexeddb-'));
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Storage fixture</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const profile = mobileProfileFixture('indexeddb-profile');
    const context = await createMobileContext(browser, profile);
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      localStorage.setItem('preference', 'private-storage-value');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('sessions', 2);
        request.onupgradeneeded = () => { const store = request.result.createObjectStore('records', { keyPath: 'id' }); store.createIndex('by-name', 'name', { unique: true }); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put({ id: 7, name: 'private-db-value', date: new Date('2026-01-01'), bytes: new Uint8Array([1, 2, 3]) });
          tx.objectStore('records').put({ id: 9, name: 'private-second-value', preference: false });
          tx.objectStore('records').put({ id: 11, name: 'private-third-value', preference: null });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      });
    });
    const staged = await stageMobileProfile(dir, profile, context); await staged.publish(); await staged.discard(); await context.close();
    const loaded = await loadMobileProfile(dir, profile.profileId);
    assert.equal(loaded.profile.origins[0].indexedDB[0].stores[0].records.length, 3);
    const restored = await createMobileContext(browser, loaded.profile, loaded.storageStatePath);
    const report = await verifyRestoredSession(restored, loaded.profile);
    assert.equal(report.status, 'passed'); assert.equal(report.indexedDBRecordsCount, 3); assert.equal(report.indexedDBDatabasesCount, 1);
    assert.ok(!JSON.stringify(report).includes('private-'));
    const restoredPage = await restored.newPage(); await restoredPage.goto(`http://127.0.0.1:${server.address().port}/`);
    const actual = await restoredPage.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('sessions', 2);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('records', 'readonly'), get = tx.objectStore('records').get(7);
        get.onsuccess = () => { const value = get.result; resolve({ date: value.date.toISOString(), dateType: value.date instanceof Date, bytes: Array.from(value.bytes), byteType: value.bytes instanceof Uint8Array }); };
        get.onerror = () => reject(get.error); tx.oncomplete = () => db.close();
      }; request.onerror = () => reject(request.error);
    }));
    assert.deepEqual(actual, { date: '2026-01-01T00:00:00.000Z', dateType: true, bytes: [1, 2, 3], byteType: true });
    const broken = structuredClone(loaded.profile); broken.origins[0].indexedDB[0].stores[0].records[0].valueEncoded = { s: 'changed' };
    delete broken.origins[0].indexedDB[0].stores[0].records[0].value;
    await assert.rejects(verifyRestoredSession(restored, broken), error => error.diagnostics.mismatchedIndexedDBItems === 1);
    const reordered = structuredClone(loaded.profile); reordered.origins[0].indexedDB[0].stores[0].records.reverse();
    assert.equal((await verifyRestoredSession(restored, reordered)).status, 'passed');
    await restored.close();
  } finally { await browser?.close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await rm(dir, { recursive: true, force: true }); }
});

test('legacy taskId profiles preserve their fingerprint and cookies when upgraded to profileId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-legacy-profile-'));
  try {
    const original = mobileProfileFixture('new-profile');
    const { profileId: _profileId, origins: _origins, ...fields } = original;
    await writeFile(join(dir, 'legacy-task.json'), JSON.stringify({ ...fields, version: 1, taskId: 'legacy-task' }));
    const loaded = await loadMobileProfile(dir, 'new-profile', 'legacy-task');
    assert.equal(loaded.reused, true);
    assert.equal(loaded.profile.profileId, 'new-profile');
    assert.deepEqual(loaded.profile.fingerprint, original.fingerprint);
    assert.equal(loaded.profile.canvasSeed, original.canvasSeed);
    assert.deepEqual(loaded.profile.origins, []);
    await assert.rejects(readFile(join(dir, 'new-profile.json')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partitioned Chromium cookies survive atomic profile save and reuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-partitioned-profile-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const profile = mobileProfileFixture('partitioned-profile', 'android');
    const context = await createMobileContext(browser, profile);
    await context.addCookies([{ name: 'partitioned-session', value: 'synthetic-value', domain: 'example.com', path: '/',
      expires: -1, httpOnly: true, secure: true, sameSite: 'None', partitionKey: 'https://ya.ru', _crHasCrossSiteAncestor: true }]);
    const state = await context.storageState();
    assert.equal(state.cookies[0]._crHasCrossSiteAncestor, true);
    const staged = await stageMobileProfile(dir, profile, context);
    await staged.publish(); await staged.discard();
    await context.close();
    const loaded = await loadMobileProfile(dir, profile.profileId);
    assert.deepEqual(loaded.profile.cookies, state.cookies);
    const reused = await createMobileContext(browser, loaded.profile, loaded.storageStatePath);
    assert.deepEqual((await reused.storageState()).cookies, state.cookies);
    await reused.close();
    if (process.platform !== 'win32') assert.equal((await stat(loaded.storageStatePath)).mode & 0o777, 0o600);
  } finally {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
