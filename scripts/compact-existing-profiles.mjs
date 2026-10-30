// Offline artifact compaction of idle profiles; no browser is launched. Import-safe.
import { lstat, readdir, realpath, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import artifacts from '../utils/previousProfileCache.js';
import snapshots from '../utils/profileSnapshots.js';
import { sqliteWrite } from '../worker/sqlite-write.mjs';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const fail = code => Object.assign(new Error(code), { code });
const exists = async path => {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw fail('unsafe_directory');
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function readRegular(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw fail('unsafe_snapshot_file');
    return { text: await file.readFile('utf8'), stat };
  } finally { await file.close(); }
}
async function treeBytes(path, check) {
  await check();
  const stat = await exists(path);
  if (!stat) return 0;
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw fail('unsafe_profile_entry');
  if (stat.isFile()) return stat.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await treeBytes(join(path, name), check);
  return bytes;
}
async function filesystemActivity(root, id) {
  const journals = join(root, '.publications');
  if (await exists(journals)) {
    await directory(journals);
    if ((await readdir(journals)).some(name => name === id || name.startsWith(`.prepare-${id}-`) || name.startsWith(`.settled-${id}-`))) return 'publication_pending';
  }
  const browsers = join(root, 'browser-data'), profile = join(browsers, id);
  if (!await exists(browsers)) return null;
  await directory(browsers);
  if (!await exists(profile)) return null;
  await directory(profile);
  const names = await readdir(profile);
  // A stale run is intentionally skipped as well: orphan reclamation is a separate operation.
  if (names.some(name => /^(run-|retired-|Singleton)|lock/i.test(name))) return 'run_or_lock_present';
  for (const name of ['current', 'previous']) {
    const path = join(profile, name);
    if (!await exists(path)) continue;
    await directory(path);
    if ((await readdir(path)).some(entry => /^Singleton|^lock(?:file)?$|^\.lock$/i.test(entry))) return 'browser_lock_present';
  }
  return null;
}
async function databaseActivity(db, id, owner) {
  const profile = await db.profile.findUnique({ where: { id }, select: { deletedAt: true } });
  if (!profile || profile.deletedAt) return 'profile_unavailable';
  if (await db.warmupJob.count({ where: { profileId: id, status: 'running' } }) ||
      await db.taskExecution.count({ where: { profileId: id, status: 'running' } })) return 'profile_running';
  const lease = await db.workflowLease.findUnique({ where: { key: `profile:${id}` } });
  if (lease && lease.owner !== owner && (!Number.isFinite(+lease.expiresAt) || +lease.expiresAt > Date.now())) return 'profile_leased';
  return null;
}

// Writer admission and lease reservation are atomic. No filesystem traversal or
// deletion runs inside a SQLite write transaction. Only our own lease is released.
export async function withIdleProfileLease(db, id, action, { ttlMs = 600000 } = {}) {
  if (!validId(id) || !Number.isFinite(ttlMs) || ttlMs < 1000) throw fail('invalid_lease_options');
  const owner = `profile-compaction:${randomUUID()}`, key = `profile:${id}`;
  const busy = await sqliteWrite(db, async tx => {
    const reason = await databaseActivity(tx, id);
    if (reason) return reason;
    const data = { owner, expiresAt: new Date(Date.now() + ttlMs) };
    await tx.workflowLease.upsert({ where: { key }, create: { key, ...data }, update: data });
    return null;
  });
  if (busy) return { skipped: busy };
  let failure, renewal = Promise.resolve(), lastChecked = 0;
  const renew = () => {
    renewal = renewal.then(async () => {
      if (failure) throw failure;
      const changed = await sqliteWrite(db, tx => tx.workflowLease.updateMany({
        where: { key, owner, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date(Date.now() + ttlMs) },
      }));
      if (changed.count !== 1) throw fail('compaction_lease_lost');
    }).catch(error => { failure = error; });
    return renewal;
  };
  const timer = setInterval(renew, Math.min(10000, ttlMs / 3)); timer.unref();
  const check = async (force = false) => {
    if (failure) throw failure;
    if (!force && Date.now() - lastChecked < Math.min(1000, ttlMs / 4)) return;
    await renew();
    if (failure) throw failure;
    if (await databaseActivity(db, id, owner)) throw fail('profile_became_active');
    lastChecked = Date.now();
  };
  try { await check(true); return await action(check); }
  finally {
    clearInterval(timer); await renewal;
    await sqliteWrite(db, tx => tx.workflowLease.deleteMany({ where: { key, owner } }));
  }
}

async function planProfile(root, row, check) {
  const json = [], targets = [];
  let bytesBefore = 0, reclaimable = 0;
  for (const [version, suffix] of [['current', '.json'], ['previous', '.json.previous']]) {
    const path = join(root, row.id + suffix), native = join(root, 'browser-data', row.id, version);
    let value;
    if (await exists(path)) {
      const original = await readRegular(path);
      try { value = JSON.parse(original.text); } catch { throw fail('invalid_snapshot_json'); }
      // checkSnapshot accepts unversioned legacy data; maintenance requires a checksum.
      if (value.profileId !== row.id || !value.snapshot?.id || !snapshots.checkSnapshot(value)) throw fail('profile_snapshot_mismatch');
      if (version === 'current' && row.snapshotId && row.snapshotId !== value.snapshot.id) throw fail('profile_storage_version_mismatch');
      const text = JSON.stringify(value), compactBytes = Buffer.byteLength(text);
      if (!snapshots.checkSnapshot(JSON.parse(text))) throw fail('profile_snapshot_mismatch');
      json.push({ path, ...original, compact: compactBytes < original.stat.size ? text : original.text });
      bytesBefore += original.stat.size;
      reclaimable += Math.max(0, original.stat.size - compactBytes);
    }
    if (await exists(native)) {
      await directory(native);
      if (!value || (await readRegular(join(native, '.orbit-snapshot-id'))).text !== value.snapshot.id) throw fail('profile_storage_version_mismatch');
      const candidates = await artifacts.transientProfileArtifacts(native, { previous: version === 'previous' });
      // Entire legacy HTTP caches are evicted, not edited: their index and
      // response files must remain consistent. This intentionally loses validators.
      const httpCache = join(native, 'Default/Cache');
      if (version === 'current' && await treeBytes(httpCache, check) > 15_000_000) candidates.push(httpCache);
      bytesBefore += await treeBytes(native, check);
      for (const path of candidates) {
        const bytes = await treeBytes(path, check);
        targets.push({ path, bytes }); reclaimable += bytes;
      }
    }
  }
  return { json, targets, bytesBefore, reclaimable };
}
async function replaceSnapshot(entry, check, replaced) {
  const temporary = join(dirname(entry.path), `.compact-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(entry.compact, 'utf8'); await file.sync(); await file.close(); file = null;
    await check();
    const current = await readRegular(entry.path);
    if (current.stat.ino !== entry.stat.ino || current.stat.dev !== entry.stat.dev || current.text !== entry.text) throw fail('snapshot_changed');
    await rename(temporary, entry.path);
    replaced();
    await syncDirectory(dirname(entry.path));
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}

export async function compactExistingProfiles({ db, directory: directoryName, apply = false, limit, log = () => {} }) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw fail('invalid_limit');
  const root = resolve(directoryName); await directory(root);
  const summary = { mode: apply ? 'apply' : 'dry-run', scanned: 0, compacted: 0, skippedActive: 0, errors: 0, bytesBefore: 0, bytesAfter: 0, bytesReclaimed: 0 };
  const rows = await db.profile.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, ...(limit ? { take: limit } : {}) });
  for (const row of rows) {
    summary.scanned++;
    try {
      if (!validId(row.id)) throw fail('invalid_profile_id');
      const activity = await databaseActivity(db, row.id) || await filesystemActivity(root, row.id);
      let result = activity ? { skipped: activity } : null;
      if (!result) {
        const processProfile = async leaseCheck => {
          const busy = await filesystemActivity(root, row.id);
          if (busy) return { skipped: busy };
          const check = async (force = false) => {
            await leaseCheck(force);
            if (force && await filesystemActivity(root, row.id)) throw fail('profile_became_active');
          };
          // A warmup may have published since the candidate list was loaded.
          // Apply reads the committed identity only after reserving our lease.
          const freshRow = await db.profile.findUnique({ where: { id: row.id }, select: { id: true, snapshotId: true, deletedAt: true } });
          if (!freshRow || freshRow.deletedAt) return { skipped: 'profile_unavailable' };
          const plan = await planProfile(root, freshRow, check);
          await check(true);
          summary.bytesBefore += plan.bytesBefore;
          summary.bytesAfter += plan.bytesBefore;
          if (!apply) {
            summary.bytesAfter -= plan.reclaimable;
            return { status: 'candidate', bytesReclaimed: plan.reclaimable };
          }
          let reclaimed = 0, changed = false;
          try {
            for (const target of plan.targets) {
              await check(true);
              // Revalidate the parents before deletion; never follow a replaced parent.
              await directory(dirname(target.path));
              try { await rm(target.path, { recursive: true, force: false }); }
              finally { reclaimed += target.bytes - await treeBytes(target.path, async () => {}); }
              changed = true;
              await syncDirectory(dirname(target.path));
            }
            for (const entry of plan.json) {
              if (entry.text === entry.compact) continue;
              await replaceSnapshot(entry, () => check(true), () => {
                reclaimed += entry.stat.size - Buffer.byteLength(entry.compact); changed = true;
              });
            }
            if (changed) summary.compacted++;
            return { status: changed ? 'compacted' : 'already_compact', bytesReclaimed: reclaimed };
          } finally { summary.bytesAfter -= reclaimed; }
        };
        let lastReadCheck = 0;
        result = apply ? await withIdleProfileLease(db, row.id, processProfile) : await processProfile(async (force = false) => {
          if (!force && Date.now() - lastReadCheck < 1000) return;
          if (await databaseActivity(db, row.id)) throw fail('profile_became_active');
          lastReadCheck = Date.now();
        });
      }
      if (result.skipped) { summary.skippedActive++; log({ profileId: row.id, status: 'skipped_active', reason: result.skipped }); }
      else log({ profileId: row.id, ...result });
    } catch (error) {
      if (error.code === 'profile_became_active') { summary.skippedActive++; log({ profileId: row.id, status: 'skipped_active' }); }
      else { summary.errors++; log({ profileId: row.id, status: 'error', code: error.code || 'compaction_failed' }); }
    }
  }
  summary.bytesReclaimed = summary.bytesBefore - summary.bytesAfter;
  return summary;
}

export function parseOptions(args) {
  const options = { apply: false };
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') continue;
    else if (/^--limit=[1-9]\d*$/.test(arg) && Number.isSafeInteger(Number(arg.slice(8)))) options.limit = Number(arg.slice(8));
    else throw fail('invalid_cli_argument');
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw fail('conflicting_modes');
  return options;
}
async function main() {
  const options = parseOptions(process.argv.slice(2));
  // Explicit paths prevent accidentally compacting another checkout's profile pool.
  if (!process.env.WORKER_PROFILES_DIR || !process.env.DATABASE_URL?.startsWith('file:/')) throw fail('absolute_database_url_and_profiles_dir_required');
  const db = new PrismaClient();
  try {
    const summary = await compactExistingProfiles({ ...options, db, directory: process.env.WORKER_PROFILES_DIR,
      log: event => process.stderr.write(JSON.stringify(event) + '\n') });
    process.stdout.write(JSON.stringify(summary) + '\n');
    if (summary.errors) process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(JSON.stringify({ status: 'error', code: error.code || 'compaction_failed' }) + '\n'); process.exitCode = 1; });
}
