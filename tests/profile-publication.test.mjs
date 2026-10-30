import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { poolFixture } from './helpers/pool-fixture.mjs';
import fp from '../utils/fingerprint.js';
import publication from '../utils/profilePublication.js';
import { stageMobileProfile } from '../worker/profiles.mjs';
import { preparePersistentProfile } from '../worker/persistent-profile.mjs';
import { recoverProfileSaves } from '../worker/profile-publication.mjs';
const exec = promisify(execFile);

async function sample(f, persistent, initial = false) {
  const row = await f.db.profile.create({ data: { name: 'Crash fixture', storageMode: persistent ? 'persistent' : 'snapshot' } });
  const directory = join(f.dir, row.id); await mkdir(directory);
  const profile = fp.profileFromPassport(row.id, fp.localPassport({ fingerprintMode: 'local' }));
  const stage = value => stageMobileProfile(directory, profile, { storageState: async () => ({ cookies: [], origins: [{ origin: 'https://fixture.test', localStorage: [{ name: 'state', value }] }] }) });
  let old, previous;
  if (!initial) {
    previous = await stage('previous'); await previous.publish();
    old = await stage('old'); await old.publish();
    await f.db.profile.update({ where: { id: row.id }, data: { snapshotId: old.summary.snapshotId } });
    if (persistent) for (const s of [previous, old]) {
      const browser = await preparePersistentProfile(directory, row.id);
      await writeFile(join(browser.path, 'data'), s === old ? 'old' : 'previous');
      for (const name of ['Cache', 'Code Cache', 'Service Worker/CacheStorage', 'IndexedDB']) {
        await mkdir(join(browser.path, 'Default', name), { recursive: true });
        await writeFile(join(browser.path, 'Default', name, 'state'), s === old ? 'old' : 'previous');
      }
      await browser.publish(s.summary.savedAt, s.summary.snapshotId);
    }
  }
  const next = await stage('new');
  let browser;
  if (persistent) {
    browser = await preparePersistentProfile(directory, row.id);
    await writeFile(join(browser.path, 'data'), 'new');
    await browser.seal(next.summary.savedAt, next.summary.snapshotId);
  }
  return { row, directory, old, previous, next, browser, options: { directory, profileId: row.id,
    stagedPath: next.temporary, persistentPath: browser?.path, previousSnapshotId: old?.summary.snapshotId ?? null, nextSnapshotId: next.summary.snapshotId } };
}
async function crash(f, s, phase) {
  // A separate process exits with a live SQLite transaction. SQLite, rather
  // than a mocked transaction callback, determines whether SQL survived.
  const code = `const {DatabaseSync}=require('node:sqlite');const publication=require(process.argv[1]);
    const db=new DatabaseSync(process.argv[2]),options=JSON.parse(process.argv[3]),phase=process.argv[4];
    (async()=>{db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
      await publication.publishProfileFiles({...options,checkpoint:async step=>{if(step===phase)process.exit(73)}});
      db.prepare('UPDATE Profile SET snapshotId=?,warmupScore=warmupScore+1 WHERE id=?').run(options.nextSnapshotId,options.profileId);
      if(phase==='sql_updated')process.exit(73);db.exec('COMMIT');if(phase==='sql_committed')process.exit(73);db.close();
    })().catch(e=>{console.error(e.code||e.name);process.exit(1)});`;
  await assert.rejects(exec(process.execPath, ['-e', code, resolve('utils/profilePublication.js'), join(f.dir, 'test.db'), JSON.stringify(s.options), phase]), e => e.code === 73);
}
async function assertState(f, s, committed) {
  const row = await f.db.profile.findUnique({ where: { id: s.row.id } });
  assert.equal(row.snapshotId, committed ? s.next.summary.snapshotId : s.old?.summary.snapshotId ?? null);
  assert.equal(row.warmupScore, committed ? 1 : 0, 'the SQL outcome is neither replayed nor reversed');
  const target = join(s.directory, `${s.row.id}.json`);
  if (!committed && !s.old) await assert.rejects(access(target), { code: 'ENOENT' });
  else {
    const saved = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(saved.snapshot.id, row.snapshotId);
    assert.equal(saved.origins[0].localStorage[0].value, committed ? 'new' : 'old');
  }
  if (s.old) assert.equal(JSON.parse(await readFile(`${target}.previous`, 'utf8')).snapshot.id, committed ? s.old.summary.snapshotId : s.previous.summary.snapshotId);
  if (s.browser) {
    const current = join(s.directory, 'browser-data', s.row.id, 'current');
    if (!committed && !s.old) await assert.rejects(access(current), { code: 'ENOENT' });
    else {
      assert.equal(await readFile(join(current, '.orbit-snapshot-id'), 'utf8'), row.snapshotId);
      assert.equal(await readFile(join(current, 'data'), 'utf8'), committed ? 'new' : 'old');
      if (s.old) for (const name of ['Cache', 'Code Cache', 'Service Worker/CacheStorage', 'IndexedDB'])
        assert.equal(await readFile(join(current, 'Default', name, 'state'), 'utf8'), 'old');
    }
    if (s.old) assert.equal(await readFile(join(s.directory, 'browser-data', s.row.id, 'previous', 'data'), 'utf8'), committed ? 'old' : 'previous');
  }
  if (s.browser && s.old) {
    const previous = join(s.directory, 'browser-data', s.row.id, 'previous');
    for (const name of ['Cache', 'Code Cache']) await assert.rejects(access(join(previous, 'Default', name)), { code: 'ENOENT' });
    for (const name of ['Service Worker/CacheStorage', 'IndexedDB']) assert.equal(await readFile(join(previous, 'Default', name, 'state'), 'utf8'), committed ? 'old' : 'previous');
  }
  assert.equal(await publication.hasPendingPublication(s.directory, s.row.id), false);
}
for (const persistent of [false, true]) test(`process crashes recover ${persistent ? 'persistent' : 'snapshot'} publication at every commit boundary`, { timeout: 60000 }, async () => {
  const f = await poolFixture();
  try {
    for (const initial of [false, true]) for (const phase of ['journal_prepared', ...(persistent ? ['browser_previous_staged', 'browser_published'] : []), 'snapshot_published', 'sql_updated', 'sql_committed']) {
      const s = await sample(f, persistent, initial);
      await crash(f, s, phase);
      await recoverProfileSaves(f.db, s.directory);
      await assertState(f, s, phase === 'sql_committed');
      await recoverProfileSaves(f.db, s.directory);
      await assertState(f, s, phase === 'sql_committed');
    }
  } finally { await f.cleanup(); }
});

test('recovery itself can be interrupted while restoring or rotating backups', { timeout: 60000 }, async () => {
  const f = await poolFixture();
  try {
    for (const [committed, steps] of [[false, ['rollback_browser_displaced', 'rollback_browser_restored', 'rollback_snapshot_restored']], [true, ['backup_snapshot_published', 'backup_browser_retired', 'backup_browser_published', 'backup_cache_pruned']]]) {
      for (const step of steps) {
        const s = await sample(f, true); await crash(f, s, committed ? 'sql_committed' : 'sql_updated');
        await assert.rejects(f.db.$transaction(async tx => {
          await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
          await publication.recoverProfilePublication(tx, { directory: s.directory, profileId: s.row.id,
            checkpoint: async phase => { if (phase === step) throw new Error('Injected recovery interruption'); } });
        }), /Injected recovery interruption/);
        await recoverProfileSaves(f.db, s.directory);
        await assertState(f, s, committed);
      }
    }
  } finally { await f.cleanup(); }
});

test('live leases prevent another worker recovering an in-flight save; conflicting SQL preserves evidence', async () => {
  const f = await poolFixture();
  try {
    const s = await sample(f, true); await crash(f, s, 'snapshot_published');
    await f.db.workflowLease.create({ data: { key: `profile:${s.row.id}`, owner: 'active', expiresAt: new Date(Date.now() + 60000) } });
    await recoverProfileSaves(f.db, s.directory);
    assert.equal(await publication.hasPendingPublication(s.directory, s.row.id), true);
    await assert.rejects(recoverProfileSaves(f.db, s.directory, { profileId: s.row.id, owner: 'other' }), { code: 'profile_publication_busy' });
    await recoverProfileSaves(f.db, s.directory, { profileId: s.row.id, owner: 'active' });
    await assertState(f, s, false);
    const conflict = await sample(f, false); await crash(f, conflict, 'snapshot_published');
    await f.db.profile.update({ where: { id: conflict.row.id }, data: { snapshotId: randomUUID() } });
    await assert.rejects(recoverProfileSaves(f.db, conflict.directory, { profileId: conflict.row.id }), { code: 'profile_publication_conflict' });
    assert.equal(await publication.hasPendingPublication(conflict.directory, conflict.row.id), true);
    assert.equal(JSON.parse(await readFile(join(conflict.directory, `${conflict.row.id}.json`), 'utf8')).snapshot.id, conflict.next.summary.snapshotId);
  } finally { await f.cleanup(); }
});

test('explicit restoration handles corrupt or missing current files while preserving a good backup', async () => {
  const f = await poolFixture();
  try {
    for (const corrupt of [true, false]) {
      const s = await sample(f, false), target = join(s.directory, `${s.row.id}.json`);
      if (corrupt) await writeFile(target, '{broken');
      else await (await import('node:fs/promises')).rm(target);
      await f.db.$transaction(async tx => {
        await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
        await publication.publishProfileFiles({ ...s.options, allowInvalidPrevious: true });
        await tx.profile.update({ where: { id: s.row.id }, data: { snapshotId: s.next.summary.snapshotId } });
      });
      await recoverProfileSaves(f.db, s.directory);
      assert.equal(JSON.parse(await readFile(target, 'utf8')).snapshot.id, s.next.summary.snapshotId);
      assert.equal(JSON.parse(await readFile(`${target}.previous`, 'utf8')).snapshot.id, s.previous.summary.snapshotId);
      assert.equal(await publication.hasPendingPublication(s.directory, s.row.id), false);
    }
  } finally { await f.cleanup(); }
});
