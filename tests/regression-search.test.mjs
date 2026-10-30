import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Isolated behavior checks: supplied modules lack their sibling dependencies.
const search = await readFile(new URL('../worker/search.mjs', import.meta.url), 'utf8');
const captcha = await readFile(new URL('../worker/captcha-page.mjs', import.meta.url), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to).replaceAll('export ', '');
}
const prepare = section(search, 'export async function prepareSearchQuery', 'export async function submitSearch');
const errors = section(search, 'export class SearchError', 'function isActiveSerpUrl') + section(search, 'function isNavigationTransientError', 'async function waitForSerpAttached');
for (const [url, scrollY, suffix, failEvaluate, redirect] of [
  ['https://ya.ru/search/touch?text=q', 0, 's', false, true],
  ['https://ya.ru/search?text=q&p=2', 0, 's', false, true],
  ['https://ya.ru/search?text=q&p=0', 0, 's', false, true],
  ['https://ya.ru/search?text=q', 201, 's', false, true],
  ['https://ya.ru/search?text=q', 0, 's', true, true],
  ['https://ya.ru/search?text=q', 0, 's', false, false],
  ['https://ya.ru/search/touch?text=q', 600, undefined, false, false],
]) {
  test(`prepare: ${url}, scroll=${scrollY}, suffix=${suffix}, evaluation failure=${failEvaluate}`, async () => {
    const calls = [], typed = [];
    let value = 'q';
    const doc = { activeElement: null };
    const element = { value, ownerDocument: doc }; doc.activeElement = element;
    const input = { evaluate: async fn => { element.value = value; return fn(element); } };
    const page = { evaluate: async fn => {
      if (failEvaluate) throw new Error('Execution context was destroyed');
      return vm.runInNewContext(`(${fn.toString()})()`, { window: { scrollY }, location: { href: url }, URL });
    } };
    const context = vm.createContext({ performance,
      findSearchInput: async () => { calls.push('locate'); return input; },
      usesTouch: async () => true, activateElement: async () => {}, waitForSearchInputReady: async () => {},
      typeTextHumanLike: async (_input, text, options) => { typed.push({ text, append: options.append }); return {}; },
      openSearchHome: async (_page, home) => { assert.equal(home, 'https://ya.ru/'); calls.push('home'); value = ''; },
    });
    vm.runInContext(errors + prepare, context);
    await context.prepareSearchQuery(page, 'q', suffix, {
      home: 'https://ya.ru/', timeout: 5000, allowedHost: () => true,
      document: async () => calls.push('document'), check: async () => {},
    });
    assert.equal(calls.includes('home'), redirect);
    if (redirect) {
      assert.deepEqual(calls.slice(0, 3), ['home', 'document', 'locate']);
      assert.deepEqual(typed, [{ text: 'q s', append: false }]);
    }
  });
}

const paginate = section(search, 'export async function findInSerpOrPaginate', 'async function scrollAndMove');
class TaskStoppedError extends Error {}
for (const mode of ['had_captcha', 'recover_429', 'recover_ok', 'stopped', 'aborted']) {
  test(`competitor recovery: ${mode}`, async () => {
    let opened = 0, documented = 0, revoked = 0;
    const events = [];
    const stop = new TaskStoppedError('stopped');
    const page = { url: () => 'https://ya.ru/search/touch?text=q', goto: async () => {} };
    const context = vm.createContext({ URL, TaskStoppedError,
      searchTasks: { parseSearchDepth: () => 1 }, randomInt: () => 0, choose: items => items[0],
      waitForSerpAttached: async () => {}, parseResults: async () => [{ domain: 'competitor.test', destination: 'https://competitor.test/' }],
    });
    vm.runInContext(errors + paginate, context);
    const session = {
      hadCaptcha: mode === 'had_captcha', timeout: 1000, searchDomains: ['ya.ru'],
      document: async () => {
        documented++;
        if (documented === 2 && mode !== 'recover_ok') {
          if (mode === 'stopped') throw stop;
          if (mode === 'aborted') session.signal = { aborted: true };
          const error = new Error('429'); error.code = 'search_rate_limited'; throw error;
        }
      },
      log: (name, data) => events.push({ name, data }), pause: async () => {}, setOutbound: () => {},
      allowExternalOrigin: () => () => { revoked++; },
      openResult: async () => { opened++; throw new Error('Optional visit failed'); },
    };
    const work = context.findInSerpOrPaginate(page, { targetDomain: 'target.test' }, session);
    if (mode === 'stopped' || mode === 'aborted') {
      await assert.rejects(work, error => mode === 'stopped' ? error === stop : error.code === 'search_rate_limited');
    } else {
      const result = await work;
      assert.equal(result.target, null); assert.equal(result.pagesVisited, 1);
      assert.equal(opened, mode === 'had_captcha' ? 0 : 1);
      assert.equal(events.some(event => event.data?.reason === 'competitor_return_rate_limited'), mode === 'recover_429');
    }
    if (opened) assert.equal(revoked, 2);
  });
}

const check = section(search, '  const check = async (child = page)', '  const document = async');
test('successfully handled captcha marks the session', async () => {
  const session = {};
  const page = { isClosed: () => false, url: () => 'https://ya.ru/' };
  const context = vm.createContext({ page, session, active: async () => {}, URL, signal: undefined,
    dismissSearchOverlays: async () => {}, allowedSearchHost: () => true, shouldContinue: async () => true,
    log: () => {}, task: { id: 'test' }, navigationTimeoutMs: 5000, checkCaptcha: async () => true,
  });
  vm.runInContext(`let activePage; ${check}; this.check = check;`, context);
  assert.equal(await context.check(), true);
  assert.equal(session.hadCaptcha, true);
});

const safeHome = section(search, '  const openHomeSafely = async', '  const submit = async');
const activeSerp = section(search, 'function isActiveSerpUrl', 'function isNavigationTransientError');
for (const [url, failures, success, expectedCalls, expectedDomChecks] of [
  ['https://ya.ru/search/touch?text=q&p=2', 1, true, 2, 0],
  ['https://ya.ru/search/touch?text=q&p=2', 3, false, 3, 0],
  ['https://ya.ru/', 1, true, 1, 2],
  ['https://ya.ru/showcaptcha', 3, false, 3, 0],
  ['https://sso.ya.ru/', 3, false, 3, 0],
  ['https://ya.ru/?text=q', 3, false, 3, 0],
]) {
  test(`safe home: url=${url}, transient failures=${failures}`, async () => {
    let calls = 0, domChecks = 0, sleeps = 0;
    const page = { url: () => url, evaluate: async () => { domChecks++; return true; } };
    const context = vm.createContext({ page, engine: { home: 'https://ya.ru/', domains: ['ya.ru'] },
      allowedSearchHost: host => host === 'ya.ru' || host.endsWith('.ya.ru'),
      navigationTimeoutMs: 1000, signal: undefined, shouldContinue: async () => true,
      session: { log: () => {} }, INPUTS: 'input[name="text"]', URL,
      active: async () => {}, sleep: async () => { sleeps++; },
      openSearchHome: async () => {
        if (++calls <= failures) { const error = new Error('net::ERR_ABORTED'); throw error; }
        return 'loaded';
      },
    });
    vm.runInContext(errors + activeSerp + safeHome + '\nthis.openHomeSafely = openHomeSafely;', context);
    if (success) await context.openHomeSafely();
    else await assert.rejects(context.openHomeSafely(), error => error.code === 'search_home_timeout');
    assert.equal(calls, expectedCalls);
    assert.equal(domChecks, expectedDomChecks);
    assert.equal(sleeps, Math.min(2, expectedCalls - 1));
  });
}

test('refinement uses supplied safe navigation before locating input', async () => {
  const events = [];
  const document = { activeElement: null };
  const element = { value: '', ownerDocument: document }; document.activeElement = element;
  const input = { evaluate: async fn => fn(element) };
  const context = vm.createContext({ performance,
    findSearchInput: async () => { events.push('locate'); return input; },
    usesTouch: async () => true, activateElement: async () => {}, waitForSearchInputReady: async () => {},
    typeTextHumanLike: async (_input, text, options) => {
      assert.equal(text, 'q s'); assert.equal(options.append, false); return {};
    },
    openSearchHome: async () => assert.fail('Raw navigation must be bypassed'),
  });
  vm.runInContext(errors + prepare, context);
  await context.prepareSearchQuery({ evaluate: async () => true }, 'q', 's', {
    home: 'https://ya.ru/', timeout: 1000, allowedHost: () => true,
    openHome: async () => events.push('safe-home'), document: async () => events.push('document'), check: async () => {},
  });
  assert.deepEqual(events.slice(0, 3), ['safe-home', 'document', 'locate']);
});

test('safe home propagates task cancellation without retry', async () => {
  const stopped = new TaskStoppedError('stopped');
  let calls = 0;
  const context = vm.createContext({
    page: {}, engine: { home: 'https://ya.ru/', domains: ['ya.ru'] },
    allowedSearchHost: () => true, navigationTimeoutMs: 1000, signal: undefined,
    shouldContinue: async () => true, session: { log: () => {} },
    openSearchHome: async () => { calls++; throw stopped; }, active: async () => { throw stopped; },
  });
  vm.runInContext(errors + safeHome + '\nthis.openHomeSafely = openHomeSafely;', context);
  await assert.rejects(context.openHomeSafely(), error => error === stopped);
  assert.equal(calls, 1);
});
