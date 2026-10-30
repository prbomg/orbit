import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendTaskLiveEvent, flushLiveView, startLiveView } from '../worker/live-view.mjs';
import { EventEmitter } from 'node:events';
import history from '../utils/liveHistory.js';

test('donor navigation, completion and skip reach the execution journal with a safe domain', async () => {
  const runId = randomUUID(), taskId = randomUUID(), executionId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId), file = resolve(directory, `${executionId}.jsonl`);
  try {
    for (const event of ['search_pre_warmup_started', 'search_pre_warmup_completed', 'search_pre_warmup_skipped']) {
      appendTaskLiveEvent(runId, taskId, event, { executionId, donorDomain: 'news.example.org', scrolls: 2, elapsedMs: 7000, code: 'donor_timeout', token: 'secret', url: 'https://news.example.org/?token=secret' });
    }
    appendTaskLiveEvent(runId, taskId, 'search_pre_warmup_skipped', { executionId, donorDomain: 'user:secret@example.org/?token=secret', code: 'donor_pool_empty' });
    await flushLiveView(runId);
    const { events } = await history.readEventPage(file);
    assert.equal(events.length, 4);
    for (const event of events.slice(0, 3)) {
      assert.equal(event.donorDomain, 'news.example.org'); assert.equal(event.scrolls, 2); assert.equal(event.elapsedMs, 7000);
    }
    assert.equal(events[3].donorDomain, undefined);
    assert.doesNotMatch(await readFile(file, 'utf8'), /secret|token|https:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('donor observation follows canonical same-site redirects, isolates private tenants, and revokes once', async () => {
  const runId = randomUUID(), taskId = randomUUID(), directory = resolve('.orbit-runtime', 'live', runId);
  const context = new EventEmitter(), page = new EventEmitter();
  let current = 'about:blank';
  const frame = { url: () => current };
  Object.assign(page, { url: () => current, isClosed: () => false, mainFrame: () => frame });
  context.pages = () => [page];
  const stop = startLiveView(context, { runId, taskId, targetUrl: 'https://target.example/' });
  const navigate = url => { current = url; page.emit('framenavigated', frame); };
  try {
    const revoke1 = stop.allowTemporarySite('https://www.news.example.co.uk');
    const revoke2 = stop.allowTemporarySite('https://www.news.example.co.uk');
    navigate('https://news.example.co.uk/redirected');
    revoke1(); revoke1();
    navigate('https://cdn.news.example.co.uk/still-allowed');
    revoke2();
    navigate('https://news.example.co.uk/revoked');
    const revokeTenant = stop.allowTemporarySite('https://one.github.io');
    navigate('https://two.github.io/unrelated');
    navigate('https://one.github.io/tenant');
    revokeTenant();
    await flushLiveView(runId);
    const text = await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8');
    assert.match(text, /redirected/); assert.match(text, /still-allowed/); assert.match(text, /\/tenant/);
    assert.doesNotMatch(text, /revoked|unrelated/);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});

test('only input-typing events record the concrete Unicode query and omit other payloads', async () => {
  const runId = randomUUID(), taskId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId), file = resolve(directory, `${taskId}.jsonl`);
  try {
    appendTaskLiveEvent(runId, taskId, 'search_input_typing', { query: 'купить коляску & <тест>', method: 'composition', token: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'search_input_typing', { query: 'уточнение\nзапроса', method: 'keyboard' });
    appendTaskLiveEvent(runId, taskId, 'search_input_metrics', { query: 'not-allowed-here', token: 'secret' });
    await flushLiveView(runId);
    const text = await readFile(file, 'utf8'), { events } = await history.readEventPage(file);
    assert.equal(events[0].query, 'купить коляску & <тест>');
    assert.equal(events[1].query, 'уточнение запроса');
    assert.equal(events[2].query, undefined);
    assert.doesNotMatch(text, /secret|not-allowed-here/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
