const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function resourcePaths(root = process.cwd(), env = process.env) {
  const filename = env.DATABASE_URL?.startsWith('file:') ? decodeURIComponent(env.DATABASE_URL.slice(5).split('?')[0]) : '';
  const database = filename ? path.resolve(root, 'prisma', filename) : path.join(root, 'prisma');
  return {
    release: root,
    application: path.resolve(env.ORBIT_SERVICE_DIRECTORY || (path.basename(path.dirname(root)) === 'releases' ? path.dirname(path.dirname(root)) : root)),
    data: path.resolve(env.ORBIT_DATA_DIRECTORY || (filename ? path.dirname(database) : path.join(root, 'prisma'))),
    logs: path.resolve(env.ORBIT_LOG_DIRECTORY || '/var/log/supervisor'),
    database: filename ? database : null,
    extraDirectories: [
      ['profiles', env.WORKER_PROFILES_DIR], ['browsers', env.PLAYWRIGHT_BROWSERS_PATH === '0' ? null : env.PLAYWRIGHT_BROWSERS_PATH],
      ['serviceBackups', env.ORBIT_SERVICE_BACKUPS_DIRECTORY], ['fonts', env.FONTCONFIG_FILE ? path.dirname(env.FONTCONFIG_FILE) : null],
    ].filter(([, value]) => value).map(([key, value]) => ({ key, path: path.resolve(root, value) })),
  };
}
// One du process shares its inode set across ALL partitions, including pnpm
// hardlinks shared by releases and stores. Never follow arbitrary symlinks.
async function diskUsage(directories, _depth, onProgress = () => {}) {
  if (!directories.length) return { sizes: new Map(), complete: true };
  return new Promise(resolve => {
    let output = '';
    const child = execFile('du', ['-x', '-B1', '--summarize', '--null', '--files0-from=-'], {
      timeout: 600000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
    }, (error, _stdout, stderr) => resolve({ sizes: parseDu(output), complete: !error,
      warning: !error ? null : /Permission denied/.test(stderr || '') ? 'Нет доступа к части файлов сервиса.'
        : /No such file or directory/.test(stderr || '') ? 'Некоторые файлы изменились или исчезли во время обхода.'
        : error.killed ? 'Замер превысил допустимое время.' : 'Обход файлов завершился не полностью.',
    }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      onProgress(parseDu(output.slice(0, output.lastIndexOf('\0') + 1)));
    });
    child.stdin.on('error', () => {}); // du may exit before consuming all paths.
    child.stdin.end(directories.join('\0') + '\0');
  });
}
function parseDu(stdout) {
  const sizes = new Map();
  for (const line of stdout.split(stdout.includes('\0') ? '\0' : '\n')) {
    const match = /^(\d+)\t([\s\S]+)$/.exec(line);
    if (match && Number.isSafeInteger(Number(match[1]))) sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}
const diskCategories = [
  ['application', 'Приложение, сборка и релизы'], ['taskLogs', 'Логи заданий'], ['logs', 'Журналы служб'],
  ['profiles', 'Профили и сессии'], ['database', 'База данных, WAL и SHM'],
  ['serviceBackups', 'Резервные копии сервиса'], ['backups', 'Архивные резервные копии'],
  ['browsers', 'Браузеры Chromium'], ['runtime', 'Данные исполнителей и наблюдения'],
  ['caches', 'Кэши зависимостей и окружения'], ['maintenance', 'Диагностика и материалы выкладок'],
  ['reports', 'Сохранённые отчёты'], ['fonts', 'Шрифты браузера'], ['otherData', 'Прочие файлы сервиса'],
];
async function collectVolume(config) {
  try {
    const volume = await fs.statfs(config.application);
    return { totalBytes: volume.bsize * volume.blocks, usedBytes: volume.bsize * (volume.blocks - volume.bfree), availableBytes: volume.bsize * volume.bavail };
  } catch { return null; }
}
async function collectDisk(config, { onProgress = () => {}, scan = diskUsage } = {}) {
  const boundaries = new Map(), issues = new Set(), overhead = [], entries = [];
  const canonical = async p => fs.realpath(p).catch(() => path.resolve(p));
  const application = await canonical(config.application), data = await canonical(config.data), release = await canonical(config.release);
  async function register(directory, key, required = false) {
    try {
      const real = await fs.realpath(directory), stat = await fs.lstat(real);
      boundaries.set(real, { key, directory: stat.isDirectory() });
      return real;
    } catch (error) { if (required || error.code !== 'ENOENT') issues.add(key); return null; }
  }
  await register(application, 'application', true);
  await register(data, 'otherData', true);
  await register(release, boundaries.get(release)?.key || 'application', true);
  const dataDirectories = { profiles: 'profiles', backups: 'backups', 'service-backups': 'serviceBackups', browsers: 'browsers', runtime: 'runtime',
    home: 'caches', '.pnpm-store': 'caches', maintenance: 'maintenance', reports: 'reports', 'android-fonts-v1': 'fonts',
    'test-chromium-cache': 'caches', 'test-chromium-config': 'caches' };
  for (const [name, key] of Object.entries(dataDirectories)) await register(path.join(data, name), key);
  await register(path.join(application, '.pnpm-store'), 'caches');
  for (const extra of config.extraDirectories || []) if (diskCategories.some(([key]) => key === extra.key)) await register(extra.path, extra.key);
  // Follow only known service data links, including logs preserved in an older
  // release by a restore. Arbitrary links inside source/data remain untraversed.
  const releases = new Set([application, release]);
  let releaseCount = null;
  for (const container of ['releases', '.release-deletions']) {
    try {
      const children = (await fs.readdir(path.join(application, container), { withFileTypes: true })).filter(e => e.isDirectory());
      if (container === 'releases') releaseCount = children.length;
      for (const child of children) releases.add(path.join(application, container, child.name));
    } catch (error) { if (error.code !== 'ENOENT') issues.add('application'); }
  }
  for (const root of releases) {
    await register(path.join(root, 'logs'), 'taskLogs');
    for (const [name, key] of [['.orbit-runtime', 'runtime'], ['profiles', 'profiles']]) {
      // Only the active release may reference external live runtime data.
      if (root === release) await register(path.join(root, name), key);
    }
  }
  // Database files are shallow stat targets, not an extra recursive DB scan.
  try {
    for (const item of await fs.readdir(data, { withFileTypes: true })) {
      if (item.isFile() && /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(item.name)) await register(path.join(data, item.name), 'database');
    }
  } catch { issues.add('otherData'); }
  if (config.database) for (const suffix of ['', '-wal', '-shm', '-journal']) await register(config.database + suffix, 'database', suffix === '');
  // Select only Orbit's Supervisor logs, never another service's logs.
  const logFiles = [];
  try {
    for (const name of await fs.readdir(config.logs)) if (/^orbit(?:-warmup)?\.log(?:\.\d+)?(?:\.gz)?$/.test(name)) logFiles.push(path.join(config.logs, name));
  } catch (error) { if (error.code !== 'ENOENT') issues.add('logs'); }
  for (const filename of logFiles) await register(filename, 'logs');

  const roots = [...boundaries.keys()].filter(p => ![...boundaries.keys()].some(other => other !== p && boundaries.get(other).directory && within(other, p)));
  async function partition(directory, inherited) {
    const key = boundaries.get(directory)?.key || inherited;
    const descendants = [...boundaries.keys()].filter(p => p !== directory && within(directory, p));
    if (!descendants.length) { entries.push({ path: directory, key }); return; }
    try {
      const stat = await fs.lstat(directory);
      overhead.push({ path: directory, key, bytes: stat.blocks * 512 });
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, item.name);
        if (item.isDirectory() && descendants.some(p => within(child, p))) await partition(child, key);
        else entries.push({ path: child, key: boundaries.get(child)?.key || key });
      }
    } catch { issues.add(key); }
  }
  for (const root of roots) await partition(root, boundaries.get(root).key);
  let sizes = new Map(), complete = false, warning = null;
  const volume = await collectVolume(config);
  function result() {
    const totals = new Map(diskCategories.map(([key]) => [key, 0])), unknown = new Set(issues);
    let activeReleaseBytes = 0, activeKnown = true;
    for (const entry of [...overhead, ...entries]) {
      const bytes = entry.bytes ?? sizes.get(entry.path) ?? (complete ? 0 : null);
      if (bytes === null) unknown.add(entry.key); else totals.set(entry.key, totals.get(entry.key) + bytes);
      if (within(release, entry.path)) { if (bytes === null) activeKnown = false; else activeReleaseBytes += bytes; }
    }
    const breakdown = diskCategories.map(([key, label]) => ({ key, label, bytes: unknown.has(key) ? null : totals.get(key) }));
    const knownBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);
    const done = complete && unknown.size === 0;
    return { measuredAt: new Date().toISOString(), bytes: done ? knownBytes : null, knownBytes, complete: done, breakdown,
      activeReleaseBytes: activeKnown ? activeReleaseBytes : null, releaseCount, volume,
      warning, scope: [application, data, ...roots.filter(root => !within(application, root) && !within(data, root))],
    };
  }
  onProgress(result());
  const measured = await scan(entries.map(e => e.path), 0, progress => { sizes = progress; onProgress(result()); });
  sizes = measured.sizes; complete = measured.complete; warning = measured.warning || (issues.size ? 'Не удалось проверить доступ ко всем каталогам сервиса.' : null);
  const final = result(); onProgress(final); return final;
}
function parseProcessStat(text, pageSize = 4096) {
  const end = text.lastIndexOf(')'); if (end < 0) return null;
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 22 || fields[0] === 'Z') return null;
  return { name: text.slice(text.indexOf('(') + 1, end), parentPid: fields[1], ticks: Number(fields[11]) + Number(fields[12]), started: fields[19], rssBytes: Number(fields[21]) * pageSize };
}
async function processSnapshot(application, pageSize) {
  const rows = new Map();
  const ids = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  // Bound the number of descriptors while browsers create and exit processes.
  for (let offset = 0; offset < ids.length; offset += 32) await Promise.all(ids.slice(offset, offset + 32).map(async pid => {
    try {
      const row = parseProcessStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'), pageSize); if (!row) return;
      try { row.owned = within(application, await fs.readlink(`/proc/${pid}/cwd`)); } catch { row.owned = false; }
      rows.set(pid, row);
    } catch { /* Processes of other users and processes that just exited are not readable. */ }
  }));
  // Chromium renderers can change their cwd. Follow parent links so their
  // memory and CPU remain attributed to the Orbit browser that launched them.
  const result = selectServiceProcesses(rows);
  const entries = [...result];
  for (let offset = 0; offset < entries.length; offset += 32) await Promise.all(entries.slice(offset, offset + 32).map(async ([pid, row]) => {
    try { const match = /^Pss:\s+(\d+)\s+kB$/m.exec(await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8')); row.pssBytes = match ? Number(match[1]) * 1024 : null; } catch { row.pssBytes = null; }
  }));
  return result;
}
function selectServiceProcesses(rows) {
  const selected = new Set([...rows].filter(([, row]) => row.owned).map(([pid]) => pid));
  let added;
  do { added = false; for (const [pid, row] of rows) if (!selected.has(pid) && selected.has(row.parentPid)) { selected.add(pid); added = true; } } while (added);
  return new Map([...rows].filter(([pid]) => selected.has(pid)));
}
async function readNumber(filename) {
  try { const value = Number((await fs.readFile(filename, 'utf8')).trim()); return Number.isFinite(value) && value >= 0 ? value : null; } catch { return null; }
}
async function serverMemory() {
  let totalBytes = os.totalmem(), availableBytes = os.freemem();
  try { const info = await fs.readFile('/proc/meminfo', 'utf8'); const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info); if (match) availableBytes = Number(match[1]) * 1024; } catch { /* Fall back to OS free memory. */ }
  const limit = await readNumber('/sys/fs/cgroup/memory.max') ?? await readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (limit && limit < totalBytes) {
    const current = await readNumber('/sys/fs/cgroup/memory.current') ?? await readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    totalBytes = limit; availableBytes = current === null ? Math.min(availableBytes, limit) : Math.max(0, limit - current);
  }
  return { totalBytes, availableBytes };
}
async function cpuCapacity() {
  let cores = os.availableParallelism();
  try {
    const [quota, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cores = Math.min(cores, quota / period);
  } catch {
    const quota = await readNumber('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), period = await readNumber('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (quota && period) cores = Math.min(cores, quota / period);
  }
  return cores;
}
async function collectProcesses(config) {
  if (process.platform !== 'linux') return { measuredAt: new Date().toISOString(), available: false, count: null, browserCount: null, memoryBytes: null, memoryAccounting: null, cpuCores: null, cpuCapacity: os.availableParallelism(), serverMemory: await serverMemory() };
  const [{ stdout: ticks }, { stdout: pages }] = await Promise.all([run('getconf', ['CLK_TCK']), run('getconf', ['PAGESIZE'])]);
  const first = await processSnapshot(config.application, Number(pages)); const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 250));
  const last = await processSnapshot(config.application, Number(pages)); const seconds = (performance.now() - started) / 1000;
  const values = [...last.values()]; let delta = 0;
  for (const [pid, row] of last) { const prior = first.get(pid); if (prior?.started === row.started) delta += Math.max(0, row.ticks - prior.ticks); }
  const pss = values.every(row => row.pssBytes !== null);
  return {
    measuredAt: new Date().toISOString(), available: true, count: values.length,
    browserCount: values.filter(row => /chrome|chromium/i.test(row.name)).length,
    memoryBytes: values.reduce((sum, row) => sum + (pss ? row.pssBytes : row.rssBytes), 0), memoryAccounting: pss ? 'pss' : 'rss',
    cpuCores: delta / Number(ticks) / seconds, cpuCapacity: await cpuCapacity(), serverMemory: await serverMemory(),
  };
}
function cachedCollector(collect, ttlMs, now = Date.now) {
  let value, expiresAt = 0, pending, generation = 0;
  const get = () => {
    if (value && now() < expiresAt) return Promise.resolve(value);
    if (!pending) { const version = generation; pending = Promise.resolve().then(collect).then(result => { if (version === generation) { value = result; expiresAt = now() + ttlMs; } return result; }).finally(() => { pending = null; }); }
    return pending;
  };
  get.invalidate = () => { generation++; value = undefined; expiresAt = 0; };
  return get;
}
function resourceMonitor(config = resourcePaths(), dependencies = {}) {
  const now = dependencies.now || Date.now;
  const scan = dependencies.collectDisk || collectDisk;
  const volume = dependencies.collectVolume || collectVolume;
  const processes = cachedCollector(() => (dependencies.collectProcesses || collectProcesses)(config), 15000, now);
  let current = null, progress = null, pending = null, expiresAt = 0, diskEpoch = null, startedAt = null, failure = false, rerun = false;
  function refreshDisk() {
    if (pending) return;
    startedAt = new Date(now()).toISOString(); failure = false;
    pending = Promise.resolve().then(() => scan(config, { onProgress: value => { progress = value; } })).then(value => {
      progress = value;
      if (value.complete || !current?.complete) current = value;
      failure = !value.complete;
      expiresAt = now() + (value.complete ? 300000 : 30000);
    }).catch(() => { failure = true; expiresAt = now() + 30000; }).finally(() => { pending = null; if (rerun) { rerun = false; expiresAt = 0; refreshDisk(); } });
  }
  return async ({ refresh = false } = {}) => {
    const epoch = dependencies.readEpoch ? await dependencies.readEpoch() : await fs.readFile(path.join(config.application, '.releases-updated'), 'utf8').catch(() => null);
    if (epoch !== diskEpoch) { expiresAt = 0; diskEpoch = epoch; if (pending) rerun = true; }
    if (refresh || now() >= expiresAt) refreshDisk();
    const [usage, filesystem] = await Promise.all([
      processes().catch(() => ({ measuredAt: new Date().toISOString(), available: false, count: null, browserCount: null, memoryBytes: null, memoryAccounting: null, cpuCores: null, cpuCapacity: null, serverMemory: null })),
      volume(config),
    ]);
    const storage = current || progress;
    const disk = storage || { measuredAt: startedAt || new Date(now()).toISOString(), bytes: null, knownBytes: 0, complete: false,
      breakdown: diskCategories.map(([key, label]) => ({ key, label, bytes: null })), activeReleaseBytes: null, releaseCount: null };
    return { checkedAt: new Date(now()).toISOString(), disk: { ...disk, volume: filesystem, scanState: pending ? 'scanning' : failure ? 'error' : 'idle', scanStartedAt: startedAt }, processes: usage };
  };
}
module.exports = { resourcePaths, collectDisk, collectProcesses, parseDu, parseProcessStat, selectServiceProcesses, cachedCollector, resourceMonitor };
