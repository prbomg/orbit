import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import daily from '../utils/taskDailySchedule.js';
import schedule from '../utils/projectSchedule.js';
import { claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { sqliteWrite } from '../worker/sqlite-write.mjs';
import { poolFixture, migrations } from './helpers/pool-fixture.mjs';
import { managedEventRecord } from '../worker/managed-state.mjs';

const now = new Date('2026-10-09T05:00:00Z'); // Friday 08:00 Moscow.
const project = { scheduleHours: schedule.preset('work'), scheduleTimezone: 'Europe/Moscow' };
const configure = async (f, limit, total = 10) => {
  const t = await f.task(f.project.id, total);
  await f.db.project.update({ where: { id: f.project.id }, data: project });
  return f.db.task.update({ where: { id: t.id }, data: { dailyExecutionLimit: limit, concurrency: 10 }, include: { project: true } });
};

test('day calendars follow timezone, fractional offsets, weekends and DST day lengths', () => {
  const moscow = daily.dayCalendar(project, now);
  assert.equal(moscow.dayKey, '2026-10-09');
  assert.equal(moscow.start, +new Date('2026-10-08T21:00:00Z'));
  assert.deepEqual(moscow.windows, [{ start: +now, end: +new Date('2026-10-09T17:00:00Z') }]);
  assert.deepEqual(daily.dayCalendar(project, new Date('2026-10-10T05:00:00Z')).windows, []);
  for (const [stamp, hours] of [['2026-03-08T12:00:00Z',23],['2026-11-01T12:00:00Z',25]]) {
    const day = daily.dayCalendar({ scheduleTimezone: 'America/New_York' }, new Date(stamp));
    assert.equal(day.end - day.start, hours * 3600000);
  }
  const fractional = daily.dayCalendar({ scheduleTimezone: 'Asia/Kathmandu' }, now);
  assert.equal(new Date(fractional.start).toISOString(), '2026-10-08T18:15:00.000Z');
  assert.equal(daily.dayCalendar({ scheduleTimezone: 'Invalid/Zone' }, now), null);
});

test('random slots spread over allowed remaining windows without fixed intervals or forbidden hours', () => {
  const mask = [...schedule.preset('clear')]; for (const hour of [8,9,15,16]) mask[4*24+hour] = '1';
  const p = { ...project, scheduleHours: mask.join('') }, calendar = daily.dayCalendar(p, now);
  const start = new Date('2026-10-09T06:00:00Z');
  const a = daily.generateSlots(calendar, 40, start), b = daily.generateSlots(calendar, 40, start);
  assert.equal(a.length, 40); assert.notDeepEqual(a, b);
  assert.ok(a.every((time, i) => time >= +start && time < calendar.end && schedule.isAllowed(p, new Date(time)) && (!i || time > a[i-1])));
  assert.ok(a.some(time => time < +new Date('2026-10-09T07:00:00Z')));
  assert.ok(a.some(time => time >= +new Date('2026-10-09T12:00:00Z')));
  assert.ok(new Set(a.slice(1).map((t,i) => t-a[i])).size > 20);
  assert.deepEqual(daily.generateSlots(calendar, 10, new Date(calendar.end)), []);
});

test('daily plan persists between checks and restarts; reservations prevent concurrent quota overshoot', async () => {
  const f = await poolFixture();
  try {
    const task = await configure(f, 2);
    const first = await f.db.$transaction(tx => daily.dailyState(tx, task, { now, create: true }));
    assert.equal(first.allowed, false); assert.equal(first.reason, 'daily_schedule');
    const persisted = await f.db.taskDailyPlan.findFirst();
    const again = await f.db.$transaction(tx => daily.dailyState(tx, task, { now, create: true, random: () => { throw new Error('Must reuse plan'); } }));
    assert.equal(+again.nextAt, +first.nextAt);
    await f.db.taskDailyPlan.update({ where: { id: persisted.id }, data: { slots: [+now, +now] } });
    const profiles = await Promise.all([f.ready(), f.ready(), f.ready()]);
    const claims = await Promise.all(profiles.map(profile => sqliteWrite(f.db, async tx => {
      const state = await daily.dailyState(tx, task, { now, create: true });
      if (!state.allowed) return false;
      await tx.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'running', startedAt: now } });
      return true;
    })));
    assert.equal(claims.filter(Boolean).length, 2);
    assert.equal((await daily.dailyState(f.db, task, { now })).reason, 'daily_limit');
    assert.equal(await f.db.taskExecution.count(), 2);
  } finally { await f.cleanup(); }
});

test('completed and in-progress sessions reserve their start day; failed attempts release capacity', async () => {
  const f = await poolFixture();
  try {
    const task = await configure(f, 2), profile = await f.ready();
    const execution = await f.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'completed', startedAt: now, completedAt: new Date('2026-10-09T22:00:00Z') } });
    await daily.dailyState(f.db, task, { now, create: true });
    let state = await daily.dailyState(f.db, task, { now });
    assert.equal(state.completed, 1); assert.equal(state.reserved, 0);
    state = await daily.dailyState(f.db, task, { now: new Date('2026-10-12T05:00:00Z'), create: true });
    assert.equal(state.completed, 0); assert.equal(state.reason, 'daily_schedule');
    await f.db.taskExecution.update({ where: { id: execution.id }, data: { status: 'failed' } });
    const repaired = await daily.dailyState(f.db, task, { now, create: true });
    assert.equal(repaired.completed, 0);
    const plan = await f.db.taskDailyPlan.findUnique({ where: { taskId_dayKey: { taskId: task.id, dayKey: '2026-10-09' } } });
    assert.equal(plan.baseCount, 0); assert.equal(plan.slots.length, 2);
  } finally { await f.cleanup(); }
});

test('late restart and setting changes redistribute remaining slots rather than starting a catch-up burst', async () => {
  const f = await poolFixture();
  try {
    let task = await configure(f, 10);
    await daily.dailyState(f.db, task, { now, create: true });
    const plan = await f.db.taskDailyPlan.findFirst();
    await f.db.taskDailyPlan.update({ where: { id: plan.id }, data: { slots: Array(10).fill(+now) } });
    const later = new Date(+now + 3600000);
    const state = await daily.dailyState(f.db, task, { now: later, create: true });
    assert.equal(state.allowed, false); assert.ok(+state.nextAt > +later);
    task = await f.db.task.update({ where: { id: task.id }, data: { dailyExecutionLimit: 3 }, include: { project: true } });
    await daily.dailyState(f.db, task, { now: later, create: true });
    assert.equal((await f.db.taskDailyPlan.findFirst()).slots.length, 3);
    task = await f.db.task.update({ where: { id: task.id }, data: { dailyExecutionLimit: null }, include: { project: true } });
    assert.equal((await daily.dailyState(f.db, task, { now: later })).allowed, true);
  } finally { await f.cleanup(); }
});

test('daily plan never exceeds the total remaining work and a lower limit preserves running sessions', async () => {
  const f = await poolFixture();
  try {
    let task = await configure(f, 20, 3);
    await daily.dailyState(f.db, task, { now, create: true });
    assert.equal((await f.db.taskDailyPlan.findFirst()).slots.length, 3);
    for (const status of ['completed','running']) {
      const profile = await f.ready();
      await f.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status, startedAt: now } });
    }
    task = await f.db.task.update({ where: { id: task.id }, data: { dailyExecutionLimit: 1, currentExecutions: 1 }, include: { project: true } });
    const state = await daily.dailyState(f.db, task, { now, create: true });
    assert.equal(state.allowed, false); assert.equal(state.reason, 'daily_limit');
    assert.equal(await f.db.taskExecution.count({ where: { status: 'running' } }), 1);
  } finally { await f.cleanup(); }
});

test('scheduler reserves no profile before a slot, honors the daily cap, and preserves unlimited scheduling', async () => {
  const f = await poolFixture();
  try {
    let task = await configure(f, 1); await f.ready(); await f.ready();
    assert.equal(await claimTarget(f.db, task.id, 'daily-test', now), null);
    assert.equal(await f.db.projectProfileUse.count(), 0); assert.equal(await f.db.workflowLease.count(), 0);
    const plan = await f.db.taskDailyPlan.findFirst();
    const due = new Date(plan.slots[0] + 100);
    const claim = await claimTarget(f.db, task.id, 'daily-test', due); assert.ok(claim);
    assert.equal(await claimTarget(f.db, task.id, 'daily-test', due), null);
    assert.equal(await f.db.taskExecution.count({ where: { status: 'running' } }), 1);
    await finishClaim(f.db, claim, { stopped: true });
    task = await f.db.task.update({ where: { id: task.id }, data: { dailyExecutionLimit: null } });
    const immediate = await claimTarget(f.db, task.id, 'daily-test', now); assert.ok(immediate);
    await finishClaim(f.db, immediate, { stopped: true });
    await f.db.project.update({ where: { id: f.project.id }, data: { scheduleHours: schedule.preset('clear') } });
    assert.equal(await claimTarget(f.db, task.id, 'daily-test', now), null);
  } finally { await f.cleanup(); }
});

test('migration keeps existing counts and paused tasks unlimited; daily waiting reasons are safe', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = await readFile(new URL('../prisma/migrations/20261009140000_task_daily_schedule/migration.sql', import.meta.url), 'utf8');
    const scripts = await migrations(); for (const s of scripts.slice(0, scripts.indexOf(sql))) db.exec(s);
    db.exec("INSERT INTO Task(id,status,targetExecutions,currentExecutions) VALUES ('t','paused',300,4)");
    db.exec(sql);
    const task = db.prepare("SELECT * FROM Task WHERE id='t'").get();
    assert.equal(task.dailyExecutionLimit, null); assert.equal(task.status, 'paused'); assert.equal(task.currentExecutions, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  for (const reason of ['daily_limit','daily_schedule']) assert.equal(managedEventRecord({}, 'waiting', { reason }).waitReason, reason);
});
