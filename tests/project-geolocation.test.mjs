import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import regions from '../utils/yandexRegions.json' with { type: 'json' };
import geo from '../utils/projectGeolocation.js';
import fp from '../utils/fingerprint.js';
import snapshots from '../utils/profileSnapshots.js';
import { reserveProjectLocation, applyProjectGeolocation } from '../worker/project-geolocation.mjs';
import { createMobileContext, mobileContextOptions, stageMobileProfile, loadMobileProfile } from '../worker/profiles.mjs';
import { passportValidation } from '../worker/passport-validation.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { startMotionEmulation } from '../worker/motion-emulation.mjs';

const project = { id: 'geo-project', yandexRegionId: '213', targetUrl: 'https://project.example/' };
const passport = () => fp.localPassport({ fingerprintMode: 'local' });
const launch = () => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
const coordinates = page => page.evaluate(() => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
  position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
  error => reject(Error(`${error.code}: ${error.message}`)), { timeout: 5000, maximumAge: 0 })));

test('catalog distinguishes all city circles from unsupported territories without changing IDs', () => {
  assert.equal(regions.regions.length, 281);
  assert.equal(new Set(regions.regions.map(r => r.id)).size, 281);
  assert.equal(regions.regions.filter(r => r.geolocation).length, 60);
  for (const region of regions.regions) if (region.geolocation) {
    const area = geo.locationArea({ ...project, yandexRegionId: region.id });
    assert.ok(area.latitude > 40 && area.latitude < 75);
    assert.match(area.source, /^https:\/\/www.geonames.org\/\d+\/$/);
  }
  for (const id of ['1', '225', '10054', '168', '999999']) {
    assert.equal(geo.locationArea({ ...project, yandexRegionId: id }), null);
    assert.equal(geo.createProjectLocation({ ...project, yandexRegionId: id }), null);
  }
  assert.ok(Math.abs(geo.locationArea(project).latitude - 55.75) < .05);
  assert.ok(Math.abs(geo.locationArea({ ...project, yandexRegionId: '15' }).latitude - 54.2) < .05);
});

test('1000 samples are valid and distributed over circle area with accuracy 14–38 m', () => {
  const area = geo.locationArea(project), accuracy = new Set(); let squaredRadius = 0;
  for (let i = 0; i < 1000; i++) {
    const point = geo.createProjectLocation(project);
    assert.equal(geo.validProjectLocation(point, project), true);
    accuracy.add(point.accuracy);
    const x = (point.longitude - area.longitude) * Math.cos(area.latitude * Math.PI / 180) * 111.195;
    const y = (point.latitude - area.latitude) * 111.195;
    const r2 = (x * x + y * y) / area.radiusKm ** 2;
    assert.ok(r2 <= 1.001); squaredRadius += r2;
  }
  assert.equal(accuracy.size, 25);
  assert.ok(squaredRadius / 1000 > .45 && squaredRadius / 1000 < .55);
});

test('manual zero radius and antimeridian are supported; invalid configuration fails closed', () => {
  const manual = { ...project, geolocation: { mode: 'manual', latitude: 50, longitude: 180, radiusKm: 0 } };
  const point = geo.createProjectLocation(manual);
  assert.ok(Math.abs(point.latitude - 50) < 1e-10); assert.equal(Math.abs(point.longitude), 180);
  assert.equal(geo.validProjectLocation(point, manual), true);
  assert.equal(geo.validProjectLocation({ ...point, latitude: 51 }, manual), false);
  assert.equal(geo.createProjectLocation({ ...project, geolocation: { mode: 'off' } }), null);
  for (const config of [{ mode: 'other' }, { ...manual.geolocation, latitude: NaN }, { ...manual.geolocation, radiusKm: 51 }]) {
    assert.throws(() => geo.createProjectLocation({ ...project, geolocation: config }), /invalid_project_geolocation/);
  }
  assert.throws(() => geo.createProjectLocation(project, { random: () => 1 }), /invalid_location_random/);
});

test('execution binding is stable within an attempt, independent of passport history, and fails closed when stale', async () => {
  const f = await poolFixture();
  try {
    const p = passport(); p.projectLocations = { [f.project.id]: geo.createProjectLocation(f.project) };
    const hash = fp.identityHash('profile-geo', p);
    await f.db.profile.create({ data: { id: 'profile-geo', name: 'Geo', fingerprint: p, fingerprintHash: hash, readinessVersion: 1 } });
    const task = await f.task();
    const execution = await f.db.taskExecution.create({ data: { taskId: task.id, profileId: 'profile-geo', status: 'running', attempts: 1 } });
    const first = await f.db.$transaction(async tx => {
      const point = await reserveProjectLocation(tx, f.project, 'profile-geo', execution);
      await tx.projectProfileUse.create({ data: { projectId: f.project.id, profileId: 'profile-geo', taskId: task.id, geolocation: point } });
      return point;
    });
    assert.notDeepEqual(first, p.projectLocations[f.project.id]);
    assert.equal(first.executionId, execution.id); assert.equal(first.attempt, 1);
    assert.deepEqual(await reserveProjectLocation(f.db, f.project, 'profile-geo'), first);
    assert.deepEqual(await reserveProjectLocation(f.db, f.project, 'profile-geo'), first);
    const row = await f.db.profile.findUniqueOrThrow({ where: { id: 'profile-geo' } });
    assert.deepEqual(row.fingerprint, p); assert.equal(row.fingerprintHash, hash); assert.equal(row.readinessVersion, 1);
    await f.db.taskExecution.update({ where: { id: execution.id }, data: { attempts: 2 } });
    await assert.rejects(reserveProjectLocation(f.db, f.project, 'profile-geo'), /invalid_saved_execution_geolocation/);
    await f.db.taskExecution.update({ where: { id: execution.id }, data: { attempts: 1, status: 'completed' } });
    await assert.rejects(reserveProjectLocation(f.db, f.project, 'profile-geo'), /invalid_saved_execution_geolocation/);
    assert.equal(await reserveProjectLocation(f.db, { ...f.project, geolocation: { mode: 'off' } }, 'profile-geo'), null);
    await f.db.projectProfileUse.deleteMany();
    const standalone1 = await reserveProjectLocation(f.db, f.project, 'profile-geo');
    const standalone2 = await reserveProjectLocation(f.db, f.project, 'profile-geo');
    assert.notDeepEqual([standalone1.latitude, standalone1.longitude], [standalone2.latitude, standalone2.longitude]);
  } finally { await f.cleanup(); }
});

test('context options carry coordinates without granting global permissions', () => {
  const profile = fp.profileFromPassport('context-geo', passport()), point = geo.createProjectLocation(project);
  assert.deepEqual(mobileContextOptions(profile, point).geolocation, geo.browserGeolocation(point));
  assert.equal(mobileContextOptions(profile).geolocation, undefined);
  assert.equal(mobileContextOptions(profile, point).permissions, undefined);
});

test('scheduler gives a retried execution a fresh point, even for the same task and profile', async () => {
  const f = await poolFixture();
  try {
    const row = await f.ready(), p = passport();
    await f.db.profile.update({ where: { id: row.id }, data: { fingerprint: p, fingerprintHash: fp.identityHash(row.id, p) } });
    const task = await f.task(), claim = await claimTarget(f.db, task.id, 'geo-demand');
    assert.ok(claim);
    const use = await f.db.projectProfileUse.findUniqueOrThrow({ where: { projectId_profileId: { projectId: f.project.id, profileId: row.id } } });
    assert.equal(geo.validProjectLocation(use.geolocation, f.project), true);
    await finishClaim(f.db, claim, { stopped: true });
    assert.equal(await f.db.projectProfileUse.count(), 0);
    const next = await claimTarget(f.db, task.id, 'geo-retry'); assert.ok(next);
    const again = await f.db.projectProfileUse.findUniqueOrThrow({ where: { projectId_profileId: { projectId: f.project.id, profileId: row.id } } });
    assert.equal(next.task.executionId, claim.task.executionId);
    assert.equal(again.geolocation.attempt, use.geolocation.attempt + 1);
    assert.notDeepEqual([again.geolocation.latitude, again.geolocation.longitude], [use.geolocation.latitude, use.geolocation.longitude]);
    assert.deepEqual(await reserveProjectLocation(f.db, f.project, row.id), again.geolocation);
    assert.deepEqual((await f.db.profile.findUniqueOrThrow({ where: { id: row.id } })).fingerprint, p);
    await finishClaim(f.db, next, { stopped: true });
  } finally { await f.cleanup(); }
});

test('parallel executions have independent five-kilometer points and transaction rollback leaves no binding', async () => {
  const f = await poolFixture();
  try {
    const project = await f.db.project.update({ where: { id: f.project.id }, data: { geolocation: { mode: 'region', radiusKm: 5 } } });
    for (let i = 0; i < 2; i++) {
      const row = await f.ready();
      await f.db.profile.update({ where: { id: row.id }, data: { fingerprint: passport() } });
    }
    const task = await f.task(project.id, 2);
    await f.db.task.update({ where: { id: task.id }, data: { concurrency: 2 } });
    const first = await claimTarget(f.db, task.id, 'geo-parallel');
    const second = await claimTarget(f.db, task.id, 'geo-parallel');
    assert.ok(first); assert.ok(second);
    const a = await reserveProjectLocation(f.db, project, first.task.profileId);
    const b = await reserveProjectLocation(f.db, project, second.task.profileId);
    assert.notEqual(a.executionId, b.executionId);
    assert.notDeepEqual([a.latitude, a.longitude], [b.latitude, b.longitude]);
    for (const point of [a, b]) { assert.equal(point.area.radiusKm, 5); assert.ok(geo.validProjectLocation(point, project)); }
    await assert.rejects(f.db.$transaction(async tx => {
      await tx.projectProfileUse.update({ where: { projectId_profileId: { projectId: project.id, profileId: first.task.profileId } }, data: { geolocation: b } });
      throw Error('rollback');
    }), /rollback/);
    assert.deepEqual(await reserveProjectLocation(f.db, project, first.task.profileId), a);
    await finishClaim(f.db, first, { stopped: true }); await finishClaim(f.db, second, { stopped: true });
  } finally { await f.cleanup(); }
});

test('native geolocation works on first page, iframe and popup, with isolated permissions and contexts', { timeout: 30000 }, async () => {
  const browser = await launch();
  try {
    const profile = fp.profileFromPassport('native-geo', passport()), point = geo.createProjectLocation(project);
    const context = await createMobileContext(browser, profile, undefined, undefined, true, point, project);
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Geo test</title>' }));
    const page = await context.newPage(); await page.goto('https://ya.ru/');
    assert.deepEqual(await coordinates(page), geo.browserGeolocation(point));
    const motion = startMotionEmulation(context); await motion.prepare(page);
    assert.deepEqual(await coordinates(page), geo.browserGeolocation(point));
    await motion.stop();
    assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state), 'prompt');
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame); });
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.title === 'Geo test');
    assert.deepEqual(await coordinates(page.frames()[1]), geo.browserGeolocation(point));
    const popupPromise = context.waitForEvent('page'); await page.evaluate(() => window.open('https://project.example/'));
    const popup = await popupPromise; await popup.waitForLoadState();
    assert.deepEqual(await coordinates(popup), geo.browserGeolocation(point));
    const other = await context.newPage(); await other.goto('https://unrelated.example/');
    assert.equal(await other.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state), 'prompt');
    const isolated = await browser.newContext(); await isolated.route('**/*', route => route.fulfill({ body: 'isolated' }));
    const isolatedPage = await isolated.newPage(); await isolatedPage.goto('https://ya.ru/');
    assert.equal(await isolatedPage.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state), 'prompt');
    const otherPoint = geo.createProjectLocation(project);
    const otherGeo = await createMobileContext(browser, profile, undefined, undefined, true, otherPoint, project);
    await otherGeo.route('**/*', route => route.fulfill({ body: '<!doctype html>' }));
    const otherGeoPage = await otherGeo.newPage(); await otherGeoPage.goto('https://ya.ru/');
    await context.close();
    assert.deepEqual(await coordinates(otherGeoPage), geo.browserGeolocation(otherPoint));
  } finally { await browser.close(); }
});

test('persistent relaunch reuses location and snapshot export keeps project metadata with valid checksum', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-geo-'));
  let context;
  try {
    const p = passport(), point = geo.createProjectLocation(project);
    const profile = fp.profileFromPassport('persistent-geo', p);
    profile.passport.projectLocations = { [project.id]: point };
    for (let launchNumber = 0; launchNumber < 2; launchNumber++) {
      context = await chromium.launchPersistentContext(join(dir, 'native'), { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH, ...mobileContextOptions(profile, point) });
      await applyProjectGeolocation(context, point, project);
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      const page = await context.newPage(); await page.goto('https://ya.ru/');
      assert.deepEqual(await coordinates(page), geo.browserGeolocation(point));
      const staged = await stageMobileProfile(join(dir, 'profiles'), profile, context, { storageMode: 'persistent' });
      const raw = JSON.parse(await readFile(staged.temporary, 'utf8'));
      assert.equal(snapshots.checkSnapshot(raw), true);
      assert.equal(raw.snapshot.passportHash, fp.identityHash(profile.profileId, p));
      assert.deepEqual(raw.passport.projectLocations[project.id], point);
      await staged.publish();
      const loaded = await loadMobileProfile(join(dir, 'profiles'), profile.profileId);
      assert.deepEqual(loaded.profile.passport.projectLocations[project.id], point);
      await context.close(); context = undefined;
    }
  } finally { await context?.close(); await rm(dir, { recursive: true, force: true }); }
});
