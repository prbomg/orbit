import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import fp from '../utils/fingerprint.js';
import snapshots from '../utils/profileSnapshots.js';
import publication from '../utils/profilePublication.js';
import { preparePersistentProfile } from '../worker/persistent-profile.mjs';
import { persistentLaunchOptions } from '../worker/persistent-cache.mjs';
import { createMobileContext, mobileContextOptions, stageMobileProfile, loadMobileProfile } from '../worker/profiles.mjs';
import { verifySessionAfterRestart } from '../worker/session-restart-check.mjs';
import { recoverProfileSaves } from '../worker/profile-publication.mjs';

const launch = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH };
const readState = page => page.evaluate(async () => ({ local: localStorage.getItem('continuity'),
  idb: await new Promise((resolve, reject) => {
    const q = indexedDB.open('continuity-db', 1); q.onerror = reject;
    q.onsuccess = () => { const db = q.result, request = db.transaction('items').objectStore('items').get('key');
      request.onerror = reject; request.onsuccess = () => { db.close(); resolve(request.result); }; };
  }) }));

test('snapshot seeds a fresh native directory once, survives restart and commits with the reset flag', { timeout: 90000 }, async () => {
  const f = await poolFixture();
  const server = createServer((_, response) => response.end('<!doctype html><body>Owned migration fixture</body>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, context, run, staged;
  try {
    const warmedAt = new Date(Date.now() - 5 * 86400000);
    const row = await f.db.profile.create({ data: { name: 'Snapshot migration', storageMode: 'persistent', storageResetRequested: true, warmedAt, status: 'needs_check' } });
    browser = await chromium.launch(launch);
    const passport = fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: browser.version() });
    let profile = fp.profileFromPassport(row.id, passport);
    context = await createMobileContext(browser, profile);
    await context.addCookies([
      { name: 'yandexuid', value: 'synthetic-durable', url: origin, expires: Date.now() / 1000 + 3600 },
      { name: 'session', value: 'synthetic-session', url: origin },
    ]);
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async () => {
      localStorage.setItem('continuity', 'retained');
      await new Promise((resolve, reject) => {
        const q = indexedDB.open('continuity-db', 1); q.onerror = reject;
        q.onupgradeneeded = () => q.result.createObjectStore('items');
        q.onsuccess = () => { const db = q.result, tx = db.transaction('items', 'readwrite'); tx.objectStore('items').put('retained-idb', 'key');
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; };
      });
    });
    staged = await stageMobileProfile(f.dir, profile, context); await staged.publish(); staged = null;
    await context.close(); context = null; await browser.close(); browser = null;
    const file = join(f.dir, `${row.id}.json`);
    const source = JSON.parse(await readFile(file, 'utf8'));
    source.cookies.push({ ...source.cookies[0], name: 'expired', expires: Date.now() / 1000 - 60 });
    const snapshot = snapshots.stampSnapshot(source, 'snapshot', 6);
    await writeFile(file, JSON.stringify(snapshot));
    const identityHash = fp.identityHash(row.id, passport);
    await f.db.profile.update({ where: { id: row.id }, data: { snapshotId: snapshot.snapshot.id, fingerprint: passport, fingerprintHash: identityHash } });
    const loaded = await loadMobileProfile(f.dir, row.id); profile = loaded.profile;
    assert.deepEqual(loaded.savedSnapshot, snapshot);
    // A stale directory from an earlier mode must not contaminate the seed.
    run = await preparePersistentProfile(f.dir, row.id);
    await writeFile(join(run.path, 'stale-native-data'), 'unrelated');
    await run.publish('stale', 'stale-id'); run = null;
    run = await preparePersistentProfile(f.dir, row.id, { seedProfile: loaded.savedSnapshot, expectedSnapshotId: snapshot.snapshot.id });
    assert.equal(run.initialized, false);
    await assert.rejects(access(join(run.path, 'stale-native-data')), { code: 'ENOENT' });
    await assert.rejects(run.seal('not-verified', 'not-verified'), e => e.code === 'profile_storage_seed_required');
    context = await chromium.launchPersistentContext(run.path, { ...persistentLaunchOptions(launch), ...mobileContextOptions(profile) });
    let imports = 0; const setState = context.setStorageState.bind(context);
    context.setStorageState = async state => { imports++; return setState(state); };
    const seeded = await run.seed(context); assert.equal(seeded.status, 'passed');
    await run.seed(context); assert.equal(imports, 1);
    await createMobileContext(context.browser(), profile, undefined, context, false);
    let probe = await context.newPage(); await probe.goto(origin);
    assert.deepEqual(await readState(probe), { local: 'retained', idb: 'retained-idb' });
    const cookies = await context.cookies(origin);
    assert.ok(cookies.some(c => c.name === 'yandexuid' && c.value === 'synthetic-durable'));
    assert.ok(cookies.some(c => c.name === 'session' && c.value === 'synthetic-session'));
    assert.ok(!cookies.some(c => c.name === 'expired'));
    await probe.evaluate(() => localStorage.setItem('continuity', 'native-update'));
    staged = await stageMobileProfile(f.dir, profile, context, { storageMode: 'persistent' });
    await context.close(); context = null;
    const restart = await verifySessionAfterRestart(staged, { launchOptions: launch, persistentPath: run.path }).catch(error => { assert.fail(JSON.stringify(error.diagnostics)); });
    assert.equal(restart.status, 'passed');
    await run.seal(staged.snapshot.savedAt, staged.snapshot.snapshot.id);
    await f.db.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      await publication.publishProfileFiles({ directory: f.dir, profileId: row.id, stagedPath: staged.temporary,
        persistentPath: run.path, previousSnapshotId: snapshot.snapshot.id, nextSnapshotId: staged.snapshot.snapshot.id });
      await tx.profile.update({ where: { id: row.id }, data: { snapshotId: staged.snapshot.snapshot.id, storageResetRequested: false } });
    });
    await recoverProfileSaves(f.db, f.dir, { profileId: row.id });
    const after = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.storageResetRequested, false); assert.equal(+after.warmedAt, +warmedAt); assert.equal(after.fingerprintHash, identityHash);
    assert.equal(after.snapshotId, staged.snapshot.snapshot.id);
    await run.discard(); run = null; await staged.discard(); staged = null;
    const next = await loadMobileProfile(f.dir, row.id); profile = next.profile;
    assert.equal(profile.snapshot.storageMode, 'persistent');
    run = await preparePersistentProfile(f.dir, row.id, { expectedSnapshotId: after.snapshotId });
    assert.equal(run.seedSnapshotId, null);
    const marker = JSON.parse(await readFile(join(run.path, '.orbit-seeded-from-snapshot.json'), 'utf8'));
    assert.equal(marker.sourceSnapshotId, snapshot.snapshot.id);
    context = await chromium.launchPersistentContext(run.path, { ...persistentLaunchOptions(launch), ...mobileContextOptions(profile) });
    context.setStorageState = () => { throw Error('A native restart must not re-import JSON'); };
    await createMobileContext(context.browser(), profile, undefined, context, false);
    probe = await context.newPage(); await probe.goto(origin);
    assert.deepEqual(await readState(probe), { local: 'native-update', idb: 'retained-idb' });
    assert.ok((await context.cookies(origin)).some(c => c.name === 'yandexuid'));
  } finally {
    await context?.close(); await browser?.close(); await run?.discard(); await staged?.discard();
    await new Promise(resolve => server.close(resolve)); await f.cleanup();
  }
});

test('invalid, mismatched and failed seeds leave the published profile and reset flag intact', async () => {
  const f = await poolFixture(); let run;
  try {
    const row = await f.db.profile.create({ data: { name: 'Failed migration', storageMode: 'persistent', storageResetRequested: true } });
    const profile = fp.profileFromPassport(row.id, fp.localPassport()); profile.savedAt = new Date().toISOString();
    const source = snapshots.stampSnapshot(profile, 'snapshot');
    await writeFile(join(f.dir, `${row.id}.json`), JSON.stringify(source));
    await f.db.profile.update({ where: { id: row.id }, data: { snapshotId: source.snapshot.id } });
    const old = await preparePersistentProfile(f.dir, row.id);
    await writeFile(join(old.path, 'keep'), 'old-native'); await old.publish('old', 'old-id');
    await assert.rejects(preparePersistentProfile(f.dir, row.id, { seedProfile: { ...source, savedAt: new Date(0).toISOString() } }), e => e.code === 'profile_snapshot_mismatch');
    await assert.rejects(preparePersistentProfile(f.dir, row.id, { seedProfile: source, expectedSnapshotId: 'wrong-id' }), e => e.code === 'profile_snapshot_mismatch');
    run = await preparePersistentProfile(f.dir, row.id, { seedProfile: source, expectedSnapshotId: source.snapshot.id });
    await assert.rejects(run.seed({ setStorageState: async () => { throw Error('simulated import failure'); } }), /simulated import failure/);
    await assert.rejects(run.seal('failed', 'failed'), e => e.code === 'profile_storage_seed_required');
    await run.discard(); run = null;
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, `${row.id}.json`), 'utf8')), source);
    assert.equal(await readFile(join(f.dir, 'browser-data', row.id, 'current', 'keep'), 'utf8'), 'old-native');
    const after = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.storageResetRequested, true); assert.equal(after.snapshotId, source.snapshot.id);
    // A subsequent attempt can retry from the same intact source snapshot.
    run = await preparePersistentProfile(f.dir, row.id, { seedProfile: source });
    assert.equal(run.seedSnapshotId, source.snapshot.id);
  } finally { await run?.discard(); await f.cleanup(); }
});
