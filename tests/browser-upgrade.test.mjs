import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import snapshots from '../utils/profileSnapshots.js';
import { synchronizeBrowserRuntime } from '../worker/browser-upgrade.mjs';
import { passportValidation } from '../worker/passport-validation.mjs';
import { readRuntimeBrands } from '../worker/runtime-metadata.mjs';
import { createMobileContext, createMobilePage, mobileContextOptions, stageMobileProfile, loadMobileProfile, verifyRestoredSession } from '../worker/profiles.mjs';
import { closePersistentStartupPages } from '../worker/persistent-cache.mjs';
import { buildHttpClientHints, buildCdpUserAgentOverride } from '../worker/client-hints.mjs';
import journal from '../utils/warmupJournal.js';
import { appendTaskLiveEvent, flushLiveView } from '../worker/live-view.mjs';
import { resolve } from 'node:path';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimWarmup, finishClaim } from '../worker/pool-scheduler.mjs';

const make = version => fp.localPassport({ fingerprintMode: 'local' }, { seed: '0123456789abcdef0123456789abcdef', runtimeVersion: version });
const options = version => { const m = fp.chromeMetadata({ fullVersion: version, osVersion: '14.0.0', modelCode: 'control' }); return { runtimeVersion: version, nativeBrands: m.userAgentData.brands, nativeFullVersionList: m.userAgentData.fullVersionList }; };
export function legacySnapshot(profile, storageMode = 'snapshot') {
  const { snapshot: ignored, ...body } = profile;
  return { ...body, snapshot: { version: 1, id: randomUUID(), passportHash: snapshots.legacyPassportHash(body), contentHash: snapshots.snapshotHash(body), storageMode } };
}

test('version 4 identity is stable across patch/major browser changes, while version 3 remains exactly verifiable', () => {
  const p = make('134.0.6998.45'), original = JSON.stringify(p), id = randomUUID(), identity = fp.identityHash(id, p);
  const patch = synchronizeBrowserRuntime(id, p, options('134.0.6998.46')).passport;
  const next = synchronizeBrowserRuntime(id, patch, options('135.0.7012.10')).passport;
  assert.equal(identity, fp.identityHash(id, patch)); assert.equal(identity, fp.identityHash(id, next));
  assert.notEqual(fp.legacyIdentityHash(id, p), fp.legacyIdentityHash(id, next));
  assert.equal(fp.matchesIdentityHash(id, p, fp.legacyIdentityHash(id, p)), true);
  assert.equal(fp.matchesIdentityHash(id, p, identity), true);
  assert.notEqual(fp.identityHash('another-profile', p), identity);
  assert.equal(JSON.stringify(p), original);
  assert.equal(next.runtimeVersion, '135.0.7012.10'); assert.equal(next.browserUpgrades.length, 2);
  assert.equal(synchronizeBrowserRuntime(id, next, options('135.0.7012.10')).changed, false);
  assert.deepEqual(passportValidation(next, next.runtimeVersion).errors, []);
});

test('hardware, OS, locale, timezone, rendering policy and canvas seed stay in the identity', () => {
  const p = make('134.0.6998.45'), identity = fp.identityHash('constant', p);
  const changes = [q => q.fingerprint.navigator.userAgentData.model += '-other', q => q.fingerprint.navigator.userAgentData.platformVersion = '15.0.0',
    q => q.fingerprint.navigator.hardwareConcurrency++, q => q.fingerprint.navigator.deviceMemory = 2,
    q => q.fingerprint.navigator.userAgentData.bitness = '32', q => q.fingerprint.navigator.userAgentData.architecture = 'x86',
    q => q.fingerprint.screen.width++, q => q.fingerprint.screen.devicePixelRatio += .1,
    q => q.fingerprint.videoCard.renderer += '-different', q => q.fingerprint.fonts.push('Other'),
    q => q.fingerprint.canvas.mode = 'legacy-seeded-v1', q => q.canvasSeed++,
    q => q.fingerprint.navigator.language = 'en-US', q => q.headers['accept-language'] = 'en-US', q => q.timezone = 'UTC'];
  for (const mutate of changes) { const q = structuredClone(p); mutate(q); assert.notEqual(fp.identityHash('constant', q), identity, String(mutate)); }
});

test('immutable archived passports keep their exact legacy digest and are accepted without rewriting fixtures', async () => {
  for (const file of ['device-catalog-v1-passports.json', 'local-v5-passport.json', 'local-v6-pre-audit-passport.json']) {
    const source = await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
    for (const fixture of [JSON.parse(source)].flat()) {
      const id = fixture.profileId || 'saved-v5';
      assert.equal(fp.legacyIdentityHash(id, fixture.passport), fixture.identityHash, file);
      assert.equal(fp.matchesIdentityHash(id, fixture.passport, fixture.identityHash), true);
      assert.equal(passportValidation(fixture.passport).status, 'passed');
    }
    assert.equal(await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'), source);
  }
});

test('old snapshot integrity uses its original full hash; new snapshots explicitly use v4 and still cover browser/storage bytes', () => {
  const p = make('134.0.6998.45'), profile = { ...fp.profileFromPassport('snapshot', p), savedAt: new Date().toISOString() };
  const old = legacySnapshot(profile); assert.equal(snapshots.checkSnapshot(old), true);
  const next = snapshots.stampSnapshot(profile); assert.equal(next.snapshot.identityHashVersion, 4); assert.equal(snapshots.checkSnapshot(next), true);
  for (const value of [old, next]) {
    for (const alter of [v => v.headers['user-agent'] += ' tamper', v => v.origins.push({ origin: 'https://changed.test', localStorage: [] })]) {
      const bad = structuredClone(value); alter(bad); assert.equal(snapshots.checkSnapshot(bad), false);
    }
    assert.equal(snapshots.checkSnapshot({ ...value, snapshot: { ...value.snapshot, identityHashVersion: 99 } }), false);
  }
  const upgraded = synchronizeBrowserRuntime('snapshot', p, options('135.0.7012.10')).passport;
  const saved = snapshots.stampSnapshot({ ...profile, fingerprint: upgraded.fingerprint, headers: upgraded.headers });
  assert.equal(saved.snapshot.passportHash, next.snapshot.passportHash);
  assert.notEqual(saved.snapshot.contentHash, next.snapshot.contentHash);
  assert.equal(snapshots.checkSnapshot(saved), true);
});

test('runtime metadata uses native brand order and updates existing high entropy headers without changing device fields', () => {
  const p = make('134.0.6998.45'); p.headers['Sec-CH-UA-Full-Version'] = '"134.0.6998.45"';
  p.headers['Sec-CH-UA-Full-Version-List'] = 'old';
  const runtime = options('135.0.7012.10'); runtime.nativeBrands.reverse(); runtime.nativeFullVersionList.reverse();
  const next = synchronizeBrowserRuntime('headers', p, runtime).passport;
  assert.deepEqual(next.fingerprint.navigator.userAgentData.brands, runtime.nativeBrands);
  assert.equal(next.headers['Sec-CH-UA-Full-Version'], '"135.0.7012.10"');
  assert.equal(next.headers['Sec-CH-UA-Full-Version-List'], buildHttpClientHints(next, true)['Sec-CH-UA-Full-Version-List']);
  assert.equal(buildCdpUserAgentOverride(next).userAgentMetadata.fullVersion, runtime.runtimeVersion);
  assert.equal(fp.identityHash('headers', p), fp.identityHash('headers', next));
  for (const key of ['platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'language', 'languages']) assert.deepEqual(next.fingerprint.navigator[key], p.fingerprint.navigator[key]);
});

test('downgrades and missing native metadata fail; opaque legacy identities are not silently rewritten', () => {
  const p = make('135.0.7012.10');
  assert.throws(() => synchronizeBrowserRuntime('x', p, options('134.0.6998.45')), { code: 'browser_runtime_downgrade' });
  assert.throws(() => synchronizeBrowserRuntime('x', p, { runtimeVersion: '136.0.1.1' }), { code: 'browser_runtime_metadata_unavailable' });
  assert.throws(() => synchronizeBrowserRuntime('x', p, { runtimeVersion: 'invalid' }), { code: 'browser_runtime_version_invalid' });
  const legacy = structuredClone(p); delete legacy.fingerprint.navigator.userAgentData;
  const before = JSON.stringify(legacy); const result = synchronizeBrowserRuntime('legacy', legacy, options('136.0.1.1'));
  assert.equal(result.unsupported, true); assert.equal(JSON.stringify(result.passport), before);
});

test('live and warmup upgrade journals retain bounded version metadata and exclude credentials', async () => {
  const runId = randomUUID(), taskId = randomUUID(), directory = resolve('.orbit-runtime', 'live', runId);
  const details = { fromVersion: '134.0.6998.45', toVersion: '135.0.7012.10', password: 'private-test-credential' };
  try {
    assert.ok(journal.runtimeEvents.has('profile_browser_upgraded'));
    const warmup = journal.journalEntry({ profileId: 'test' }, 'profile_browser_upgraded', details);
    assert.deepEqual(warmup.details, { fromVersion: details.fromVersion, toVersion: details.toVersion });
    appendTaskLiveEvent(runId, taskId, 'profile_browser_upgraded', details); await flushLiveView(runId);
    const log = await readFile(join(directory, `${taskId}.jsonl`), 'utf8'), record = JSON.parse(log.trim());
    assert.equal(record.fromVersion, details.fromVersion); assert.equal(record.toVersion, details.toVersion);
    assert.ok(!log.includes('private-test-credential'));
    assert.deepEqual(journal.journalEntry({ profileId: 'test' }, 'profile_browser_upgraded', { fromVersion: 'untrusted://token', toVersion: 'text' }).details, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unavailable/downgraded engine does not consume the profile failure budget or erase its session binding', async () => {
  const f = await poolFixture();
  try {
    const passport = make('135.0.7012.10'), id = randomUUID(), warmedAt = new Date(Date.now() - 86400000), snapshotId = randomUUID();
    const fingerprintHash = fp.legacyIdentityHash(id, passport);
    await f.db.profile.create({ data: { id, name: 'Existing engine fixture', fingerprint: passport, fingerprintHash, snapshotId, warmedAt, status: 'ready' } });
    await f.db.warmupJob.create({ data: { profileId: id, status: 'queued', currentStage: 6 } });
    for (const errorCode of ['browser_qualification_failed', 'browser_runtime_downgrade', 'browser_runtime_metadata_unavailable', 'browser_runtime_changed']) {
      await f.db.warmupJob.update({ where: { profileId: id }, data: { status: 'queued', retryAfter: null } });
      const claim = await claimWarmup(f.db); assert.ok(claim);
      await finishClaim(f.db, claim, { errorCode });
      const job = await f.db.warmupJob.findUniqueOrThrow({ where: { profileId: id } });
      assert.equal(job.attempts, 0); assert.equal(job.status, 'retry_wait'); assert.ok(job.dependencyRetries > 0);
      const row = await f.db.profile.findUniqueOrThrow({ where: { id } });
      assert.equal(row.fingerprintHash, fingerprintHash); assert.deepEqual(row.fingerprint, passport);
      assert.equal(row.snapshotId, snapshotId); assert.equal(+row.warmedAt, +warmedAt); assert.notEqual(row.status, 'failed');
      assert.equal(await f.db.workflowLease.count({ where: { key: { startsWith: 'cooldown:' } } }), 0);
    }
  } finally { await f.cleanup(); }
});

for (const persistent of [false, true]) test(`old snapshot -> installed native browser preserves cookies, localStorage and IndexedDB (${persistent ? 'native directory' : 'snapshot'})`, { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-browser-upgrade-'));
  const launch = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH };
  let browser = await chromium.launch(launch), context;
  try {
    const runtimeVersion = browser.version(), native = await readRuntimeBrands(browser);
    const oldVersion = `${Number(runtimeVersion.split('.')[0]) - 1}.0.1.1`;
    const p = make(oldVersion), id = randomUUID(); let profile = fp.profileFromPassport(id, p);
    if (persistent) { await browser.close(); context = await chromium.launchPersistentContext(join(dir, 'native'), { ...launch, ...mobileContextOptions(profile) }); browser = context.browser(); await closePersistentStartupPages(context); await createMobileContext(browser, profile, undefined, context, false); }
    else context = await createMobileContext(browser, profile);
    const route = c => c.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await route(context); let page = await createMobilePage(context, profile); await page.goto('https://upgrade.invalid/');
    await context.addCookies([{ name: 'retained', value: 'old-session', domain: 'upgrade.invalid', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await page.evaluate(async () => { localStorage.setItem('existing', 'kept'); await new Promise((resolve, reject) => { const open = indexedDB.open('existing', 1); open.onupgradeneeded = () => open.result.createObjectStore('data'); open.onerror = () => reject(open.error); open.onsuccess = () => { const tx = open.result.transaction('data', 'readwrite'); tx.objectStore('data').put('kept', 'key'); tx.oncomplete = () => { open.result.close(); resolve(); }; }; }); });
    const staged = await stageMobileProfile(dir, profile, context, { storageMode: persistent ? 'persistent' : 'snapshot' });
    const old = legacySnapshot(staged.snapshot, persistent ? 'persistent' : 'snapshot');
    await staged.discard(); await writeFile(join(dir, `${id}.json`), JSON.stringify(old), { mode: 0o600 });
    await context.close(); await browser.close(); context = undefined;
    const loaded = await loadMobileProfile(dir, id); profile = loaded.profile;
    assert.equal(profile.snapshot.identityHashVersion, undefined); assert.equal(snapshots.checkSnapshot(loaded.savedSnapshot), true);
    const updated = synchronizeBrowserRuntime(id, p, { runtimeVersion, ...native }).passport;
    assert.equal(snapshots.passportHash(profile), fp.identityHash(id, updated));
    profile = { ...profile, fingerprint: updated.fingerprint, headers: updated.headers };
    if (persistent) { context = await chromium.launchPersistentContext(join(dir, 'native'), { ...launch, ...mobileContextOptions(profile) }); browser = context.browser(); await closePersistentStartupPages(context); await createMobileContext(browser, profile, undefined, context, false); }
    else { browser = await chromium.launch(launch); context = await createMobileContext(browser, profile); }
    await route(context);
    const report = await verifyRestoredSession(context, profile, { discoverOrigins: persistent });
    assert.equal(report.status, 'passed'); assert.equal(report.passportHash, old.snapshot.passportHash);
    page = await createMobilePage(context, profile); await page.goto('https://upgrade.invalid/');
    assert.equal(await page.evaluate(() => navigator.userAgentData.getHighEntropyValues(['uaFullVersion']).then(h => h.uaFullVersion)), runtimeVersion);
    assert.equal(await page.evaluate(() => localStorage.getItem('existing')), 'kept');
    assert.equal((await context.cookies()).find(c => c.name === 'retained').value, 'old-session');
    const next = await stageMobileProfile(dir, profile, context, { storageMode: persistent ? 'persistent' : 'snapshot' });
    assert.equal(next.snapshot.snapshot.identityHashVersion, 4); assert.equal(snapshots.checkSnapshot(next.snapshot), true);
    assert.deepEqual(next.snapshot.origins[0].indexedDB, old.origins[0].indexedDB);
    await next.discard();
    assert.equal(snapshots.checkSnapshot(loaded.savedSnapshot), true, 'old backup was never rewritten');
  } finally { await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
