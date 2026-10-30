const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resourcePaths, parseDu } = require('./serviceResources');
const run = promisify(execFile);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && value !== '.' && value !== '..';
const safeJob = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const identity = stat => `${stat.dev}:${stat.ino}`;
const revision = stat => createHash('sha256').update(`${identity(stat)}:${stat.birthtimeMs}:${stat.mtimeMs}`).digest('hex');
const now = () => new Date().toISOString();
class ReleaseError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
async function realDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReleaseError('unsafe_directory', 'Каталог релизов недоступен для управления', 503);
}
async function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temp, filename);
}
async function acquireFileLock(filename) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = sync.openSync(filename, 'wx', 0o600);
      try { sync.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { sync.closeSync(fd); }
      return () => {
        try { if (JSON.parse(sync.readFileSync(filename, 'utf8')).token === token) sync.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(sync.readFileSync(filename, 'utf8')); } catch { throw new ReleaseError('release_busy', 'Управление релизами уже выполняется. Попробуйте позже'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new ReleaseError('release_busy', 'Управление релизами уже выполняется. Попробуйте позже');
      try { process.kill(owner.pid, 0); throw new ReleaseError('release_busy', 'Управление релизами уже выполняется. Попробуйте позже'); }
      catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
      try { sync.unlinkSync(filename); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
  }
  throw new ReleaseError('release_busy', 'Управление релизами уже выполняется. Попробуйте позже');
}
async function withReleaseOperation(application, action) {
  const unlock = await acquireFileLock(path.join(application, '.release-operation.lock'));
  try { return await action(); } finally { unlock(); }
}
async function protections(application, releases, config) {
  const reasons = new Map();
  const mark = (value, reason) => {
    const relative = path.relative(releases, value);
    const id = relative.split(path.sep)[0];
    if (safeId(id) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      if (!reasons.has(id)) reasons.set(id, new Set()); reasons.get(id).add(reason);
    }
  };
  try { mark(await fs.realpath(path.join(application, 'current')), 'current'); }
  catch (error) { if (error.code !== 'ENOENT') throw new ReleaseError('protection_unavailable', 'Не удалось проверить текущий релиз. Удаление временно недоступно', 503); }
  mark(process.cwd(), 'in_use');
  const reserved = [config.data, config.logs, path.join(config.release, '.orbit-runtime'), path.join(config.release, 'logs'), ...['WORKER_PROFILES_DIR','PLAYWRIGHT_BROWSERS_PATH'].filter(key => process.env[key]).map(key => path.resolve(config.release, process.env[key]))];
  for (const directory of reserved) { mark(directory, 'storage'); try { mark(await fs.realpath(directory), 'storage'); } catch { /* A missing optional data path has no release to protect. */ } }
  for (const name of ['node_modules', '.next']) { try { mark(await fs.realpath(path.join(config.release, name)), 'in_use'); } catch { /* Optional in test and early deployment directories. */ } }
  if (process.platform !== 'linux') throw new ReleaseError('protection_unavailable', 'Проверка работающих процессов доступна только на сервере Linux', 503);
  const pids = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  for (let offset = 0; offset < pids.length; offset += 32) await Promise.all(pids.slice(offset, offset + 32).map(async pid => {
    try { mark(await fs.readlink(`/proc/${pid}/cwd`), 'in_use'); } catch { /* Other users and exited processes are not readable. */ }
    try {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
      for (const argument of args) if (path.isAbsolute(argument)) mark(argument, 'in_use');
    } catch { /* No command arguments are exposed to the client. */ }
  }));
  return reasons;
}
function createReleaseManager(config = resourcePaths(), dependencies = {}) {
  const application = config.application, releases = path.join(application, 'releases'), trash = path.join(application, '.release-deletions');
  const remove = dependencies.remove || (directory => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  let sizes = new Map(), sizesAt = 0, sizePending = null, cleaning = false;
  async function ensureRoots() { await realDirectory(application); try { await realDirectory(releases); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  function refreshSizes(entries) {
    if (sizePending || Date.now() - sizesAt < 300000 && entries.every(row => sizes.get(row.id)?.revision === row.revision)) return;
    sizePending = (async () => {
      try {
        const { stdout } = await run('du', ['-x', '-B1', '--max-depth=1', '--', releases], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        const parsed = parseDu(stdout), next = new Map();
        for (const row of entries) if (parsed.has(path.join(releases, row.id))) next.set(row.id, { revision: row.revision, bytes: parsed.get(path.join(releases, row.id)) });
        sizes = next; sizesAt = Date.now();
      } catch { sizesAt = Date.now() - 270000; } // Retry failed measurements after 30 seconds.
    })().finally(() => { sizePending = null; });
  }
  async function entries() {
    if (!await ensureRoots()) return [];
    const protectedIds = await protections(application, releases, config), rows = [];
    for (const name of await fs.readdir(releases)) {
      try {
        const stat = await fs.lstat(path.join(releases, name)); if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
        const reasons = [...(protectedIds.get(name) || [])];
        if (!safeId(name) || stat.isSymbolicLink()) reasons.push('unsafe');
        const metadata = path.join(releases, name, '.orbit-release.json');
        if (!stat.isSymbolicLink()) {
          try { if (JSON.parse(await fs.readFile(metadata, 'utf8')).state !== 'ready') reasons.push('preparing'); }
          catch (error) { if (error.code !== 'ENOENT') reasons.push('unsafe'); }
        }
        const token = revision(stat), cached = sizes.get(name);
        rows.push({ id: name, revision: token, savedAt: new Date(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs).toISOString(), dateSource: stat.birthtimeMs > 0 ? 'created' : 'modified', bytes: cached?.revision === token ? cached.bytes : null, protected: reasons.length > 0, reasons });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
    refreshSizes(rows.filter(row => !row.reasons.includes('unsafe')));
    return rows;
  }
  async function readJobs() {
    let names;
    try { await realDirectory(trash); names = await fs.readdir(trash); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const jobs = [];
    for (const id of names.filter(safeJob)) {
      try {
        await realDirectory(path.join(trash, id));
        const job = JSON.parse(await fs.readFile(path.join(trash, id, 'job.json'), 'utf8'));
        if (job.id !== id || !Array.isArray(job.items) || job.items.length > 100 || !job.items.every(item => safeId(item.id) && typeof item.identity === 'string') || !['preparing','deleting','failed','completed'].includes(job.status)) throw new Error('Invalid deletion journal');
        jobs.push(job);
      } catch (error) { if (error.code !== 'ENOENT') throw new ReleaseError('journal_unavailable', 'Не удалось прочитать журнал удаления. Обратитесь к администратору', 503); }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  function publicJob(job) {
    return { id: job.id, status: job.status, createdAt: job.createdAt, completedAt: job.completedAt || null, total: job.items.length, done: job.items.filter(item => item.done).length, releases: job.items.map(item => item.id), error: job.status === 'failed' ? 'Не удалось полностью удалить файлы. Можно повторить очистку.' : null };
  }
  async function writeEpoch() {
    const filename = path.join(application, '.releases-updated'), temp = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, randomUUID(), { mode: 0o600 }); await fs.rename(temp, filename);
  }
  async function recoverPreparing() {
    if (!(await readJobs()).some(job => job.status === 'preparing')) return;
    try {
      await withReleaseOperation(application, async () => {
        for (const job of (await readJobs()).filter(job => job.status === 'preparing')) {
          const folder = path.join(trash, job.id), files = path.join(folder, 'files'); await realDirectory(files);
          for (const item of job.items) {
            const target = path.join(files, item.id), source = path.join(releases, item.id);
            let stat;
            try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== item.identity) throw new ReleaseError('journal_unavailable', 'Не удалось восстановить прерванную подготовку удаления', 503);
            try { await fs.lstat(source); throw new ReleaseError('release_changed', 'Каталог релиза создан повторно. Обратитесь к администратору', 503); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rename(target, source);
          }
          await fs.rm(folder, { recursive: true, force: true });
        }
      });
    } catch (error) { if (error.code !== 'release_busy') throw error; }
  }
  async function wakeCleanup() {
    if (cleaning) return; cleaning = true;
    let unlock, completedPass = false;
    try {
      const jobs = (await readJobs()).filter(job => job.status === 'deleting'); if (!jobs.length) return;
      try { unlock = await acquireFileLock(path.join(application, '.release-cleanup.lock')); } catch (error) { if (error.code === 'release_busy') return; throw error; }
      for (const job of jobs) {
        const folder = path.join(trash, job.id), files = path.join(folder, 'files'); await realDirectory(files);
        let failed = false;
        for (const item of job.items.filter(item => !item.done)) {
          try {
            const target = path.join(files, item.id);
            try { const stat = await fs.lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== item.identity) throw new Error('Deletion directory changed'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await remove(target); item.done = true;
          } catch { failed = true; }
          await atomicJson(path.join(folder, 'job.json'), job);
        }
        job.status = failed ? 'failed' : 'completed'; job.completedAt = now();
        await atomicJson(path.join(folder, 'job.json'), job); await writeEpoch(); sizesAt = 0;
      }
      completedPass = true;
    } catch { /* Keep persisted jobs for the next authenticated status request. */ }
    finally { unlock?.(); cleaning = false; if (completedPass) setTimeout(() => { void wakeCleanup(); }, 0); }
  }
  async function list() {
    await recoverPreparing();
    const [rows, jobs] = await Promise.all([entries(), readJobs()]);
    void wakeCleanup();
    return { checkedAt: now(), releases: rows, sizesPending: rows.some(row => row.bytes === null && !row.reasons.includes('unsafe')), deletions: jobs.filter(job => job.status !== 'preparing').slice(-10).reverse().map(publicJob) };
  }
  async function deleteSelected(selected) {
    if (!Array.isArray(selected) || !selected.length || selected.length > 100 || selected.some(row => !safeId(row.id) || !/^[a-f0-9]{64}$/.test(row.revision)) || new Set(selected.map(row => row.id)).size !== selected.length) throw new ReleaseError('invalid_selection', 'Выберите корректные релизы для удаления', 400);
    await recoverPreparing(); await readJobs();
    const job = await withReleaseOperation(application, async () => {
      const current = new Map((await entries()).map(row => [row.id, row]));
      for (const row of selected) {
        const existing = current.get(row.id);
        if (!existing) throw new ReleaseError('release_missing', 'Один из выбранных релизов уже удалён. Обновите список', 409);
        if (existing.protected) throw new ReleaseError('release_protected', `Релиз ${row.id} используется или защищён от удаления`, 409);
        if (existing.revision !== row.revision) throw new ReleaseError('release_changed', 'Один из выбранных релизов изменился. Обновите список', 409);
      }
      await fs.mkdir(trash, { mode: 0o700, recursive: true }); await realDirectory(trash);
      const id = randomUUID(), folder = path.join(trash, id), files = path.join(folder, 'files'); await fs.mkdir(folder, { mode: 0o700 }); await fs.mkdir(files, { mode: 0o700 });
      const items = [], moved = [];
      try {
        // Re-check the active link and processes immediately before detaching.
        const protectedIds = await protections(application, releases, config);
        for (const row of selected) {
          if (protectedIds.has(row.id)) throw new ReleaseError('release_protected', `Релиз ${row.id} начал использоваться. Обновите список`, 409);
          const source = path.join(releases, row.id), stat = await fs.lstat(source);
          if (!stat.isDirectory() || stat.isSymbolicLink() || revision(stat) !== row.revision) throw new ReleaseError('release_changed', 'Выбранный каталог изменился. Обновите список', 409);
          items.push({ id: row.id, identity: identity(stat), done: false });
        }
        // Persist before detaching any directory. A crash before the commit
        // restores the original folders on the next status request.
        const value = { id, status: 'preparing', createdAt: now(), items };
        await atomicJson(path.join(folder, 'job.json'), value);
        for (const row of selected) {
          const source = path.join(releases, row.id), stat = await fs.lstat(source);
          if (!stat.isDirectory() || stat.isSymbolicLink() || revision(stat) !== row.revision) throw new ReleaseError('release_changed', 'Выбранный каталог изменился. Обновите список', 409);
          await fs.rename(source, path.join(files, row.id)); moved.push(row.id);
        }
        value.status = 'deleting'; await atomicJson(path.join(folder, 'job.json'), value); return value;
      } catch (error) {
        for (const name of moved.reverse()) await fs.rename(path.join(files, name), path.join(releases, name));
        await fs.rm(folder, { recursive: true, force: true }); throw error;
      }
    });
    void wakeCleanup(); return publicJob(job);
  }
  async function retry(id) {
    if (!safeJob(id)) throw new ReleaseError('invalid_job', 'Некорректная операция удаления', 400);
    const job = await withReleaseOperation(application, async () => {
      const value = (await readJobs()).find(job => job.id === id); if (!value) throw new ReleaseError('job_missing', 'Операция удаления не найдена', 404);
      if (value.status !== 'failed') throw new ReleaseError('job_not_failed', 'Эта операция не требует повторного удаления');
      value.status = 'deleting'; value.completedAt = null; await atomicJson(path.join(trash, id, 'job.json'), value); return value;
    });
    void wakeCleanup(); return publicJob(job);
  }
  return { list, deleteSelected, retry, waitForCleanup: async () => { await sizePending; while (cleaning) await new Promise(resolve => setTimeout(resolve, 10)); } };
}
module.exports = { ReleaseError, createReleaseManager, withReleaseOperation };
