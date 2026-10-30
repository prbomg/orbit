import { test } from 'node:test';
import { attestedSession } from './helpers/attestation.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import schedule from '../utils/projectSchedule.js';
import { poolFixture, migrations } from './helpers/pool-fixture.mjs';
import { claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { pollDatabase } from '../worker/runner.mjs';
import { managedEventRecord } from '../worker/managed-state.mjs';

const count = hours => [...hours].filter(bit => bit === '1').length;
test('presets cover exact day/hour ranges; random selects 118 distinct hours', () => {
  for (const [name, expected] of [['work', 60], ['day', 84], ['weekdays', 120], ['weekends', 48], ['all', 168], ['clear', 0], ['random', 118]]) {
    const hours = schedule.preset(name);
    assert.match(hours, /^[01]{168}$/); assert.equal(count(hours), expected);
  }
  const work = schedule.preset('work');
  assert.equal(work[7], '0'); assert.equal(work[8], '1'); assert.equal(work[19], '1'); assert.equal(work[20], '0');
  assert.equal(work[4 * 24 + 19], '1'); assert.equal(work[5 * 24 + 8], '0');
});

test('schedule uses project timezone, Monday-first days and exclusive end hours', () => {
  const project = { scheduleHours: schedule.preset('work'), scheduleTimezone: 'Europe/Moscow' };
  for (const [stamp, expected] of [
    ['2026-10-05T04:59:59Z', false], ['2026-10-05T05:00:00Z', true],
    ['2026-10-09T16:59:59Z', true], ['2026-10-09T17:00:00Z', false],
    ['2026-10-10T06:00:00Z', false], ['2026-10-11T06:00:00Z', false],
  ]) assert.equal(schedule.isAllowed(project, new Date(stamp)), expected, stamp);
  const sunday = { scheduleHours: '0'.repeat(6 * 24 + 23) + '1', scheduleTimezone: 'Asia/Kolkata' };
  assert.equal(schedule.isAllowed(sunday, new Date('2026-10-11T17:30:00Z')), true);
  assert.equal(schedule.isAllowed(sunday, new Date('2026-10-11T18:30:00Z')), false);
});

test('DST repeated hour follows wall clock; invalid settings fail closed', () => {
  const hours = [...schedule.preset('clear')]; hours[6 * 24 + 1] = '1';
  const project = { scheduleHours: hours.join(''), scheduleTimezone: 'America/New_York' };
  assert.equal(schedule.isAllowed(project, new Date('2026-11-01T05:30:00Z')), true);
  assert.equal(schedule.isAllowed(project, new Date('2026-11-01T06:30:00Z')), true);
  assert.equal(schedule.isAllowed(project, new Date('2026-11-01T07:00:00Z')), false);
  assert.equal(schedule.isAllowed({ scheduleHours: '' }), false);
  assert.equal(schedule.isAllowed({ scheduleTimezone: 'Invalid/Zone' }), false);
  assert.equal(schedule.isAllowed({ scheduleHours: schedule.preset('clear') }), false);
  assert.equal(schedule.isAllowed({ scheduleHours: schedule.ALL_HOURS }), true);
});

test('migration backfills 24/7 without changing existing project or paused task', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const scripts = await migrations();
    const migration = await readFile(new URL('../prisma/migrations/20261009130000_project_schedule/migration.sql', import.meta.url), 'utf8');
    for (const sql of scripts.slice(0, scripts.indexOf(migration))) db.exec(sql);
    db.exec(`INSERT INTO Project(id,name,websiteUrl,yandexRegionId,regionName) VALUES ('p','Existing','https://example.test','213','');
      INSERT INTO Task(id,projectId,status,url,targetExecutions) VALUES ('t','p','paused','https://example.test',300);`);
    db.exec(migration);
    const project = db.prepare('SELECT * FROM Project WHERE id=?').get('p');
    assert.equal(project.scheduleHours, schedule.ALL_HOURS); assert.equal(project.scheduleTimezone, schedule.DEFAULT_TIMEZONE);
    const task = db.prepare('SELECT * FROM Task WHERE id=?').get('t');
    assert.equal(task.status, 'paused'); assert.equal(task.targetExecutions, 300);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('closed schedule reserves no profile or channel and releases target demand; other projects still run', async () => {
  const f = await poolFixture();
  try {
    const task = await f.task(); await f.ready();
    await f.db.project.update({ where: { id: f.project.id }, data: { scheduleHours: schedule.preset('clear') } });
    await f.db.workflowLease.create({ data: { key: 'target-demand', owner: 'schedule-test', expiresAt: new Date(Date.now() + 30000) } });
    assert.equal(await claimTarget(f.db, task.id, 'schedule-test'), null);
    assert.equal(await f.db.taskExecution.count(), 0); assert.equal(await f.db.projectProfileUse.count(), 0); assert.equal(await f.db.workflowLease.count(), 0);
    const other = await f.db.project.create({ data: { name: 'Other', targetUrl: 'https://other.test', regionName: '', yandexRegionId: '2' } });
    const otherTask = await f.task(other.id);
    const claim = await claimTarget(f.db, otherTask.id, 'schedule-test'); assert.ok(claim);
    await finishClaim(f.db, claim, { stopped: true });
  } finally { await f.cleanup(); }
});

test('worker waits without consuming profiles, resumes after schedule edit and completes already started session after closure', { timeout: 15000 }, async () => {
  const f = await poolFixture(), controller = new AbortController(); let worker;
  try {
    const task = await f.task(f.project.id, 2); await f.ready(); await f.ready();
    await f.db.project.update({ where: { id: f.project.id }, data: { scheduleHours: schedule.preset('clear') } });
    let signalWaiting, signalFinished;
    const waiting = new Promise(resolve => { signalWaiting = resolve; });
    const finished = new Promise(resolve => { signalFinished = resolve; });
    let started = 0;
    worker = pollDatabase({ prisma: f.db, config: { projectId: f.project.id, pollMs: 20, cooldownMs: 20 }, signal: controller.signal,
      log: (event, detail) => { if (event === 'waiting' && detail.reason === 'schedule') signalWaiting(); },
      runTaskRunner: async ({ checkActive, beforeTargetVisit, commitRun }) => {
        started++;
        await f.db.project.update({ where: { id: f.project.id }, data: { scheduleHours: schedule.preset('clear') } });
        assert.equal(await checkActive(), true);
        await beforeTargetVisit();
        const result = await f.db.$transaction(tx => commitRun(tx, async () => {}, attestedSession()));
        assert.equal(result.count, 1); signalFinished(); return true;
      } });
    await waiting;
    assert.equal(started, 0); assert.equal(await f.db.projectProfileUse.count(), 0);
    await f.db.project.update({ where: { id: f.project.id }, data: { scheduleHours: schedule.ALL_HOURS } });
    await finished;
    controller.abort(); await worker;
    const row = await f.db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(started, 1); assert.equal(row.currentExecutions, 1); assert.equal(row.status, 'running');
    assert.equal(await f.db.taskExecution.count({ where: { status: 'running' } }), 0);
  } finally { controller.abort(); await worker; await f.cleanup(); }
});

test('managed status exposes schedule waiting reason and clears it on session start', () => {
  const waiting = managedEventRecord({}, 'waiting', { reason: 'schedule' });
  assert.equal(waiting.waitReason, 'schedule');
  assert.equal(managedEventRecord(waiting, 'session_started').waitReason, null);
  assert.equal(managedEventRecord({}, 'waiting', { reason: 'untrusted' }).waitReason, null);
});
