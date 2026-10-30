import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('task groups: alphabetic projects, collapse, drag, keyboard order, filters, new tasks and mobile', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  let server, browser, output = '';
  try {
    // No proxy/browser workers may be launched by this isolated UI fixture.
    await fixture.db.proxy.deleteMany();
    await fixture.db.project.update({ where: { id: fixture.project.id }, data: { name: 'Альфа' } });
    const other = await fixture.db.project.create({ data: { name: 'Яблоко', targetUrl: 'https://other.test/', yandexRegionId: '213', regionName: '' } });
    const makeTask = (id, date, projectId = fixture.project.id) => fixture.db.task.create({ data: { id, projectId, taskType: 'target', url: `https://example.test/${id}`, status: 'paused', createdAt: new Date(date), targetExecutions: 5 } });
    await makeTask('older', '2026-10-01T12:00:00Z');
    await makeTask('middle', '2026-10-02T12:00:00Z');
    await makeTask('newest', '2026-10-03T12:00:00Z');
    await makeTask('other-task', '2026-10-04T12:00:00Z', other.id);
    const runtime = join(fixture.dir, 'runtime');
    const user = await fixture.db.authUser.create({ data: { email: 'observe@example.test', passwordHash: 'disabled-fixture' } });
    const token = randomBytes(32).toString('hex');
    await fixture.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`, root = resolve(import.meta.dirname, '..');
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env: { ...process.env, DATABASE_URL: `file:${fixture.dir}/test.db`, AUTH_EMAIL: user.email, APP_ORIGIN: origin, ORBIT_LIVE_RUNTIME_DIRECTORY: runtime }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
    for (let n = 0; ; n++) {
      try { if ((await fetch(origin + '/login/')).ok) break; } catch {}
      if (n > 150) throw Error('Fixture startup failed'); await wait(100);
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tasks/`);
    const alpha = page.getByRole('region', { name: 'Задачи проекта Альфа', exact: true });
    const zeta = page.getByRole('region', { name: 'Задачи проекта Яблоко', exact: true });
    const rows = () => alpha.locator('tbody [data-task-id]').evaluateAll(nodes => nodes.map(node => node.dataset.taskId));
    const handle = id => alpha.locator(`[data-task-id="${id}"] button[aria-describedby="task-order-help"]`);
    await handle('newest').waitFor();
    assert.deepEqual(await page.locator('[data-task-project]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Задачи проекта Альфа', 'Задачи проекта Яблоко']);
    assert.deepEqual(await rows(), ['newest', 'middle', 'older']);
    const toggle = alpha.locator('h2 button');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await handle('newest').isVisible(), false);
    await page.reload();
    await toggle.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-task-project] h2 button')?.getAttribute('aria-expanded') === 'false');
    await toggle.click();
    await handle('older').focus();
    await page.keyboard.press('ArrowUp');
    assert.deepEqual(await rows(), ['newest', 'older', 'middle']);
    await page.reload();
    await handle('newest').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-task-project] tbody tr')[1]?.getAttribute('data-task-id') === 'older');
    async function dragTo(source, target) {
      const from = await handle(source).boundingBox();
      const to = await alpha.locator(`[data-task-id="${target}"]`).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
      await page.mouse.up();
    }
    await dragTo('middle', 'newest');
    assert.deepEqual(await rows(), ['middle', 'newest', 'older']);
    // Escape cancels the preview instead of persisting it.
    const from = await handle('older').boundingBox(), to = await handle('middle').boundingBox();
    await page.mouse.move(from.x + 5, from.y + 5); await page.mouse.down();
    await page.mouse.move(to.x + 5, to.y + 5); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await rows(), ['middle', 'newest', 'older']);
    const crossFrom = await handle('older').boundingBox();
    await page.mouse.move(crossFrom.x + 5, crossFrom.y + 5); await page.mouse.down();
    const crossTo = await zeta.locator('[data-task-id="other-task"]').boundingBox();
    await page.mouse.move(crossTo.x + 20, crossTo.y + 20); await page.mouse.up();
    assert.deepEqual(await rows(), ['middle', 'newest', 'older']);
    await page.getByRole('textbox', { name: 'Поиск задач', exact: true }).fill('older');
    assert.deepEqual(await rows(), ['older']);
    await handle('older').press('ArrowUp');
    await page.getByRole('textbox', { name: 'Поиск задач', exact: true }).fill('');
    assert.deepEqual(await rows(), ['middle', 'newest', 'older']);
    await makeTask('added', '2026-10-05T12:00:00Z');
    await page.reload(); await handle('added').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-task-project] tbody tr')?.getAttribute('data-task-id') === 'added');
    assert.deepEqual(await rows(), ['added', 'middle', 'newest', 'older']);
    await alpha.getByRole('button', { name: 'Сбросить порядок задач проекта Альфа' }).click();
    assert.deepEqual(await rows(), ['added', 'newest', 'middle', 'older']);
    await page.setViewportSize({ width: 390, height: 844 });
    await handle('newest').scrollIntoViewIfNeeded();
    assert(await handle('newest').isVisible());
    await handle('newest').press('ArrowUp');
    assert.deepEqual(await rows(), ['newest', 'added', 'middle', 'older']);
    const mobileToggle = alpha.locator('h2 button');
    await mobileToggle.click(); assert.equal(await handle('newest').isVisible(), false);
    await mobileToggle.click(); assert.equal(await handle('newest').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Preferences cannot silently claim persistence when browser storage is unavailable.
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
    await handle('newest').press('ArrowDown');
    await page.getByRole('alert').filter({ hasText: 'Не удалось сохранить порядок в браузере' }).waitFor();
    assert.equal(await fixture.db.task.count({ where: { status: { not: 'paused' } } }), 0);
    assert.deepEqual(errors, []);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally { await browser?.close(); if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); } await fixture.cleanup(); }
});
