import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startLiveView, appendTaskLiveEvent } from '../worker/live-view.mjs';

test('live observation records allowed top-level transitions and captures a frame without URL secrets', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url?.startsWith('/next') ? '<h1>Second page</h1>' : '<h1>First page</h1><a href="/next?token=secret">Next</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const runId = randomUUID(); const taskId = randomUUID();
  const directory = resolve('.orbit-runtime', 'live', runId);
  let browser; let stop = () => {};
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    stop = startLiveView(context, { runId, taskId, targetUrl: url });
    const page = await context.newPage();
    await page.goto(`${url}/?token=secret`);
    await page.getByText('Next').click();
    appendTaskLiveEvent(runId, taskId, 'action_started', { action: 'scroll_down', taskId, password: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_retrying', { attempt: 2, total: 3, code: 'ERROR_CAPTCHA_UNSOLVABLE', apiKey: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_coordinate_applied', { step: 1, total: 5, method: 'touch', token: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_image_ready', { source: 'instruction', width: 480, height: 180, method: 'network_bitmap', image: 'secret' });
    appendTaskLiveEvent(runId, taskId, 'captcha_image_capture_failed', { source: 'main', code: 'original_response_missing', url: 'https://image.invalid/?token=secret', error: 'secret' });
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 30; i++) {
        try { await stat(resolve(directory, `${taskId}.jpg`)); return; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw new Error('No screenshot written');
    });
    const events = await readFile(resolve(directory, `${taskId}.jsonl`), 'utf8');
    assert.match(events, /"event":"navigation"/);
    assert.match(events, /\/next/);
    assert.match(events, /"event":"action_started"/);
    assert.ok(events.trim().split('\n').map(line => JSON.parse(line)).some(event => event.event === 'captcha_retrying' && event.attempt === 2 && event.total === 3));
    assert.match(events, /"event":"captcha_coordinate_applied"/);
    const parsed = events.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(parsed.some(event => event.event === 'captcha_image_ready' && event.width === 480 && event.height === 180));
    assert.ok(parsed.some(event => event.event === 'captcha_image_capture_failed' && event.source === 'main' && event.code === 'original_response_missing'));
    assert.doesNotMatch(events, /secret|password|token=/);
  } finally {
    stop();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
