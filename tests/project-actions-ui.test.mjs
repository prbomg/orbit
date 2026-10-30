import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';

test('project cards expose icon actions, start/pause state, isolated schedule editing and mobile controls', { timeout: 60000 }, async () => {
  const base = process.env.API_TEST_BASE_URL;
  assert.ok(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
  const token = (await authHeaders()).Cookie.split('=')[1];
  const project = { id: 'card-fixture', name: 'Карточка проекта', targetUrl: 'https://example.test/', yandexRegionId: '213', archivedAt: null, scheduleHours: '1'.repeat(168), scheduleTimezone: 'Europe/Moscow', _count: { tasks: 2 } };
  const archived = { ...project, id: 'archived-fixture', name: 'Архивный проект', archivedAt: new Date().toISOString() };
  const commands = [], patches = [], errors = [];
  let status = { state: 'stopped' }, releaseStop;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: base }]);
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      let body = [];
      if (url.pathname === '/api/projects/') body = url.searchParams.has('archived') ? [archived] : [project];
      else if (url.pathname === `/api/projects/${project.id}/run/`) {
        if (request.method() === 'POST') {
          const command = request.postDataJSON(); commands.push(command);
          if (command.action === 'stop') await new Promise(resolve => { releaseStop = resolve; });
          status = { state: command.action === 'start' ? 'running' : 'stopping' };
        }
        body = status;
      } else if (url.pathname === `/api/projects/${project.id}/` && request.method() === 'PATCH') {
        const patch = request.postDataJSON(); patches.push(patch); Object.assign(project, patch); body = project;
      } else if (url.pathname === '/api/system/') body = { workerState: 'stopped', checkedAt: new Date().toISOString(), projectRuns: [], projectRun: null, planMode: 'local' };
      await route.fulfill({ json: body });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/projects/`);
    const start = page.getByRole('button', { name: `Запустить проект ${project.name}`, exact: true });
    await start.waitFor(); await page.waitForFunction(() => !document.querySelector('button[aria-label="Запустить проект Карточка проекта"]')?.disabled);
    const icons = [start, page.getByRole('link', { name: `Открыть проект ${project.name}`, exact: true }), page.getByRole('button', { name: `Настроить расписание проекта ${project.name}`, exact: true }), page.getByRole('button', { name: `Редактировать проект ${project.name}`, exact: true }), page.getByRole('button', { name: `В архив проект ${project.name}`, exact: true }), page.getByRole('button', { name: `Удалить проект ${project.name}`, exact: true })];
    for (const icon of icons) { assert.equal((await icon.innerText()).trim(), ''); assert.ok(await icon.getAttribute('title')); }
    await start.click();
    const pause = page.getByRole('button', { name: `Приостановить проект ${project.name}`, exact: true }); await pause.waitFor();
    assert.deepEqual(commands, [{ action: 'start', visible: false }]);
    await pause.click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Приостановить проект Карточка проекта"]')?.disabled);
    assert.equal(commands.length, 2); assert.deepEqual(commands[1], { action: 'stop' });
    releaseStop(); releaseStop = undefined;
    const stopping = page.getByRole('button', { name: `Приостановка проекта ${project.name}`, exact: true }); await stopping.waitFor(); assert.ok(await stopping.isDisabled());
    status = { state: 'stopped' }; await start.waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: `Настроить расписание проекта ${project.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByRole('textbox', { name: 'Название проекта' }).count(), 0);
    await dialog.getByRole('button', { name: 'Рабочее время', exact: true }).click();
    await dialog.getByLabel('Часовой пояс', { exact: true }).fill('Asia/Yekaterinburg');
    await dialog.getByRole('button', { name: 'Сохранить расписание', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(Object.keys(patches[0]).sort(), ['scheduleHours', 'scheduleTimezone']);
    assert.equal([...patches[0].scheduleHours].filter(bit => bit === '1').length, 60);
    await page.getByRole('button', { name: `Настроить расписание проекта ${project.name}`, exact: true }).click();
    assert.equal(await dialog.getByLabel('Часовой пояс', { exact: true }).inputValue(), 'Asia/Yekaterinburg'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `Удалить проект ${project.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    if (process.env.PROJECT_ACTIONS_SCREENSHOT) await page.screenshot({ path: process.env.PROJECT_ACTIONS_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const icon of icons) { const box = await icon.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390); }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 768, height: 900 });
    for (const icon of icons) { const box = await icon.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 768); }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: `Архив · 1`, exact: true }).click();
    await page.getByRole('button', { name: `Восстановить проект ${archived.name}`, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Запустить проект|Приостановить проект|Настроить расписание проекта/ }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { releaseStop?.(); await browser.close(); }
});
