import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import cache from '../utils/previousProfileCache.js';
import { preparePersistentProfile } from '../worker/persistent-profile.mjs';
const paths = ['Cache', 'Code Cache', 'Network', 'Service Worker/CacheStorage', 'IndexedDB'];
async function populate(root, value) {
  for (const name of paths) {
    await mkdir(join(root, 'Default', name), { recursive: true });
    await writeFile(join(root, 'Default', name, 'state'), value);
  }
}
test('automatic previous-cache pruning validates identity, preserves durable data and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-auto-cache-'));
  try {
    for (const copy of ['current', 'previous']) {
      await populate(join(root, copy), copy);
      await writeFile(join(root, copy, '.orbit-snapshot-id'), copy);
    }
    await assert.rejects(cache.prunePreviousProfileCache(root, 'wrong'), { code: 'profile_storage_version_mismatch' });
    assert.equal(await readFile(join(root, 'previous/Default/Cache/state'), 'utf8'), 'previous');
    for (let i = 0; i < 2; i++) await cache.prunePreviousProfileCache(root, 'previous');
    for (const name of paths) {
      assert.equal(await readFile(join(root, 'current/Default', name, 'state'), 'utf8'), 'current');
      if (['Cache', 'Code Cache'].includes(name)) await assert.rejects(access(join(root, 'previous/Default', name)), { code: 'ENOENT' });
      else assert.equal(await readFile(join(root, 'previous/Default', name, 'state'), 'utf8'), 'previous');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('automatic pruning rejects symlinks before removing either cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-auto-link-'));
  try {
    const previous = join(root, 'previous');
    await populate(previous, 'keep'); await writeFile(join(previous, '.orbit-snapshot-id'), 'id');
    await rm(join(previous, 'Default/Code Cache'), { recursive: true });
    await symlink(join(previous, 'Default/Network'), join(previous, 'Default/Code Cache'));
    await assert.rejects(cache.prunePreviousProfileCache(root, 'id'), { code: 'invalid_profile_file' });
    assert.equal(await readFile(join(previous, 'Default/Cache/state'), 'utf8'), 'keep');
    await rm(join(previous, 'Default/Code Cache'));
    await rm(join(previous, 'Default'), { recursive: true });
    await symlink(join(root, 'outside'), join(previous, 'Default'));
    await assert.rejects(cache.prunePreviousProfileCache(root, 'id'), { code: 'invalid_profile_file' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('restoring previous publishes a cacheless backup of the displaced current, not the source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-auto-restore-'));
  try {
    for (const id of ['one', 'two']) {
      const run = await preparePersistentProfile(root, 'profile');
      await populate(run.path, id); await run.publish(id, id);
    }
    const restore = await preparePersistentProfile(root, 'profile', { source: 'previous', expectedSnapshotId: 'one' });
    await restore.publish('restored', 'three');
    const previous = join(root, 'browser-data/profile/previous');
    assert.equal(await readFile(join(previous, '.orbit-snapshot-id'), 'utf8'), 'two');
    assert.equal(await readFile(join(previous, 'Default/Network/state'), 'utf8'), 'two');
    await assert.rejects(access(join(previous, 'Default/Cache')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
