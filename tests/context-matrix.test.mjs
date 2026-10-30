import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { compareContext, inspectContextMatrix } from '../worker/context-matrix.mjs';
import { inspectFingerprint, verifyFingerprint } from '../worker/fingerprint-check.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';

const launch = options => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH, ...options });
const makeProfile = (id, browser) => fp.profileFromPassport(id, fp.localPassport({ fingerprintDevicePreset: 's23_android14' }, { seed: '1234567890abcdef1234567890abcdef', runtimeVersion: browser.version() }));

test('matrix compares identity and GPU fields; unavailable Worker APIs are explicitly unsupported', () => {
  const profile = makeProfile('unit', { version: () => '154.0.0.0' });
  const nav = structuredClone(profile.fingerprint.navigator);
  const hints = nav.userAgentData;
  const gpu = { ...profile.fingerprint.videoCard, limits: profile.fingerprint.webglLimits };
  const observed = { navigator: nav, clientHints: hints, timezone: 'Europe/Moscow',
    capabilities: Object.fromEntries([...Object.keys(nav), 'clientHints'].map(key => [key, true])),
    offscreen: { canvasHash: 'same', webgl: gpu, webgl2: structuredClone(gpu) } };
  const main = { documentCanvas: { canvasHash: 'same' } };
  assert.equal(compareContext('dedicatedWorker', observed, profile, main).status, 'passed');
  const mismatch = structuredClone(observed);
  mismatch.navigator.hardwareConcurrency = 2;
  mismatch.clientHints.model = 'other';
  mismatch.offscreen.webgl.limits.maxTextureSize = 1024;
  const failed = compareContext('dedicatedWorker', mismatch, profile, main);
  assert.deepEqual(failed.checks.filter(c => c.status === 'failed').map(c => c.field), ['navigator.hardwareConcurrency', 'clientHints.model', 'offscreen.webgl.limits.maxTextureSize']);
  const unsupported = { navigator: nav, timezone: 'Europe/Moscow', capabilities: { ...observed.capabilities, clientHints: false, deviceMemory: false } };
  delete unsupported.navigator.deviceMemory;
  const result = compareContext('serviceWorker', unsupported, profile, main);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.find(c => c.field === 'navigator.deviceMemory').status, 'unsupported');
  assert.equal(result.checks.find(c => c.field === 'clientHints.model').status, 'unsupported');
});

test('offline matrix matches all six realms and both canvas APIs, and cleans up on repeated runs', { timeout: 60000 }, async () => {
  // A dead upstream proves diagnostic documents and initial SW scripts never
  // need DNS or a working proxy. All owned fixture requests must be fulfilled.
  const browser = await launch({ proxy: { server: 'http://127.0.0.1:1' } });
  try {
    const profile = makeProfile('browser', browser), before = JSON.stringify(profile);
    const context = await createMobileContext(browser, profile);
    try {
      const page = await createMobilePage(context, profile);
      const failedRequests = [];
      context.on('requestfailed', request => failedRequests.push(request.url()));
      for (let repeat = 0; repeat < 2; repeat++) {
        const report = await inspectContextMatrix(page, profile);
        assert.deepEqual(report.records.map(r => r.scene), ['main', 'iframe', 'crossOriginIframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker']);
        assert.equal(report.summary.errors, 0, JSON.stringify(report));
        assert.equal(report.status, 'passed', JSON.stringify(report));
        assert.equal(report.summary.mismatches, 0);
        for (const row of report.records) {
          for (const api of ['webgl', 'webgl2']) {
            const gpu = row.observed.offscreen[api];
            assert.ok(gpu.limits.maxVertexUniformVectors > 0);
            assert.equal(typeof gpu.shaderPrecision.FRAGMENT_SHADER.HIGH_FLOAT.precision, 'number');
            assert.equal(row.checks.find(c => c.field === `offscreen.${api}.shaderPrecisionMatchesMain`).status, 'passed');
            assert.equal(row.checks.find(c => c.field === `offscreen.${api}.runtimeLimits.maxVertexUniformVectors`).status, 'passed');
          }
        }
        for (const scene of ['main', 'iframe', 'crossOriginIframe']) {
          const row = report.records.find(r => r.scene === scene);
          assert.ok(row.checks.filter(c => c.field.startsWith('navigator.') || c.field.startsWith('clientHints.')).every(c => c.status === 'passed'), JSON.stringify(row));
          assert.equal(row.checks.find(c => c.field === 'offscreen.canvasMatchesMain').status, 'passed');
        }
        for (const scene of ['dedicatedWorker', 'sharedWorker', 'serviceWorker']) assert.ok(report.records.find(r => r.scene === scene).checks.every(c => c.status !== 'failed'));
        assert.equal(page.url(), 'about:blank');
        const cleanupUrl = 'https://orbit-context.invalid/check-cleanup';
        const cleanupHandler = route => route.fulfill({ contentType: 'text/html', body: '<body>cleanup check</body>' });
        await context.route(cleanupUrl, cleanupHandler);
        try {
          await page.goto(cleanupUrl);
          assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
        } finally { await context.unroute(cleanupUrl, cleanupHandler); }
        // Another inspection can run in the same context without a stale route,
        // SharedWorker name or registration taking over its fixture document.
        const urls = report.records.map(r => r.observed?.navigator?.userAgent).filter(Boolean);
        assert.equal(urls.length, 6);
      }
      assert.deepEqual(failedRequests, []);
      assert.equal(JSON.stringify(profile), before);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test('qualification persists matrix findings and warnings without silently changing admission policy', { timeout: 60000 }, async () => {
  const f = await poolFixture(), browser = await launch();
  try {
    const row = await f.db.profile.create({ data: { name: 'Context matrix' } });
    const profile = makeProfile(row.id, browser), context = await createMobileContext(browser, profile);
    try {
      const page = await createMobilePage(context, profile);
      const result = await verifyFingerprint({ prisma: f.db, page, profile, runtimeVersion: browser.version() });
      assert.equal(result.version, 5);
      assert.equal(result.graphics.canvasMode, 'native');
      assert.equal(result.graphics.webglLimitsSource, 'catalog-emulation');
      assert.equal(result.graphics.deviceDumpVerified, false);
      assert.ok(result.observed.gpuLimits.maxVertexUniformVectors > 0);
      assert.equal(typeof result.observed.shaderPrecision.webgl.FRAGMENT_SHADER.HIGH_FLOAT.precision, 'number');
      assert.equal(result.status, 'passed');
      assert.equal(result.contextMatrix.status, 'passed');
      assert.equal(result.contextMatrix.enforcement, 'diagnostic');
      assert.ok(!result.warnings.some(w => w.includes('Матрица контекстов')));
      const measurement = await f.db.fingerprintMeasurement.findFirst({ where: { profileId: row.id } });
      const saved = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
      assert.deepEqual(measurement.report.contextMatrix, result.contextMatrix);
      assert.deepEqual(saved.fingerprintCheck.contextMatrix, result.contextMatrix);
      assert.equal(saved.fingerprintState, 'verified');
      const second = await inspectFingerprint(page, profile, result, browser.version());
      assert.equal(second.checks.canvasStable, true);
      assert.equal(second.checks.audioStable, true);
    } finally { await context.close(); }
  } finally { await browser.close(); await f.cleanup(); }
});

test('a failed Worker probe is recorded safely while the remaining matrix still runs', { timeout: 30000 }, async () => {
  const browser = await launch();
  try {
    const profile = makeProfile('probe-error', browser), context = await createMobileContext(browser, profile);
    try {
      await context.addInitScript(() => {
        globalThis.SharedWorker = class { constructor() { throw Error('sensitive-transport-detail'); } };
      });
      const report = await inspectContextMatrix(await createMobilePage(context, profile), profile);
      assert.equal(report.summary.contexts, 6);
      assert.equal(report.summary.errors, 1);
      assert.equal(report.records.find(r => r.scene === 'sharedWorker').status, 'error');
      assert.ok(report.records.find(r => r.scene === 'serviceWorker').observed);
      assert.ok(!JSON.stringify(report).includes('sensitive-transport-detail'));
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test('a Worker that never responds times out and does not prevent ServiceWorker measurement', { timeout: 30000 }, async () => {
  const browser = await launch();
  try {
    const profile = makeProfile('probe-timeout', browser), context = await createMobileContext(browser, profile);
    try {
      await context.addInitScript(() => {
        globalThis.SharedWorker = class { constructor() { this.port = { start() {}, close() {} }; } };
      });
      const report = await inspectContextMatrix(await createMobilePage(context, profile), profile, { timeoutMs: 1500 });
      assert.equal(report.summary.contexts, 6);
      assert.equal(report.summary.errors, 1);
      assert.equal(report.records.find(r => r.scene === 'sharedWorker').error, 'context_probe_failed_or_timed_out');
      assert.ok(report.records.find(r => r.scene === 'serviceWorker').observed);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
