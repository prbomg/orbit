import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanPreviousCache, withProfileLease, protectedTree } from '../scripts/clean-previous-profile-cache.mjs';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-previous-cache-'));
  const previous = join(root, 'browser-data', 'fixture', 'previous');
  const put = async (name, value = `retained:${name}`) => { const p = join(root, name); await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, value); };
  try {
    await put('fixture.json.previous', JSON.stringify({ profileId: 'fixture', snapshot: { id: 'old-id' } }));
    await put('fixture.json', 'current passport');
    for (const version of ['previous', 'current', 'run-unrelated']) {
      for (const name of ['Default/Cache/file', 'Default/Code Cache/js/file', 'Default/Network/Cookies', 'Default/Local Storage/leveldb/file', 'Default/IndexedDB/file', 'Default/Service Worker/CacheStorage/file', 'Default/DawnGraphiteCache/file', 'Local State']) await put(`browser-data/fixture/${version}/${name}`);
      await put(`browser-data/fixture/${version}/.orbit-snapshot-id`, version === 'previous' ? 'old-id' : 'current-id');
    }
    await action({ root, previous, put });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('only previous HTTP/code cache is removed, preserving storage, snapshots, current and run copies', async () => {
  await fixture(async ({ root, previous }) => {
    const before = await protectedTree(previous);
    const currentFile = join(root, 'browser-data/fixture/current/Default/Cache/file'), current = await readFile(currentFile);
    const passport = await readFile(join(root, 'fixture.json.previous'));
    const result = await cleanPreviousCache(root, 'fixture', { apply: true });
    assert.equal(result.cleaned, true); assert.ok(result.cacheBytes > 0);
    assert.deepEqual(result.protected, before); assert.equal(result.currentUnchanged, true);
    await assert.rejects(access(join(previous, 'Default/Cache')), { code: 'ENOENT' });
    await assert.rejects(access(join(previous, 'Default/Code Cache')), { code: 'ENOENT' });
    for (const path of ['Default/Network/Cookies','Default/Local Storage/leveldb/file','Default/IndexedDB/file','Default/Service Worker/CacheStorage/file','Default/DawnGraphiteCache/file','Local State']) assert.ok((await readFile(join(previous, path))).length);
    assert.deepEqual(await readFile(currentFile), current);
    assert.deepEqual(await readFile(join(root, 'fixture.json.previous')), passport);
    await access(join(root, 'browser-data/fixture/run-unrelated/Default/Cache/file'));
    assert.equal((await cleanPreviousCache(root, 'fixture', { apply: true })).skipped, 'already_clean');
  });
});

test('dry run is read-only and pending publication or mismatched marker prevents cleanup', async () => {
  await fixture(async ({ root, previous, put }) => {
    assert.equal((await cleanPreviousCache(root, 'fixture')).candidate, true);
    await access(join(previous, 'Default/Cache/file'));
    await mkdir(join(root, '.publications/fixture'), { recursive: true });
    assert.equal((await cleanPreviousCache(root, 'fixture', { apply: true })).skipped, 'publication_pending');
    await rm(join(root, '.publications'), { recursive: true });
    await put('browser-data/fixture/previous/.orbit-snapshot-id', 'wrong-id');
    assert.equal((await cleanPreviousCache(root, 'fixture', { apply: true })).skipped, 'snapshot_mismatch');
    await access(join(previous, 'Default/Cache/file'));
    await assert.rejects(cleanPreviousCache(root, '../current', { apply: true }), /invalid_profile_id/);
  });
});

for (const target of ['Default', 'Default/Cache']) test(`symlink ${target} cannot redirect deletion into current`, async () => {
  await fixture(async ({ root, previous }) => {
    await rm(join(previous, target), { recursive: true });
    const current = join(root, 'browser-data/fixture/current', target);
    await symlink(current, join(previous, target));
    await assert.rejects(cleanPreviousCache(root, 'fixture', { apply: true }), /unsafe_/);
    await access(join(root, 'browser-data/fixture/current/Default/Cache/file'));
  });
});

test('lease renewal, foreign/running-profile protection and cleanup after failure use actual SQLite', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Profile(id TEXT PRIMARY KEY,deletedAt INTEGER,status TEXT); CREATE TABLE WorkflowLease(key TEXT PRIMARY KEY,owner TEXT,expiresAt INTEGER); CREATE TABLE WarmupJob(profileId TEXT,status TEXT); CREATE TABLE TaskExecution(profileId TEXT,status TEXT); INSERT INTO Profile VALUES (\'fixture\',NULL,\'ready\');');
  let time = 1000;
  try {
    db.prepare('INSERT INTO WorkflowLease VALUES (?,?,?)').run('profile:fixture', 'other', 5000);
    const action = () => assert.fail('busy profile was touched');
    assert.equal((await withProfileLease(db, 'fixture', action, { now: () => time })).skipped, 'profile_leased');
    db.prepare('DELETE FROM WorkflowLease').run();
    db.prepare('INSERT INTO WarmupJob VALUES (?,?)').run('fixture', 'running');
    assert.equal((await withProfileLease(db, 'fixture', action, { now: () => time })).skipped, 'profile_running');
    db.prepare('DELETE FROM WarmupJob').run();
    await assert.rejects(withProfileLease(db, 'fixture', async check => {
      assert.equal(db.prepare('SELECT count(*) AS n FROM WorkflowLease').get().n, 1);
      time += 100; await check();
      assert.equal(db.prepare('SELECT expiresAt FROM WorkflowLease').get().expiresAt, time + 120000);
      throw Error('fixture-failure');
    }, { now: () => time }), /fixture-failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM WorkflowLease').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM Profile').get().status, 'ready');
    await assert.rejects(withProfileLease(db, 'fixture', async check => {
      db.prepare('UPDATE WorkflowLease SET owner=?').run('new-owner');
      await check();
    }, { now: () => time }), /cleanup_lease_lost/);
    assert.equal(db.prepare('SELECT owner FROM WorkflowLease').get().owner, 'new-owner');
  } finally { db.close(); }
});

test('a lost lease aborts before removing any cache directory', async () => {
  await fixture(async ({ root, previous }) => {
    await assert.rejects(cleanPreviousCache(root, 'fixture', { apply: true, check: async () => { throw Error('cleanup_lease_lost'); } }), /cleanup_lease_lost/);
    await access(join(previous, 'Default/Cache/file'));
    await access(join(previous, 'Default/Code Cache/js/file'));
  });
});
