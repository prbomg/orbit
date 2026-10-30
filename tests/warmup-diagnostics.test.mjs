import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { withDeadline, cachedCheck } from '../worker/warmup-timing.mjs';
import { browserCleanup } from '../worker/browser-cleanup.mjs';
import { performWarmup } from '../worker/warmup.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';
import { claimWarmup } from '../worker/pool-scheduler.mjs';
import { sqliteWrite, measureSqliteWrites } from '../worker/sqlite-write.mjs';
import journal from '../utils/warmupJournal.js';
import pool from '../utils/profilePool.js';
import { poolFixture, migrations } from './helpers/pool-fixture.mjs';

const launch = () => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });

test('journal retains outcomes and scoped status, excludes secrets, and accepts legacy input', () => {
  const input = { pixels: -800, movedPixels: -214, result: 'scrolled', scrollTarget: 'container', operation: 'scroll', durationMs: 1234, navigationId: 4, responseScope: 'document', status: 200, responseDomain: 'fixture.test', password: 'secret', url: 'https://fixture.test/?token=secret', cookies: ['secret'] };
  const entry = journal.journalEntry({ profileId: 'fixture' }, 'warmup_scroll', input);
  for (const key of ['movedPixels', 'result', 'operation', 'navigationId', 'responseScope', 'status']) assert.equal(entry.details[key], input[key]);
  assert(!JSON.stringify(entry).includes('secret'));
  assert.deepEqual(journal.journalEntry({ profileId: 'fixture' }, 'warmup_scroll', { pixels: 300 }).details, { pixels: 300 });
  for (const event of ['warmup_wait', 'warmup_link_clicked', 'warmup_operation_failed']) assert(journal.runtimeEvents.has(event));
});

test('deadline ends an uncooperative API and external cancellation remains distinct', async () => {
  let cancelled = 0; const started = performance.now();
  await assert.rejects(withDeadline(() => new Promise(() => {}), { timeoutMs: 35, code: 'warmup_site_timeout', onTimeout: () => cancelled++ }), { code: 'warmup_site_timeout' });
  assert.equal(cancelled, 1); assert(performance.now() - started < 500);
  const controller = new AbortController(), reason = new Error('paused');
  const operation = withDeadline(() => new Promise(() => {}), { timeoutMs: 1000, signal: controller.signal });
  controller.abort(reason); await assert.rejects(operation, error => error === reason);
});

test('frequent checks coalesce reads; fresh commit reads and failures are never cached', async () => {
  let calls = 0, state = true, now = 0;
  const check = cachedCheck(async () => { calls++; await delay(2); return state; }, { now: () => now, ttlMs: 100 });
  assert((await Promise.all(Array.from({ length: 20 }, () => check()))).every(Boolean)); assert.equal(calls, 1);
  state = false; assert.equal(await check(true), false); assert.equal(calls, 2);
  now = 101; assert.equal(await check(), false); assert.equal(calls, 3);
  let failed = 0;
  const retry = cachedCheck(async () => { if (!failed++) throw new Error('busy'); return true; });
  await assert.rejects(retry()); assert.equal(await retry(), true);
});

test('SQLite measurements distinguish queue wait and transaction time by async caller', async () => {
  const prisma = { $transaction: async callback => callback() }, a = [], b = [];
  const first = measureSqliteWrites(() => sqliteWrite(prisma, () => delay(45)), sample => a.push(sample));
  const second = measureSqliteWrites(() => sqliteWrite(prisma, () => delay(5)), sample => b.push(sample));
  await Promise.all([first, second]);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert(a[0].transactionMs >= 35); assert(b[0].queueMs >= 35); assert(!b[0].failed);
});

test('history query uses a bounded ordered index and migration preserves existing rows', async () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const all = await migrations(); for (const migration of all.slice(0, -1)) sql.exec(migration);
    sql.exec("INSERT INTO Profile(id,name) VALUES('fixture','Fixture')");
    sql.exec("INSERT INTO ProfileWarmupEvent(profileId,proxyLabel,event,createdAt) VALUES('fixture','proxy.test:80','warmup_site_completed',1)");
    for (const migration of all.slice(-1)) sql.exec(migration);
    const explain = sql.prepare("EXPLAIN QUERY PLAN SELECT event,details,createdAt FROM ProfileWarmupEvent WHERE proxyLabel=? AND event IN ('warmup_site_completed','warmup_site_skipped') AND createdAt>=? ORDER BY createdAt DESC,id DESC LIMIT 2000").all('proxy.test:80', 0);
    assert(explain.some(row => row.detail.includes('ProfileWarmupEvent_proxyLabel_createdAt_id_idx')));
    assert(!explain.some(row => /SCAN ProfileWarmupEvent|TEMP B-TREE/.test(row.detail)));
    assert.equal(sql.prepare('SELECT count(*) AS n FROM ProfileWarmupEvent').get().n, 1);
  } finally { sql.close(); }
});

test('hung runner releases its slot, preserves stage, and cannot publish a late result', { timeout: 10_000 }, async () => {
  const f = await poolFixture();
  try {
    await f.db.$transaction(tx => pool.createProfileBatch(tx, { count: 1 }));
    const claim = await claimWarmup(f.db); let saved;
    const started = performance.now();
    await executeWarmup({ prisma: f.db, claim, config: { warmupRunTimeoutMs: 100, warmupCleanupTimeoutMs: 50 }, signal: new AbortController().signal,
      runner: async options => { saved = options; options.log('warmup_operation_started', { operation: 'internal_link' }); await new Promise(() => {}); } });
    assert(performance.now() - started < 3000);
    const job = await f.db.warmupJob.findUnique({ where: { id: claim.job.id } });
    assert.equal(job.currentStage, claim.job.currentStage); assert.equal(job.status, 'retry_wait'); assert.equal(job.errorCode, 'warmup_run_timeout');
    assert.equal(await f.db.workflowLease.count({ where: { owner: claim.owner } }), 0);
    let published = false;
    await assert.rejects(f.db.$transaction(tx => saved.commitRun(tx, async () => { published = true; })));
    assert.equal(published, false);
    const events = await f.db.profileWarmupEvent.findMany({ where: { runId: claim.owner }, orderBy: { id: 'asc' } });
    assert(events.some(e => e.event === 'warmup_operation_failed' && e.details.operation === 'internal_link'));
    assert(events.some(e => e.event === 'warmup_database_metrics'));
    assert(!events.some(e => e.event === 'session_saved'));
  } finally { await f.cleanup(); }
});

test('a stalled page API is cancelled with the precise operation in the journal', { timeout: 10_000 }, async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext(), page = await context.newPage(), events = [];
    page.goto = () => new Promise(() => {});
    await assert.rejects(performWarmup(page, { sites: ['https://one.test', 'https://two.test', 'https://three.test'], operationTimeoutMs: 100, cleanupTimeoutMs: 100,
      log: (event, details) => events.push({ event, ...details }) }), { code: 'warmup_operation_timeout' });
    assert(events.some(e => e.event === 'warmup_operation_failed' && e.operation === 'navigation'));
    assert(!events.some(e => e.event === 'warmup_site_completed'));
  } finally { await browser.close(); }
});

test('forced cleanup terminates only the owned browser when graceful close stalls', { timeout: 15_000 }, async () => {
  const browser = await launch(), other = await launch(), events = [];
  const close = browser.close.bind(browser);
  try {
    const cleaner = browserCleanup({ cleanupMs: 200, log: event => events.push(event) });
    await cleaner.track(browser);
    browser.close = () => new Promise(() => {});
    await cleaner.close();
    assert(events.includes('warmup_browser_terminated'));
    assert.equal(await (await other.newPage()).evaluate(() => 2 + 2), 4);
  } finally { await close(); await other.close(); }
});

test('site and session budgets take precedence over a longer operation timeout', { timeout: 10_000 }, async () => {
  const browser = await launch();
  try {
    for (const [limits, code] of [
      [{ siteTimeoutMs: 40 }, 'warmup_site_timeout'],
      [{ siteTimeoutMs: 500, sessionMinutes: 0.0005, navigationTimeoutMs: 20 }, 'warmup_session_timeout'],
    ]) {
      const context = await browser.newContext(), page = await context.newPage();
      page.goto = () => new Promise(() => {});
      await assert.rejects(performWarmup(page, { sites: ['https://one.test', 'https://two.test', 'https://three.test'], operationTimeoutMs: 1000, cleanupTimeoutMs: 100, ...limits }), { code });
      await context.close();
    }
  } finally { await browser.close(); }
});

test('warmup binds status to the document reached after a challenge and records real movement', { timeout: 30_000 }, async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext(), page = await context.newPage(), events = [];
    const solved = new Set();
    await context.route('**/*', route => route.fulfill({ status: solved.has(new URL(route.request().url()).hostname) ? 200 : 429, contentType: 'text/html', body: '<main style="height:3500px">Local fixture</main>' }));
    await performWarmup(page, { sites: ['https://one.test', 'https://two.test', 'https://three.test'], waitFor: async () => {},
      createCheckCaptcha: () => async p => { const host = new URL(p.url()).hostname; if (solved.has(host)) return false; solved.add(host); await p.reload(); return true; },
      log: (event, details) => events.push({ event, ...details }) });
    assert.equal(events.filter(e => e.event === 'warmup_site_completed').length, 3);
    assert(events.filter(e => e.event === 'warmup_site_completed').every(e => e.status === 200 && e.responseScope === 'document'));
    assert(events.filter(e => e.event === 'warmup_scroll').every(e => Number.isInteger(e.movedPixels) && e.result && e.scrollTarget));
    assert(events.some(e => e.event === 'warmup_wait' && Number.isInteger(e.plannedMs)));
  } finally { await browser.close(); }
});
