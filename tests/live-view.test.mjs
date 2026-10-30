import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import liveSocket from '../utils/liveSocket.js';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startLiveView, appendTaskLiveEvent, flushLiveView } from '../worker/live-view.mjs';

test('live observation records allowed top-level transitions and captures a frame without URL secrets', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url?.startsWith('/next') ? '<h1>Second page</h1>' : '<h1>First page</h1><a href="/next?token=secret">Next</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const runId = randomUUID(); const taskId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId);
  let browser,viewer; let stop = () => {};
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext();
    stop = startLiveView(context, { runId, taskId, targetUrl: url });
    const page = await context.newPage();
    await page.goto(`${url}/?token=secret`);
    await page.getByText('Next').click();
    await new Promise(resolve=>setTimeout(resolve,300));
    await assert.rejects(stat(resolve(directory,`${taskId}.jpg`)),{code:'ENOENT'});
    await stop.captureFailure(page, { stage: 'search_submit_completed', elapsedMs: 2400, status: 200 });
    assert.ok((await stat(resolve(directory, `${taskId}.failure.jpg`))).size > 0);
  await flushLiveView(runId);
    const evidence=(await readFile(resolve(directory, `${taskId}.jsonl`),'utf8')).trim().split('\n').map(JSON.parse).find(e=>e.event==='search_failure_snapshot');
    assert.equal(evidence.url, `${url}/next`); assert.equal(evidence.status,200); assert.equal(evidence.screenshotState,'saved');
    viewer=createConnection(liveSocket.liveSocketPath(resolve('.orbit-runtime'),runId,taskId));viewer.on('data',()=>{});
    appendTaskLiveEvent(runId, taskId, 'action_started', { action: 'scroll_down', taskId, password: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'search_input_metrics', { elapsedMs: 800, checksMs: 120, intervalCount: 3, intervalMedianMs: 140, intervalMaxMs: 190, focusRecoveryCount: 1, query: 'private-search-text' });
    appendTaskLiveEvent(runId, taskId, 'search_submit_blocked', { reason: 'value_changed', code: 'search_query_mismatch' });
    const firstExecution=randomUUID(),secondExecution=randomUUID();
    appendTaskLiveEvent(runId,taskId,'action_started',{action:'scroll_down',executionId:firstExecution});
    appendTaskLiveEvent(runId,taskId,'action_started',{action:'scroll_up',executionId:secondExecution});
  await flushLiveView(runId);
    assert.match(await readFile(resolve(directory,`${firstExecution}.jsonl`),'utf8'),/scroll_down/);
  await flushLiveView(runId);
    assert.doesNotMatch(await readFile(resolve(directory,`${firstExecution}.jsonl`),'utf8'),/scroll_up/);
  await flushLiveView(runId);
    assert.match(await readFile(resolve(directory,`${secondExecution}.jsonl`),'utf8'),/scroll_up/);
    appendTaskLiveEvent(runId, taskId, 'captcha_page_load_failed', { status: 429, retryAfterMs: 120000, token: 'secret' });
  await flushLiveView(runId);
    const recorded = (await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(recorded.some(row => row.event === 'captcha_page_load_failed' && row.status === 429 && row.retryAfterMs === 120000));
    const navResponse = recorded.find(row => row.event === 'navigation_response');
    assert.ok(Number.isInteger(navResponse.navigationId) && navResponse.navigationId > 0);
    assert.ok(recorded.some(row => row.event === 'navigation' && row.tab === navResponse.tab && row.navigationId === navResponse.navigationId));
    appendTaskLiveEvent(runId, taskId, 'captcha_retrying', { attempt: 2, total: 3, code: 'ERROR_CAPTCHA_UNSOLVABLE', apiKey: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_coordinate_applied', { step: 1, total: 5, method: 'touch', token: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_image_ready', { source: 'instruction', width: 480, height: 180, method: 'network_bitmap', image: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_image_capture_failed', { source: 'main', code: 'original_response_missing', element: 'img', sourceType: 'https', captureState: 'active', capturedResponses: 2, url: 'https://image.invalid/?token=secret', error: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'target_internal_link_started', { url: `${url}/next?token=secret` });
    appendTaskLiveEvent(runId, taskId, 'target_internal_navigation_started');
    appendTaskLiveEvent(runId, taskId, 'target_internal_link_skipped', { code: 'target_internal_no_navigation', href: `${url}/next?token=secret` });
    appendTaskLiveEvent(runId, taskId, 'target_internal_link_failed', { errorType: 'SearchError', code: 'target_internal_navigation_timeout', message: 'secret' });
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 30; i++) {
        try { await stat(resolve(directory, `${taskId}.jpg`)); return; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw new Error('No screenshot written');
    });
  await flushLiveView(runId);
    const events = await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8');
    const metrics = events.trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'search_input_metrics');
    assert.equal(metrics.checksMs, 120); assert.equal(metrics.intervalMedianMs, 140); assert.equal(metrics.focusRecoveryCount, 1);
    assert.doesNotMatch(events, /private-search-text/);
    assert.match(events, /search_submit_blocked/);
    assert.match(events, /"event":"navigation"/);
    assert.match(events, /\/next/);
    assert.match(events, /"event":"action_started"/);
    assert.ok(events.trim().split('\n').map(line => JSON.parse(line)).some(event => event.event === 'captcha_retrying' && event.attempt === 2 && event.total === 3));
    assert.match(events, /"event":"captcha_coordinate_applied"/);
    const parsed = events.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(parsed.some(event => event.event === 'captcha_image_ready' && event.width === 480 && event.height === 180));
    assert.ok(parsed.some(event => event.event === 'captcha_image_capture_failed' && event.source === 'main' && event.code === 'original_response_missing'));
    assert.ok(parsed.some(event => event.event === 'captcha_image_capture_failed' && event.element === 'img' && event.sourceType === 'https' && event.captureState === 'active' && event.capturedResponses === 2));
    assert.ok(parsed.some(event => event.event === 'target_internal_link_started'));
    assert.ok(parsed.some(event => event.event === 'target_internal_navigation_started'));
    assert.ok(parsed.some(event => event.event === 'target_internal_link_skipped' && event.code === 'target_internal_no_navigation'));
    assert.ok(parsed.some(event => event.event === 'target_internal_link_failed' && event.code === 'target_internal_navigation_timeout'));
    assert.doesNotMatch(events, /secret|password|token=/);
  } finally {
    viewer?.destroy();
    await stop();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('temporary donor observation streams its page and stops after the permission is revoked', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<h1>Donor preview</h1><style>@keyframes move{to{transform:translateX(180px)}}h1{animation:move .4s infinite alternate}</style>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, runId = randomUUID(), taskId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId);
  let browser, viewer, stop;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => { for (let n = 0; n < 50; n++) { if (predicate()) return; await wait(100); } throw Error('No donor stream'); };
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
    const context = await browser.newContext(), page = await context.newPage();
    stop = startLiveView(context, { runId, taskId, targetUrl: 'https://target.example.test/' });
    await page.goto(origin + '/unapproved?token=secret');
    await wait(300);
    const frames = [], states = []; let buffer = '';
    viewer = createConnection(liveSocket.liveSocketPath(resolve('.orbit-runtime'), runId, taskId));
    viewer.on('data', chunk => {
      buffer += chunk;
      let at; while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (message.type === 'frame') frames.push(message); else states.push(message);
      }
    });
    await wait(400); assert.equal(frames.length, 0);
    const revoke = stop.allowTemporarySite(origin);
    await page.goto(origin + '/donor?token=secret');
    try { await until(() => frames.length >= 3); }
    catch (error) { error.message += `: frames=${frames.length}; states=${JSON.stringify(states)}`; throw error; }
    assert(frames.every(frame => frame.data.length > 100));
    await flushLiveView(runId);
    const text = await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8');
    assert.match(text, /\/donor/); assert.doesNotMatch(text, /unapproved|secret|token=/);
    revoke(); revoke();
    await wait(400); const count = frames.length;
    await page.goto(origin + '/after-revocation');
    await wait(400); assert.equal(frames.length, count);
    await flushLiveView(runId);
    assert.doesNotMatch(await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8'), /after-revocation/);
  } finally {
    viewer?.destroy(); await stop?.(); await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
