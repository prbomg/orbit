import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectContextMatrix } from '../worker/context-matrix.mjs';

test('different profile seeds preserve native Canvas pixels across all six realms on the same runtime', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const plain = await browser.newContext();
    let expected;
    try {
      const page = await plain.newPage();
      await plain.route('https://orbit-native-canvas.invalid/', route => route.fulfill({ contentType: 'text/html', body: '<body>Native reference</body>' }));
      await page.goto('https://orbit-native-canvas.invalid/');
      expected = await page.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 64, 64);
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, 64, 64).data)), b => b.toString(16).padStart(2, '0')).join('');
      });
    } finally { await plain.close(); }
    const identities = [];
    for (const seed of ['1234567890abcdef1234567890abcdef', 'abcdef0123456789abcdef0123456789']) {
      const passport = fp.localPassport({ fingerprintMode: 'local' }, { seed, templateId: 'redmi_note13_4g_android14', runtimeVersion: browser.version() });
      identities.push(fp.identityHash('same-profile-id', passport));
      const profile = fp.profileFromPassport(`cohort-${seed.slice(0, 4)}`, passport);
      const context = await createMobileContext(browser, profile);
      try {
        const report = await inspectContextMatrix(await createMobilePage(context, profile), profile);
        assert.equal(report.status, 'passed', JSON.stringify(report));
        assert.equal(report.records.length, 6);
        for (const row of report.records) {
          assert.equal(row.observed.offscreen.canvasHash, expected, row.scene);
          if (row.observed.documentCanvas) assert.equal(row.observed.documentCanvas.canvasHash, expected, row.scene);
        }
      } finally { await context.close(); }
    }
    assert.notEqual(identities[0], identities[1], 'Independent identities must not be merged when their Canvas pixels match');
  } finally { await browser.close(); }
});
