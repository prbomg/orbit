import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';

test('schedule editor supports presets, click, rectangle painting, keyboard, persistence and mobile touch', { timeout: 60000 }, async () => {
  const base = process.env.API_TEST_BASE_URL;
  assert.ok(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
  const prisma = new PrismaClient(); let browser, project;
  try {
    project = await prisma.project.create({ data: { name: 'Schedule browser fixture', targetUrl: 'https://example.test/', regionName: '', yandexRegionId: '213' } });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const token = (await authHeaders()).Cookie.split('=')[1];
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: base }]);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/projects/${project.id}/`);
    await page.getByRole('button', { name: 'Настроить расписание' }).click();
    const dialog = page.getByRole('dialog'), selected = dialog.locator('[data-schedule-cell][aria-pressed="true"]');
    const expectCount = async expected => { await page.waitForFunction(n => document.querySelectorAll('[role="dialog"] [data-schedule-cell][aria-pressed="true"]').length === n, expected); };
    assert.equal(await selected.count(), 168);
    for (const [name, count] of [['Рабочее время', 60], ['Ежедневно днём', 84], ['Будни', 120], ['Выходные', 48], ['Случайно · 70%', 118], ['Очистить', 0]]) {
      await dialog.getByRole('button', { name, exact: true }).click(); await expectCount(count);
    }
    const first = dialog.locator('[data-schedule-cell="8"]');
    await first.click(); await expectCount(1);
    await first.click(); await expectCount(0);
    const start = await first.boundingBox(), end = await dialog.locator('[data-schedule-cell="58"]').boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 }); await page.mouse.up();
    await expectCount(9);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 }); await page.mouse.up();
    await expectCount(0);
    await first.focus(); await page.keyboard.press('Space'); await expectCount(1);
    await dialog.getByRole('button', { name: 'Рабочее время', exact: true }).click();
    await dialog.getByLabel('Часовой пояс', { exact: true }).fill('Asia/Yekaterinburg');
    if (process.env.SCHEDULE_SCREENSHOT) { await page.waitForTimeout(250); await page.screenshot({ path: process.env.SCHEDULE_SCREENSHOT }); }
    await dialog.getByRole('button', { name: 'Сохранить расписание', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: 'Настроить расписание' }).click(); await expectCount(60);
    assert.equal(await dialog.getByLabel('Часовой пояс', { exact: true }).inputValue(), 'Asia/Yekaterinburg');
    const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    assert.equal([...row.scheduleHours].filter(bit => bit === '1').length, 60);
    // Clear is a persisted prohibition, not an implicit reset to 24/7.
    await dialog.getByRole('button', { name: 'Очистить', exact: true }).click();
    await dialog.getByRole('button', { name: 'Сохранить расписание', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).scheduleHours, '0'.repeat(168));
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.addCookies([{ name: 'orbit_session', value: token, url: base }]);
    const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(`${base}/projects/${project.id}/`); await phone.getByRole('button', { name: 'Настроить расписание' }).tap();
    const mobileDialog = phone.getByRole('dialog');
    const rect = await mobileDialog.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
    const mobileCell = mobileDialog.locator('[data-schedule-cell="0"]'); await mobileCell.tap();
    assert.equal(await mobileCell.getAttribute('aria-pressed'), 'true');
    await mobileDialog.locator('[data-schedule-cell="23"]').scrollIntoViewIfNeeded();
    await mobileDialog.locator('[data-schedule-cell="23"]').tap();
    assert.equal(await mobileDialog.locator('[data-schedule-cell="23"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (project) await prisma.project.delete({ where: { id: project.id } }); await prisma.$disconnect(); }
});
