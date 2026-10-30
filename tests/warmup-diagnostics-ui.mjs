import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import journal from '../utils/warmupJournal.js';
const f = await poolFixture(); let server, browser;
try {
  const profile = await f.db.profile.create({ data: { name: 'Диагностика прогрева' } });
  const context = { profileId: profile.id, runId: 'fixture-run', stage: 1, attempt: 1 };
  const events = [
    ['warmup_scroll', { inputMethod: 'touch', gestures: 1, pixels: 600, movedPixels: 0, result: 'blocked', scrollTarget: 'page', operation: 'scroll', status: 200, navigationId: 2, responseScope: 'document', responseDomain: 'fixture.test' }],
    ['warmup_wait', { phase: 'initial', plannedMs: 5000, durationMs: 5250 }],
    ['warmup_link_clicked', { result: 'url_changed', operation: 'internal_link', durationMs: 830 }],
    ['warmup_operation_failed', { operation: 'navigation', reason: 'warmup_operation_timeout', durationMs: 60000, responseScope: 'unknown' }],
    ['warmup_database_metrics', { writesCount: 4, failedWrites: 0, queueMs: 120, maxQueueMs: 80, transactionMs: 100, maxTransactionMs: 40 }],
  ];
  await f.db.profileWarmupEvent.createMany({ data: events.map(([event, data]) => journal.journalEntry(context, event, data)) });
  const user = await f.db.authUser.create({ data: { email: 'seo@uniofweb.ru', passwordHash: 'fixture' } }), token = randomBytes(32).toString('hex');
  await f.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
  const base = 'http://127.0.0.1:3102';
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3102'], { env: { ...process.env, DATABASE_URL: `file:${f.dir}/test.db`, APP_ORIGIN: base, AUTH_EMAIL: user.email }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', d => output += d); server.stderr.on('data', d => output += d);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/login/', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (i === 79) throw Error(output); await new Promise(r => setTimeout(r, 250)); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addCookies([{ name: 'orbit_session', value: token, url: base }]);
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/profiles/?profile=${profile.id}`);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Журнал', exact: true }).click();
    const section = page.getByRole('region', { name: 'Журнал прогрева' });
    await section.locator('summary').click();
    for (const text of ['Содержимое не сдвинулось', 'Запрошено: 600 px вниз · смещение: 0 px', 'текущий документ', 'Операция: Внутренняя ссылка', 'по плану: 5 с', 'Транзакций: 4 · ошибок: 0']) await section.getByText(text, { exact: false }).first().waitFor();
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`Journal ${width}px: outcomes, timings, response ownership, database metrics, no JS errors`);
    await ctx.close();
  }
} finally {
  await browser?.close();
  if (server) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
  await f.cleanup();
}
