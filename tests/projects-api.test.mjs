import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = process.env.API_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('API_TEST_BASE_URL must point to a local server');
async function call(path, method = 'GET', body, origin = new URL(base).origin) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

test('project CRUD stores string region IDs and updates timestamps', async () => {
  let id;
  try {
    const created = await call('/api/projects/', 'POST', { name: `QA ${randomUUID()}`, targetUrl: 'https://example.test/site', yandexRegionId: '213' });
    assert.equal(created.status, 201); id = created.data.id;
    assert.equal(created.data.yandexRegionId, '213');
    assert.equal(created.data.targetUrl, 'https://example.test/site');
    assert.ok(created.data.updatedAt);
    const item = await call(`/api/projects/${id}/`);
    assert.equal(item.status, 200); assert.equal(item.data._count.tasks, 0);
    assert.ok((await call('/api/projects/')).data.some(project => project.id === id));
    const changed = await call(`/api/projects/${id}/`, 'PATCH', { name: 'Updated QA', yandexRegionId: '2' });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.yandexRegionId, '2');
    assert.equal(changed.data.targetUrl, created.data.targetUrl);
    assert.ok(Date.parse(changed.data.updatedAt) >= Date.parse(created.data.updatedAt));
    assert.equal((await call(`/api/projects/${id}/`, 'DELETE')).status, 204);
    assert.equal((await call(`/api/projects/${id}/`)).status, 404);
    assert.equal((await call(`/api/projects/${id}/`, 'DELETE')).status, 404); id = undefined;
  } finally { if (id) await call(`/api/projects/${id}/`, 'DELETE'); }
});

test('projects validate fields and reject cross-origin changes', async () => {
  const valid = { name: 'Validation fixture', targetUrl: 'https://example.test', yandexRegionId: '213' };
  for (const invalid of [{ name: '' }, { targetUrl: 'javascript:alert(1)' }, { targetUrl: 'https://user:password@example.test' }, { yandexRegionId: 213 }, { yandexRegionId: '0' }, { yandexRegionId: 'ABC' }, { yandexRegionId: '9999999999' }]) {
    assert.equal((await call('/api/projects/', 'POST', { ...valid, ...invalid })).status, 400);
  }
  assert.equal((await call('/api/projects/', 'POST', valid, 'https://untrusted.invalid')).status, 403);
});

test('project deletion preserves linked tasks and history', async () => {
  const prisma = new PrismaClient(); let project; let profile; let task;
  try {
    project = await prisma.project.create({ data: { name: 'Deletion fixture', targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
    profile = await prisma.profile.create({ data: { name: 'Deletion fixture' } });
    task = await prisma.task.create({ data: { projectId: project.id, profileId: profile.id, status: 'paused', url: 'https://example.test/' } });
    assert.equal((await call(`/api/projects/${project.id}/`, 'DELETE')).status, 409);
    await prisma.task.delete({ where: { id: task.id } }); task = null;
    await prisma.projectProfileUse.create({ data: { projectId: project.id, profileId: profile.id } });
    assert.equal((await call(`/api/projects/${project.id}/`, 'DELETE')).status, 409);
    await prisma.projectProfileUse.deleteMany({ where: { projectId: project.id } });
    await prisma.profileProjectHistory.create({ data: { projectId: project.id, profileId: profile.id } });
    assert.equal((await call(`/api/projects/${project.id}/`, 'DELETE')).status, 409);
    assert.ok(await prisma.project.findUnique({ where: { id: project.id } }));
  } finally {
    if (task) await prisma.task.delete({ where: { id: task.id } });
    if (project) { await prisma.projectProfileUse.deleteMany({ where: { projectId: project.id } }); await prisma.profileProjectHistory.deleteMany({ where: { projectId: project.id } }); await prisma.project.delete({ where: { id: project.id } }); }
    if (profile) await prisma.profile.delete({ where: { id: profile.id } });
    await prisma.$disconnect();
  }
});

test('project tasks store plans, inherit the project domain, and keep progress read-only', async () => {
  const prisma = new PrismaClient(); let project; let task; let profileId;
  try {
    project = await prisma.project.create({ data: { name: 'Task architecture fixture', targetUrl: 'https://project.example.test/catalog', yandexRegionId: '213', regionName: '' } });
    const created = await call('/api/tasks/', 'POST', { projectId: project.id, targetExecutions: 3, status: 'paused' });
    assert.equal(created.status, 201); task = created.data; profileId = task.profileId;
    assert.equal(task.currentExecutions, 0); assert.equal(task.targetExecutions, 3);
    assert.equal(task.url, project.targetUrl); assert.equal(task.project.id, project.id); assert.ok(!('targetDomain' in task));
    const rows = (await call(`/api/tasks/?projectId=${project.id}`)).data;
    assert.deepEqual(rows.map(row => row.id), [task.id]);
    assert.equal((await call(`/api/tasks/${task.id}/`, 'PATCH', { targetExecutions: 5 })).data.targetExecutions, 5);
    assert.equal((await call(`/api/tasks/${task.id}/`, 'PATCH', { currentExecutions: 99 })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { projectId: project.id, targetDomain: 'other.test' })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { projectId: project.id, targetExecutions: 0 })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { url: project.targetUrl })).status, 400);
    await prisma.task.update({ where: { id: task.id }, data: { currentExecutions: 5, status: 'completed' } });
    assert.equal((await call(`/api/tasks/${task.id}/`, 'PATCH', { status: 'running' })).status, 400);
    assert.equal((await call(`/api/tasks/${task.id}/`, 'PATCH', { targetExecutions: 4 })).status, 400);
    assert.equal((await call(`/api/tasks/${task.id}/`, 'PATCH', { targetExecutions: 6, status: 'running' })).status, 200);
  } finally {
    if (task) await prisma.task.delete({ where: { id: task.id } });
    if (project) await prisma.project.delete({ where: { id: project.id } });
    if (profileId) await prisma.profile.delete({ where: { id: profileId } });
    await prisma.$disconnect();
  }
});

test('profile statuses and warmup metadata follow the new schema', async () => {
  const created = await call('/api/profiles/', 'POST', { name: 'Status architecture fixture' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const prisma = new PrismaClient();
  try {
    assert.equal(created.data.status, 'new'); assert.equal(created.data.warmupScore, 0);
    for (const status of ['warming_up', 'ready', 'banned', 'new']) assert.equal((await call(`/api/profiles/${id}/`, 'PATCH', { status })).data.status, status);
    const warmup = await call('/api/tasks/', 'POST', { taskType: 'warmup', profileId: id, status: 'paused' });
    assert.equal(warmup.status, 201);
    try { assert.equal((await prisma.profile.findUniqueOrThrow({ where: { id } })).status, 'warming_up'); }
    finally { await call(`/api/tasks/${warmup.data.id}/`, 'DELETE'); }
    assert.equal((await prisma.profile.findUniqueOrThrow({ where: { id } })).status, 'new');
    assert.equal((await call(`/api/profiles/${id}/`, 'PATCH', { status: 'active' })).status, 400);
    assert.equal((await call(`/api/profiles/${id}/`, 'PATCH', { warmupScore: 99 })).status, 400);
    assert.equal((await call(`/api/profiles/${id}/`, 'PATCH', { isEnabled: false })).data.isEnabled, false);
  } finally { await prisma.profile.delete({ where: { id } }); await prisma.$disconnect(); }
});
