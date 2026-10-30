import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { inspectZip } from './helpers/zip-inspect.mjs';
import { UPLOAD_LIMIT } from '../utils/projectFiles.js';

const root = resolve(import.meta.dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('file manager API and UI: authorization, edit conflicts, downloads, trash, restore and mobile layout', { timeout: 120000 }, async () => {
  const fixture = await poolFixture();
  let server, browser, output = '';
  try {
    const files = join(fixture.dir, 'source'), history = join(fixture.dir, 'private-history');
    await mkdir(files); await mkdir(join(files, 'worker'));
    await writeFile(join(files, 'worker', 'sample.mjs'), 'export const example = 1;\n');
    await writeFile(join(files, 'readme.txt'), 'Example project\n');
    await writeFile(join(files, 'binary.dat'), Buffer.from([0, 1, 255]));
    await symlink('/etc', join(files, 'outside'));
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString('hex');
    const user = await fixture.db.authUser.create({ data: { email: 'files@example.test', passwordHash: 'disabled-fixture' } });
    await fixture.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env: { ...process.env, DATABASE_URL: `file:${fixture.dir}/test.db`, AUTH_EMAIL: user.email, APP_ORIGIN: origin, ORBIT_FILES_ROOT: files, ORBIT_FILES_HISTORY_DIRECTORY: history, WORKER_PROFILES_DIR: join(fixture.dir, 'profiles'), ORBIT_COOKIE_MIN_AGE_HOURS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
    for (let i = 0; ; i++) {
      try { if ((await fetch(origin + '/login/')).ok) break; } catch {}
      if (i === 150) throw new Error('Fixture did not start');
      await wait(100);
    }
    const api = origin + '/api/system/files/', headers = { Cookie: `orbit_session=${token}`, Origin: origin, 'Content-Type': 'application/json' };
    const get = async query => { const response = await fetch(api + '?' + new URLSearchParams(query), { headers }); return { status: response.status, data: await response.json() }; };
    for (const action of ['list', 'read', 'stat', 'download', 'archive', 'history']) assert.equal((await fetch(api + `?action=${action}&path=readme.txt`)).status, 401);
    assert.equal((await fetch(api, { headers: { Cookie: 'orbit_session=' + 'a'.repeat(64) } })).status, 401);
    for (const method of ['PATCH', 'DELETE', 'POST', 'PUT']) {
      assert.equal((await fetch(api, { method, headers: { ...headers, Origin: 'https://foreign.test' }, body: '{}' })).status, 403);
      assert.equal((await fetch(api, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    }
    assert.equal((await get({ action: 'read', path: '../secret' })).status, 400);
    assert.equal((await get({ action: 'read', path: 'outside/passwd' })).status, 403);
    const binaryResponse = await fetch(api + '?action=download&path=binary.dat', { headers });
    assert.match(binaryResponse.headers.get('content-disposition'), /^attachment;/);
    assert.equal(binaryResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await binaryResponse.arrayBuffer()), Buffer.from([0, 1, 255]));
    assert.equal((await get({ action: 'archive', path: '../secret' })).status, 400);
    assert.equal((await get({ action: 'archive', path: 'outside' })).status, 403);
    const zipResponse = await fetch(api + '?action=archive', { headers });
    assert.equal(zipResponse.status, 200);
    assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
    assert.equal(zipResponse.headers.get('cache-control'), 'no-store');
    const rootZip = await inspectZip(Buffer.from(await zipResponse.arrayBuffer()));
    assert.deepEqual(Object.keys(rootZip).sort(), ['project/', 'project/binary.dat', 'project/readme.txt', 'project/worker/', 'project/worker/sample.mjs'].sort());

    const uploadHeaders = { ...headers, 'Content-Type': 'application/octet-stream' };
    const put = (path, content, revision) => fetch(api + '?' + new URLSearchParams({ path, ...(revision ? { revision } : {}) }), { method: 'PUT', headers: uploadHeaders, body: content });
    assert.equal((await fetch(api + '?path=bad', { method: 'PUT', headers, body: '{}' })).status, 415);
    assert.equal((await put('../escape', 'blocked')).status, 400);
    assert.equal((await put('outside/escape', 'blocked')).status, 403);
    assert.equal((await put('.next/created', 'blocked')).status, 403);
    assert.equal((await fetch(api + '?path=cross-site', { method: 'PUT', headers: { ...uploadHeaders, 'Sec-Fetch-Site': 'cross-site' }, body: 'blocked' })).status, 403);
    const original = (await get({ action: 'stat', path: 'binary.dat' })).data;
    assert.equal('content' in original, false);
    assert.equal((await put('binary.dat', 'unconfirmed')).status, 409);
    const uploadedBinary = Buffer.from([0, 255, 128, 27, 10]);
    const replaced = await put('binary.dat', uploadedBinary, original.revision);
    assert.equal(replaced.status, 200);
    const replacement = await replaced.json();
    assert.deepEqual(await readFile(join(files, 'binary.dat')), uploadedBinary);
    assert.deepEqual(await readFile(join(history, replacement.versionId, 'content')), Buffer.from([0, 1, 255]));
    assert.equal((await put('binary.dat', 'stale', original.revision)).status, 409);
    assert.equal((await put('empty', Buffer.alloc(0))).status, 200);
    // Larger than Next's default proxy body buffer: verify every byte reaches disk.
    const large = Buffer.alloc(UPLOAD_LIMIT, 0x7b); large[large.length - 1] = 0xff;
    assert.equal((await put('large.bin', large)).status, 200);
    assert.deepEqual(await readFile(join(files, 'large.bin')), large);
    const tooLarge = new ReadableStream({ start(controller) { controller.enqueue(large); controller.enqueue(new Uint8Array([1])); controller.close(); } });
    const overflow = await fetch(api + '?path=overflow.bin', { method: 'PUT', headers: uploadHeaders, body: tooLarge, duplex: 'half' });
    assert.equal(overflow.status, 413);
    await assert.rejects(readFile(join(files, 'overflow.bin')), { code: 'ENOENT' });
    assert.equal((await put('too-large.bin', Buffer.alloc(UPLOAD_LIMIT + 1))).status, 413);

    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(origin + '/files/');
    const panel = page.getByRole('region', { name: 'Файловый менеджер', exact: true });
    const folderDownloading = page.waitForEvent('download');
    await panel.getByRole('link', { name: 'Скачать папку worker ZIP', exact: true }).click();
    const folderDownload = await folderDownloading;
    assert.equal(folderDownload.suggestedFilename(), 'worker.zip');
    assert.deepEqual(Object.keys(await inspectZip(await readFile(await folderDownload.path()))).sort(), ['worker/', 'worker/sample.mjs']);
    await panel.getByRole('button', { name: 'Открыть worker', exact: true }).click();
    const uploadInput = panel.getByLabel('Выберите файлы для загрузки', { exact: true });
    await uploadInput.setInputFiles([
      { name: 'готовый.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFГотовый файл\r\n') },
      { name: 'data.bin', mimeType: 'application/octet-stream', buffer: uploadedBinary },
    ]);
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить', exact: true }).click();
    await panel.getByText(/^Загружено файлов: 2\./).waitFor();
    assert.equal(await readFile(join(files, 'worker', 'готовый.txt'), 'utf8'), '\uFEFFГотовый файл\r\n');
    assert.deepEqual(await readFile(join(files, 'worker', 'data.bin')), uploadedBinary);
    await uploadInput.setInputFiles({ name: 'готовый.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') });
    await page.getByRole('dialog').getByText('Замена', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await readFile(join(files, 'worker', 'готовый.txt'), 'utf8'), '\uFEFFГотовый файл\r\n');
    await uploadInput.setInputFiles({ name: 'готовый.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить и заменить', exact: true }).click();
    await panel.getByText(/^Загружено файлов: 1\./).waitFor();
    assert.equal(await readFile(join(files, 'worker', 'готовый.txt'), 'utf8'), 'replacement');
    // Re-check revision at publish time; preserve the external edit on conflict.
    await uploadInput.setInputFiles({ name: 'готовый.txt', mimeType: 'text/plain', buffer: Buffer.from('stale upload') });
    await page.getByRole('dialog').getByText('Замена', { exact: true }).waitFor();
    await writeFile(join(files, 'worker', 'готовый.txt'), 'external');
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить и заменить', exact: true }).click();
    await panel.getByRole('alert').getByText(/Загрузка .* остановлена/).waitFor();
    assert.equal(await readFile(join(files, 'worker', 'готовый.txt'), 'utf8'), 'external');
    await panel.getByRole('button', { name: 'Открыть sample.mjs', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: 'Содержимое файла', exact: true });
    assert.equal(await editor.inputValue(), 'export const example = 1;\n');
    await editor.fill('export const example = 2;\n');
    const currentDownloading = page.waitForEvent('download');
    await panel.getByRole('link', { name: 'Скачать текущую папку ZIP', exact: true }).click();
    const currentDownload = await currentDownloading;
    const currentZip = await inspectZip(await readFile(await currentDownload.path()));
    assert.equal(Buffer.from(currentZip['worker/sample.mjs'].content, 'base64').toString(), 'export const example = 1;\n');
    assert.equal(await editor.inputValue(), 'export const example = 2;\n', 'ZIP download keeps the unsaved draft');
    const cancelled = new Promise(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve(); }));
    await panel.getByRole('button', { name: 'На папку выше', exact: true }).click(); await cancelled;
    assert.equal(await editor.inputValue(), 'export const example = 2;\n');
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await panel.getByText(/^Файл сохранён\./).waitFor();
    assert.equal(await readFile(join(files, 'worker', 'sample.mjs'), 'utf8'), 'export const example = 2;\n');
    await editor.fill('my draft\n');
    await writeFile(join(files, 'worker', 'sample.mjs'), 'external change\n');
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await panel.getByRole('alert').getByText(/Файл изменился на сервере/).waitFor();
    assert.equal(await editor.inputValue(), 'my draft\n');
    assert.equal(await readFile(join(files, 'worker', 'sample.mjs'), 'utf8'), 'external change\n');
    const leave = new Promise(resolve => page.once('dialog', async dialog => { await dialog.accept(); resolve(); }));
    await panel.getByRole('button', { name: 'На папку выше', exact: true }).click(); await leave;
    await panel.getByRole('button', { name: 'Открыть readme.txt', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await panel.getByRole('link', { name: 'Скачать readme.txt', exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), 'readme.txt');
    assert.equal(await readFile(await download.path(), 'utf8'), 'Example project\n');
    await panel.getByRole('button', { name: 'Удалить readme.txt', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await readFile(join(files, 'readme.txt'), 'utf8'), 'Example project\n');
    await panel.getByRole('button', { name: 'Удалить readme.txt', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Переместить в корзину', exact: true }).click();
    await panel.getByText(/^Файл перемещён в корзину\./).waitFor();
    await assert.rejects(readFile(join(files, 'readme.txt')), { code: 'ENOENT' });
    await panel.getByRole('button', { name: 'Корзина и версии', exact: true }).click();
    await panel.getByRole('button', { name: 'Восстановить readme.txt', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить восстановление', exact: true }).click();
    await panel.getByText('Восстановлен файл readme.txt', { exact: true }).waitFor();
    assert.equal(await readFile(join(files, 'readme.txt'), 'utf8'), 'Example project\n');
    await panel.getByRole('button', { name: 'Восстановить worker/sample.mjs', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить восстановление', exact: true }).click();
    await panel.getByText('Восстановлен файл worker/sample.mjs', { exact: true }).waitFor();
    assert.equal(await readFile(join(files, 'worker/sample.mjs'), 'utf8'), 'export const example = 1;\n');
    await panel.getByRole('button', { name: 'Удалить копию readme.txt', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить окончательно', exact: true }).click();
    await panel.getByText('Резервная копия удалена окончательно.', { exact: true }).waitFor();
    assert.equal(await readFile(join(files, 'readme.txt'), 'utf8'), 'Example project\n');
    assert.equal((await get({ action: 'history' })).data.entries.some(entry => entry.path === 'readme.txt'), false);
    await panel.getByRole('button', { name: 'Файлы проекта', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Поиск в текущей папке' }).fill('readme');
    await wait(400);
    assert.equal(await panel.getByRole('button', { name: /^Открыть / }).count(), 1);
    await panel.getByRole('button', { name: 'Открыть readme.txt', exact: true }).click();
    const artifacts = join(root, 'prepared', 'file-manager-20261020');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await uploadInput.setInputFiles({ name: 'mobile.txt', mimeType: 'text/plain', buffer: Buffer.from('mobile upload') });
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить', exact: true }).click();
    await panel.getByText(/^Загружено файлов: 1\./).waitFor();
    assert.equal(await readFile(join(files, 'mobile.txt'), 'utf8'), 'mobile upload');
    await writeFile(join(artifacts, 'ui-report.json'), JSON.stringify({ passed: true, checks: ['auth on all methods including ZIP', 'cross-origin writes rejected', 'traversal and symlink rejection', 'binary attachment', 'root ZIP extracted with independent reader', 'folder row ZIP', 'current folder ZIP preserves unsaved draft', 'edit and draft warning', 'external edit conflict', 'download', 'cancel deletion', 'delete and restore', 'restore previous version', 'purge selected copy preserves working file', 'filename search', '390px layout', 'no browser errors'] }, null, 2));
  } catch (error) { error.message += '\nFixture output:\n' + output.slice(-2500); throw error; }
  finally {
    await browser?.close();
    if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
    await fixture.cleanup();
  }
});
