import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import readiness from '../utils/profileReadiness.js';
import { poolFixture, migrations } from './helpers/pool-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
import { attestedSession } from './helpers/attestation.mjs';
import { maintainReadiness } from '../worker/readiness-service.mjs';
import { claimTarget } from '../worker/pool-scheduler.mjs';

test('migration revokes old readiness without changing passports, snapshots or completed preparation', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = await migrations();
    for (const migration of sql.filter(s => !s.includes('ADD COLUMN "readinessVersion"'))) db.exec(migration);
    db.exec(`INSERT INTO Profile(id,name,status,warmedAt,fingerprint,snapshotId,readinessVerifiedAt,readinessValidUntil)
      VALUES ('legacy','Legacy','ready',1000,'{"seed":"fixed"}','snapshot-fixed',2000,9999999999999)`);
    db.exec(sql.find(s => s.includes('ADD COLUMN "readinessVersion"')));
    const row = db.prepare('SELECT * FROM Profile WHERE id=?').get('legacy');
    assert.equal(row.status, 'needs_check'); assert.equal(row.readinessVersion, 0);
    assert.equal(row.readinessVerifiedAt, null); assert.equal(row.readinessValidUntil, null);
    assert.equal(row.warmedAt, 1000); assert.equal(row.fingerprint, '{"seed":"fixed"}'); assert.equal(row.snapshotId, 'snapshot-fixed');
  } finally { db.close(); }
});

test('every ready profile requires versioned restart evidence for its exact snapshot', async () => {
  const f = await poolFixture();
  try {
    const row = await f.ready(); assert.equal(readiness.confirmed(row), true);
    for (const patch of [{ snapshotId: null }, { readinessVersion: 0 },
      ...[{ processRestartVerified: false }, { verificationVersion: 0 }, { sourceSnapshotId: randomUUID() },
        { runtimeVersion: '' }, { checkedAt: null }, { passportHash: '' }].map(change => ({ sessionCheck: { ...row.sessionCheck, ...change } }))]) {
      assert.equal(readiness.confirmed({ ...row, ...patch }), false, JSON.stringify(patch));
    }
    const evidence = attestedSession();
    assert.equal(readiness.attestable({ ...row, sessionCheck: evidence.sessionCheck }, { ...evidence, state: 'saved' }, null), true);
    for (const change of [{ snapshotId: null }, { savedAt: new Date(0).toISOString() }, { passportHash: 'b'.repeat(64) }])
      assert.equal(readiness.attestable({ ...row, sessionCheck: evidence.sessionCheck }, { ...evidence, ...change, state: 'saved' }, null), false);
    await f.db.profile.update({ where: { id: row.id }, data: { readinessVersion: 0 } });
    const task = await f.task();
    assert.equal(await f.db.profile.count({ where: readiness.eligibleWhere() }), 0);
    assert.equal(await claimTarget(f.db, task.id, 'fixture'), null);
  } finally { await f.cleanup(); }
});

test('legacy reattestation advances in batches, preserves identities and preparation, respects pauses and leases', { timeout: 60000 }, async () => {
  const f = await poolFixture();
  try {
    const warmedAt = new Date(Date.now() - 86400000), ids = Array.from({ length: 205 }, () => randomUUID());
    await f.db.profile.createMany({ data: ids.map(id => ({ id, name: 'Legacy', status: 'ready', warmedAt, fingerprint: { seed: id }, sessionCheck: { status: 'passed' } })) });
    await f.db.warmupJob.createMany({ data: ids.map(profileId => ({ id: randomUUID(), profileId, status: 'completed', currentStage: 6, totalStages: 6, updatedAt: new Date() })) });
    const [busy, paused, failed] = ids;
    await f.db.workflowLease.create({ data: { key: `profile:${busy}`, owner: 'live', expiresAt: new Date(Date.now() + 60000) } });
    await f.db.warmupJob.update({ where: { profileId: paused }, data: { status: 'paused' } });
    await f.db.warmupJob.update({ where: { profileId: failed }, data: { status: 'failed', attempts: 3 } });
    for (let i = 0; i < 3; i++) await maintainReadiness(f.db, {});
    assert.equal(await f.db.warmupJob.count({ where: { status: 'queued' } }), 202);
    assert.equal((await f.db.warmupJob.findUnique({ where: { profileId: paused } })).status, 'paused');
    assert.equal((await f.db.warmupJob.findUnique({ where: { profileId: failed } })).attempts, 3);
    for (const row of await f.db.profile.findMany()) {
      assert.equal(row.fingerprint.seed, row.id); assert.equal(+row.warmedAt, +warmedAt); assert.equal(row.readinessVersion, 0);
    }
    await f.db.workflowLease.delete({ where: { key: `profile:${busy}` } }); await maintainReadiness(f.db, {});
    assert.equal(await f.db.warmupJob.count({ where: { status: 'queued' } }), 203);
    assert.equal(await f.db.profile.count({ where: readiness.eligibleWhere() }), 0);
  } finally { await f.cleanup(); }
});
