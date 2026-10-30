import { captchaBudgets } from '../worker/captcha-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/captcha-page.mjs', import.meta.url), 'utf8');
// Run the complete handler including its recursive retries; isolate browser and provider I/O.
const handlerSource = source.slice(source.indexOf('export function createCaptchaHandler')).replace('export function', 'function');
class CaptchaError extends Error { constructor(code) { super(code); this.code = code; this.name = 'CaptchaError'; } }
class TaskStoppedError extends Error {}

function fixture(options = {}) {
  let clock = 100000, clicks = 0, reloads = 0, providerRequests = 0, pending;
  const events = [], controller = new AbortController();
  const page = new EventEmitter();
  page.state = options.initialState ?? 'checkbox';
  page.url = () => page.state === 'done' ? 'https://ya.ru/search/touch?text=q' : 'https://ya.ru/showcaptcha';
  const frame = {};
  page.mainFrame = () => frame;
  page.isClosed = () => false;
  page.evaluate = async fn => {
    const code = fn.toString();
    if (code.includes('document.readyState')) return true;
    if (code.includes('document.title.includes')) return false;
    throw new Error('Unexpected browser evaluation: ' + code);
  };
  page.waitForLoadState = async () => {};
  page.reload = async () => {
    reloads++;
    if (options.abortReload) { controller.abort(); controller.signal.throwIfAborted(); }
    if (options.reloadError) throw options.reloadError;
    page.state = options.afterReload ?? 'checkbox';
  };
  const context = vm.createContext({ captchaBudgets, CaptchaError, TaskStoppedError, URL, Date: { now: () => clock },
    isYandexHostUrl: url => new URL(url).hostname === 'ya.ru',
    isYandexBadChallengePage: async () => false,
    isYandexChallengeState: async () => page.state !== 'done',
    detectCaptcha: async () => null,
    detectYandexImagePuzzle: async () => page.state === 'image' ? {} : null,
    detectYandexTextPuzzle: async () => page.state === 'text' ? {} : null,
    inspectYandexChallenge: async () => ({ checkboxForm: page.state === 'checkbox' }),
    createImageCaptchaRouter: () => ({ failed: () => {} }),
    solveYandexImagePuzzle: async (_page, _puzzle, { onRequest }) => {
      onRequest(); providerRequests++;
      if (providerRequests <= (options.imageFailures ?? 0)) {
        const err = new CaptchaError(options.failureCode ?? 'submission_rejected');
        if (err.code === 'captcha_rate_limited') { err.httpStatus = 429; err.retryDelayMs = options.retryAfterMs ?? 0; }
        throw err;
      }
      page.state = 'done'; return true;
    },
    solveYandexTextPuzzle: async (_page, _puzzle, { onRequest }) => { onRequest(); providerRequests++; page.state = 'done'; return true; },
    prepareCaptchaRetry: async () => { if (!options.imageFailures) assert.fail('Stuck checkbox must not reuse the ready page'); },
    sleep: async ms => {
      controller.signal.throwIfAborted(); clock += ms;
      if (options.abortSleep) { controller.abort(); controller.signal.throwIfAborted(); }
      if (pending && clock >= pending.due) {
        page.state = 'done'; page.emit('requestfinished', pending.request); pending = undefined;
      }
    },
    openYandexChallenge: async (_page, _signal, beforeInput) => {
      if (page.state !== 'checkbox') return false;
      for (let i = 0; i < (options.multipleControls ? 10 : 1); i++) {
        beforeInput(); clicks++;
        if (options.expireEpisode) clock += 90001;
      }
      if (options.onClickState) page.state = options.onClickState;
      if (options.networkProgress) {
        const request = { url: () => 'https://ya.ru/checkcaptcha', frame: () => frame, method: () => 'POST', isNavigationRequest: () => true };
        pending = { request, due: clock + 5000 };
        page.emit('request', request);
      }
      return true;
    },
  });
  vm.runInContext(handlerSource, context);
  const handle = context.createCaptchaHandler({
    prisma: { settings: { findUnique: async () => ({}) } },
    config: { captchaWidgetWaitMs: options.waitMs ?? 15000, navigationTimeoutMs: 30000, ...options.config },
    shouldContinue: async () => true, log: (event, data) => events.push({ event, data }), taskId: 'fixture',
    navigationPolicy: { clearCaptchaPost: () => {} },
  });
  return { page, events, handle: () => handle(page, controller.signal),
    get clicks() { return clicks; }, get reloads() { return reloads; }, get providerRequests() { return providerRequests; },
    get elapsedMs() { return clock - 100000; },
    assertClean() { for (const event of ['request', 'requestfinished', 'requestfailed']) assert.equal(page.listenerCount(event), 0); },
  };
}

for (const waitMs of [15000, 500]) {
  test(`stuck checkbox: at most six attempts and one reload, widget wait ${waitMs} ms`, async () => {
    const f = fixture({ waitMs });
    await assert.rejects(f.handle(), error => error.code === 'checkbox_not_completed');
    assert.equal(f.clicks, 6); assert.equal(f.reloads, 1); assert.equal(f.providerRequests, 0);
    assert.ok(f.elapsedMs < 90000);
    const exhausted = f.events.find(e => e.event === 'captcha_checkbox_exhausted');
    assert.equal(exhausted.data.totalClicks, 6); assert.equal(exhausted.data.reloads, 1);
    assert.equal(exhausted.data.reason, 'retry_limit');
    await assert.rejects(f.handle(), error => error.code === 'checkbox_not_completed');
    assert.equal(f.clicks, 6); assert.equal(f.reloads, 1);
    f.assertClean();
  });
}

test('multiple selector candidates cannot bypass the click limit within one call', async () => {
  const f = fixture({ multipleControls: true });
  await assert.rejects(f.handle(), error => error.code === 'checkbox_not_completed');
  assert.equal(f.clicks, 6); assert.equal(f.reloads, 1); f.assertClean();
});

test('episode time budget stops retries after a slow browser action', async () => {
  const f = fixture({ expireEpisode: true });
  await assert.rejects(f.handle(), error => error.code === 'checkbox_not_completed');
  assert.equal(f.clicks, 1); assert.equal(f.reloads, 0);
  assert.equal(f.events.find(e => e.event === 'captcha_checkbox_exhausted').data.reason, 'no_progress_timeout');
  f.assertClean();
});

for (const afterReload of ['done', 'image', 'text']) {
  test(`reload recovers to ${afterReload} and does not exhaust future episodes`, async () => {
    const f = fixture({ afterReload });
    assert.equal(await f.handle(), true);
    assert.equal(f.reloads, 1); assert.equal(f.clicks, 3);
    assert.equal(f.providerRequests, afterReload === 'done' ? 0 : 1);
    assert.ok(!f.events.some(e => e.event === 'captcha_checkbox_exhausted'));
    f.page.state = 'checkbox';
    assert.equal(await f.handle(), true);
    assert.equal(f.reloads, 2); assert.equal(f.clicks, 6);
    f.assertClean();
  });
}

test('direct successful checkbox needs no reload', async () => {
  const f = fixture({ onClickState: 'done' });
  assert.equal(await f.handle(), true);
  assert.equal(f.clicks, 1); assert.equal(f.reloads, 0); f.assertClean();
});

test('active network transition is awaited without repeated clicks', async () => {
  const f = fixture({ networkProgress: true });
  assert.equal(await f.handle(), true);
  assert.equal(f.clicks, 1); assert.equal(f.reloads, 0); f.assertClean();
});

test('reload failure is terminal and preserves its cause', async () => {
  const failure = new Error('net::ERR_CONNECTION_RESET');
  const f = fixture({ reloadError: failure });
  await assert.rejects(f.handle(), error => error.code === 'captcha_reload_failed' && error.cause === failure);
  assert.equal(f.reloads, 1); assert.equal(f.clicks, 3); f.assertClean();
});

for (const option of ['abortSleep', 'abortReload']) {
  test(`cancellation during ${option} propagates`, async () => {
    const f = fixture({ [option]: true });
    await assert.rejects(f.handle(), error => error.name === 'AbortError');
    assert.ok(!f.events.some(e => e.event === 'captcha_checkbox_exhausted'));
    f.assertClean();
  });
}

for (const failureCode of ['captcha_rate_limited', 'timeout']) test(`22nd provider call can succeed after ${failureCode}`, async () => {
 const f=fixture({initialState:'image',imageFailures:21,failureCode});
 assert.equal(await f.handle(),true); assert.equal(f.providerRequests,22);
});
test('total provider budget stops at 25 calls',async()=>{
 const f=fixture({initialState:'image',imageFailures:99,failureCode:'captcha_rate_limited'});
 await assert.rejects(f.handle(),e=>e.code==='solve_limit');assert.equal(f.providerRequests,25);
});
test('incorrect solution budget stops at 20 consecutive errors',async()=>{
 const f=fixture({initialState:'image',imageFailures:99});
 await assert.rejects(f.handle(),e=>e.code==='incorrect_limit');assert.equal(f.providerRequests,20);
});
test('challenge 429 respects Retry-After before another provider request',async()=>{
 const f=fixture({initialState:'image',imageFailures:1,failureCode:'captcha_rate_limited',retryAfterMs:5000});
 assert.equal(await f.handle(),true);assert.ok(f.elapsedMs>=5000);assert.equal(f.providerRequests,2);
});
test('cancellation stops Retry-After wait',async()=>{
 const f=fixture({initialState:'image',imageFailures:1,failureCode:'captcha_rate_limited',retryAfterMs:5000,abortSleep:true});
 await assert.rejects(f.handle());assert.equal(f.providerRequests,1);
});
test('legacy small config preserves effective working budgets',async()=>{
 const f=fixture({initialState:'image',imageFailures:21,failureCode:'captcha_rate_limited',config:{captchaMaxSolves:10,captchaMaxIncorrect:3}});
 assert.equal(await f.handle(),true);assert.equal(f.providerRequests,22);
});
