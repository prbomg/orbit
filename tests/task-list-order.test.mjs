import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTasks, groupTasks, moveTask, readTaskListPreferences } from '../utils/taskListOrder.js';
const row = (id, day, projectId = 'alpha', name = 'Альфа') => ({ id, projectId, project: { name }, createdAt: `2026-10-${day}T00:00:00Z` });

test('project groups are alphabetical and tasks default to newest first without mutating inputs', () => {
  const tasks = [row('old', 10), row('z', 20, 'zeta', 'Яблоко'), row('new', 21)];
  assert.deepEqual(groupTasks(tasks).map(group => group.name), ['Альфа', 'Яблоко']);
  assert.deepEqual(orderTasks(tasks.filter(task => task.projectId === 'alpha')).map(task => task.id), ['new', 'old']);
  assert.deepEqual(tasks.map(task => task.id), ['old', 'z', 'new']);
});

test('manual order survives refresh, ignores deleted ids and prepends newly added tasks', () => {
  assert.deepEqual(orderTasks([row('a', 10), row('b', 12), row('c', 20), row('d', 21)], ['a', 'deleted', 'b']).map(task => task.id), ['d', 'c', 'a', 'b']);
});

test('moves retain filtered tasks and cannot move tasks between projects', () => {
  const tasks = [row('a', 21), row('hidden', 20), row('b', 19), row('other', 18, 'other')];
  assert.deepEqual(moveTask(tasks, 'a', 'b').map(task => task.id), ['hidden', 'b', 'a', 'other']);
  assert.equal(moveTask(tasks, 'a', 'other'), tasks);
  assert.equal(moveTask(tasks, 'missing', 'a'), tasks);
  assert.equal(moveTask(tasks, 'a', 'a'), tasks);
});

test('layout preferences survive serialization and tolerate corrupt browser storage', () => {
  const state = { version: 1, collapsed: ['alpha'], orders: { alpha: ['b', 'a'] } };
  assert.deepEqual(readTaskListPreferences(JSON.stringify(state)), state);
  for (const text of [null, '{', 'null', '{"version":2}', '{"version":1,"collapsed":[],"orders":{"alpha":"bad"}}']) {
    assert.deepEqual(readTaskListPreferences(text), { version: 1, collapsed: [], orders: {} });
  }
});
