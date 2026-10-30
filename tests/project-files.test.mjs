import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat, readdir, readlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectFiles, TEXT_LIMIT, UPLOAD_LIMIT } from '../utils/projectFiles.js';
import { inspectZip } from './helpers/zip-inspect.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'orbit-files-'));
  const root = join(base, 'project'), history = join(base, 'private-history');
  await mkdir(root); await mkdir(join(root, 'worker'));
  await writeFile(join(root, 'worker', 'sample.mjs'), 'export const value = 1;\r\n', { mode: 0o640 });
  await writeFile(join(base, 'secret'), 'outside root');
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, history, manager: createProjectFiles({ root, history }) };
}
test('lists folders first, filters and pages without reading file contents', async t => {
  const { root, manager } = await fixture(t);
  await writeFile(join(root, 'a.txt'), 'a'); await writeFile(join(root, '.hidden'), 'hidden');
  const first = await manager.list({ limit: 1 });
  assert.equal(first.entries[0].type, 'directory'); assert.equal(first.total, 3);
  assert.equal((await manager.list({ query: '.hidden' })).entries[0].name, '.hidden');
  const next = await manager.list({ offset: 1, limit: 1 }); assert.equal(next.entries.length, 1);
  assert.equal((await manager.read('worker/sample.mjs')).content, 'export const value = 1;\r\n');
});
test('rejects traversal, absolute paths and intermediate/final symlinks', async t => {
  const { base, root, manager } = await fixture(t);
  await symlink(join(base, 'secret'), join(root, 'link.txt'));
  await symlink(base, join(root, 'escape'));
  for (const value of ['../secret', '/etc/passwd', 'worker/../../secret', 'worker\\sample.mjs', 'worker//sample.mjs', './worker', 'bad\0name']) {
    await assert.rejects(manager.read(value), { status: 400 });
  }
  await assert.rejects(manager.read('link.txt'), { status: 403 });
  await assert.rejects(manager.list({ path: 'escape' }), { status: 403 });
  await assert.rejects(manager.download('escape/secret'), { status: 403 });
  assert.equal((await manager.list()).entries.find(e => e.name === 'link.txt').writable, false);
});
test('save preserves mode, creates private recoverable version and detects external edits', async t => {
  const { root, history, manager } = await fixture(t);
  const old = await manager.read('worker/sample.mjs');
  const saved = await manager.save(old.path, old.revision, 'export const value = 2;\n');
  assert.equal(saved.file.content, 'export const value = 2;\n');
  assert.equal((await stat(join(root, old.path))).mode & 0o777, 0o640);
  assert.equal((await stat(join(history, saved.versionId, 'content'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(history, saved.versionId, 'content'), 'utf8'), old.content);
  await assert.rejects(manager.save(old.path, old.revision, 'stale'), { status: 409 });
  await writeFile(join(root, old.path), 'external');
  await assert.rejects(manager.remove(old.path, saved.file.revision), { status: 409 });
  assert.equal(await readFile(join(root, old.path), 'utf8'), 'external');
  assert.equal((await manager.history()).entries.length, 1);
});
test('only one concurrent writer succeeds and the winning data is retained', async t => {
  const { root, history, manager } = await fixture(t);
  const other = createProjectFiles({ root, history }), file = await manager.read('worker/sample.mjs');
  const result = await Promise.allSettled([manager.save(file.path, file.revision, 'first'), other.save(file.path, file.revision, 'second')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await manager.history()).entries.length, 1);
});
test('delete and restore preserve binary bytes; restore refuses an unconfirmed replacement', async t => {
  const { root, manager } = await fixture(t);
  const content = Buffer.from([0, 255, 1, 128, 24]);
  await writeFile(join(root, 'data.bin'), content);
  const file = await manager.read('data.bin');
  assert.equal(file.content, null); assert.equal(file.editable, false);
  const deleted = await manager.remove(file.path, file.revision);
  await assert.rejects(readFile(join(root, 'data.bin')), { code: 'ENOENT' });
  await manager.restore(deleted.versionId, null);
  assert.deepEqual(await readFile(join(root, 'data.bin')), content);
  await assert.rejects(manager.restore(deleted.versionId, null), { status: 409 });
  const current = await manager.read('data.bin');
  await manager.restore(deleted.versionId, current.revision);
  assert.equal((await manager.history()).entries.length, 2);
});
test('restores a previous text version and preserves the version replaced by restore', async t => {
  const { manager } = await fixture(t), file = await manager.read('worker/sample.mjs');
  const saved = await manager.save(file.path, file.revision, 'new');
  await manager.restore(saved.versionId, saved.file.revision);
  assert.equal((await manager.read(file.path)).content, file.content);
  assert.equal((await manager.history()).entries.length, 2);
  await assert.rejects(manager.restore('../../outside', null), { status: 400 });
});
test('blocks writes to generated files, hardlinks, directories and history', async t => {
  const { root, manager } = await fixture(t);
  await mkdir(join(root, '.next')); await writeFile(join(root, '.next', 'BUILD_ID'), 'build');
  const generated = await manager.read('.next/BUILD_ID');
  assert.equal(generated.editable, false);
  await assert.rejects(manager.remove(generated.path, generated.revision), { status: 403 });
  await link(join(root, 'worker/sample.mjs'), join(root, 'alias'));
  const aliased = await manager.read('alias'); assert.equal(aliased.writable, false);
  await assert.rejects(manager.save('alias', aliased.revision, 'changed'), { status: 403 });
  await assert.rejects(manager.remove('worker', 'a'.repeat(64)), { status: 400 });
  const nested = createProjectFiles({ root, history: join(root, '.file-manager') });
  await nested.list(); await assert.rejects(nested.list({ path: '.file-manager' }), { status: 403 });
});
test('caps text reads and edits, rejects binary conversion, streams arbitrary files', async t => {
  const { root, manager } = await fixture(t);
  await writeFile(join(root, 'large.txt'), Buffer.alloc(TEXT_LIMIT + 1, 65));
  const large = await manager.read('large.txt'); assert.equal(large.content, null);
  await assert.rejects(manager.save('large.txt', large.revision, 'small'), { status: 413 });
  await writeFile(join(root, 'binary'), Buffer.from([0, 255]));
  const binary = await manager.read('binary');
  await assert.rejects(manager.save(binary.path, binary.revision, 'text'), { status: 403 });
  const file = await manager.read('worker/sample.mjs');
  await assert.rejects(manager.save(file.path, file.revision, 'a'.repeat(TEXT_LIMIT + 1)), { status: 413 });
  const download = await manager.download('large.txt');
  assert.equal((await new Response(download.stream).arrayBuffer()).byteLength, TEXT_LIMIT + 1);
});
test('preserves UTF-8 BOM and does not expose content or physical roots in history', async t => {
  const { root, manager } = await fixture(t);
  await writeFile(join(root, 'русский.txt'), '\uFEFFТекст\n');
  const file = await manager.read('русский.txt'); assert.equal(file.content, '\uFEFFТекст\n');
  await manager.save(file.path, file.revision, '\uFEFFНовый текст\n');
  const history = await manager.history();
  assert.equal(JSON.stringify(history).includes(root), false);
  assert.equal(JSON.stringify(history).includes('Новый текст'), false);
});
test('refuses backups under public and does not expose history from another release', async t => {
  const { root, base, history, manager } = await fixture(t);
  await assert.rejects(createProjectFiles({ root, history: join(root, 'public', 'history') }).list(), { status: 503 });
  const file = await manager.read('worker/sample.mjs');
  const saved = await manager.save(file.path, file.revision, 'new');
  const otherRoot = join(base, 'other'); await mkdir(otherRoot);
  const other = createProjectFiles({ root: otherRoot, history });
  assert.equal((await other.history()).entries.length, 0);
  await assert.rejects(other.restore(saved.versionId, null), { status: 404 });
});
test('stale process lock is recovered, live or malformed lock fails closed', async t => {
  const { history, manager } = await fixture(t);
  const file = await manager.read('worker/sample.mjs');
  await writeFile(join(history, 'operation.lock'), 'invalid');
  await assert.rejects(manager.save(file.path, file.revision, 'new'), { status: 409 });
  await writeFile(join(history, 'operation.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(manager.save(file.path, file.revision, 'new'), { status: 409 });
  await writeFile(join(history, 'operation.lock'), JSON.stringify({ pid: 2147483647 }));
  await manager.save(file.path, file.revision, 'new');
  assert.equal((await readdir(history)).includes('operation.lock'), false);
});
test('purging one version leaves the working file and other versions intact', async t => {
  const { manager } = await fixture(t), file = await manager.read('worker/sample.mjs');
  const first = await manager.save(file.path, file.revision, 'second');
  await manager.save(file.path, first.file.revision, 'third');
  await manager.purge(first.versionId);
  assert.equal((await manager.history()).entries.length, 1);
  assert.equal((await manager.read(file.path)).content, 'third');
  await assert.rejects(manager.restore(first.versionId, null), { status: 404 });
  await assert.rejects(manager.purge('../../anything'), { status: 400 });
});

const uploadStream = (...chunks) => (async function* () { yield* chunks; })();
test('upload creates exact binary, UTF-8 and empty files without the text editor limit', async t => {
  const { root, manager } = await fixture(t);
  const binary = randomBytes(TEXT_LIMIT + 10);
  const result = await manager.upload('worker/new.bin', null, uploadStream(binary.subarray(0, 123), binary.subarray(123)));
  assert.equal(result.versionId, null); assert.equal(result.file.size, binary.length);
  assert.equal('content' in result.file, false);
  assert.deepEqual(await readFile(join(root, 'worker/new.bin')), binary);
  assert.equal((await stat(join(root, 'worker/new.bin'))).mode & 0o777, 0o600);
  const utf8 = Buffer.from('\uFEFFГотовый файл\r\n');
  await manager.upload('файл.txt', null, uploadStream(utf8));
  assert.deepEqual(await readFile(join(root, 'файл.txt')), utf8);
  await manager.upload('empty', null, uploadStream());
  assert.equal((await manager.stat('empty')).size, 0);
  assert.equal((await manager.history()).entries.length, 0);
});
test('upload replacement requires the confirmed revision and keeps original bytes and mode for restore', async t => {
  const { root, history, manager } = await fixture(t);
  const old = await manager.read('worker/sample.mjs');
  await assert.rejects(manager.upload(old.path, null, uploadStream(Buffer.from('unconfirmed'))), { status: 409 });
  const bytes = Buffer.from([0, 255, 10]);
  const result = await manager.upload(old.path, old.revision, uploadStream(bytes));
  assert.equal((await stat(join(root, old.path))).mode & 0o777, 0o640);
  assert.equal(await readFile(join(history, result.versionId, 'content'), 'utf8'), old.content);
  assert.deepEqual(await readFile(join(root, old.path)), bytes);
  await assert.rejects(manager.upload(old.path, old.revision, uploadStream(bytes)), { status: 409 });
  await manager.restore(result.versionId, result.file.revision);
  assert.equal(await readFile(join(root, old.path), 'utf8'), old.content);
});
test('upload accepts the byte limit and rejects streamed overflow without publishing or leaving temporary files', async t => {
  const { root, manager } = await fixture(t);
  await manager.upload('limit.bin', null, uploadStream(Buffer.alloc(UPLOAD_LIMIT)));
  assert.equal((await manager.stat('limit.bin')).size, UPLOAD_LIMIT);
  await assert.rejects(manager.upload('overflow.bin', null, uploadStream(Buffer.alloc(UPLOAD_LIMIT), Buffer.from([1]))), { status: 413 });
  await assert.rejects(readFile(join(root, 'overflow.bin')), { code: 'ENOENT' });
  assert.equal((await readdir(root)).some(name => name.startsWith('.orbit-edit-')), false);
});
test('aborted and broken uploads keep existing data and do not create a backup or partial file', async t => {
  const { root, manager } = await fixture(t), old = await manager.read('worker/sample.mjs');
  const abort = new AbortController();
  async function* cancelled() { yield Buffer.from('partial'); abort.abort(); yield Buffer.from('rest'); }
  await assert.rejects(manager.upload(old.path, old.revision, cancelled(), { signal: abort.signal }));
  async function* broken() { yield Buffer.from('partial'); throw new Error('upload disconnected'); }
  await assert.rejects(manager.upload('broken.bin', null, broken()));
  assert.equal(await readFile(join(root, old.path), 'utf8'), old.content);
  await assert.rejects(readFile(join(root, 'broken.bin')), { code: 'ENOENT' });
  assert.equal((await manager.history()).entries.length, 0);
  for (const folder of [root, join(root, 'worker')]) assert.equal((await readdir(folder)).some(name => name.startsWith('.orbit-edit-')), false);
});
test('external edits and files created during streaming cannot be overwritten by upload', async t => {
  const { root, manager } = await fixture(t), old = await manager.read('worker/sample.mjs');
  async function* changed() { yield Buffer.from('new'); await writeFile(join(root, old.path), 'external'); }
  await assert.rejects(manager.upload(old.path, old.revision, changed()), { status: 409 });
  assert.equal(await readFile(join(root, old.path), 'utf8'), 'external');
  async function* appeared() { yield Buffer.from('new'); await writeFile(join(root, 'new.txt'), 'external'); }
  await assert.rejects(manager.upload('new.txt', null, appeared()), { status: 409 });
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'external');
});
test('upload rejects unsafe destinations, links, protected files and missing parents', async t => {
  const { base, root, manager } = await fixture(t);
  await symlink(base, join(root, 'escape')); await symlink(join(base, 'secret'), join(root, 'link'));
  await link(join(root, 'worker/sample.mjs'), join(root, 'hardlink'));
  for (const target of ['../outside', '/tmp/outside', 'worker//bad', 'worker\\bad']) {
    await assert.rejects(manager.upload(target, null, uploadStream()), { status: 400 });
  }
  for (const target of ['.git/config', '.next/new', 'node_modules/new', '.orbit-edit-fake', 'worker/.orbit-edit-fake', 'escape/new', 'link']) {
    await assert.rejects(manager.upload(target, null, uploadStream()), { status: 403 });
  }
  await assert.rejects(manager.upload('hardlink', (await manager.stat('hardlink')).revision, uploadStream()), { status: 403 });
  await assert.rejects(manager.upload('worker', null, uploadStream()), { status: 400 });
  await assert.rejects(manager.upload('missing/new', null, uploadStream()), { status: 404 });
  await assert.rejects(manager.upload('missing.txt', 'a'.repeat(64), uploadStream()), { status: 409 });
  assert.equal(await readFile(join(base, 'secret'), 'utf8'), 'outside root');
  await mkdir(join(root, '.next'));
  assert.equal((await manager.list({ path: '.next' })).uploadAllowed, false);
});
test('concurrent upload writers cannot replace each other or leak the operation lock', async t => {
  const { root, history, manager } = await fixture(t), other = createProjectFiles({ root, history });
  const results = await Promise.allSettled([manager.upload('same', null, uploadStream(Buffer.from('one'))), other.upload('same', null, uploadStream(Buffer.from('two')))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.ok(['one', 'two'].includes(await readFile(join(root, 'same'), 'utf8')));
  assert.equal((await readdir(history)).includes('operation.lock'), false);
});

test('ZIP contains the whole nested folder, hidden/binary files, UTF-8 names, modes and empty directories', async t => {
  const { root, manager } = await fixture(t);
  await mkdir(join(root, 'worker', 'папка', 'empty'), { recursive: true });
  const bytes = Buffer.from([0, 255, 1, 128, 24]);
  await writeFile(join(root, 'worker', 'папка', 'данные.bin'), bytes);
  await writeFile(join(root, 'worker', '.hidden'), 'hidden');
  const download = await manager.archive('worker');
  assert.equal(download.name, 'worker.zip');
  const archive = await inspectZip(Buffer.from(await new Response(download.stream).arrayBuffer()));
  assert.deepEqual(Object.keys(archive).sort(), [
    'worker/', 'worker/.hidden', 'worker/sample.mjs', 'worker/папка/', 'worker/папка/empty/', 'worker/папка/данные.bin',
  ].sort());
  assert.deepEqual(Buffer.from(archive['worker/папка/данные.bin'].content, 'base64'), bytes);
  assert.equal(Buffer.from(archive['worker/sample.mjs'].content, 'base64').toString(), 'export const value = 1;\r\n');
  assert.equal(archive['worker/sample.mjs'].mode & 0o777, 0o640);
  assert.equal(archive['worker/папка/empty/'].directory, true);
  await mkdir(join(root, 'пустая папка'));
  const empty = await manager.archive('пустая папка');
  assert.equal(empty.name, 'пустая папка.zip');
  assert.deepEqual(Object.keys(await inspectZip(Buffer.from(await new Response(empty.stream).arrayBuffer()))), ['пустая папка/']);
});

test('root ZIP excludes symlinks, special files, private history and edit staging, but includes ordinary hidden/generated files', async t => {
  const { root, base } = await fixture(t);
  const manager = createProjectFiles({ root, history: join(root, 'private-history') });
  const file = await manager.read('worker/sample.mjs');
  await manager.save(file.path, file.revision, 'updated');
  await symlink(join(base, 'secret'), join(root, 'secret-link'));
  await symlink(root, join(root, 'cycle'));
  await writeFile(join(root, '.orbit-edit-test'), 'staging');
  await mkdir(join(root, '.next'));
  await writeFile(join(root, '.next', 'example'), 'generated');
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const zip = await manager.archive();
  assert.equal(zip.name, 'project.zip');
  const contents = await inspectZip(Buffer.from(await new Response(zip.stream).arrayBuffer()));
  assert.deepEqual(Object.keys(contents).sort(), ['project/', 'project/worker/', 'project/worker/sample.mjs', 'project/.next/', 'project/.next/example'].sort());
  for (const forbidden of ['../secret', '/etc', 'worker/../../', 'worker\\x']) {
    await assert.rejects(manager.archive(forbidden), { status: 400 });
  }
  await assert.rejects(manager.archive('cycle'), { status: 403 });
  await assert.rejects(manager.archive('secret-link'), { status: 403 });
  await assert.rejects(manager.archive('private-history'), { status: 403 });
  await assert.rejects(manager.archive('missing'), { status: 404 });
});

test('cancelled ZIP and aborted request release source/directory descriptors without temporary archives', async t => {
  const { root, history, manager } = await fixture(t);
  await writeFile(join(root, 'worker', 'large.bin'), randomBytes(2 * 1024 * 1024));
  const handles = async () => (await Promise.all((await readdir('/proc/self/fd')).map(async fd => {
    try { return await readlink('/proc/self/fd/' + fd); } catch { return ''; }
  }))).filter(target => target.startsWith(root));
  for (const bySignal of [false, true]) {
    const controller = new AbortController();
    const archive = await manager.archive('worker', { signal: controller.signal });
    const reader = archive.stream.getReader();
    await reader.read();
    for (let i = 0; i < 100 && !(await handles()).some(name => name.endsWith('large.bin')); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok((await handles()).some(name => name.endsWith('large.bin')), 'file is being streamed');
    if (bySignal) {
      controller.abort();
      await assert.rejects(async () => { while (!(await reader.read()).done) {} });
    } else await reader.cancel();
    for (let i = 0; i < 100 && (await handles()).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await handles(), []);
  }
  assert.deepEqual(await readdir(history), []);
  assert.deepEqual((await readdir(root)).sort(), ['worker']);
});

test('a source modified during ZIP streaming fails the download instead of returning a successful partial archive', async t => {
  const { root, manager } = await fixture(t);
  const filename = join(root, 'worker', 'large.bin');
  await writeFile(filename, randomBytes(2 * 1024 * 1024));
  const archive = await manager.archive('worker');
  const reader = archive.stream.getReader();
  await reader.read();
  for (let i = 0; i < 100; i++) {
    const names = await Promise.all((await readdir('/proc/self/fd')).map(fd => readlink('/proc/self/fd/' + fd).catch(() => '')));
    if (names.includes(filename)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writeFile(filename, 'changed during download');
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
});
