import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

test('project metadata migration preserves IDs, tasks, reservations, and timestamps', async () => {
  const root = new URL('../prisma/migrations/', import.meta.url);
  const migrations = (await readdir(root)).filter(name => /^\d/.test(name)).sort();
  const db = new DatabaseSync(':memory:');
  try {
    const index = migrations.indexOf('20260929010000_project_metadata');
    for (const name of migrations.slice(0, index)) db.exec(await readFile(new URL(`${name}/migration.sql`, root), 'utf8'));
    db.prepare('INSERT INTO Project (id,name,websiteUrl,yandexRegionId,regionName,createdAt) VALUES (?,?,?,?,?,?)').run('project-fixture', 'QA', 'https://example.test/', 213, 'fixture', '2026-09-01 10:00:00');
    db.prepare('INSERT INTO Profile(id,name) VALUES (?,?)').run('profile-fixture', 'Fixture');
    db.prepare('INSERT INTO Task(id,profileId,projectId,url,status) VALUES (?,?,?,?,?)').run('task-fixture', 'profile-fixture', 'project-fixture', 'https://example.test/', 'paused');
    db.prepare('INSERT INTO ProjectProfileUse(id,projectId,profileId,taskId) VALUES (?,?,?,?)').run('use-fixture', 'project-fixture', 'profile-fixture', 'task-fixture');
    db.exec(await readFile(new URL(`${migrations[index]}/migration.sql`, root), 'utf8'));
    const project = db.prepare('SELECT * FROM Project WHERE id=?').get('project-fixture');
    assert.equal(project.yandexRegionId, '213');
    assert.equal(project.websiteUrl, 'https://example.test/');
    assert.equal(project.updatedAt, project.createdAt);
    assert.equal(db.prepare('SELECT projectId FROM Task WHERE id=?').get('task-fixture').projectId, project.id);
    assert.equal(db.prepare('SELECT taskId FROM ProjectProfileUse WHERE id=?').get('use-fixture').taskId, 'task-fixture');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
