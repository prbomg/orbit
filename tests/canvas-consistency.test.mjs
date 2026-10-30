import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installCanvasProfile } from '../worker/canvas-profile.mjs';

for (const mode of ['legacy-seeded-v1', 'native']) test(`${mode}: HTML and Offscreen reads/PNG exports agree, preserve pixels and retain native error behavior`, { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const context = await browser.newContext();
    await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<body>Canvas fixture</body>' }));
    const page = await context.newPage(); await page.goto('https://orbit-canvas.invalid/');
    await page.evaluate(() => {
      globalThis.nativeCanvas = {
        htmlGet: CanvasRenderingContext2D.prototype.getImageData,
        offscreenGet: OffscreenCanvasRenderingContext2D.prototype.getImageData,
        convert: OffscreenCanvas.prototype.convertToBlob,
      };
    });
    await page.evaluate(installCanvasProfile, { seed: 0x12345678, ios: false, mode });
    const result = await page.evaluate(async () => {
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const html = document.createElement('canvas'); html.width = html.height = 64;
      const offscreen = new OffscreenCanvas(64, 64);
      const [h, o] = [html, offscreen].map(c => { const x = c.getContext('2d'); x.fillStyle = '#336699'; x.fillRect(0, 0, 64, 64); return x; });
      const raw = Array.from(nativeCanvas.htmlGet.call(h, 0, 0, 64, 64).data);
      const expected = Array.from(h.getImageData(0, 0, 64, 64).data);
      const read = context => Array.from(context.getImageData(0, 0, 64, 64).data);
      const offscreenReadsMatch = same(read(o), expected);
      const legacyReadHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(expected))), b => b.toString(16).padStart(2, '0')).join('');
      const decode = async blob => {
        const bitmap = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = c.height = 64;
        const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return Array.from(nativeCanvas.htmlGet.call(ctx, 0, 0, 64, 64).data);
      };
      const blobs = [await (await fetch(html.toDataURL())).blob(), await new Promise(resolve => html.toBlob(resolve)), await offscreen.convertToBlob()];
      const exportsMatch = (await Promise.all(blobs.map(decode))).every(pixels => same(pixels, expected));
      const unchanged = same(raw, Array.from(nativeCanvas.htmlGet.call(h, 0, 0, 64, 64).data)) && same(raw, Array.from(nativeCanvas.offscreenGet.call(o, 0, 0, 64, 64).data));
      const negativeReads = [h, o].every(x => same(Array.from(x.getImageData(64, 64, -64, -64).data), expected));
      const crop = h.getImageData(0, 0, 32, 32).data;
      const cropsMatch = Array.from(crop).every((v, i) => v === expected[(Math.floor(i / 128) * 64 + Math.floor(i % 128 / 4)) * 4 + i % 4]);
      const nativeError = async fn => { try { await fn(); return null; } catch (e) { return e.name; } };
      const zero = new OffscreenCanvas(0, 0);
      const associated = document.createElement('canvas').transferControlToOffscreen();
      const errors = {
        zero: [await nativeError(() => nativeCanvas.convert.call(zero)), await nativeError(() => zero.convertToBlob())],
        associated: [await nativeError(() => nativeCanvas.convert.call(associated)), await nativeError(() => associated.convertToBlob())],
        wrongReceiver: [await nativeError(() => nativeCanvas.convert.call({})), await nativeError(() => OffscreenCanvas.prototype.convertToBlob.call({}))],
      };
      const atCallTime = offscreen.convertToBlob(); o.fillStyle = '#ffffff'; o.fillRect(0, 0, 64, 64);
      return { methodsUnchanged: nativeCanvas.htmlGet === CanvasRenderingContext2D.prototype.getImageData && nativeCanvas.offscreenGet === OffscreenCanvasRenderingContext2D.prototype.getImageData && nativeCanvas.convert === OffscreenCanvas.prototype.convertToBlob,
        readsMatch: same(read(h), expected), offscreenReadsMatch, legacyReadHash,
        repeatedReads: same(read(h), expected), noiseApplied: !same(raw, expected), exportsMatch, unchanged, negativeReads, cropsMatch, errors,
        capturesAtCallTime: same(await decode(await atCallTime), expected) };
    });
    for (const key of ['readsMatch', 'offscreenReadsMatch', 'repeatedReads', 'exportsMatch', 'unchanged', 'negativeReads', 'cropsMatch', 'capturesAtCallTime']) assert.equal(result[key], true, `${key}: ${JSON.stringify(result)}`);
    assert.equal(result.noiseApplied, mode === 'legacy-seeded-v1');
    assert.equal(result.methodsUnchanged, mode === 'native');
    if (mode === 'legacy-seeded-v1') assert.equal(result.legacyReadHash, '6bf2d34da094f04218efa87eaae5fe5f26729445e55d8b50fe65b09834d26784');
    for (const [key, [native, patched]] of Object.entries(result.errors)) assert.equal(patched, native, key);
    await context.close();
  } finally { await browser.close(); }
});
