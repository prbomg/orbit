import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { attestedSession } from './helpers/attestation.mjs';
import fp from '../utils/fingerprint.js';
import snapshots from '../utils/profileSnapshots.js';
import { runTask } from '../worker/runner.mjs';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.closeAllConnections(); s.close(r); });

for (const storageMode of ['snapshot', 'persistent']) test(`runner upgrades a saved v3 passport and publishes a verified v4 session without losing previous data (${storageMode})`, { timeout: 120000 }, async () => {
  const f = await poolFixture(); let donor, proxy;
  try {
    const installed = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const actual = installed.version(); await installed.close();
    const oldVersion = `${Number(actual.split('.')[0]) - 1}.0.1.1`;
    donor = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Controlled local health</title>'); });
    await listen(donor); const origin = `http://127.0.0.1:${donor.address().port}`;
    proxy = createServer((req, res) => {
      const headers = { ...req.headers }; delete headers['proxy-authorization'];
      const upstream = request(req.url, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    }); await listen(proxy);
    const selectedProxy = await f.db.proxy.update({ where: { id: f.proxy.id }, data: { port: proxy.address().port } });
    const id = randomUUID(), passport = fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: oldVersion });
    delete passport.identityHashVersion;
    const warmedAt = new Date(Date.now() - 7 * 86400000), savedAt = new Date().toISOString();
    const profile = { ...fp.profileFromPassport(id, passport), savedAt,
      cookies: [{ name: 'retained', value: 'old-session-cookie', domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, secure: false, httpOnly: true, sameSite: 'Lax' }],
      origins: [{ origin, localStorage: [{ name: 'old-state', value: 'retained' }], indexedDB: [{ name: 'old-db', version: 1, stores: [{ name: 'data', autoIncrement: false, indexes: [], records: [{ key: 'old-key', value: 'retained' }] }] }] }] };
    const snapshot = { ...profile, snapshot: { version: 1, id: randomUUID(), passportHash: snapshots.legacyPassportHash(profile), contentHash: snapshots.snapshotHash(profile), storageMode: 'snapshot' } };
    const directory = join(f.dir, 'profiles'), original = JSON.stringify(snapshot); await mkdir(directory);
    await writeFile(join(directory, `${id}.json`), original, { mode: 0o600 });
    const legacyHash = fp.legacyIdentityHash(id, passport), stable = fp.identityHash(id, passport);
    await f.db.profile.create({ data: { id, name: 'Saved upgrade fixture', warmedAt, status: 'ready', fingerprint: passport, fingerprintHash: legacyHash, fingerprintState: 'verified', storageMode,
      storageResetRequested: storageMode === 'persistent', snapshotId: snapshot.snapshot.id, sessionCheck: attestedSession({ snapshotId: snapshot.snapshot.id, savedAt, passportHash: snapshot.snapshot.passportHash }).sessionCheck } });
    const task = await f.db.task.create({ data: { projectId: f.project.id, profileId: id, taskType: 'warmup', url: '', targetExecutions: 1 } });
    const events = [];
    const success = await runTask({ prisma: f.db, task: { ...task, warmupStage: 3, verificationOnly: true }, proxy: selectedProxy,
      config: { profilesDirectory: directory, chromiumExecutablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH, headless: true, motionMode: 'off', navigationTimeoutMs: 5000, proxyScheme: 'http', proxyCheckUrl: origin + '/health', proxyIPCheckMode: 'off' },
      log: (event, details) => events.push({ event, ...details }),
      commitRun: async (tx, publish, summary) => { await publish(); await tx.profile.update({ where: { id }, data: { sessionCheck: summary.sessionCheck } }); return { count: 1 }; },
    });
    assert.equal(success, true);
    const current = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
    assert.equal(snapshots.checkSnapshot(current), true); assert.equal(current.snapshot.identityHashVersion, 4);
    assert.equal(current.snapshot.passportHash, stable);
    assert.equal(current.fingerprint.navigator.userAgentData.uaFullVersion, actual);
    assert.equal(current.cookies.find(c => c.name === 'retained').value, 'old-session-cookie');
    assert.deepEqual(current.origins, profile.origins);
    assert.equal(await readFile(join(directory, `${id}.json.previous`), 'utf8'), original);
    const row = await f.db.profile.findUniqueOrThrow({ where: { id } });
    assert.equal(row.fingerprintHash, stable); assert.notEqual(row.fingerprintHash, legacyHash); assert.equal(+row.warmedAt, +warmedAt);
    assert.equal(row.fingerprint.runtimeVersion, actual); assert.equal(row.fingerprint.identityHashVersion, 4);
    assert.equal(row.sessionCheck.processRestartVerified, true); assert.equal(row.sessionCheck.passportHash, stable);
    assert.ok(events.some(e => e.event === 'profile_browser_upgraded' && e.fromVersion === oldVersion && e.toVersion === actual));
    if (storageMode === 'persistent') assert.ok(events.some(e => e.event === 'profile_storage_seeded'));
  } finally { if (proxy) await close(proxy); if (donor) await close(donor); await f.cleanup(); }
});
