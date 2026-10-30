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
test('task observation: controls preserve progress; query is escaped; diagnostics follow statistics on desktop and mobile', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  let server, browser, output = '';
  try {
    // No proxy/browser workers may be launched by this isolated UI fixture.
    await fixture.db.proxy.deleteMany();
    const task = await fixture.db.task.create({ data: { projectId: fixture.project.id, taskType: 'target', url: fixture.project.targetUrl, status: 'paused', currentExecutions: 2, targetExecutions: 5 } });
    const profile = await fixture.db.profile.create({ data: { name: 'Observation fixture', status: 'ready' } });
    const startedAt = new Date(Date.now() - 10000);
    const execution = await fixture.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'failed', startedAt, completedAt: new Date(), errorCode: 'stopped' } });
    const runtime = join(fixture.dir, 'runtime'), live = join(runtime, 'live', 'observation-fixture');
    await mkdir(live, { recursive: true });
    const searchQuery = 'купить коляску <script>window.queryInjected=true</script>';
    await writeFile(join(live, `${execution.id}.jsonl`), JSON.stringify({ time: new Date(startedAt.getTime() + 1000).toISOString(), event: 'search_input_typing', query: searchQuery, method: 'composition' }) + '\n');
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
    assert.equal((await fetch(`${origin}/api/tasks/${task.id}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"status":"running"}' })).status, 401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tasks/${task.id}/live/`);
    await page.getByText(`Ввод запроса: ${searchQuery}`, { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => window.queryInjected), undefined);
    assert.deepEqual(await page.locator('[role="tabpanel"]').evaluateAll(nodes => nodes.map(n => n.id)), ['observe-panel-screen', 'observe-panel-journal', 'observe-panel-stats', 'observe-panel-diagnostics']);
    const commands = page.getByRole('group', { name: 'Управление заданием' });
    await commands.getByRole('button', { name: 'Старт', exact: true }).click();
    await page.getByText('Задача запущена.', { exact: false }).waitFor();
    assert.equal((await fixture.db.task.findUnique({ where: { id: task.id } })).status, 'running');
    await commands.getByRole('button', { name: 'Пауза', exact: true }).click();
    await page.getByText('Задача приостановлена.', { exact: false }).waitFor();
    assert.equal((await fixture.db.task.findUnique({ where: { id: task.id } })).status, 'paused');
    const patches = []; page.on('request', request => { if (request.url() === `${origin}/api/tasks/${task.id}/` && request.method() === 'PATCH') patches.push(request.postDataJSON()); });
    await commands.getByRole('button', { name: 'Перезапуск', exact: true }).click();
    await page.getByText('Перезапуск запрошен.', { exact: false }).waitFor();
    assert.deepEqual(patches, [{ status: 'running' }]);
    await commands.getByRole('button', { name: 'Перезапуск', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Управление заданием"] button:last-of-type')?.textContent === 'Перезапуск');
    assert.deepEqual(patches.slice(-2), [{ status: 'paused' }, { status: 'running' }]);
    const saved = await fixture.db.task.findUnique({ where: { id: task.id } });
    assert.equal(saved.currentExecutions, 2); assert.equal(saved.targetExecutions, 5);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ['Старт', 'Пауза', 'Перезапуск']) assert(await commands.getByRole('button', { name, exact: true }).isVisible());
    const tabs = page.getByRole('tablist', { name: 'Разделы наблюдения' });
    assert.equal(await tabs.getByRole('tab').last().innerText(), 'Диагностика');
    await tabs.getByRole('tab', { name: 'Диагностика', exact: true }).click();
    assert(await page.getByRole('heading', { name: 'Диагностика попытки' }).isVisible());
    await tabs.getByRole('tab', { name: 'Журнал', exact: true }).click();
    assert(await page.getByText(`Ввод запроса: ${searchQuery}`, { exact: true }).last().isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally { await browser?.close(); if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); } await fixture.cleanup(); }
});
