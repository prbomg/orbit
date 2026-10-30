import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { getPageSession, pageSessions } from '../worker/page-session.mjs';
import { createMobileContext, prepareMobilePage } from '../worker/profiles.mjs';
import { touchTap } from '../worker/touch-tap.mjs';
import { scrollPage } from '../worker/mobile-input.mjs';
import { observeTouchActivity } from '../worker/touch-trajectory.mjs';
import { buildHttpClientHints } from '../worker/client-hints.mjs';
import fp from '../utils/fingerprint.js';

test('concurrent input shares one attachment and releases its page-lifetime session', async () => {
  const page = new EventEmitter(), session = new EventEmitter();
  let attach = 0, detach = 0;
  page.isClosed = () => false;
  page.context = () => ({ newCDPSession: async () => { attach++; return session; } });
  session.detach = async () => { detach++; session.emit('close'); };
  const sessions = await Promise.all(Array.from({ length: 20 }, () => getPageSession(page)));
  assert.equal(attach, 1); assert(sessions.every(value => value === session));
  assert.equal(pageSessions.get(page), session);
  assert.equal(page.listenerCount('close'), 1);
  page.emit('close');
  assert.equal(detach, 1); assert.equal(pageSessions.has(page), false);
  assert.equal(page.listenerCount('close'), 0);
});

test('a failed attachment can retry and a page closed during attachment leaves no cached session', async () => {
  const page = new EventEmitter(), session = new EventEmitter();
  let calls = 0, closed = false, detach = 0, release;
  page.isClosed = () => closed;
  page.context = () => ({ newCDPSession: async () => {
    if (++calls === 1) throw new Error('controlled_attach_failure');
    return new Promise(resolve => { release = () => resolve(session); });
  } });
  session.detach = async () => { detach++; };
  await assert.rejects(getPageSession(page), /controlled_attach_failure/);
  const pending = getPageSession(page);
  closed = true; release();
  await assert.rejects(pending, /Page is closed/);
  assert.equal(detach, 1); assert.equal(pageSessions.has(page), false);
});

test('prepared page reuses its network session across taps, scrolls and cancellation without losing Client Hints', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const profile = fp.profileFromPassport('shared-session', fp.localPassport({ fingerprintMode: 'local' }, { runtimeVersion: browser.version() }));
    const context = await createMobileContext(browser, profile);
    try {
      const page = await context.newPage(), create = context.newCDPSession.bind(context), requests = [];
      let attachments = 0, detaches = 0;
      context.newCDPSession = async target => {
        const session = await create(target);
        if (target === page) {
          attachments++;
          const detach = session.detach.bind(session);
          session.detach = async () => { detaches++; return detach(); };
        }
        return session;
      };
      const expected = buildHttpClientHints(profile, true);
      await context.route('https://session.invalid/**', async route => {
        requests.push(await route.request().allHeaders());
        await route.fulfill({ contentType: 'text/html', headers: { 'accept-ch': Object.keys(expected).join(', ') },
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:5000px}button{width:180px;height:80px}</style><button>Tap</button>' });
      });
      await prepareMobilePage(page, profile);
      const session = pageSessions.get(page);
      await prepareMobilePage(page, profile);
      assert.equal(pageSessions.get(page), session);
      await page.goto('https://session.invalid/first');
      await touchTap(page, 60, 40, { durationMs: 60 });
      assert.equal((await scrollPage(page, 200, { durationMs: 160, mode: 'precise' })).result, 'scrolled');
      const controller = new AbortController();
      const unsubscribe = observeTouchActivity(page, event => { if (event.type === 'touchStart') controller.abort(); });
      try { await assert.rejects(touchTap(page, 60, 400, { signal: controller.signal }), { name: 'AbortError' }); }
      finally { unsubscribe(); }
      await touchTap(page, 60, 400, { durationMs: 60 });
      assert.equal(attachments, 1); assert.equal(detaches, 0);
      assert.equal(await getPageSession(page), session);
      await page.goto('https://session.invalid/second');
      for (const [name, value] of Object.entries(expected)) assert.equal(requests.at(-1)[name.toLowerCase()], value, name);
      assert.equal(requests.at(-1)['accept-language'], profile.headers['accept-language']);
      await page.close();
      assert.equal(pageSessions.has(page), false);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
