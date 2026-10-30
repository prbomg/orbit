// The database snapshotId is the commit decision. A durable journal preserves
// the old JSON and browser directory until the SQL transaction has committed.
// Call publication/recovery only while holding the SQLite writer lock.
const { open, mkdir, lstat, rename, rm, readdir } = require('node:fs/promises');
const { constants } = require('node:fs');
const { join, resolve, dirname, basename } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const snapshots = require('./profileSnapshots.js');
const limits = require('./profileLimits.js');
const { prunePreviousProfileCache } = require('./previousProfileCache.js');

class PublicationError extends Error {
  constructor(code = 'profile_publication_recovery_required') { super(code); this.name = 'PublicationError'; this.code = code; }
}
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const hash = text => createHash('sha256').update(text).digest('hex');
function paths(directory, profileId) {
  if (!validId(profileId)) throw new PublicationError('invalid_profile_id');
  const root = resolve(directory), journals = join(root, '.publications');
  return { root, journals, journal: join(journals, profileId), target: join(root, `${profileId}.json`), browserRoot: join(root, 'browser-data', profileId) };
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PublicationError();
}
async function sync(path) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
async function move(from, to) {
  await rename(from, to);
  await sync(dirname(to));
  if (dirname(from) !== dirname(to)) await sync(dirname(from));
}
async function read(path, maxBytes = limits.maxProfileBytes()) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new PublicationError();
    if (stat.size > maxBytes) throw new PublicationError('profile_too_large');
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw new PublicationError('profile_too_large');
    return text;
  }
  finally { await file.close(); }
}
async function write(path, contents) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
}
async function install(contents, target) {
  const temporary = `${target}.${randomUUID()}.publication`;
  try { await write(temporary, contents); await move(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
async function snapshot(path, profileId, maxBytes) {
  const text = await read(path, maxBytes), value = JSON.parse(text);
  if (value.profileId !== profileId || !snapshots.checkSnapshot(value)) throw new PublicationError('profile_snapshot_mismatch');
  return { text, value };
}
async function browserMarker(path) {
  await directory(path);
  try { return await read(join(path, '.orbit-snapshot-id'), 128); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function hasPendingPublication(directoryName, profileId) {
  return exists(paths(directoryName, profileId).journal);
}
async function pendingPublications(directoryName) {
  const root = join(resolve(directoryName), '.publications');
  if (!await exists(root)) return [];
  await directory(root);
  return (await readdir(root)).filter(validId);
}

async function publishProfileFiles({ directory: directoryName, profileId, stagedPath, persistentPath = null,
  previousSnapshotId = null, nextSnapshotId, allowInvalidPrevious = false, maxProfileBytes, checkpoint = async () => {} }) {
  const p = paths(directoryName, profileId), maxBytes = limits.maxProfileBytes(maxProfileBytes);
  await directory(p.root);
  if (!validId(nextSnapshotId) || nextSnapshotId === previousSnapshotId || dirname(resolve(stagedPath)) !== p.root) throw new PublicationError();
  await mkdir(p.journals, { recursive: true, mode: 0o700 }); await directory(p.journals); await sync(p.root);
  if (await exists(p.journal)) throw new PublicationError();
  const next = await snapshot(stagedPath, profileId, maxBytes);
  if (next.value.snapshot?.id !== nextSnapshotId) throw new PublicationError('profile_snapshot_mismatch');
  const oldText = await exists(p.target) ? await read(p.target, maxBytes) : null;
  let previousValid = false;
  try {
    const value = oldText === null ? null : JSON.parse(oldText);
    if (value && (value.profileId !== profileId || !snapshots.checkSnapshot(value)) ||
      (value?.snapshot?.id ?? null) !== previousSnapshotId) throw new PublicationError('profile_snapshot_mismatch');
    previousValid = Boolean(value);
  } catch (error) { if (!allowInvalidPrevious) throw error; }
  const current = join(p.browserRoot, 'current');
  let hadBrowser = false, previousBrowserId = null;
  if (persistentPath) {
    if (dirname(resolve(persistentPath)) !== p.browserRoot || !/^run-[a-f0-9-]{36}$/.test(basename(persistentPath))) throw new PublicationError();
    await directory(p.browserRoot);
    if (await browserMarker(persistentPath) !== nextSnapshotId) throw new PublicationError('profile_storage_version_mismatch');
    hadBrowser = await exists(current);
    if (hadBrowser) previousBrowserId = await browserMarker(current);
  }
  const manifest = { version: 1, profileId, previousSnapshotId, nextSnapshotId, hadSnapshot: oldText !== null,
    previousValid, beforeHash: oldText === null ? null : hash(oldText),
    persistent: Boolean(persistentPath), runName: persistentPath ? basename(persistentPath) : null, hadBrowser, previousBrowserId };
  const preparing = join(p.journals, `.prepare-${profileId}-${randomUUID()}`);
  await mkdir(preparing, { mode: 0o700 });
  try {
    if (oldText !== null) await write(join(preparing, 'before.json'), oldText);
    await write(join(preparing, 'after.json'), next.text);
    await write(join(preparing, 'manifest.json'), JSON.stringify(manifest));
    await sync(preparing); await move(preparing, p.journal);
  } finally { await rm(preparing, { recursive: true, force: true }); }
  await checkpoint('journal_prepared');
  if (persistentPath) {
    if (hadBrowser) await move(current, join(p.journal, 'before-browser'));
    await checkpoint('browser_previous_staged');
    await move(persistentPath, current);
    await checkpoint('browser_published');
  }
  await install(next.text, p.target);
  await checkpoint('snapshot_published');
}

async function recoverProfilePublication(tx, { directory: directoryName, profileId, maxProfileBytes, checkpoint = async () => {} }) {
  const p = paths(directoryName, profileId), maxBytes = limits.maxProfileBytes(maxProfileBytes);
  if (!await exists(p.journal)) return 'none';
  await directory(p.journals); await directory(p.journal);
  const m = JSON.parse(await read(join(p.journal, 'manifest.json'), 4096));
  if (m.version !== 1 || m.profileId !== profileId || !validId(m.nextSnapshotId) ||
    m.previousSnapshotId !== null && !validId(m.previousSnapshotId) || m.nextSnapshotId === m.previousSnapshotId ||
    typeof m.hadSnapshot !== 'boolean' || typeof m.previousValid !== 'boolean' || typeof m.persistent !== 'boolean' || typeof m.hadBrowser !== 'boolean' ||
    m.persistent && !/^run-[a-f0-9-]{36}$/.test(m.runName)) throw new PublicationError();
  const row = await tx.profile.findUnique({ where: { id: profileId }, select: { snapshotId: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new PublicationError('profile_publication_conflict');
  const committed = row.snapshotId === m.nextSnapshotId;
  if (!committed && row.snapshotId !== m.previousSnapshotId) throw new PublicationError('profile_publication_conflict');
  const oldText = m.hadSnapshot ? await read(join(p.journal, 'before.json'), maxBytes) : null;
  if (m.hadSnapshot && hash(oldText) !== m.beforeHash) throw new PublicationError();
  if (m.previousValid) {
    const old = await snapshot(join(p.journal, 'before.json'), profileId, maxBytes);
    if ((old.value.snapshot?.id ?? null) !== m.previousSnapshotId) throw new PublicationError();
  }
  const next = await snapshot(join(p.journal, 'after.json'), profileId, maxBytes);
  if (next.value.snapshot?.id !== m.nextSnapshotId) throw new PublicationError();
  const current = join(p.browserRoot, 'current'), before = join(p.journal, 'before-browser');
  if (committed) {
    // SQL can only commit after all new files have been fsynced. Never quietly
    // revert a committed counter or replace a missing durable browser directory.
    if (m.persistent && await browserMarker(current) !== m.nextSnapshotId) throw new PublicationError('profile_storage_version_mismatch');
    await install(next.text, p.target);
    if (m.previousValid) await install(oldText, `${p.target}.previous`);
    await checkpoint('backup_snapshot_published');
    if (m.persistent && m.hadBrowser && await exists(before)) {
      const previous = join(p.browserRoot, 'previous'), retired = join(p.journal, 'retired-browser');
      if (await exists(previous)) {
        if (await exists(retired)) throw new PublicationError();
        await move(previous, retired);
      }
      await checkpoint('backup_browser_retired');
      await move(before, previous);
      await checkpoint('backup_browser_published');
    }
    // Also run on recovery after the previous-directory rename already completed.
    // Uncommitted rollback data is never trimmed.
    if (m.persistent && m.hadBrowser) {
      await prunePreviousProfileCache(p.browserRoot, m.previousBrowserId);
      await checkpoint('backup_cache_pruned');
    }
  } else {
    if (m.persistent) {
      const marker = await exists(current) ? await browserMarker(current) : undefined;
      if (m.hadBrowser && await exists(before)) {
        if (marker !== undefined) {
          if (marker !== m.nextSnapshotId) throw new PublicationError('profile_storage_version_mismatch');
          await move(current, join(p.journal, 'discarded-browser'));
        }
        await checkpoint('rollback_browser_displaced');
        await move(before, current);
        await checkpoint('rollback_browser_restored');
      } else if (m.hadBrowser) {
        if (marker !== m.previousBrowserId) throw new PublicationError('profile_storage_version_mismatch');
      } else if (marker !== undefined) {
        if (marker !== m.nextSnapshotId) throw new PublicationError('profile_storage_version_mismatch');
        await move(current, join(p.journal, 'discarded-browser'));
      }
    }
    if (m.hadSnapshot) await install(oldText, p.target);
    else { await rm(p.target, { force: true }); await sync(p.root); }
    await checkpoint('rollback_snapshot_restored');
  }
  // Retire the complete journal atomically; interrupted cleanup cannot leave a
  // live journal with missing recovery files. Existing .previous stays intact on rollback.
  if (m.persistent) await rm(join(p.browserRoot, m.runName), { recursive: true, force: true });
  const settled = join(p.journals, `.settled-${profileId}-${randomUUID()}`);
  await move(p.journal, settled);
  await rm(settled, { recursive: true, force: true });
  await sync(p.journals);
  await checkpoint('journal_removed');
  return committed ? 'committed' : 'rolled_back';
}
module.exports = { PublicationError, publishProfileFiles, recoverProfilePublication, hasPendingPublication, pendingPublications };
