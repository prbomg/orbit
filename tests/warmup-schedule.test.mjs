import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import schedule from '../utils/projectSchedule.js';
import pool from '../utils/profilePool.js';
import { poolFixture, migrations } from './helpers/pool-fixture.mjs';
import { claimWarmup, claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';

const night = { warmupScheduleHours: schedule.preset('night'), warmupScheduleTimezone: 'Europe/Moscow' };
const atNight = new Date('2026-10-09T18:00:00Z');
test('night schedule crosses midnight in its own timezone, with exclusive end and pause precedence', () => {
  assert.equal([...night.warmupScheduleHours].filter(x => x === '1').length, 84);
  for (const [date, expected] of [['2026-10-09T16:59:59Z', false], ['2026-10-09T17:00:00Z', true], ['2026-10-09T21:00:00Z', true], ['2026-10-10T04:59:59Z', true], ['2026-10-10T05:00:00Z', false]]) {
    assert.equal(schedule.isWarmupAllowed(night, new Date(date)), expected, date);
  }
  assert.equal(schedule.isWarmupAllowed({ ...night, warmupEnabled: false }, atNight), false);
  assert.equal(schedule.isWarmupAllowed({ ...night, warmupScheduleTimezone: 'Invalid/Zone' }, atNight), false);
  assert.equal(schedule.isWarmupAllowed({ warmupScheduleHours: '0'.repeat(168) }), false);
  assert.equal(schedule.isWarmupAllowed(null), true);
});

test('migration keeps existing pause and queue while defaulting to all hours', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const scripts = await migrations(), index = scripts.findIndex(sql => sql.includes('ADD COLUMN "warmupScheduleHours"'));
    assert.ok(index >= 0);
    for (const sql of scripts.slice(0, index)) db.exec(sql);
    db.exec("INSERT INTO Settings(id,warmupEnabled) VALUES (1,0); INSERT INTO Profile(id,name,status) VALUES ('p','Profile','queued'); INSERT INTO WarmupJob(id,profileId,status,currentStage,updatedAt) VALUES ('j','p','waiting_stage',2,CURRENT_TIMESTAMP)");
    const before = db.prepare('SELECT * FROM WarmupJob').get();
    db.exec(scripts[index]);
    assert.deepEqual(db.prepare('SELECT * FROM WarmupJob').get(), before);
    const settings = db.prepare('SELECT * FROM Settings').get();
    assert.equal(settings.warmupEnabled, 0);
    assert.equal(settings.warmupScheduleHours, schedule.ALL_HOURS);
    assert.equal(settings.warmupScheduleTimezone, 'Europe/Moscow');
  } finally { db.close(); }
});

test('closed hours reserve no resources; target tasks remain available; due queued, retry and continuation jobs resume at night', async () => {
  const f = await poolFixture();
  try {
    await f.db.settings.update({ where: { id: 1 }, data: night });
    await f.db.$transaction(tx => pool.createProfileBatch(tx, { count: 1 }));
    const job = await f.db.warmupJob.findFirstOrThrow();
    for (const status of ['queued', 'retry_wait', 'waiting_stage']) {
      await f.db.warmupJob.update({ where: { id: job.id }, data: { status, currentStage: status === 'waiting_stage' ? 2 : 1, nextStageAt: new Date(0), retryAfter: new Date(0) } });
      const before = await f.db.warmupJob.findUnique({ where: { id: job.id } });
      assert.equal(await claimWarmup(f.db, new Date('2026-10-09T12:00:00Z')), null);
      assert.deepEqual(await f.db.warmupJob.findUnique({ where: { id: job.id } }), before);
      assert.equal(await f.db.workflowLease.count({ where: { key: { startsWith: 'profile:' } } }), 0);
      const claim = await claimWarmup(f.db, atNight); assert.ok(claim);
      await finishClaim(f.db, claim, { stopped: true });
    }
    await f.ready(); const task = await f.task();
    const claim = await claimTarget(f.db, task.id, 'schedule-test'); assert.ok(claim);
    await finishClaim(f.db, claim, { stopped: true });
  } finally { await f.cleanup(); }
});

test('closing the schedule lets an active stage commit but prevents the next start; edits and pauses take effect without restart', async () => {
  const f = await poolFixture();
  try {
    await f.db.$transaction(tx => pool.createProfileBatch(tx, { count: 2 }));
    const claim = await claimWarmup(f.db); assert.ok(claim);
    await f.db.settings.update({ where: { id: 1 }, data: { warmupScheduleHours: schedule.preset('clear') } });
    await executeWarmup({ prisma: f.db, claim, config: {}, signal: new AbortController().signal, runner: async ({ checkActive, commitRun }) => {
      assert.equal(await checkActive(), true);
      assert.equal((await f.db.$transaction(tx => commitRun(tx, async () => {}))).count, 1);
      return true;
    } });
    const saved = await f.db.warmupJob.findUnique({ where: { id: claim.job.id } });
    assert.equal(saved.currentStage, 2); assert.equal(saved.status, 'waiting_stage');
    assert.equal(await claimWarmup(f.db), null);
    await f.db.settings.update({ where: { id: 1 }, data: { ...night, warmupEnabled: false } });
    assert.equal(await claimWarmup(f.db, atNight), null);
    await f.db.settings.update({ where: { id: 1 }, data: { warmupEnabled: true } });
    const next = await claimWarmup(f.db, atNight); assert.ok(next);
    await finishClaim(f.db, next, { stopped: true });
  } finally { await f.cleanup(); }
});
