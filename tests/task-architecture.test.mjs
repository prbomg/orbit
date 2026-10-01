import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import lifecycle from '../utils/taskLifecycle.js';

async function migrationScripts() {
  const root = new URL('../prisma/migrations/', import.meta.url);
  const names = (await readdir(root)).filter(name => /^\d/.test(name)).sort();
  return Promise.all(names.map(name => readFile(new URL(`${name}/migration.sql`, root), 'utf8')));
}

test('architecture migration preserves counts, disabled profiles, project links and actual usage', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const scripts = await migrationScripts();
    for (const sql of scripts.slice(0, -1)) db.exec(sql);
    db.exec(`INSERT INTO Profile(id,name,status,warmedAt) VALUES ('legacy-profile','Fixture','paused',CURRENT_TIMESTAMP);
      INSERT INTO Task(id,profileId,url,executionsCount) VALUES ('legacy-task','legacy-profile','https://example.test/legacy',7);
      INSERT INTO Task(id,profileId,taskType,status,executionsCount) VALUES ('legacy-warmup','legacy-profile','warmup','completed',2);
      INSERT INTO Project(id,name,websiteUrl,yandexRegionId,regionName) VALUES ('existing-project','Existing','https://existing.test/','2','');
      INSERT INTO Task(id,profileId,projectId,url,executionLimit,executionsCount) VALUES ('existing-task','legacy-profile','existing-project','https://existing.test/',10,3);
      INSERT INTO ProjectProfileUse(id,profileId,projectId,taskId) VALUES ('reservation','legacy-profile','existing-project','existing-task');`);
    db.exec(scripts.at(-1));
    const task = db.prepare('SELECT * FROM Task WHERE id=?').get('legacy-task');
    assert.equal(task.currentExecutions, 7); assert.equal(task.targetExecutions, 7);
    assert.equal(task.projectId, 'import-legacy-task'); assert.ok(!('targetDomain' in task));
    assert.equal(db.prepare('SELECT websiteUrl FROM Project WHERE id=?').get(task.projectId).websiteUrl, task.url);
    const existing = db.prepare('SELECT * FROM Task WHERE id=?').get('existing-task');
    assert.equal(existing.targetExecutions, 10); assert.equal(existing.currentExecutions, 3);
    const profile = db.prepare('SELECT * FROM Profile').get();
    assert.equal(profile.status, 'ready'); assert.equal(profile.isEnabled, 0); assert.equal(profile.warmupScore, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ProfileProjectHistory').get().n, 2);
    assert.equal(db.prepare('SELECT source FROM ProfileProjectHistory LIMIT 1').get().source, 'legacy');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-task-architecture-'));
  const file = join(dir, 'fixture.db');
  const db = new DatabaseSync(file); for (const sql of await migrationScripts()) db.exec(sql); db.close();
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  const project = await prisma.project.create({ data: { name: 'Fixture', targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
  const profile = await prisma.profile.create({ data: { name: 'Fixture' } });
  const task = await prisma.task.create({ data: { projectId: project.id, profileId: profile.id, targetExecutions: 3 } });
  return { prisma, project, profile, task, cleanup: async () => { await prisma.$disconnect(); await rm(dir, { recursive: true, force: true }); } };
}

test('completed executions increment counts and persist profile-project history without exceeding the plan', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 3; index++) {
      assert.equal((await f.prisma.$transaction(tx => lifecycle.commitTaskExecution(tx, { taskId: f.task.id, profileId: f.profile.id }))).count, 1);
      const row = await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } });
      assert.equal(row.currentExecutions, index); assert.equal(row.status, index === 3 ? 'completed' : 'running');
    }
    assert.equal((await f.prisma.$transaction(tx => lifecycle.commitTaskExecution(tx, { taskId: f.task.id, profileId: f.profile.id }))).count, 0);
    assert.equal(await f.prisma.profileProjectHistory.count({ where: { projectId: f.project.id, profileId: f.profile.id } }), 3);
    await f.prisma.task.delete({ where: { id: f.task.id } });
    assert.equal(await f.prisma.profileProjectHistory.count({ where: { projectId: f.project.id } }), 3);
  } finally { await f.cleanup(); }
});

test('blocked profiles and failed state publication do not record success', async () => {
  const f = await fixture();
  try {
    await f.prisma.profile.update({ where: { id: f.profile.id }, data: { status: 'banned' } });
    assert.equal((await f.prisma.$transaction(tx => lifecycle.commitTaskExecution(tx, { taskId: f.task.id, profileId: f.profile.id }))).count, 0);
    await f.prisma.profile.update({ where: { id: f.profile.id }, data: { status: 'new' } });
    await assert.rejects(f.prisma.$transaction(tx => lifecycle.commitTaskExecution(tx, { taskId: f.task.id, profileId: f.profile.id, publish: async () => { throw new Error('synthetic publication failure'); } })));
    assert.equal((await f.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).currentExecutions, 0);
    assert.equal(await f.prisma.profileProjectHistory.count(), 0);
  } finally { await f.cleanup(); }
});

test('successful warmup updates profile metadata without creating project history', async () => {
  const f = await fixture();
  try {
    const warmup = await f.prisma.task.create({ data: { profileId: f.profile.id, taskType: 'warmup' } });
    await f.prisma.$transaction(tx => lifecycle.commitTaskExecution(tx, { taskId: warmup.id, profileId: f.profile.id }));
    const profile = await f.prisma.profile.findUniqueOrThrow({ where: { id: f.profile.id } });
    assert.equal(profile.status, 'ready'); assert.equal(profile.warmupScore, 1); assert.ok(profile.warmedAt);
    assert.equal(await f.prisma.profileProjectHistory.count(), 0);
  } finally { await f.cleanup(); }
});
