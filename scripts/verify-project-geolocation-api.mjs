// Exercise production HTTP handlers with a temporary database, never live data.
import { poolFixture } from '../tests/helpers/pool-fixture.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const f = await poolFixture({ wal: true }); let server;
try {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); const base = `http://127.0.0.1:${port}`;
  const user = await f.db.authUser.create({ data: { email: 'geo-fixture@example.test', passwordHash: 'synthetic-disabled' } });
  const token = randomBytes(32).toString('hex');
  await f.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DATABASE_URL: `file:${f.dir}/test.db`, APP_ORIGIN: base, AUTH_EMAIL: user.email }, stdio: 'ignore' });
  let started = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error('isolated_next_start_failed');
    try { if ((await fetch(base + '/login/')).status === 200) { started = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(started);
  const headers = { Cookie: `orbit_session=${token}`, Origin: base, 'Content-Type': 'application/json' };
  const patch = data => fetch(`${base}/api/projects/${f.project.id}/`, { method: 'PATCH', headers, body: JSON.stringify(data) });
  assert.equal((await fetch(`${base}/api/projects/${f.project.id}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"geolocation":{"mode":"off"}}' })).status, 401);
  const manual = { mode: 'manual', latitude: 54.19, longitude: 37.62, radiusKm: 2 };
  const changed = await patch({ geolocation: manual }); assert.equal(changed.status, 200); assert.deepEqual((await changed.json()).geolocation, manual);
  for (const geolocation of [{ ...manual, latitude: 100 }, { ...manual, radiusKm: -1 }, { ...manual, radiusKm: 51 }, { mode: 'unknown' }, { mode: 'region', latitude: 50 }]) assert.equal((await patch({ geolocation })).status, 400);
  const task = await f.task(); const profile = await f.ready();
  await f.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'running' } });
  assert.equal((await patch({ geolocation: { mode: 'off' } })).status, 409);
  assert.equal((await patch({ yandexRegionId: '15' })).status, 409);
  assert.equal((await patch({ geolocation: manual })).status, 200, 'identical config is allowed');
  assert.equal((await patch({ name: 'Rename while active' })).status, 200);
  await f.db.taskExecution.updateMany({ where: { taskId: task.id }, data: { status: 'completed' } });
  assert.equal((await patch({ geolocation: { mode: 'off' } })).status, 200);
  const created = await fetch(`${base}/api/projects/`, { method: 'POST', headers, body: JSON.stringify({ name: 'Default geo', targetUrl: 'https://example.test/', yandexRegionId: '213' }) });
  assert.equal(created.status, 201); assert.deepEqual((await created.json()).geolocation, { mode: 'region' });
  console.log('PASS project geolocation API: CRUD/defaults, coordinate validation, authentication, active attempt guard and no-op edits');
} finally {
  if (server && server.exitCode === null) { const exited = new Promise(r => server.once('close', r)); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); }
  await f.cleanup();
}
