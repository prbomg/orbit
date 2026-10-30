import { lstat, readdir, readFile, realpath, rm, mkdir, writeFile, appendFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import artifacts from '../utils/previousProfileCache.js';

const execute = promisify(execFile);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe_directory');
}
async function publicationPending(root, id) {
  const path = join(root, '.publications');
  if (!await exists(path)) return false;
  await directory(path);
  return (await readdir(path)).some(name => name === id || name.startsWith(`.prepare-${id}-`) || name.startsWith(`.settled-${id}-`));
}

// Byte hashes of everything that must survive the confirmed previous policy.
// ScriptCache and registration Database remain protected together.
export async function protectedTree(root) {
  const hash = createHash('sha256'); let files = 0;
  async function walk(path, relative = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (artifacts.isTransientProfilePath(name, { previous: true })) continue;
      const child = join(path, entry.name), stat = await lstat(child);
      hash.update(JSON.stringify([name, stat.mode, stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file']) + '\n');
      if (stat.isSymbolicLink()) throw Error('protected_symlink_requires_review');
      if (stat.isDirectory()) await walk(child, name);
      else { hash.update(digest(await readFile(child))); files++; }
    }
  }
  await walk(root);
  return { sha256: hash.digest('hex'), files };
}
async function currentSignature(root, id) {
  const result = {};
  for (const name of ['current', 'current/Default', 'current/Default/Cache', 'current/Default/Code Cache']) {
    const stat = await exists(join(root, 'browser-data', id, name));
    result[name] = stat ? [stat.dev, stat.ino, stat.mode, stat.mtimeMs] : null;
  }
  for (const name of [`${id}.json`, `${id}.json.previous`, `browser-data/${id}/current/.orbit-snapshot-id`]) {
    const path = join(root, name);
    result[name] = await exists(path) ? digest(await readFile(path)) : null;
  }
  return result;
}

// Caller holds profile:<id>. No publication/cache mutation is allowed outside
// the confirmed previous copy. Current HTTP responses and validators are protected.
export async function cleanPreviousCache(directoryName, id, { apply = false, check = async () => {} } = {}) {
  if (!validId(id)) throw Error('invalid_profile_id');
  const root = resolve(directoryName);
  await directory(root); await directory(join(root, 'browser-data')); await directory(join(root, 'browser-data', id));
  if (await publicationPending(root, id)) return { skipped: 'publication_pending' };
  const previous = join(root, 'browser-data', id, 'previous');
  if (!await exists(previous)) return { skipped: 'previous_missing' };
  await directory(previous); await directory(join(previous, 'Default'));
  if (await realpath(previous) !== previous) throw Error('unsafe_directory');
  const snapshotPath = join(root, `${id}.json.previous`);
  if (!await exists(snapshotPath)) return { skipped: 'previous_snapshot_missing' };
  const snapshotStat = await lstat(snapshotPath);
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) throw Error('unsafe_snapshot_file');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const marker = await readFile(join(previous, '.orbit-snapshot-id'), 'utf8');
  if (snapshot.profileId !== id || !snapshot.snapshot?.id || snapshot.snapshot.id !== marker) return { skipped: 'snapshot_mismatch' };
  const targets = await artifacts.transientProfileArtifacts(previous, { previous: true });
  if (!targets.length) return { skipped: 'already_clean' };
  const { stdout } = await execute('du', ['-B1', '-s', '--', ...targets]);
  const cacheBytes = stdout.trim().split('\n').reduce((sum, line) => sum + Number(line.split('\t', 1)[0]), 0);
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw Error('invalid_cache_size');
  if (!apply) return { candidate: true, cacheBytes };
  const before = await protectedTree(previous), current = await currentSignature(root, id);
  await check();
  if (await publicationPending(root, id)) throw Error('publication_started');
  for (const target of targets) {
    await check(); await directory(dirname(target));
    if (await realpath(dirname(target)) !== dirname(target)) throw Error('unsafe_directory');
    await rm(target, { recursive: true, force: false });
    const parent = await open(dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  const after = await protectedTree(previous);
  if (before.sha256 !== after.sha256 || before.files !== after.files) throw Error('protected_state_changed');
  if (JSON.stringify(current) !== JSON.stringify(await currentSignature(root, id))) throw Error('current_state_changed');
  return { cleaned: true, cacheBytes, protected: after, currentUnchanged: true, snapshotId: marker };
}

export async function withProfileLease(db, id, action, { now = Date.now, ttlMs = 120000 } = {}) {
  if (!validId(id)) throw Error('invalid_profile_id');
  const owner = `previous-cache-cleanup:${randomUUID()}`, key = `profile:${id}`;
  const query = () => db.prepare('SELECT owner,expiresAt FROM WorkflowLease WHERE key=?').get(key);
  db.exec('BEGIN IMMEDIATE');
  let reserved;
  try {
    if (!db.prepare('SELECT id FROM Profile WHERE id=? AND deletedAt IS NULL').get(id)) { db.exec('COMMIT'); return { skipped: 'profile_missing' }; }
    if (db.prepare("SELECT 1 FROM WarmupJob WHERE profileId=? AND status='running'").get(id) || db.prepare("SELECT 1 FROM TaskExecution WHERE profileId=? AND status='running'").get(id)) { db.exec('COMMIT'); return { skipped: 'profile_running' }; }
    const lease = query();
    if (lease && (typeof lease.expiresAt !== 'number' || lease.expiresAt > now())) { db.exec('COMMIT'); return { skipped: 'profile_leased' }; }
    reserved = db.prepare('INSERT INTO WorkflowLease(key,owner,expiresAt) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt WHERE WorkflowLease.expiresAt<=?').run(key, owner, now() + ttlMs, now()).changes === 1;
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (!reserved) return { skipped: 'profile_leased' };
  let failed = false;
  const renew = () => {
    const stamp = now();
    if (db.prepare('UPDATE WorkflowLease SET expiresAt=? WHERE key=? AND owner=? AND expiresAt>?').run(stamp + ttlMs, key, owner, stamp).changes !== 1) failed = true;
  };
  const timer = setInterval(() => { try { renew(); } catch { failed = true; } }, Math.min(10000, ttlMs / 3)); timer.unref();
  try {
    const before = JSON.stringify(db.prepare('SELECT * FROM Profile WHERE id=?').get(id));
    const result = await action(async () => { renew(); if (failed) throw Error('cleanup_lease_lost'); });
    if (before !== JSON.stringify(db.prepare('SELECT * FROM Profile WHERE id=?').get(id))) throw Error('profile_record_changed');
    return result;
  } finally { clearInterval(timer); db.prepare('DELETE FROM WorkflowLease WHERE key=? AND owner=?').run(key, owner); }
}

async function main() {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  const options = ['--directory', '--database', '--report-directory'];
  if (options.some(name => !args.includes(name) || !value(name) || value(name).startsWith('--'))) throw Error('directory_database_and_report_required');
  const root = resolve(value('--directory')), database = resolve(value('--database')), reports = resolve(value('--report-directory'));
  const apply = args.includes('--apply'); await directory(root);
  const stat = await lstat(database); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('invalid_database');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database, { readOnly: !apply }); db.exec('PRAGMA busy_timeout=5000');
  let ids = args.includes('--profile-id') ? [value('--profile-id')] : db.prepare('SELECT id FROM Profile WHERE deletedAt IS NULL ORDER BY id').all().map(row => row.id);
  if (args.includes('--plan')) {
    ids = JSON.parse(await readFile(resolve(value('--plan')), 'utf8'));
    if (!Array.isArray(ids) || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) throw Error('invalid_profile_plan');
  }
  const shards = args.includes('--shard-count') ? Number(value('--shard-count')) : 1;
  const shard = args.includes('--shard-index') ? Number(value('--shard-index')) : 0;
  if (!Number.isInteger(shards) || shards < 1 || shards > 8 || !Number.isInteger(shard) || shard < 0 || shard >= shards) throw Error('invalid_shard');
  ids = ids.filter((_, index) => index % shards === shard);
  const summary = { startedAt: new Date().toISOString(), apply, total: ids.length, processed: 0, cleaned: 0, candidates: 0, cacheBytes: 0, skipped: {}, failed: 0 };
  const emit = async () => { await writeFile(join(reports, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); };
  try {
    for (const id of ids) {
      let result;
      try {
        result = apply ? await withProfileLease(db, id, check => cleanPreviousCache(root, id, { apply, check })) : await cleanPreviousCache(root, id);
      } catch (error) {
        result = { error: /^[a-z_]+$/.test(error.message) ? error.message : error.code || 'cleanup_error' }; summary.failed++;
      }
      summary.processed++;
      if (result.cleaned) summary.cleaned++;
      if (result.candidate) summary.candidates++;
      summary.cacheBytes += result.cacheBytes || 0;
      if (result.skipped) summary.skipped[result.skipped] = (summary.skipped[result.skipped] || 0) + 1;
      await appendFile(join(reports, 'profiles.jsonl'), JSON.stringify({ profileId: id, ...result }) + '\n', { mode: 0o600 });
      if (summary.processed % 25 === 0 || result.error) await emit();
      if (result.error) break; // Preserve evidence and stop before touching another profile.
    }
  } finally { summary.finishedAt = new Date().toISOString(); await emit(); db.close(); }
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
