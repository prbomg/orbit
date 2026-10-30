// Integration check against an isolated database and an isolated Next.js process.
import { poolFixture } from '../tests/helpers/pool-fixture.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const f = await poolFixture({ wal: true }); let server;
try {
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r)); const base = `http://127.0.0.1:${port}`;
  const user = await f.db.authUser.create({ data: { email: 'storage-fixture@example.test', passwordHash: 'synthetic-disabled' } });
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
  assert.ok(started, 'isolated Next.js did not become ready');
  const row = await f.ready(); const before = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
  const headers = { Cookie: `orbit_session=${token}`, Origin: base, 'Content-Type': 'application/json' };
  const patch = async (storageMode, id = row.id) => fetch(`${base}/api/profiles/${id}/`, { method: 'PATCH', headers, body: JSON.stringify({ storageMode }) });
  assert.equal((await fetch(`${base}/api/profiles/${row.id}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storageMode: 'persistent' }) })).status, 401);
  assert.equal((await patch('snapshot')).status, 200);
  let actual = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(actual.storageResetRequested, false); assert.equal(+actual.readinessVerifiedAt, +before.readinessVerifiedAt); assert.equal(+actual.readinessValidUntil, +before.readinessValidUntil);
  await f.db.workflowLease.create({ data: { key: `profile:${row.id}`, owner: 'storage-test', expiresAt: new Date(Date.now() + 300000) } });
  assert.equal((await patch('snapshot')).status, 200);
  assert.equal((await patch('persistent')).status, 409);
  await f.db.workflowLease.delete({ where: { key: `profile:${row.id}` } });
  assert.equal((await patch('persistent')).status, 200);
  actual = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(actual.storageMode, 'persistent'); assert.equal(actual.storageResetRequested, true);
  assert.equal(actual.readinessVerifiedAt, null); assert.equal(actual.readinessValidUntil, null);
  assert.equal(+actual.warmedAt, +before.warmedAt); assert.equal(actual.snapshotId, before.snapshotId); assert.deepEqual(actual.sessionCheck, before.sessionCheck);
  assert.equal((await patch('persistent')).status, 200);
  await f.db.profile.update({ where: { id: row.id }, data: { storageResetRequested: false, readinessVerifiedAt: before.readinessVerifiedAt, readinessValidUntil: before.readinessValidUntil } });
  assert.equal((await patch('persistent')).status, 200);
  actual = await f.db.profile.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(actual.storageResetRequested, false); assert.equal(+actual.readinessVerifiedAt, +before.readinessVerifiedAt);
  assert.equal((await patch('unsupported')).status, 400);
  assert.equal((await patch('persistent', '00000000-0000-4000-8000-000000000000')).status, 404);
  console.log('PASS storage-mode API: no-op preserves readiness, busy transition rejected, real transition requests verification, warmedAt/snapshot/session evidence preserved, auth/validation/404 checked');
} finally {
  if (server && server.exitCode === null) { const exited = new Promise(r => server.once('close', r)); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); }
  await f.cleanup();
}
