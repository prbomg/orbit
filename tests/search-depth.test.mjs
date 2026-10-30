import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import searchTasks from '../utils/searchTask.js';

const task = { searchEngine: 'yandex', searchQueries: ['fixture'], targetDomain: 'target.test' };

test('search depth defaults to three and accepts every integer from one to ten', () => {
  assert.equal(searchTasks.parseSearchDepth(), 3);
  assert.equal(searchTasks.searchTaskConfig(task).searchDepth, 3);
  for (let depth = 1; depth <= 10; depth++) {
    assert.equal(searchTasks.searchTaskConfig({ ...task, searchDepth: depth }).searchDepth, depth);
  }
});

test('search depth rejects malformed and out-of-range values without coercion', () => {
  for (const value of [null, false, true, '', '5', [], {}, 0, -1, 11, 1.5, NaN, Infinity]) {
    assert.throws(() => searchTasks.parseSearchDepth(value));
    assert.throws(() => searchTasks.searchTaskConfig({ ...task, searchDepth: value }));
  }
});

test('migration preserves existing task state and defaults old and new rows to five', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE Task (id TEXT PRIMARY KEY, status TEXT, currentExecutions INTEGER);');
    db.exec("INSERT INTO Task VALUES ('existing', 'paused', 7);");
    db.exec(await readFile(new URL('../prisma/migrations/20261021140000_task_search_depth/migration.sql', import.meta.url), 'utf8'));
    assert.deepEqual({ ...db.prepare('SELECT * FROM Task').get() }, {
      id: 'existing', status: 'paused', currentExecutions: 7, searchDepth: 5,
    });
    db.exec("INSERT INTO Task (id,status,currentExecutions) VALUES ('new','paused',0);");
    assert.equal(db.prepare('SELECT searchDepth FROM Task WHERE id=?').get('new').searchDepth, 5);
  } finally { db.close(); }
});


test('default-four migration preserves task values and dependent history', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const root = new URL('../prisma/migrations/', import.meta.url);
    const name = '20261022090000_search_depth_default_four';
    for (const folder of (await readdir(root)).filter(n => /^\d/.test(n) && n < name).sort()) {
      db.exec(await readFile(new URL(`${folder}/migration.sql`, root), 'utf8'));
    }
    db.exec("PRAGMA foreign_keys=ON; INSERT INTO Task (id,status,currentExecutions) VALUES ('saved-five','paused',7); INSERT INTO Task (id,status,searchDepth) VALUES ('saved-four','paused',4);");
    db.exec("INSERT INTO TaskDailyPlan (id,taskId,dayKey,settingsKey,slots) VALUES ('history','saved-five','2026-10-22','fixture','[]');");
    const before = db.prepare('SELECT * FROM Task ORDER BY id').all();
    db.exec(await readFile(new URL(`${name}/migration.sql`, root), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM Task ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM TaskDailyPlan').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec("INSERT INTO Task (id,status) VALUES ('new','paused');");
    assert.equal(db.prepare("SELECT searchDepth FROM Task WHERE id='new'").get().searchDepth, 4);
  } finally { db.close(); }
});

test('default-three migration preserves task values and dependent history', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const root = new URL('../prisma/migrations/', import.meta.url);
    const name = '20261022180000_search_depth_default_three';
    for (const folder of (await readdir(root)).filter(n => /^\d/.test(n) && n < name).sort()) {
      db.exec(await readFile(new URL(`${folder}/migration.sql`, root), 'utf8'));
    }
    db.exec("PRAGMA foreign_keys=ON; INSERT INTO Task (id,status,currentExecutions) VALUES ('saved-five','paused',7); INSERT INTO Task (id,status,searchDepth) VALUES ('saved-four','paused',4);");
    db.exec("INSERT INTO TaskDailyPlan (id,taskId,dayKey,settingsKey,slots) VALUES ('history','saved-five','2026-10-22','fixture','[]');");
    const before = db.prepare('SELECT * FROM Task ORDER BY id').all();
    db.exec(await readFile(new URL(`${name}/migration.sql`, root), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM Task ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM TaskDailyPlan').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec("INSERT INTO Task (id,status) VALUES ('new','paused');");
    assert.equal(db.prepare("SELECT searchDepth FROM Task WHERE id='new'").get().searchDepth, 3);
  } finally { db.close(); }
});
