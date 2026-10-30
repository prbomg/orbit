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
test('analytics: IP API batches, searchable project selector, reload and responsive layout', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  let server, browser, output = '';
  try {
    // No proxy/browser workers may be launched by this isolated UI fixture.
    await fixture.db.proxy.deleteMany();
    const longName = 'Альфа — ' + 'ОченьДлинноеНазваниеПроектаБезПробелов'.repeat(5);
    await fixture.db.project.update({ where: { id: fixture.project.id }, data: { name: longName } });
    const other = await fixture.db.project.create({ data: { name: 'Яблоко', targetUrl: 'https://other.test/', yandexRegionId: '213', regionName: '', archivedAt: new Date() } });
    for (let index = 0; index < 35; index++) await fixture.db.project.create({ data: { name: `Проект ${index}`, targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
    const task = await fixture.db.task.create({ data: { projectId: fixture.project.id, status: 'paused' } });
    const runtime = join(fixture.dir, 'runtime'), live = join(runtime, 'live', 'analytics-fixture');
    await mkdir(live, { recursive: true });
    for (let index = 0; index < 55; index++) {
      const profile = await fixture.db.profile.create({ data: { name: `Fixture ${index}` } });
      const startedAt = new Date(Date.now() - 120000 - index * 60000), measured = new Date(+startedAt + 1000);
      const execution = await fixture.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'failed', errorCode: 'execution_failed', startedAt, completedAt: new Date(+startedAt + 2000) } });
      await writeFile(join(live, `${execution.id}.jsonl`), JSON.stringify({ time: measured.toISOString(), event: 'proxy_ip_observed', browserIp: `198.51.100.${index + 1}`, routeComparison: 'differs_from_worker' }) + '\n');
    }
    for (const status of ['completed', 'failed']) {
      const profile = await fixture.db.profile.create({ data: { name: 'Excluded ' + status } });
      await fixture.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status, errorCode: status === 'failed' ? 'stopped' : null, startedAt: new Date(Date.now() - 5000), completedAt: new Date() } });
    }
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
    const headers = { Cookie: `orbit_session=${token}` };
    assert.equal((await fetch(origin + '/api/diagnostics/')).status, 401);
    for (const key of ['ipLimit', 'recentLimit']) for (const limit of ['0', '26', '5001', 'bad']) assert.equal((await fetch(origin + '/api/diagnostics/?' + key + '=' + limit, { headers })).status, 400);
    const summary = await (await fetch(origin + '/api/diagnostics/', { headers })).json();
    assert.equal(summary.stats.ips.length, 25); assert.equal(summary.ipPage.total, 55);
    assert.equal(summary.stats.ips[0].ip, '198.51.100.1');
    assert.equal(summary.recent.length, 25); assert.equal(summary.recentPage.total, 55);
    const moreErrors = await (await fetch(origin + '/api/diagnostics/?recentLimit=50', { headers })).json();
    assert.equal(moreErrors.recent.length, 50); assert.equal(moreErrors.stats.ips.length, 25);
    assert.deepEqual(moreErrors.recent.slice(0,25),summary.recent);
    assert(moreErrors.recent.every(item => item.errorCode !== 'stopped'));
    const second = await (await fetch(origin + '/api/diagnostics/?ipLimit=50', { headers })).json();
    assert.equal(second.stats.ips.length, 50); assert.deepEqual(second.stats.ips.slice(0, 25), summary.stats.ips);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/analytics/?tab=attempts&section=network`);
    const ips = page.getByRole('region', { name: 'Фактические IP браузера', exact: true });
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByText('Показано 25 из 55', { exact: true }).waitFor();
    assert.equal(await ips.locator('tbody tr').count(), 25);
    const failures = page.getByRole('region', { name: 'Последние неуспешные попытки', exact: true });
    await page.getByRole('button', { name: 'Ошибки и проекты', exact: true }).click();
    await failures.getByText('Показано 25 из 55', { exact: true }).waitFor();
    await failures.getByRole('button', { name: 'Загрузить ещё 25' }).click();
    await failures.getByText('Показано 50 из 55', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    assert.equal(await ips.locator('tbody tr').count(), 25);
    await page.getByRole('button', { name: 'Ошибки и проекты', exact: true }).click();
    await failures.getByRole('button', { name: 'Загрузить ещё 25' }).click();
    await failures.getByText('Показано 55 из 55', { exact: true }).waitFor();
    assert.equal(await failures.getByRole('button', { name: 'Загрузить ещё 25' }).count(), 0);

    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByRole('button', { name: 'Загрузить ещё 25' }).click();
    await ips.getByText('Показано 50 из 55', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByRole('button', { name: 'Загрузить ещё 25' }).click();
    await ips.getByText('Показано 55 из 55', { exact: true }).waitFor();
    assert.equal(await ips.getByRole('button', { name: 'Загрузить ещё 25' }).count(), 0);
    await page.getByRole('button', { name: '30 дней', exact: true }).click();
    await page.getByRole('button', { name: 'Ошибки и проекты', exact: true }).click();
    await failures.getByText('Показано 25 из 55', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByText('Показано 25 из 55', { exact: true }).waitFor();
    const trigger = () => page.getByRole('button', { name: /^Выбрать проект:/ });
    await trigger().click();
    const search = page.getByRole('combobox', { name: 'Поиск проекта' });
    await search.fill('яблоко');
    await search.press('ArrowDown'); await search.press('Enter');
    await ips.getByText('Показано 0 из 0', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Ошибки и проекты', exact: true }).click();
    await failures.getByText('Показано 0 из 0', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    assert(new URL(page.url()).searchParams.get('projectId') === other.id);
    await trigger().click(); await search.fill('несуществующий');
    await page.getByText('Проекты не найдены.', { exact: true }).waitFor();
    await search.press('Escape'); assert.equal(await search.count(), 0);
    await trigger().click(); await search.fill('альфа');
    await page.getByRole('option', { name: longName, exact: true }).click();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByText('Показано 25 из 55', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.reload(); await ips.getByText('Показано 25 из 55', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('projectId'), fixture.project.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger().click();
    const list = page.getByRole('listbox', { name: 'Проекты', exact: true });
    assert(await list.evaluate(node => node.scrollHeight > node.clientHeight));
    const bounds = await page.getByRole('dialog', { name: 'Выбор проекта' }).boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert(bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await page.getByRole('option', { name: 'Все проекты', exact: true }).click();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByText('Показано 25 из 55', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Прокси и IP', exact: true }).click();
    await ips.getByRole('button', { name: 'Загрузить ещё 25' }).click();
    await ips.getByText('Показано 50 из 55', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally { await browser?.close(); if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); } await fixture.cleanup(); }
});
