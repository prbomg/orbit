import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackNavigationResponses } from '../worker/navigation-response.mjs';
function fixture() {
  const context = new EventEmitter(); context.pages = () => [];
  const tracker = trackNavigationResponses(context);
  const page = new EventEmitter(); page.address = 'https://fixture.test/search'; page.url = () => page.address;
  const frame = { url: page.url }; page.mainFrame = () => frame;
  const commit = (owner = page) => owner.emit('framenavigated', owner.mainFrame());
  const request = (owner = page, iframe = false) => ({
    isNavigationRequest: () => true,
    frame: () => ({ parentFrame: () => iframe ? {} : null, page: () => owner }),
  });
  const response = (req, status, url = page.address) => ({ request: () => req, status: () => status, url: () => url });
  return { context, tracker, page, request, response, commit };
}
test('a new main-frame request invalidates 429 even at the same URL and ignores late responses', () => {
  const f = fixture(), first = f.request(), next = f.request();
  f.context.emit('request', first); f.context.emit('response', f.response(first, 429));
  assert.equal(f.tracker.current(f.page), null, 'Uncommitted response must not describe the document');
  f.commit();
  assert.equal(f.tracker.current(f.page).status(), 429);
  f.context.emit('request', next);
  assert.equal(f.tracker.current(f.page), null);
  f.context.emit('response', f.response(first, 429));
  assert.equal(f.tracker.current(f.page), null);
  f.context.emit('response', f.response(next, 200)); f.commit();
  assert.equal(f.tracker.current(f.page).status(), 200);
  f.tracker.dispose();
  assert.equal(f.context.listenerCount('request'), 0);
  assert.equal(f.context.listenerCount('response'), 0);
});
test('iframe and popup responses cannot supply another page status', () => {
  const f = fixture(), popup = new EventEmitter();
  popup.url = () => f.page.address; const frame = { url: popup.url }; popup.mainFrame = () => frame;
  const iframe = f.request(f.page, true), popupRequest = f.request(popup);
  f.context.emit('request', iframe); f.context.emit('response', f.response(iframe, 429));
  f.context.emit('request', popupRequest); f.context.emit('response', f.response(popupRequest, 429)); f.commit(popup);
  assert.equal(f.tracker.current(f.page), null);
  assert.equal(f.tracker.current(popup).status(), 429);
  f.tracker.dispose();
});
test('redirect response cannot describe its destination; fragments preserve the document response', () => {
  const f = fixture(), req = f.request();
  f.context.emit('request', req); f.context.emit('response', f.response(req, 302, 'https://fixture.test/checkcaptcha'));
  assert.equal(f.tracker.current(f.page), null);
  const next = f.request(); f.context.emit('request', next); f.context.emit('response', f.response(next, 200)); f.commit();
  f.page.address += '#section';
  assert.equal(f.tracker.current(f.page).status(), 200);
  f.tracker.dispose();
});

test('browser commits the new document response and excludes iframe responses', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const tracker = trackNavigationResponses(context);
    let status = 429;
    await context.route('http://binding.test/**', route => route.fulfill({
      status: route.request().frame() === page.mainFrame() ? status : 429,
      contentType: 'text/html', body: '<h1>Document</h1>',
    }));
    await page.goto('http://binding.test/search');
    assert.equal(tracker.current(page).status(), 429);
    status = 200;
    await page.goto('http://binding.test/search');
    assert.equal(tracker.current(page).status(), 200);
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame); });
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('h1'));
    assert.equal(tracker.current(page).status(), 200);
    await page.evaluate(() => { location.hash = 'section'; });
    assert.equal(tracker.current(page).status(), 200);
    tracker.dispose(); await context.close();
  } finally { await browser.close(); }
});
