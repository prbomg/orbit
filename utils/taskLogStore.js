// Shared by the asynchronous worker writer and authenticated download endpoints.
// No browser state or application database is modified here.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const PART_BYTES = 64 * 1024;
const BUDGET_BYTES = 2_000_000_000;
const DAY = 86400000;
const safeId = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const rootPath = () => path.resolve(process.cwd(), 'logs/tasks');
async function regular(file) {
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const s = await h.stat();
  if (!s.isFile() || s.nlink !== 1) { await h.close(); throw Error('invalid_log_file'); }
  return h;
}
async function readCatalog(root = rootPath()) {
  let h;
  try {
    h = await regular(path.join(root, 'v2/catalog.json'));
    if ((await h.stat()).size > 32 * 1024 * 1024) throw Error('log_catalog_too_large');
    const value = JSON.parse(await h.readFile('utf8'));
    if (value.version !== 2 || !Array.isArray(value.attempts)) throw Error('invalid_log_catalog');
    return value;
  } catch (e) { if (e.code === 'ENOENT') return { version: 2, attempts: [] }; throw e; }
  finally { await h?.close(); }
}
async function locked(root, fn) {
  await fs.mkdir(path.join(root, 'v2'), { recursive: true, mode: 0o700 });
  for (const p of [root, path.join(root, 'v2')]) { const s = await fs.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('invalid_log_directory'); }
  const lock = path.join(root, 'v2/.write-lock');
  const reap = path.join(root, 'v2/.reap-lock');
  const reapDead = async () => {
    try { await fs.mkdir(reap); } catch (e) { if (e.code === 'EEXIST') return; throw e; }
    try {
      let dead = false;
      try { const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); dead = !processAlive(owner.pid); }
      catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) { try { dead = Date.now() - (await fs.stat(lock)).mtimeMs > 30000; } catch {} } else throw e; }
      if (dead) await fs.rm(lock, { recursive: true, force: true });
    } finally { await fs.rmdir(reap); }
  };
  for (let i = 0; ; i++) {
    try {
      try { const s = await fs.stat(reap); if (Date.now() - s.mtimeMs > 30000) await fs.rmdir(reap).catch(() => {}); await delay(20); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.mkdir(lock); break;
    }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await fs.stat(lock);
        const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
        if (!processAlive(owner.pid)) { await reapDead(); continue; }
        if (Date.now() - s.mtimeMs > 300000) throw Error('log_writer_lock_stalled');
      } catch (err) {
        if (err.code === 'ENOENT' || err instanceof SyntaxError) {
          try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await reapDead(); } catch {}
        } else throw err;
      }
      if (i > 1000) throw Error('log_writer_lock_timeout');
      await delay(20);
    }
  }
  try { await fs.writeFile(path.join(lock, 'owner.tmp'), JSON.stringify({ pid: process.pid })); await fs.rename(path.join(lock, 'owner.tmp'), path.join(lock, 'owner.json')); return await fn(); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function saveCatalog(root, cat) {
  const file = path.join(root, 'v2/catalog.json');
  const temp = `${file}.${process.pid}.tmp`;
  const h = await fs.open(temp, 'w', 0o600);
  try { await h.writeFile(JSON.stringify(cat)); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
function partPath(root, attempt, part) {
  if (!safeId(attempt.id) || !/^part-\d{6}\.txt$/.test(part.name)) throw Error('invalid_log_path');
  return path.join(root, 'v2', attempt.id, part.name);
}
async function readLeases(root) {
  const dir = path.join(root, 'v2/.readers'); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const leases = [];
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const h = await regular(file); let lease;
      try { lease = JSON.parse(await h.readFile('utf8')); } finally { await h.close(); }
      if (!processAlive(lease.pid) || lease.expires < Date.now()) await fs.rm(file, { force: true });
      else leases.push(lease);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return leases;
}
async function acquireReadLease(root, ids) {
  const file = path.join(root, 'v2/.readers', randomUUID() + '.json');
  await locked(root, async () => {
    if ((await readLeases(root)).length >= 4) throw Object.assign(Error('Слишком много одновременных скачиваний. Повторите позже.'), { status: 429 });
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, ids, expires: Date.now() + 120000 }), { mode: 0o600, flag: 'wx' });
  });
  let closed = false;
  const timer = setInterval(() => { if (!closed) void locked(root, async () => {
    if (!closed) await fs.writeFile(file, JSON.stringify({ pid: process.pid, ids, expires: Date.now() + 120000 }), { mode: 0o600 });
  }).catch(() => {}); }, 30000); timer.unref();
  return async () => { closed = true; clearInterval(timer); await fs.rm(file, { force: true }); };
}
async function writeBatch(root, records, options = {}) {
  const now = options.now ?? Date.now(), budget = options.budgetBytes ?? BUDGET_BYTES, partLimit = options.partBytes ?? PART_BYTES;
  return locked(root, async () => {
    const cat = await readCatalog(root);
    const protectedIds = new Set((await readLeases(root)).flatMap(l => l.ids));
    if (!cat.lastSweepAt || now - cat.lastSweepAt > 60000) {
      const known = new Map(cat.attempts.map(a => [a.id, a]));
      for (const entry of await fs.readdir(path.join(root, 'v2'), { withFileTypes: true })) {
        if (!/^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{32})$/.test(entry.name) || !entry.isDirectory()) continue;
        const dir = path.join(root, 'v2', entry.name), a = known.get(entry.name);
        if (!a) { await fs.rm(dir, { recursive: true, force: true }); continue; }
        const parts = new Set(a.parts.map(p => p.name));
        for (const name of await fs.readdir(dir)) if (/^part-\d{6}\.txt$/.test(name) && !parts.has(name)) await fs.rm(path.join(dir, name));
      }
      cat.lastSweepAt = now;
    }
    let used = cat.attempts.reduce((sum, a) => sum + (a.directoryAllocated || 0) + a.parts.reduce((n, p) => n + p.allocated, 0), 0);
    // Reserve room for the catalog, directory entries, and its atomic replacement.
    const reserve = options.reserveBytes ?? 80 * 1024 * 1024;
    let legacy = 0;
    for (const name of await fs.readdir(root)) if (/^task-[\w-]+\.txt$/.test(name)) {
      const s = await fs.lstat(path.join(root, name)); if (s.isFile()) { if (now - s.mtimeMs > 30 * DAY) await fs.rm(path.join(root, name)); else legacy += s.blocks * 512; }
    }
    const maximum = Math.max(0, budget - reserve - legacy);
    const remove = async a => {
      if (!safeId(a.id)) throw Error('invalid_log_path');
      await fs.rm(path.join(root, 'v2', a.id), { recursive: true, force: true });
      used -= (a.directoryAllocated || 0) + a.parts.reduce((n, p) => n + p.allocated, 0);
      a.directoryAllocated = 0;
      a.parts = []; a.expiredAt = new Date(now).toISOString();
    };
    for (const a of cat.attempts) {
      if (a.status === 'active' && !processAlive(a.pid)) { a.status = 'interrupted'; a.finishedAt = a.updatedAt; }
      if (a.status !== 'active' && !protectedIds.has(a.id) && a.parts.length && now - Date.parse(a.finishedAt || a.updatedAt) > (a.status === 'success' ? 7 : 30) * DAY) await remove(a);
    }
    const evict = async needed => {
      const old = cat.attempts.filter(a => a.status !== 'active' && !protectedIds.has(a.id) && a.parts.length)
        .sort((a, b) => Number(a.status !== 'success') - Number(b.status !== 'success') || a.updatedAt.localeCompare(b.updatedAt));
      while (used + needed > maximum && old.length) await remove(old.shift());
      return used + needed <= maximum;
    };
    let dropped = 0;
    const dirtyFiles = new Set();
    for (const record of records) {
      const { meta } = record;
      if (!safeId(meta.id) || !safeId(meta.taskId) || (meta.executionId && !safeId(meta.executionId))) throw Error('invalid_log_identity');
      let a = cat.attempts.find(a => a.id === meta.id);
      if (!a) { a = { ...meta, pid: process.pid, status: 'active', updatedAt: meta.startedAt, parts: [], nextPart: 1, events: 0, dropped: 0 }; cat.attempts.push(a); }
      a.updatedAt = record.time; a.events++; a.lastEvent = record.event;
      if (record.code) a.errorCode = record.code;
      // Late diagnostic records are permitted in an already closed attempt.
      let bytes = Buffer.from(record.line, 'utf8');
      const allowance = Math.ceil(bytes.length / 4096) * 4096 + 8192;
      if (bytes.length > partLimit || !await evict(allowance)) { a.dropped++; dropped++; }
      else {
        let part = a.parts.at(-1);
        if (!part || part.bytes + bytes.length > partLimit) {
          part = { name: `part-${String(a.nextPart++).padStart(6, '0')}.txt`, bytes: 0, allocated: 0 };
          const header = `# Orbit task=${a.taskId} execution=${a.executionId || '-'} attempt=${a.id} started=${a.executionStartedAt || a.startedAt} part=${part.name} UTF-8\n`;
          bytes = Buffer.concat([Buffer.from(header), bytes]);
          if (bytes.length > partLimit) { a.dropped++; dropped++; continue; }
          a.parts.push(part);
        }
        const dir = path.join(root, 'v2', a.id);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw Error('invalid_log_directory');
        used += st.blocks * 512 - (a.directoryAllocated || 0); a.directoryAllocated = st.blocks * 512;
        dirtyFiles.add(partPath(root, a, part));
        const h = await fs.open(partPath(root, a, part), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          const st = await h.stat(); if (!st.isFile() || st.nlink !== 1) throw Error('invalid_log_file');
          // Discard only an uncommitted tail left by an interrupted catalog update.
          await h.truncate(part.bytes);
          await h.write(bytes, 0, bytes.length, part.bytes);
          const after = await h.stat(); used += after.blocks * 512 - part.allocated;
          part.bytes += bytes.length; part.allocated = after.blocks * 512;
        } finally { await h.close(); }
      }
      if (record.end) { a.status = record.end; a.finishedAt = record.time; }
    }
    await evict(0);
    // Summaries remain after detailed parts expire; keep a bounded 90-day catalog.
    cat.attempts = cat.attempts.filter(a => a.parts.length || a.status === 'active' || now - Date.parse(a.updatedAt) <= 90 * DAY);
    const empty = cat.attempts.filter(a => !a.parts.length && a.status !== 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const retained = new Set(empty.slice(0, 10000).map(a => a.id));
    cat.attempts = cat.attempts.filter(a => a.parts.length || a.status === 'active' || retained.has(a.id));
    cat.updatedAt = new Date(now).toISOString(); cat.allocatedBytes = used; cat.legacyBytes = legacy; cat.budgetBytes = budget; cat.partBytes = partLimit;
    // One durable flush per touched part, not one flush per telemetry event.
    for (const file of dirtyFiles) {
      let h;
      try { h = await regular(file); await h.sync(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { await h?.close(); }
    }
    await saveCatalog(root, cat);
    return { dropped, used, attempts: cat.attempts.length };
  });
}
async function readPart(root, attempt, part) {
  const dir = await fs.lstat(path.join(root, 'v2', attempt.id));
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('invalid_log_directory');
  const h = await regular(partPath(root, attempt, part));
  try {
    if (part.bytes < 0 || part.bytes > PART_BYTES || (await h.stat()).size < part.bytes) throw Error('invalid_log_part');
    const buffer = Buffer.alloc(part.bytes);
    let offset = 0;
    while (offset < buffer.length) { const r = await h.read(buffer, offset, buffer.length - offset, offset); if (!r.bytesRead) throw Error('log_part_changed'); offset += r.bytesRead; }
    return buffer;
  } finally { await h.close(); }
}
module.exports = { PART_BYTES, BUDGET_BYTES, safeId, rootPath, readCatalog, writeBatch, readPart, acquireReadLease };
