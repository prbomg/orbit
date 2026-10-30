import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import donors from '../utils/donorSites.js';
import { selectDonorSites } from '../worker/warmup.mjs';
import { migrations, poolFixture } from './helpers/pool-fixture.mjs';
import pool from '../utils/profilePool.js';
import { claimWarmup } from '../worker/pool-scheduler.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';

test('configured sites normalize addresses and reject unusable warmup lists', () => {
  assert.deepEqual(donors.normalizeDonorSites([' https://example.com/#section ', 'https://example.org/news', 'http://example.net']), ['https://example.com/', 'https://example.org/news', 'http://example.net/']);
  assert.deepEqual(donors.resolveDonorSites(null), donors.donorSites);
  for (const sites of [[], Array(201).fill('https://example.com'), ['https://example.com', 'https://example.com/', 'https://example.org'], ['https://example.com/a', 'https://www.example.com/b', 'https://example.com/c']]) assert.throws(() => donors.normalizeDonorSites(sites));
  for (const invalid of ['javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'http://[::1]', 'https://user:password@example.com', 'http://app.internal', 'invalid']) assert.throws(() => donors.normalizeDonorSites([invalid, 'https://example.org', 'https://example.net']));
});

test('large donor lists deduplicate canonical addresses while preserving distinct pages and order', () => {
  const sites = Array.from({length: 350}, (_, i) => `https://site${i}.ru`);
  const input = [...sites, ' https://SITE0.ru/#anchor ', 'https://site1.ru/', 'https://site0.ru/news'];
  const normalized = donors.normalizeDonorSites(input);
  assert.equal(normalized.length, 351);
  assert.equal(input.length - normalized.length, 2);
  assert.deepEqual(normalized, [...sites.map(url => `${url}/`), 'https://site0.ru/news']);
  assert.deepEqual(donors.resolveDonorSites({warmupSites: input}), normalized);
});

test('donor sampling visits different sites even if the list has several pages on one domain', () => {
  const sites = ['https://example.com/a', 'https://www.example.com/b', 'https://example.org/', 'https://example.net/'];
  for (let i = 0; i < 50; i++) {
    const selected = selectDonorSites(sites);
    assert.equal(new Set(selected.map(site => new URL(site).host.replace(/^www\./, ''))).size, 3);
    assert.ok(selected.every(site => sites.includes(site)));
  }
});

test('editable sites migration preserves the interval, scheduled stage, and queue', async () => {
  const scripts = await migrations(), db = new DatabaseSync(':memory:');
  try {
    const index = scripts.findIndex(script => script.includes('ADD COLUMN "warmupSites"'));
    assert.ok(index >= 0);
    for (const script of scripts.slice(0, index)) db.exec(script);
    db.exec(`INSERT INTO Settings(id,warmupStageIntervalMinutes,mobileProxyApiKey) VALUES (1,90,'fixture-secret'); INSERT INTO Profile(id,name,status) VALUES ('p','In progress','queued'); INSERT INTO WarmupJob(id,profileId,status,currentStage,nextStageAt,updatedAt) VALUES ('w','p','waiting_stage',2,'2026-10-03 12:00:00',CURRENT_TIMESTAMP);`);
    const before = db.prepare('SELECT * FROM WarmupJob').get();
    db.exec(scripts[index]);
    assert.deepEqual(db.prepare('SELECT * FROM WarmupJob').get(), before);
    const settings = db.prepare('SELECT * FROM Settings').get();
    assert.equal(settings.warmupSites, null); assert.equal(settings.warmupStageIntervalMinutes, 90); assert.equal(settings.mobileProxyApiKey, 'fixture-secret');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('site pool updates apply while the saved scenario keeps its original intervals', async () => {
  const f = await poolFixture();
  try {
    await f.db.$transaction(tx => pool.createProfileBatch(tx, { count: 1 }));
    await f.db.settings.update({ where: { id: 1 }, data: { warmupStageIntervalMinutes: 90 } });
    for (let stage = 1; stage <= 2; stage++) {
      const sites = [`https://stage${stage}.example.com/`, 'https://example.org/', 'https://example.net/'];
      await f.db.settings.update({ where: { id: 1 }, data: { warmupSites: sites } });
      const claim = await claimWarmup(f.db), started = Date.now();
      assert.ok(claim); assert.equal(claim.job.currentStage, stage);
      await executeWarmup({ prisma: f.db, claim, config: {}, signal: new AbortController().signal, runner: async ({ config, commitRun }) => {
        assert.deepEqual(config.warmupSites, sites);
        return (await f.db.$transaction(tx => commitRun(tx, async () => {}))).count === 1;
      } });
      const job = await f.db.warmupJob.findUniqueOrThrow({ where: { id: claim.job.id } });
      assert.equal(job.status, 'waiting_stage'); assert.equal(job.currentStage, stage + 1);
      assert.ok(job.nextStageAt.getTime() - started >= (stage === 1 ? 8 : 16) * 60 * 60_000);
      assert.ok(job.nextStageAt.getTime() - started < (stage === 1 ? 8 : 24) * 60 * 60_000 + 5000);
      await f.db.warmupJob.update({ where: { id: job.id }, data: { nextStageAt: new Date(0) } });
    }
    assert.equal(await f.db.task.count(), 0);
  } finally { await f.cleanup(); }
});
