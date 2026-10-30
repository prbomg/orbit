const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { ZipFile } = require('yazl');

const TEXT_LIMIT = 512 * 1024;
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const protectedNames = new Set(['.git', '.next', 'node_modules', '.orbit-runtime', '.file-manager']);
const revision = stat => createHash('sha256').update(
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
).digest('hex');
class FileManagerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function relativePath(value = '') {
  if (typeof value !== 'string' || value.length > 2000 || /[\\\x00-\x1f\x7f]/.test(value)
    || value && value.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    throw new FileManagerError(400, 'Некорректный путь файла');
  }
  return value;
}
function metadata(relative, stat) {
  const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const protectedFile = relative.split('/').some(part => protectedNames.has(part));
  return {
    path: relative, name: path.posix.basename(relative), type,
    size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
    revision: revision(stat),
    writable: type === 'file' && !protectedFile && stat.nlink === 1n,
    reason: type === 'link' ? 'Символическая ссылка: переход за пределы каталога отключён'
      : protectedFile ? 'Служебные файлы доступны только для чтения'
        : type === 'file' && stat.nlink !== 1n ? 'Файл имеет жёсткие ссылки; изменение отключено' : null,
  };
}
function translate(error) {
  if (error instanceof FileManagerError) return error;
  if (error.code === 'ENOENT') return new FileManagerError(404, 'Файл или папка больше не существуют');
  if (['ELOOP', 'ENOTDIR'].includes(error.code)) return new FileManagerError(403, 'Переход по символическим ссылкам запрещён');
  if (['EPERM', 'EACCES'].includes(error.code)) return new FileManagerError(403, 'У процесса Orbit нет доступа к этому файлу');
  if (error.code === 'ENOSPC') return new FileManagerError(507, 'Недостаточно места для сохранения файла и резервной копии');
  if (error.code === 'EEXIST') return new FileManagerError(409, 'Файл уже существует. Обновите список');
  return new FileManagerError(500, 'Не удалось выполнить файловую операцию');
}

function createProjectFiles(options = {}) {
  // An explicit server setting is also useful for isolated integration fixtures.
  const rootInput = options.root || process.env.ORBIT_FILES_ROOT || process.cwd();
  const historyInput = options.history || process.env.ORBIT_FILES_HISTORY_DIRECTORY
    || path.join(process.env.ORBIT_DATA_DIRECTORY || path.join(process.cwd(), '.orbit-runtime'), 'file-manager');
  let roots;
  const initialize = () => roots ||= (async () => {
    if (process.platform !== 'linux') throw new FileManagerError(503, 'Файловый менеджер требует Linux');
    const root = await fs.realpath(rootInput);
    await fs.mkdir(historyInput, { recursive: true, mode: 0o700 });
    const history = await fs.realpath(historyInput);
    // Never put recoverable source/configuration files into a publicly served folder.
    if (history === root || history.startsWith(path.join(root, 'public') + path.sep) || history === path.join(root, 'public')) {
      throw new FileManagerError(503, 'Каталог резервных копий должен находиться вне public');
    }
    return { root, history, rootKey: createHash('sha256').update(root).digest('hex') };
  })().catch(error => { roots = null; throw error; });

  // Resolve each directory through an open fd, refusing links at every step.
  // Subsequent operations remain anchored to that directory even if its name changes.
  async function directory(relative) {
    const { root, history } = await initialize();
    let handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of relativePath(relative).split('/').filter(Boolean)) {
        const next = await fs.open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close(); handle = next;
      }
      const anchored = `/proc/self/fd/${handle.fd}`;
      const resolved = await fs.realpath(anchored);
      if (resolved !== root && !resolved.startsWith(root + path.sep)
        || resolved === history || resolved.startsWith(history + path.sep)) {
        throw new FileManagerError(403, 'Этот каталог недоступен в файловом менеджере');
      }
      return { handle, anchored };
    } catch (error) { await handle.close(); throw error; }
  }
  async function parent(relative) {
    relativePath(relative);
    if (!relative) throw new FileManagerError(400, 'Выберите файл');
    const dir = await directory(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
    return { ...dir, filename: `${dir.anchored}/${path.posix.basename(relative)}` };
  }
  async function openFile(relative) {
    const dir = await parent(relative);
    let handle;
    try {
      handle = await fs.open(dir.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new FileManagerError(400, 'Операция доступна только для обычного файла');
      return { ...dir, file: handle, stat, entry: metadata(relative, stat) };
    } catch (error) { await handle?.close(); await dir.handle.close(); throw error; }
  }
  async function close(opened) { await opened.file?.close(); await opened.handle.close(); }
  async function checkRevision(opened, expected) {
    const current = await fs.lstat(opened.filename, { bigint: true });
    if (typeof expected !== 'string' || revision(current) !== expected || revision(opened.stat) !== expected) {
      throw new FileManagerError(409, 'Файл изменился на сервере. Скачайте свой черновик и откройте актуальную версию');
    }
    if (!opened.entry.writable) throw new FileManagerError(403, opened.entry.reason || 'Изменение этого файла запрещено');
  }
  async function lock(action) {
    const { history } = await initialize();
    const lockPath = path.join(history, 'operation.lock');
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('invalid lock');
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if (probe.code === 'ESRCH' && attempt === 0) { await fs.unlink(lockPath); continue; }
          }
        } catch { /* Incomplete or unreadable locks fail closed. */ }
        throw new FileManagerError(409, 'Другая файловая операция ещё выполняется. Повторите позже');
      }
    }
    if (!handle) throw new FileManagerError(409, 'Файловый менеджер занят');
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await action();
    } finally { await handle.close(); await fs.unlink(lockPath); }
  }
  async function backup(opened, action) {
    const { history, rootKey } = await initialize();
    const id = randomUUID(), folder = path.join(history, id);
    await fs.mkdir(folder, { mode: 0o700 });
    const record = {
      id, rootKey, path: opened.entry.path, action, createdAt: new Date().toISOString(),
      size: Number(opened.stat.size), mode: Number(opened.stat.mode & 0o777n), status: 'prepared',
    };
    // fd source avoids a symlink swap between validation and the backup.
    await fs.copyFile(`/proc/self/fd/${opened.file.fd}`, path.join(folder, 'content'), constants.COPYFILE_EXCL);
    await fs.chmod(path.join(folder, 'content'), 0o600);
    const copy = await fs.open(path.join(folder, 'content'), 'r');
    try { await copy.sync(); } finally { await copy.close(); }
    await fs.writeFile(path.join(folder, 'record.json'), JSON.stringify(record), { mode: 0o600 });
    return { folder, record };
  }
  async function committed(saved) {
    saved.record.status = 'completed';
    await fs.writeFile(path.join(saved.folder, 'record.json'), JSON.stringify(saved.record), { mode: 0o600 });
  }
  async function writeAtomic(dir, content, mode, expected, { signal, beforePublish } = {}) {
    const temporary = `${dir.anchored}/.orbit-edit-${randomUUID()}`;
    let file;
    try {
      file = await fs.open(temporary, 'wx', 0o600);
      await file.writeFile(content); await file.chmod(mode); await file.sync(); await file.close(); file = null;
      signal?.throwIfAborted();
      await beforePublish?.();
      signal?.throwIfAborted();
      if (expected === null) {
        // link is atomic and fails if a file appeared after the operator's confirmation.
        await fs.link(temporary, dir.filename);
      } else {
        const current = await fs.lstat(dir.filename, { bigint: true });
        if (revision(current) !== expected) throw new FileManagerError(409, 'Файл изменился перед сохранением. Откройте актуальную версию');
        await fs.rename(temporary, dir.filename);
      }
      await dir.handle.sync();
    } finally {
      await file?.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function historyRecord(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new FileManagerError(400, 'Некорректная версия файла');
    const { history, rootKey } = await initialize(), folder = path.join(history, id);
    if (!(await fs.lstat(folder)).isDirectory() || (await fs.lstat(folder)).isSymbolicLink()) throw new FileManagerError(403, 'Некорректная версия');
    const record = JSON.parse(await fs.readFile(path.join(folder, 'record.json'), 'utf8'));
    if (record.id !== id || record.rootKey !== rootKey || record.status !== 'completed') throw new FileManagerError(404, 'Версия недоступна для этого релиза');
    relativePath(record.path);
    return { folder, record };
  }
  const operations = {
    async list({ path: relative = '', query = '', offset = 0, limit = 100 } = {}) {
      relativePath(relative);
      const dir = await directory(relative);
      try {
        let names = await fs.readdir(dir.anchored, { withFileTypes: true });
        names = names.filter(item => !item.name.startsWith('.orbit-edit-') && item.name.toLowerCase().includes(String(query).toLowerCase()));
        names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ru'));
        const page = names.slice(offset, offset + limit);
        const entries = (await Promise.all(page.map(async item => {
          try {
            const relativeFile = [relative, item.name].filter(Boolean).join('/');
            const entry = metadata(relativeFile, await fs.lstat(`${dir.anchored}/${item.name}`, { bigint: true }));
            if (entry.type === 'directory') {
              const { history, root } = await initialize();
              if (path.join(root, relativeFile) === history) return null;
            }
            return entry;
          } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        }))).filter(Boolean);
        return { path: relative, entries, total: names.length, offset, limit, textLimit: TEXT_LIMIT,
          uploadLimit: UPLOAD_LIMIT, uploadAllowed: !relative.split('/').some(part => protectedNames.has(part)) };
      } finally { await dir.handle.close(); }
    },
    async read(relative) {
      const opened = await openFile(relative);
      try {
        const result = { ...opened.entry, content: null, editable: false };
        if (opened.stat.size > BigInt(TEXT_LIMIT)) return { ...result, reason: 'Файл больше 512 КиБ. Скачайте его для просмотра и редактирования' };
        const bytes = Buffer.alloc(TEXT_LIMIT + 1);
        const { bytesRead } = await opened.file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > TEXT_LIMIT) return { ...result, reason: 'Файл увеличился. Откройте его заново' };
        const buffer = bytes.subarray(0, bytesRead);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
        catch { return { ...result, reason: 'Двоичный файл или другая кодировка. Доступно скачивание' }; }
        if (/[\x00-\x08\x0e-\x1f]/.test(content)) return { ...result, reason: 'Двоичный файл. Доступно скачивание' };
        if (revision(await opened.file.stat({ bigint: true })) !== opened.entry.revision) throw new FileManagerError(409, 'Файл изменился во время чтения. Откройте его заново');
        return { ...result, content, editable: opened.entry.writable };
      } finally { await close(opened); }
    },
    async stat(relative) {
      const opened = await openFile(relative);
      try { return opened.entry; } finally { await close(opened); }
    },
    async upload(relative, expected, stream, { signal } = {}) {
      relativePath(relative);
      if (relative.split('/').some(part => protectedNames.has(part) || part.startsWith('.orbit-edit-'))) {
        throw new FileManagerError(403, 'Загрузка в служебный каталог или файл запрещена');
      }
      if (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) {
        throw new FileManagerError(400, 'Некорректная версия файла');
      }
      return lock(async () => {
        signal?.throwIfAborted();
        const dir = await parent(relative);
        let opened, saved;
        try {
          try { opened = await openFile(relative); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (opened) await checkRevision(opened, expected);
          else if (expected !== null) throw new FileManagerError(409, 'Файл удалён после выбора. Выберите файл заново');
          async function* chunks() {
            let size = 0;
            for await (const chunk of stream) {
              signal?.throwIfAborted();
              if (!(chunk instanceof Uint8Array)) throw new FileManagerError(400, 'Некорректные данные файла');
              size += chunk.byteLength;
              if (size > UPLOAD_LIMIT) throw new FileManagerError(413, 'Файл больше 20 МиБ');
              yield chunk;
            }
            signal?.throwIfAborted();
          }
          await writeAtomic(dir, chunks(), opened ? Number(opened.stat.mode & 0o777n) : 0o600, expected, {
            signal,
            beforePublish: async () => {
              if (opened) {
                await checkRevision(opened, expected);
                saved = await backup(opened, 'edit');
              }
            },
          });
          if (saved) await committed(saved);
          return { file: await operations.stat(relative), versionId: saved?.record.id || null };
        } finally { if (opened) await close(opened); await dir.handle.close(); }
      });
    },
    async download(relative) {
      const opened = await openFile(relative);
      await opened.handle.close();
      const stream = opened.file.createReadStream({ autoClose: true });
      return { stream: Readable.toWeb(stream), name: opened.entry.name, size: opened.entry.size };
    },
    async archive(relative = '', { signal } = {}) {
      relativePath(relative);
      // Validate before sending response headers. Descendants are opened with the
      // same no-follow rules; private history and edit staging files never enter ZIPs.
      const initial = await directory(relative);
      const { root, history } = await initialize();
      const folderName = path.posix.basename(relative) || 'project';
      const zip = new ZipFile();
      let stopped = false, input;
      const stop = () => { stopped = true; input?.destroy(); };
      const abort = () => zip.outputStream.destroy(new FileManagerError(499, 'Скачивание отменено'));
      const fail = error => { stop(); zip.outputStream.destroy(translate(error)); };
      zip.on('error', fail);
      // Readable.toWeb forwards consumer cancellation to the Node stream.
      zip.outputStream.once('close', () => { stop(); signal?.removeEventListener('abort', abort); });
      signal?.addEventListener('abort', abort, { once: true });
      const stream = Readable.toWeb(zip.outputStream, {
        strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
      });
      if (signal?.aborted) abort();

      async function walk(dir, current, archivePath) {
        try {
          if (stopped || zip.outputStream.destroyed) return;
          const directoryStat = await dir.handle.stat({ bigint: true });
          zip.addEmptyDirectory(archivePath, { mtime: new Date(Number(directoryStat.mtimeMs)), mode: Number(directoryStat.mode) });
          const entries = await fs.opendir(dir.anchored);
          for await (const entry of entries) {
            if (stopped || zip.outputStream.destroyed) break;
            if (entry.name.startsWith('.orbit-edit-')) continue;
            const child = [current, entry.name].filter(Boolean).join('/');
            relativePath(child);
            if (path.join(root, child) === history) continue;
            const filename = `${dir.anchored}/${entry.name}`;
            const stat = await fs.lstat(filename, { bigint: true });
            if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) continue;
            const archiveName = `${archivePath}/${entry.name}`;
            if (stat.isDirectory()) {
              await walk(await directory(child), child, archiveName);
              continue;
            }
            let file;
            try {
              file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              const before = await file.stat({ bigint: true });
              if (!before.isFile() || revision(before) !== revision(stat)) {
                throw new FileManagerError(409, 'Содержимое папки изменилось. Скачайте архив повторно');
              }
              if (stopped || zip.outputStream.destroyed) break;
              // Only one source file is read at a time; compression and HTTP
              // backpressure bound content buffers. No temporary ZIP is stored.
              input = file.createReadStream({ autoClose: false });
              const done = finished(input, { cleanup: true });
              zip.addReadStream(input, archiveName, {
                size: Number(before.size), mode: Number(before.mode),
                mtime: new Date(Number(before.mtimeMs)), compressionLevel: 1,
              });
              await done;
              if (revision(await file.stat({ bigint: true })) !== revision(before)) {
                throw new FileManagerError(409, 'Файл изменился во время скачивания. Повторите загрузку архива');
              }
            } finally {
              input?.destroy(); input = undefined;
              await file?.close();
            }
          }
        } finally { await dir.handle.close(); }
      }
      // A mid-stream read/change error terminates the download, never reports a
      // truncated ZIP as successful. The walker also unwinds on client disconnect.
      void walk(initial, relative, folderName).then(() => {
        if (!stopped && !zip.outputStream.destroyed) zip.end();
      }).catch(fail);
      return { stream, name: `${folderName}.zip` };
    },
    async save(relative, expected, content) {
      if (typeof content !== 'string' || Buffer.byteLength(content) > TEXT_LIMIT || /[\x00-\x08\x0e-\x1f]/.test(content)) throw new FileManagerError(413, 'Редактор поддерживает текст UTF-8 размером до 512 КиБ');
      return lock(async () => {
        const opened = await openFile(relative);
        try {
          await checkRevision(opened, expected);
          if (opened.stat.size > BigInt(TEXT_LIMIT)) throw new FileManagerError(413, 'Исходный файл превышает лимит редактора');
          // Do not turn a binary file into text by bypassing the editor.
          if (!(await operations.read(relative)).editable) throw new FileManagerError(403, 'Этот файл нельзя изменять в текстовом редакторе');
          const saved = await backup(opened, 'edit');
          await writeAtomic(opened, content, Number(opened.stat.mode & 0o777n), expected);
          await committed(saved);
          return { file: await operations.read(relative), versionId: saved.record.id };
        } finally { await close(opened); }
      });
    },
    async remove(relative, expected) {
      return lock(async () => {
        const opened = await openFile(relative);
        try {
          await checkRevision(opened, expected);
          const saved = await backup(opened, 'delete');
          await checkRevision(opened, expected);
          await fs.unlink(opened.filename); await opened.handle.sync();
          await committed(saved);
          return { versionId: saved.record.id };
        } finally { await close(opened); }
      });
    },
    async history({ offset = 0, limit = 100 } = {}) {
      const { history } = await initialize();
      const names = (await fs.readdir(history)).filter(name => /^[0-9a-f-]{36}$/.test(name));
      const records = [];
      // No recursive source/data scan: only the manager's own small journal.
      for (const id of names) {
        try { const { record } = await historyRecord(id); const { rootKey, mode, status, ...publicRecord } = record; records.push(publicRecord); }
        catch (error) { if (!(error instanceof FileManagerError) && error.code !== 'ENOENT') throw error; }
      }
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { entries: records.slice(offset, offset + limit), total: records.length, offset, limit };
    },
    async restore(id, expected) {
      return lock(async () => {
        const { folder, record } = await historyRecord(id);
        const dir = await parent(record.path);
        let opened;
        try {
          if (record.path.split('/').some(part => protectedNames.has(part))) throw new FileManagerError(403, 'Восстановление служебного файла запрещено');
          try { opened = await openFile(record.path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (opened) await checkRevision(opened, expected);
          else if (expected !== null) throw new FileManagerError(409, 'Файл удалён после открытия. Обновите список');
          const backupStat = await fs.lstat(path.join(folder, 'content'));
          if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw new FileManagerError(403, 'Некорректная резервная копия');
          // For large deleted binaries, stream to a temp file rather than loading RAM.
          const temporary = `${dir.anchored}/.orbit-edit-${randomUUID()}`;
          let saved;
          try {
            if (opened) saved = await backup(opened, 'edit');
            await fs.copyFile(path.join(folder, 'content'), temporary, constants.COPYFILE_EXCL);
            const copy = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { await copy.chmod(record.mode & 0o777); await copy.sync(); } finally { await copy.close(); }
            if (opened) { await checkRevision(opened, expected); await fs.rename(temporary, dir.filename); }
            else await fs.link(temporary, dir.filename);
            await dir.handle.sync();
            if (saved) await committed(saved);
          } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          return { path: record.path };
        } finally { if (opened) await close(opened); await dir.handle.close(); }
      });
    },
    async purge(id) {
      return lock(async () => {
        const { folder } = await historyRecord(id);
        await fs.unlink(path.join(folder, 'content'));
        await fs.unlink(path.join(folder, 'record.json'));
        await fs.rmdir(folder);
        return { removed: true };
      });
    },
  };
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, async (...args) => {
    try { return await operation(...args); } catch (error) { throw translate(error); }
  }]));
}
module.exports = { createProjectFiles, FileManagerError, TEXT_LIMIT, UPLOAD_LIMIT };
