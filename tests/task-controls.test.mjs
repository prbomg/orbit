import test from 'node:test';
import assert from 'node:assert/strict';
import controls from '../utils/taskControls.js';

function fixture({ status = 'running', attempts = 2, finish = true } = {}) {
  let time = 0;
  const writes = [], task = { status, currentExecutions: 68, targetExecutions: 300, retryState: { retryAfter: '2099-01-01T00:00:00Z' } };
  return { task, writes, options: {
    now: () => time, stopTimeoutMs: 1000,
    wait: async ms => { time += ms; if (finish) attempts--; },
    fetchImpl: async (path, options) => {
      assert.equal(path, '/api/tasks/task-1/');
      if (options.method === 'PATCH') { const body = JSON.parse(options.body); writes.push(body); task.status = body.status; }
      return Response.json({ ...task, executions: Array.from({ length: Math.max(0, attempts) }, () => ({ status: 'running' })) });
    },
  } };
}

test('restart pauses all concurrent attempts before resuming, preserving counts and retry deadline', async () => {
  const f = fixture();
  const result = await controls.controlTask('task-1', 'restart', f.options);
  assert.deepEqual(f.writes, [{ status: 'paused' }, { status: 'running' }]);
  assert.equal(result.currentExecutions, 68); assert.equal(result.targetExecutions, 300);
  assert.deepEqual(f.task.retryState, { retryAfter: '2099-01-01T00:00:00Z' });
});
test('restart timeout leaves task paused and does not launch a second attempt', async () => {
  const f = fixture({ finish: false });
  await assert.rejects(controls.controlTask('task-1', 'restart', f.options), /оставлена на паузе/);
  assert.deepEqual(f.writes, [{ status: 'paused' }]);
});
test('restart on failed task uses normal failed-to-running API semantics', async () => {
  const f = fixture({ status: 'failed', attempts: 0 });
  await controls.controlTask('task-1', 'restart', f.options);
  assert.deepEqual(f.writes, [{ status: 'running' }]);
});
test('restart on paused task waits for a still-stopping attempt', async () => {
  const f = fixture({ status: 'paused', attempts: 1 });
  await controls.controlTask('task-1', 'restart', f.options);
  assert.deepEqual(f.writes, [{ status: 'running' }]);
});
test('completed plan cannot restart or reset progress', async () => {
  const f = fixture(); f.task.currentExecutions = 300;
  await assert.rejects(controls.controlTask('task-1', 'restart', f.options), /План уже выполнен/);
  assert.deepEqual(f.writes, []);
});
test('abort while stopping never resumes a paused task', async () => {
  const f = fixture(), controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.wait = async () => controller.abort();
  await assert.rejects(controls.controlTask('task-1', 'restart', f.options), { name: 'AbortError' });
  assert.deepEqual(f.writes, [{ status: 'paused' }]);
});
test('missing attempt state fails closed', async () => {
  const f = fixture({ status: 'paused' });
  f.options.fetchImpl = async () => Response.json(f.task);
  await assert.rejects(controls.controlTask('task-1', 'restart', f.options), /Не получено состояние попыток/);
});
test('commands propagate API rejection and perform no subsequent write', async () => {
  let calls = 0;
  await assert.rejects(controls.controlTask('task-1', 'restart', { fetchImpl: async () => {
    calls++; return Response.json({ error: 'Нет доступа' }, { status: 403 });
  } }), /Нет доступа/);
  assert.equal(calls, 1);
});
test('start and pause reuse the existing task status API', async () => {
  const f = fixture({ status: 'paused' });
  await controls.controlTask('task-1', 'start', f.options);
  await controls.controlTask('task-1', 'pause', f.options);
  assert.deepEqual(f.writes, [{ status: 'running' }, { status: 'paused' }]);
});
test('restart does not override a concurrent change from another window', async () => {
  const f = fixture();
  f.options.wait = async () => { f.task.status = 'running'; };
  await assert.rejects(controls.controlTask('task-1', 'restart', f.options), /другом окне/);
  assert.deepEqual(f.writes, [{ status: 'paused' }]);
});
