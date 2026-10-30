// Exercise the actual restore HTTP handler against an isolated Next.js/SQLite.
import { poolFixture } from '../tests/helpers/pool-fixture.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import fp from '../utils/fingerprint.js';
import snapshots from '../utils/profileSnapshots.js';
import { synchronizeBrowserRuntime } from '../worker/browser-upgrade.mjs';

const f = await poolFixture({ wal: true }); let server;
try {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); const base = `http://127.0.0.1:${port}`;
  const user = await f.db.authUser.create({ data: { email: 'upgrade-fixture@example.test', passwordHash: 'synthetic-disabled' } });
  const token = randomBytes(32).toString('hex');
  await f.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DATABASE_URL: `file:${f.dir}/test.db`, APP_ORIGIN: base, AUTH_EMAIL: user.email, WORKER_PROFILES_DIR: f.dir }, stdio: 'ignore' });
  let started = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error('isolated_next_start_failed');
    try { if ((await fetch(base + '/login/')).status === 200) { started = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(started);
  const headers = { Cookie: `orbit_session=${token}`, Origin: base };
  const id = randomUUID(), old = fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: '134.0.6998.45' });
  delete old.identityHashVersion;
  const native = fp.chromeMetadata({ fullVersion: '135.0.7012.10', modelCode: 'control', osVersion: '14.0.0' }).userAgentData;
  const current = synchronizeBrowserRuntime(id, old, { runtimeVersion: '135.0.7012.10', nativeBrands: native.brands, nativeFullVersionList: native.fullVersionList }).passport;
  const warmedAt = new Date(Date.now() - 86400000 * 7);
  const before = await f.db.profile.create({ data: { id, name: 'Restore upgrade fixture', fingerprint: current, fingerprintHash: fp.identityHash(id, current), fingerprintState: 'verified', warmedAt, status: 'ready', storageMode: 'snapshot' } });
  const legacy = value => { const { snapshot, ...body } = value; return { ...body, snapshot: { version: 1, id: randomUUID(), storageMode: 'snapshot', passportHash: snapshots.legacyPassportHash(body), contentHash: snapshots.snapshotHash(body) } }; };
  const savedAt = new Date().toISOString();
  const backup = legacy({ ...fp.profileFromPassport(id, old), savedAt,
    cookies: [{ name: 'existing', value: 'original-cookie', domain: 'restore.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [{ origin: 'https://restore.invalid', localStorage: [{ name: 'existing', value: 'original-state' }], indexedDB: [{ name: 'existing', version: 1, stores: [{ name: 'data', autoIncrement: false, indexes: [], records: [{ key: 'existing', value: 'original-record' }] }] }] }] });
  const active = snapshots.stampSnapshot({ ...fp.profileFromPassport(id, current), savedAt, cookies: [], origins: [] });
  await writeFile(join(f.dir, `${id}.json`), JSON.stringify(active), { mode: 0o600 });
  await writeFile(join(f.dir, `${id}.json.previous`), JSON.stringify(backup), { mode: 0o600 });
  await f.db.profile.update({ where: { id }, data: { snapshotId: active.snapshot.id } });
  const endpoint = `${base}/api/profiles/${id}/session/restore/`;
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
  await f.db.workflowLease.create({ data: { key: `profile:${id}`, owner: 'upgrade-test', expiresAt: new Date(Date.now() + 60000) } });
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 409);
  await f.db.workflowLease.delete({ where: { key: `profile:${id}` } });
  const mismatch = structuredClone(backup); mismatch.fingerprint.navigator.userAgentData.model += '-foreign';
  await writeFile(join(f.dir, `${id}.json.previous`), JSON.stringify(legacy(mismatch)));
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 400, 'different device must remain rejected');
  const corrupt = structuredClone(backup); corrupt.cookies[0].value = 'tampered';
  await writeFile(join(f.dir, `${id}.json.previous`), JSON.stringify(corrupt));
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 400, 'content checksum still covers cookies');
  const wrongOwner = legacy({ ...backup, profileId: randomUUID() });
  await writeFile(join(f.dir, `${id}.json.previous`), JSON.stringify(wrongOwner));
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 400);
  await writeFile(join(f.dir, `${id}.json.previous`), JSON.stringify(backup));
  const response = await fetch(endpoint, { method: 'POST', headers });
  assert.equal(response.status, 200, await response.text());
  const restored = JSON.parse(await readFile(join(f.dir, `${id}.json`), 'utf8'));
  assert.equal(snapshots.checkSnapshot(restored), true); assert.equal(restored.snapshot.identityHashVersion, 4);
  assert.equal(restored.snapshot.passportHash, fp.identityHash(id, current));
  assert.equal(restored.fingerprint.navigator.userAgentData.uaFullVersion, '135.0.7012.10');
  assert.deepEqual(restored.headers, current.headers);
  assert.deepEqual(restored.cookies, backup.cookies); assert.deepEqual(restored.origins, backup.origins);
  const after = await f.db.profile.findUniqueOrThrow({ where: { id } });
  assert.equal(after.fingerprintHash, before.fingerprintHash); assert.equal(+after.warmedAt, +warmedAt);
  assert.equal(after.status, 'needs_check'); assert.equal(after.readinessVersion, 0); assert.equal(after.readinessValidUntil, null);
  assert.deepEqual(after.fingerprint, current);
  console.log('PASS browser-upgrade restore API: legacy v3 backup accepted across versions, original storage preserved, current metadata applied; corruption/foreign device/owner/busy/auth rejected; restart verification remains required');
} finally {
  if (server && server.exitCode === null) { const exited = new Promise(r => server.once('close', r)); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); }
  await f.cleanup();
}
