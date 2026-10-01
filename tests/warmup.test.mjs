import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { runTask } from '../worker/runner.mjs';
import { performWarmup, selectDonorSites } from '../worker/warmup.mjs';
import donors from '../utils/donorSites.js';

const root = resolve(import.meta.dirname, '..');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
async function migrations() {
  const names = (await readdir(join(root, 'prisma/migrations'))).filter(name => /^\d/.test(name)).sort();
  return Promise.all(names.map(name => readFile(join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')));
}

test('donor sampling selects three distinct sites from the editable pool of twenty', () => {
  assert.equal(donors.donorSites.length, 20);
  assert.equal(new Set(donors.donorSites).size, 20);
  const selected = selectDonorSites();
  assert.equal(new Set(selected).size, 3);
  assert.ok(selected.every(url => donors.donorSites.includes(url)));
  assert.throws(() => selectDonorSites(['https://example.com', 'https://example.com']));
});

test('migration preserves task fields/session IDs and groups shared IDs into related profiles', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = await migrations();
    for (const migration of sql.slice(0, 3)) db.exec(migration);
    const profileId = 'd75b1d4f-c828-40b0-af74-dee222a02cb2';
    db.prepare('INSERT INTO Task(id, profileId, url, targetKeywords, status, executionsCount) VALUES (?, ?, ?, ?, ?, ?)').run('old-a', profileId, 'https://example.com/a', '["QA"]', 'paused', 7);
    db.prepare('INSERT INTO Task(id, profileId, url, targetKeywords, status, executionsCount) VALUES (?, ?, ?, ?, ?, ?)').run('old-b', profileId, 'https://example.com/b', '[]', 'running', 3);
    const before = db.prepare('SELECT * FROM Task ORDER BY id').all();
    db.exec(sql[3]);
    const after = db.prepare('SELECT * FROM Task ORDER BY id').all();
    for (const [index, task] of after.entries()) {
      assert.equal(task.taskType, 'target');
      const { taskType: _taskType, ...fields } = task;
      assert.deepEqual(fields, { ...before[index] });
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM Profile').get().count, 1);
    assert.equal(db.prepare('SELECT id FROM Profile').get().id, profileId);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.prepare('INSERT INTO Task(id, profileId) VALUES (?, ?)').run('orphan', 'missing'));
    db.exec(sql[4]);
    const phrase = 'бренд "QA" — доставка';
    db.prepare('UPDATE Task SET searchEngine = ?, searchQuery = ?, targetDomain = ? WHERE id = ?').run('yandex', phrase, 'example.com', 'old-a');
    const beforeSearch = db.prepare('SELECT * FROM Task WHERE id = ?').get('old-a');
    db.exec(sql[5]);
    const migrated = db.prepare('SELECT * FROM Task WHERE id = ?').get('old-a');
    const { searchQuery: _oldQuery, ...preserved } = beforeSearch;
    const { searchQueries, vitalPhrases, ...actual } = migrated;
    assert.deepEqual(actual, preserved);
    assert.deepEqual(JSON.parse(searchQueries), [phrase]); assert.deepEqual(JSON.parse(vitalPhrases), []);
    assert.deepEqual(JSON.parse(db.prepare('SELECT searchQueries FROM Task WHERE id = ?').get('old-b').searchQueries), []);
    assert.ok(!db.prepare('PRAGMA table_info(Task)').all().some(column => column.name === 'searchQuery'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  } finally { db.close(); }
});

test('warmup visits three local origins without OpenAI, saves state once, and preserves it on failure/abort', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-warmup-'));
  const databasePath = join(dir, 'test.db');
  const db = new DatabaseSync(databasePath); for (const sql of await migrations()) db.exec(sql); db.close();
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
  const visits = []; const servers = []; let failDonor = false; let proxy;
  try {
    for (let index = 0; index < 3; index++) {
      const server = createServer((req, res) => {
        visits.push({ index, path: req.url });
        res.writeHead(failDonor && index === 2 && req.url === '/next' ? 503 : 200, {
          'Content-Type': 'text/html', 'Set-Cookie': `donor_${index}=synthetic-cookie; Path=/; Max-Age=3600`,
        });
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>localStorage.setItem('donor_${index}', ${JSON.stringify('synthetic-history')});</script><main style="height:4000px">Local donor ${index}</main><a href="/next">Internal</a><a href="https://example.org">External</a><a href="/delete">Delete</a>`);
      });
      await listen(server); servers.push(server);
    }
    const sites = servers.map(server => `http://127.0.0.1:${server.address().port}/`);
    const auth = `Basic ${Buffer.from('fixture:synthetic-password').toString('base64')}`;
    proxy = createServer((req, res) => {
      if (req.headers['proxy-authorization'] !== auth) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return; }
      const url = new URL(req.url);
      assert.ok(sites.some(site => new URL(site).origin === url.origin), 'Test must never visit real donors');
      const headers = { ...req.headers }; delete headers['proxy-authorization'];
      const upstream = httpRequest(url, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    });
    await listen(proxy);
    const task = await prisma.task.create({ data: { taskType: 'warmup', profile: { create: { name: 'Warmup fixture' } } } });
    const proxyRow = await prisma.proxy.create({ data: { host: '127.0.0.1', port: proxy.address().port, username: 'fixture', password: 'synthetic-password' } });
    const events = [];
    const config = { profilesDirectory: join(dir, 'profiles'), headless: true, navigationTimeoutMs: 5000, proxyScheme: 'http', proxyCheckUrl: `${sites[0]}health` };
    const options = { prisma, task, proxy: proxyRow, config, log: (event, details) => events.push({ event, ...details }),
      warmupRunner: (page, params) => performWarmup(page, { ...params, sites, waitFor: async () => {} }),
    };
    assert.equal(await runTask(options), true);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.status, 'completed'); assert.equal(row.currentExecutions, 1);
    for (let index = 0; index < 3; index++) assert.ok(visits.some(visit => visit.index === index && visit.path === '/next'));
    assert.ok(visits.every(visit => !['/delete'].includes(visit.path)));
    assert.equal(events.filter(event => event.event === 'warmup_site_completed').length, 3);
    assert.equal(events.filter(event => event.event === 'profile_saved').length, 1);
    assert.ok(!events.some(event => event.event === 'plan_requested'));
    const scrolls = events.filter(event => event.event === 'warmup_scroll');
    for (let step = 1; step <= 3; step++) {
      const group = scrolls.filter(event => event.step === step);
      assert.ok(group.length >= 2 && group.length <= 3);
      assert.ok(group.some(event => event.pixels > 0) && group.some(event => event.pixels < 0));
    }
    for (const event of events.filter(event => event.event === 'warmup_wait')) {
      assert.ok(event.durationMs >= (event.phase === 'initial' ? 3000 : 5000));
      assert.ok(event.durationMs <= (event.phase === 'initial' ? 7000 : 10_000));
    }
    const path = join(config.profilesDirectory, `${task.profileId}.json`);
    const previous = await readFile(path, 'utf8'); const state = JSON.parse(previous);
    assert.equal(state.origins.length, 3);
    assert.ok(state.origins.every(origin => origin.localStorage.some(item => item.value === 'synthetic-history')));
    assert.equal(state.cookies.filter(cookie => cookie.name.startsWith('donor_')).length, 3);
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', targetExecutions: 2 } });
    failDonor = true;
    await assert.rejects(runTask(options));
    assert.equal(await readFile(path, 'utf8'), previous);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentExecutions, 1);
    failDonor = false;
    const controller = new AbortController();
    await assert.rejects(runTask({ ...options, signal: controller.signal,
      warmupRunner: (page, params) => performWarmup(page, { ...params, sites, waitFor: async () => { controller.abort(); } }),
    }));
    assert.equal(await readFile(path, 'utf8'), previous);
    await prisma.profile.update({ where: { id: task.profileId }, data: { isEnabled: false } });
    let launched = false;
    await assert.rejects(runTask({ ...options, onBrowser: browser => { if (browser) launched = true; } }));
    assert.equal(launched, false);
  } finally {
    await prisma.$disconnect();
    if (proxy) await stop(proxy);
    await Promise.all(servers.map(stop)); await rm(dir, { recursive: true, force: true });
  }
});
