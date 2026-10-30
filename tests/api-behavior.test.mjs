import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { compareApiBehavior } from '../worker/api-behavior.mjs';
import { readNativeBaseline, inspectNativeCpuOverride } from '../worker/native-baseline.mjs';
import { inspectContextMatrix } from '../worker/context-matrix.mjs';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';

const launch = () => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });

test('comparison distinguishes missing measurement from matching or changed semantics', () => {
  const original = { properties: { cpu: { supported: true, descriptor: { configurable: true }, functions: { getter: { source: 'native', invalidReceiver: { status: 'threw', name: 'TypeError' } } } } }, fonts: { supported: false } };
  assert.equal(compareApiBehavior(original, structuredClone(original)).status, 'matched');
  assert.equal(compareApiBehavior(original, null).status, 'incomplete');
  assert.equal(compareApiBehavior({ ...original, errors: [{ field: 'cpu', code: 'api_behavior_probe_failed' }] }, original).status, 'incomplete');
  const modified = structuredClone(original);
  modified.properties.cpu.functions.getter.source = 'get() { return 8; }';
  modified.properties.cpu.functions.getter.invalidReceiver.status = 'returned';
  modified.properties.cpu.descriptor.configurable = false;
  const result = compareApiBehavior(modified, original);
  assert.equal(result.status, 'differences');
  assert.deepEqual(result.differences.map(d => d.field), ['properties.cpu.descriptor.configurable', 'properties.cpu.functions.getter.source', 'properties.cpu.functions.getter.invalidReceiver.status']);
});

test('unmodified browser matches an independent baseline in all six contexts', { timeout: 30000 }, async () => {
  const browser = await launch();
  try {
    const baseline = await readNativeBaseline(browser);
    assert.equal(baseline.status, 'passed');
    assert.equal(baseline.records.length, 6);
    assert.equal(await readNativeBaseline(browser), baseline, 'cache must belong to this live browser');
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 360, height: 780 }, serviceWorkers: 'allow' });
    try {
      const current = await inspectContextMatrix(await context.newPage(), null, { native: true });
      for (const row of current.records) {
        assert.equal(row.status, 'passed');
        const previous = baseline.records.find(r => r.scene === row.scene);
        const comparison = compareApiBehavior(row.observed.apiBehavior, previous.observed.apiBehavior);
        assert.equal(comparison.status, 'matched', JSON.stringify({ scene: row.scene, differences: comparison.differences }));
        const properties = row.observed.apiBehavior.properties;
        assert.equal(properties['navigator.hardwareConcurrency'].supported, true);
        assert.equal(properties['Offscreen.convertToBlob'].functions.value.invalidReceiver.status, 'threw');
        if (row.scene.includes('Worker')) {
          assert.equal(properties['navigator.pdfViewerEnabled'].supported, false);
          assert.equal(properties['Element.getClientRects'].supported, false);
        }
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test('equal passport values do not conceal function differences; async failures remain contained', { timeout: 30000 }, async () => {
  const browser = await launch();
  try {
    const baseline = await readNativeBaseline(browser);
    const passport = fp.localPassport({ fingerprintMode: 'local', fingerprintDevicePreset: 's23_android14' }, { seed: '1234567890abcdef1234567890abcdef', runtimeVersion: browser.version() });
    const profile = fp.profileFromPassport('behavior-control', passport);
    // Deliberately choose a different CPU only for this synthetic control; the
    // test must also detect a necessary wrapper on hosts with eight CPUs.
    const hostCpu = baseline.records.find(r => r.scene === 'dedicatedWorker').observed.navigator.hardwareConcurrency;
    profile.fingerprint.navigator.hardwareConcurrency = hostCpu === 8 ? 7 : 8;
    const before = JSON.stringify(profile);
    const context = await createMobileContext(browser, profile);
    try {
      const report = await inspectContextMatrix(await createMobilePage(context, profile), profile, { baseline });
      assert.equal(report.status, 'passed', JSON.stringify(report.summary));
      assert.equal(report.apiBehavior.status, 'differences');
      assert.equal(report.apiBehavior.errors, 0);
      assert.ok(report.apiBehavior.differences > 0);
      for (const scene of ['dedicatedWorker', 'sharedWorker', 'serviceWorker']) {
        const row = report.records.find(r => r.scene === scene);
        assert.equal(row.observed.apiBehavior.properties['navigator.hardwareConcurrency'].functions.getter.source,
          baseline.records.find(r => r.scene === scene).observed.apiBehavior.properties['navigator.hardwareConcurrency'].functions.getter.source, scene);
        const getter = row.observed.apiBehavior.properties['navigator.hardwareConcurrency'].functions.getter;
        assert.equal(getter.invalidReceiver.name, 'TypeError', 'preserved receiver validation must be measured independently of source');
        for (const key of ['language', 'languages']) {
          assert.equal(row.observed.apiBehavior.properties[`navigator.${key}`].functions.getter.source,
            baseline.records.find(r => r.scene === scene).observed.apiBehavior.properties[`navigator.${key}`].functions.getter.source,
            `CDP-aligned ${key} must keep its original getter in ${scene}`);
        }
        assert.equal(row.observed.apiBehavior.properties['Offscreen.convertToBlob'].functions.value.invalidReceiver.status, 'threw');
      }
      assert.equal(JSON.stringify(profile), before);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test('baseline failures are explicit and retried rather than cached as a successful comparison', async () => {
  let attempts = 0;
  const browser = { newContext() { attempts++; throw Error('sensitive-transport-detail'); } };
  for (let i = 0; i < 2; i++) {
    const result = await readNativeBaseline(browser);
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('sensitive-transport-detail'));
  }
  assert.equal(attempts, 2);
});

test('partial descriptor probe errors invalidate the baseline without exposing transport details', { timeout: 15000 }, async () => {
  const browser = await launch();
  let attempts = 0;
  const scopedBrowser = { version: () => browser.version(), async newContext(options) {
    attempts++;
    const context = await browser.newContext(options);
    await context.addInitScript(() => {
      Function.prototype.toString = function () { throw Error('sensitive-probe-detail'); };
    });
    return context;
  } };
  try {
    for (let i = 0; i < 2; i++) {
      const result = await readNativeBaseline(scopedBrowser);
      assert.equal(result.status, 'failed');
      assert.ok(result.apiBehavior.errors > 0);
      assert.ok(!JSON.stringify(result).includes('sensitive-probe-detail'));
      const main = result.records.find(r => r.scene === 'main');
      assert.ok(main.observed.apiBehavior.errors.length > 0);
      assert.equal(main.observed.navigator.hardwareConcurrency > 0, true);
    }
    assert.equal(attempts, 2);
  } finally { await browser.close(); }
});

test('CDP CPU trial records child-context propagation without changing any profile', { timeout: 15000 }, async () => {
  const browser = await launch();
  try {
    const result = await inspectNativeCpuOverride(browser);
    assert.equal(result.status, 'measured');
    assert.equal(result.observed.main, result.requested);
    assert.equal(result.safeToReplaceAllCpuWrappers, false);
    assert.ok(['override_does_not_cover_tested_contexts', 'shared_and_service_workers_not_qualified'].includes(result.reason));
    // No emulation may escape the isolated context after the capability trial.
    const context = await browser.newContext();
    try { assert.equal(await (await context.newPage()).evaluate(() => navigator.hardwareConcurrency), result.before); }
    finally { await context.close(); }
  } finally { await browser.close(); }
});
