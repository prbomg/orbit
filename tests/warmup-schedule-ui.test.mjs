import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';
import schedule from '../utils/projectSchedule.js';

test('warmup schedule validates API writes, persists independently, and renders on mobile', { timeout: 60000 }, async () => {
  const base = process.env.API_TEST_BASE_URL;
  assert.ok(base && new URL(base).hostname === '127.0.0.1');
  const headers = { ...await authHeaders(), 'Content-Type': 'application/json' };
  const read = async () => (await fetch(`${base}/api/settings/`, { headers })).json();
  const patch = body => fetch(`${base}/api/settings/`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const original = await read(); let browser;
  try {
    for (const fields of [{ warmupScheduleHours: '1' }, { warmupScheduleHours: 'x'.repeat(168) }, { warmupScheduleTimezone: 'Invalid/Zone' }, { warmupScheduleHours: null }]) assert.equal((await patch(fields)).status, 400);
    assert.equal((await patch({ warmupScheduleHours: schedule.preset('clear'), warmupScheduleTimezone: 'UTC', expectedUpdatedAt: original.updatedAt })).status, 200);
    assert.equal((await patch({ warmupScheduleHours: schedule.ALL_HOURS, expectedUpdatedAt: original.updatedAt })).status, 409);
    const closed = await read(); assert.equal(closed.warmupScheduleAllowed, false); assert.equal(closed.warmupConcurrency, original.warmupConcurrency);
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: headers.Cookie.split('=')[1], url: base }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/profiles/`);
    await page.getByText('Прогрев ожидает разрешённых часов', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Управление профилями' }).getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('navigation', { name: 'Разделы настроек профилей' }).getByRole('button', { name: 'Подготовка', exact: true }).click();
    await page.getByText('Изменить дни, часы и часовой пояс', { exact: true }).click();
    const editor = page.getByRole('group', { name: 'Расписание прогрева профилей' });
    await editor.getByRole('button', { name: 'Ежедневно ночью', exact: true }).click();
    assert.equal(await editor.locator('[data-schedule-cell][aria-pressed=true]').count(), 84);
    await editor.getByLabel('Часовой пояс', { exact: true }).fill('Asia/Yekaterinburg');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/settings/') && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click(); assert.equal((await saved).status(), 200);
    assert.equal((await read()).warmupScheduleHours, schedule.preset('night'));
    assert.equal((await read()).warmupScheduleTimezone, 'Asia/Yekaterinburg');
    await page.reload();
    await page.getByRole('navigation', { name: 'Управление профилями' }).getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('navigation', { name: 'Разделы настроек профилей' }).getByRole('button', { name: 'Подготовка', exact: true }).click();
    await page.getByText('Изменить дни, часы и часовой пояс', { exact: true }).click();
    await editor.waitFor(); assert.equal(await editor.locator('[data-schedule-cell][aria-pressed=true]').count(), 84);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await patch({ warmupScheduleHours: original.warmupScheduleHours, warmupScheduleTimezone: original.warmupScheduleTimezone });
  }
});
