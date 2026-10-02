import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { FingerprintGenerator } from 'fingerprint-generator';
import { generateMobileProfile, createMobileContext, createMobilePage, loadMobileProfile, stageMobileProfile, ProfileError } from '../worker/profiles.mjs';

test('Android/iOS metadata is present in the first document, Canvas noise is stable and differs from native output', { timeout: 30_000 }, async () => {
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
    browser = await chromium.launch({ headless: true });
    const plain = await browser.newContext(); const baseline = await plain.newPage(); await baseline.goto(url);
    const native = await exportCanvas(baseline); await plain.close();
    for (const os of ['android', 'ios']) {
      const profile = generateMobileProfile(`profile-${os}`, os);
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
      assert.notEqual(first.png, native.png);
      assert.notDeepEqual(first.pixels, native.pixels);
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
    const loaded = await loadMobileProfile(dir, 'task-fixture');
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
    const restored = await loadMobileProfile(dir, 'task-fixture');
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

test('mobile profile generation skips a tablet sample instead of failing validation', () => {
  const valid = generateMobileProfile('template-profile', 'ios');
  let calls = 0;
  const method = mock.method(FingerprintGenerator.prototype, 'getFingerprint', () => {
    calls++;
    const fingerprint = structuredClone(valid.fingerprint); const headers = { ...valid.headers };
    if (calls === 1) fingerprint.navigator.userAgent = headers['user-agent'] = 'Mozilla/5.0 (Linux; Android 10; K) Chrome/146.0.0.0 Safari/537.36';
    return { fingerprint, headers };
  });
  try {
    const profile = generateMobileProfile('valid-profile');
    assert.equal(calls, 2);
    assert.equal(profile.mobileOS, 'ios');
    assert.equal(profile.fingerprint.navigator.userAgent, profile.headers['user-agent']);
    assert.equal(profile.profileId, 'valid-profile');
  } finally { method.mock.restore(); }
});

test('a failed profile save preserves the last successful file and reports the failing stage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-profile-failure-'));
  try {
    const profile = generateMobileProfile('saved-profile');
    const validState = { cookies: [], origins: [] };
    const staged = await stageMobileProfile(dir, profile, { storageState: async () => validState });
    await staged.publish(); await staged.discard();
    const path = join(dir, 'saved-profile.json'); const previous = await readFile(path, 'utf8');
    await assert.rejects(stageMobileProfile(dir, profile, { storageState: async () => { throw new Error('synthetic-secret'); } }), error => error.code === 'profile_storage_failed' && !error.message.includes('synthetic-secret'));
    await assert.rejects(stageMobileProfile(dir, profile, { storageState: async () => ({ cookies: [{}], origins: [] }) }), error => error.code === 'profile_state_invalid');
    assert.equal(await readFile(path, 'utf8'), previous);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy taskId profiles preserve their fingerprint and cookies when upgraded to profileId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-legacy-profile-'));
  try {
    const original = generateMobileProfile('new-profile');
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
    browser = await chromium.launch({ headless: true });
    const profile = generateMobileProfile('partitioned-profile', 'android');
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
