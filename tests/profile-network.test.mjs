import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';
import { inspectFirstDocuments } from '../worker/first-document.mjs';

for (const failure of ['none', 'navigation', 'popup']) test(`profile diagnostics release routing and retain native HTTP cache (${failure})`, { timeout: 30000 }, async () => {
  let assetRequests = 0, documentRequests = 0, browser;
  const server = createServer((req, res) => {
    if (req.url === '/asset.js') {
      assetRequests++;
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=3600' });
      res.end('window.assetLoaded=true;');
    } else {
      if (req.url === '/cached-document') documentRequests++;
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': req.url === '/cached-document' ? 'public, max-age=3600' : 'no-store' });
      res.end('<!doctype html><script src="/asset.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const profile = fp.profileFromPassport('cache-probe', fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: browser.version() }));
    const context = await createMobileContext(browser, profile);
    try {
      const page = await createMobilePage(context, profile);
      if (failure !== 'none') {
        const goto = page.goto, evaluate = page.evaluate;
        if (failure === 'navigation') page.goto = async () => { throw new Error('controlled_probe_failure'); };
        else page.evaluate = async (fn, ...args) => {
          if (String(fn).includes('window.open')) throw new Error('controlled_probe_failure');
          return evaluate.call(page, fn, ...args);
        };
        try { await assert.rejects(inspectFirstDocuments(page, profile), /controlled_probe_failure/); }
        finally { page.goto = goto; page.evaluate = evaluate; }
      } else {
        const report = await inspectFingerprint(page, profile, undefined, browser.version());
        assert.equal(report.status, 'passed');
        assert.equal(report.firstDocuments.records.find(record => record.scene === 'popup').status, 'passed');
      }
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const path of ['/first', '/cached-document', '/second', '/cached-document']) {
        await page.goto(origin + path);
        assert.equal(await page.evaluate(() => window.assetLoaded), true);
      }
      assert.equal(documentRequests, 1, 'document HTTP caching stays enabled');
      assert.equal(assetRequests, 1, 'an unrelated diagnostic route must not leave HTTP caching disabled');
    } finally { await context.close(); }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('restored-session discovery passes origins only to its storage request and never installs scripts', async () => {
  const { verifyRestoredSession } = await import('../worker/profiles.mjs');
  const { mobileProfileFixture } = await import('./helpers/mobile-profile-fixture.mjs');
  const profile = mobileProfileFixture('origin-request-fixture');
  profile.savedAt = new Date().toISOString();
  profile.origins = [{ origin: 'https://fixture.test', localStorage: [{ name: 'fixture', value: 'saved' }] }];
  const options = [];
  const context = {
    addInitScript: async () => assert.fail('origin discovery must never install an init script'),
    storageState: async value => { options.push(value); return { cookies: [], origins: profile.origins }; },
  };
  assert.equal((await verifyRestoredSession(context, profile, { discoverOrigins: true })).status, 'passed');
  assert.equal((await verifyRestoredSession(context, profile)).status, 'passed');
  assert.deepEqual(options, [{ indexedDB: true, orbitOrigins: ['https://fixture.test'] }, { indexedDB: true }]);
  context.storageState = async () => { throw Error('controlled_storage_failure'); };
  await assert.rejects(verifyRestoredSession(context, profile, { discoverOrigins: true }), { code: 'profile_session_verification_failed' });
  context.storageState = async value => { assert.deepEqual(value, { indexedDB: true }); return { cookies: [], origins: profile.origins }; };
  assert.equal((await verifyRestoredSession(context, profile)).status, 'passed');
});
