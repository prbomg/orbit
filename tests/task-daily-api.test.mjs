import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';

const base = process.env.API_TEST_BASE_URL;
if (!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw new Error('Local API_TEST_BASE_URL required');
async function call(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...await authHeaders(), 'Content-Type': 'application/json', Origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
test('task API defaults to unlimited and accepts/removes daily limits without changing counts or pause state', async () => {
  const db = new PrismaClient(); let project;
  try {
    project = await db.project.create({ data: { name: 'Daily API fixture', targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
    const created = await call('/api/tasks/', 'POST', { projectId: project.id, targetExecutions: 300, status: 'paused' });
    assert.equal(created.status, 201); assert.equal(created.body.dailyExecutionLimit, null);
    const id = created.body.id;
    for (const value of [0,-1,2.5,10001,'-', '50']) {
      assert.equal((await call(`/api/tasks/${id}/`, 'PATCH', { dailyExecutionLimit: value })).status, 400);
    }
    const changed = await call(`/api/tasks/${id}/`, 'PATCH', { dailyExecutionLimit: 50 });
    assert.equal(changed.status, 200); assert.equal(changed.body.dailyExecutionLimit, 50);
    assert.equal(changed.body.currentExecutions, 0); assert.equal(changed.body.targetExecutions, 300); assert.equal(changed.body.status, 'paused');
    assert.equal(changed.body.dailyExecutionsToday, 0); assert.equal(changed.body.nextExecutionAt, null);
    const list = await call(`/api/tasks/?projectId=${project.id}`);
    assert.equal(list.body[0].dailyExecutionLimit, 50);
    assert.equal((await call(`/api/tasks/${id}/`, 'PATCH', { dailyExecutionLimit: null })).body.dailyExecutionLimit, null);
  } finally { if (project) { await db.task.deleteMany({ where: { projectId: project.id } }); await db.project.delete({ where: { id: project.id } }); } await db.$disconnect(); }
});

test('task editor displays the dash, saves a daily limit and clears it; task list shows the daily value', { timeout: 60000 }, async () => {
  const db = new PrismaClient(); let project, browser;
  try {
    project = await db.project.create({ data: { name: 'Daily UI fixture', targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
    const task = await db.task.create({ data: { projectId: project.id, targetExecutions: 300, url: project.targetUrl, status: 'paused' } });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: (await authHeaders()).Cookie.split('=')[1], url: base }]);
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/projects/${project.id}/`);
    await page.getByRole('button', { name: /^Редактировать / }).click();
    let dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByLabel('Выполнений в день', { exact: true }).inputValue(), '-');
    assert.ok(await dialog.getByText('«-» или пустое поле', { exact: false }).isVisible());
    await dialog.getByLabel('Выполнений в день', { exact: true }).fill('50');
    await dialog.getByRole('button', { name: 'Сохранить изменения' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await db.task.findUnique({ where: { id: task.id } })).dailyExecutionLimit, 50);
    await page.locator('.task-parameters>summary').click();
    assert.ok(await page.getByText('В день: 50', { exact: false }).isVisible());
    await page.getByRole('button', { name: /^Редактировать / }).click();
    dialog = page.getByRole('dialog'); assert.equal(await dialog.getByLabel('Выполнений в день', { exact: true }).inputValue(), '50');
    await dialog.getByLabel('Выполнений в день', { exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Сохранить изменения' }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await db.task.findUnique({ where: { id: task.id } })).dailyExecutionLimit, null);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^Редактировать / }).click();
    assert.ok(await page.getByRole('dialog').getByLabel('Выполнений в день', { exact: true }).isVisible());
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (project) { await db.task.deleteMany({ where: { projectId: project.id } }); await db.project.delete({ where: { id: project.id } }); } await db.$disconnect(); }
});
