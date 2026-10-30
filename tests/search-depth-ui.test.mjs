import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('search depth: API boundaries/defaults, create/edit persistence and mobile form', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  let server, browser, output = '';
  try {
    await fixture.db.proxy.deleteMany();
    const user = await fixture.db.authUser.create({ data: { email: 'depth@example.test', passwordHash: 'disabled-fixture' } });
    const token = randomBytes(32).toString('hex');
    await fixture.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`, root = resolve(import.meta.dirname, '..');
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env: { ...process.env, DATABASE_URL: `file:${fixture.dir}/test.db`, AUTH_EMAIL: user.email, APP_ORIGIN: origin, ORBIT_LIVE_RUNTIME_DIRECTORY: join(fixture.dir, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
    for (let n = 0; ; n++) {
      try { if ((await fetch(origin + '/login/')).ok) break; } catch {}
      if (n > 150) throw Error('Fixture startup failed'); await wait(100);
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const request = (path, method, data) => context.request.fetch(origin + path, { method, data, headers: { Origin: origin } });
    const base = { projectId: fixture.project.id, taskType: 'target', searchEngine: 'yandex', searchQueries: ['fixture'], status: 'paused' };
    const created = await request('/api/tasks/', 'POST', base);
    assert.equal(created.status(), 201);
    const legacy = await created.json();
    assert.equal(legacy.searchDepth, 3);
    for (const searchDepth of [0, 11, 1.5, null, '5']) {
      for (const method of ['POST', 'PUT', 'PATCH']) {
        const response = await request(method === 'POST' ? '/api/tasks/' : `/api/tasks/${legacy.id}/`, method, method === 'POST' ? { ...base, searchDepth } : { searchDepth });
        assert.equal(response.status(), 400, `${method} rejected ${JSON.stringify(searchDepth)}`);
      }
    }
    for (const [method, searchDepth] of [['PATCH', 1], ['PUT', 10]]) {
      const response = await request(`/api/tasks/${legacy.id}/`, method, { searchDepth });
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).searchDepth, searchDepth);
    }
    const omitted = await request(`/api/tasks/${legacy.id}/`, 'PATCH', { status: 'paused' });
    assert.equal((await omitted.json()).searchDepth, 10);
    await request(`/api/tasks/${legacy.id}/`, 'PATCH', { searchDepth: 5 });

    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tasks/`);
    const row = page.locator(`[data-task-id="${legacy.id}"]`);
    const edit = () => row.getByRole('button', { name: /^Редактировать / }).click();
    await edit();
    const dialog = page.getByRole('dialog'), depth = dialog.getByLabel('Глубина поиска, страниц');
    assert.equal(await depth.inputValue(), '5');
    for (const value of ['0', '11', '1.5', '']) {
      await depth.fill(value);
      assert.equal(await depth.evaluate(el => el.checkValidity()), false);
    }
    await depth.fill('10');
    await dialog.getByRole('button', { name: 'Сохранить изменения' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await fixture.db.task.findUnique({ where: { id: legacy.id } })).searchDepth, 10);
    await page.reload(); await edit();
    assert.equal(await depth.inputValue(), '10');
    await page.setViewportSize({ width: 390, height: 844 });
    await depth.scrollIntoViewIfNeeded();
    assert(await depth.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await depth.fill('1');
    await dialog.getByRole('button', { name: 'Сохранить изменения' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await fixture.db.task.findUnique({ where: { id: legacy.id } })).searchDepth, 1);
    await row.getByText('Параметры задачи', { exact: true }).click();
    await row.getByText('Глубина поиска: 1 стр.', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await dialog.getByLabel('Проект новой задачи').selectOption(fixture.project.id);
    await dialog.getByLabel('Поиск сайта', { exact: false }).check();
    assert.equal(await depth.inputValue(), '3');
    await dialog.getByLabel('Поисковые фразы', { exact: true }).fill('ui fixture');
    await depth.fill('7');
    await dialog.getByLabel('Статус задачи').selectOption('paused');
    await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const tasks = await fixture.db.task.findMany();
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find(task => task.id !== legacy.id).searchDepth, 7);
    assert.ok(tasks.every(task => task.status === 'paused'));
    assert.deepEqual(errors, []);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fixture.cleanup();
  }
});
