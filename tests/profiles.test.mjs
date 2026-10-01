import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
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
    const context = { storageState: async ({ path }) => {
      const state = { cookies: [], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'session', value: 'synthetic-value' }] }] };
      await writeFile(path, JSON.stringify(state)); return state;
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
