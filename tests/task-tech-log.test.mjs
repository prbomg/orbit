import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('technical log: protected stream, missing/empty/unsafe files and UI download', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  const root = resolve(import.meta.dirname, '..');
  let server, browser, output = '', log, orphan;
  try {
    await fixture.db.proxy.deleteMany();
    const task = await fixture.db.task.create({ data: { projectId: fixture.project.id, url: 'https://example.test/', status: 'paused' } });
    const user = await fixture.db.authUser.create({ data: { email: 'tech-log@example.test', passwordHash: 'disabled-fixture' } });
    const token = randomBytes(32).toString('hex');
    await fixture.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env: { ...process.env, DATABASE_URL: `file:${fixture.dir}/test.db`, AUTH_EMAIL: user.email, APP_ORIGIN: origin, ORBIT_LIVE_RUNTIME_DIRECTORY: join(fixture.dir, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
    for (let n = 0; ; n++) {
      try { if ((await fetch(origin + '/login/')).ok) break; } catch {}
      if (n > 150) throw Error('Fixture startup failed'); await wait(100);
    }
    const endpoint = `${origin}/api/tasks/${task.id}/tech-log/`;
    assert.equal((await fetch(endpoint)).status, 401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const request = context.request;
    assert.equal((await request.get(endpoint)).status(), 404);
    assert.equal((await request.get(`${origin}/api/tasks/bad%22id/tech-log/`)).status(), 400);
    const directory = join(root, 'logs', 'tasks'); await mkdir(directory, { recursive: true });
    log = join(directory, `task-${task.id}.txt`);
    orphan = join(directory, `task-orphan-${task.id}.txt`);
    await writeFile(orphan, 'no database task');
    assert.equal((await request.get(`${origin}/api/tasks/orphan-${task.id}/tech-log/`)).status(), 404);
    await mkdir(log);
    assert.equal((await request.get(endpoint)).status(), 404);
    await rm(log, { recursive: true });
    const privateFile = join(fixture.dir, 'private.txt'); await writeFile(privateFile, 'must not be downloaded');
    await symlink(privateFile, log);
    assert.equal((await request.get(endpoint)).status(), 404);
    await rm(log);
    await writeFile(log, '');
    const empty = await request.get(endpoint); assert.equal(empty.status(), 200); assert.equal(await empty.text(), '');
    const text = 'Технический лог ✓\n<script>throw Error("must remain text")</script>\n'.repeat(5000);
    await writeFile(log, text);
    const response = await request.get(endpoint);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers()['content-disposition'], `attachment; filename="task-${task.id}-tech-log.txt"`);
    assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    assert.match(response.headers()['cache-control'], /no-store/);
    assert.equal(Number(response.headers()['content-length']), Buffer.byteLength(text));
    assert.equal(await response.text(), text);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const navigation = await page.goto(`${origin}/tasks/${task.id}/live/`);
    assert.equal(navigation.status(), 200, await page.locator('body').innerText());
    const journalTab = page.getByRole('tab', { name: 'Журнал', exact: true });
    if (await journalTab.isVisible()) await journalTab.click();
    await page.getByRole('heading', { name: 'Журнал выполнения', exact: true }).waitFor();
    const link = page.getByRole('link', { name: 'Скачать лог (.txt)', exact: true });
    assert.equal(await link.getAttribute('href'), `/api/tasks/${task.id}/tech-log/`);
    assert.equal(await link.getAttribute('download'), `task-${task.id}-tech-log.txt`);
    const downloaded = page.waitForEvent('download'); await link.click(); const download = await downloaded;
    assert.equal(download.suggestedFilename(), `task-${task.id}-tech-log.txt`);
    assert.equal(await readFile(await download.path(), 'utf8'), text);
    await page.setViewportSize({ width: 390, height: 844 });
    if (await journalTab.isVisible()) await journalTab.click();
    await link.scrollIntoViewIfNeeded();
    assert(await link.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.equal((await fixture.db.task.findUnique({ where: { id: task.id } })).status, 'paused');
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    if (log) await rm(log, { recursive: true, force: true });
    if (orphan) await rm(orphan, { force: true });
    await fixture.cleanup();
  }
});
