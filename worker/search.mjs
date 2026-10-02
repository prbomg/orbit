import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import searchTasks from '../utils/searchTask.js';

export const SEARCH_ENGINES = Object.freeze({
  yandex: { home: 'https://ya.ru/', domains: ['ya.ru', 'yandex.ru', 'yandex.com'] },
  mail: { home: 'https://mail.ru/', domains: ['mail.ru', 'ya.ru', 'yandex.ru', 'yandex.com'] },
  dzen: { home: 'https://dzen.ru/', domains: ['dzen.ru', 'ya.ru', 'yandex.ru', 'yandex.com'] },
});
const INPUTS = 'textarea[name="text"], input[name="text"], input[name="q"], input[name="query"], input[type="search"], [role="searchbox"], [contenteditable="true"][role="combobox"]';
const RESULT_ITEMS = '.serp-item, .serp-list__item, .result__item, .SearchResult, [data-testid="search-result"]';

export class SearchError extends Error {
  constructor(code) { super('Search scenario could not complete'); this.name = 'SearchError'; this.code = code; }
}
export const domainMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

async function findSearchInput(page, allowedHost, timeout, check) {
  let deadline = performance.now() + timeout;
  let activated = false;
  while (performance.now() < deadline) {
    if (await check()) deadline = performance.now() + timeout;
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        // Mail/Dzen's internet-search arrow may render inside a blank iframe.
        const element = await frame.frameElement().catch(() => null);
        const searchFrame = element && await element.evaluate(el =>
          Boolean(el.closest('form[action*="search"]') && (/search/i.test(el.className + ' ' + el.name)))).catch(() => false);
        if (!searchFrame) continue;
        const url = frame.url();
        if (!['about:blank', 'about:srcdoc', ''].includes(url) && !allowedHost(new URL(url).hostname)) continue;
      }
      const candidates = frame.locator(INPUTS);
      for (let i = 0; i < await candidates.count(); i++) {
        const input = candidates.nth(i);
        if (await input.isVisible() && await input.isEditable()) return input;
      }
    }
    if (!activated) {
      const activator = page.locator('form[action*="search"] [class*="search-arrow"][class*="overlay"], form[action*="search"] [class*="search-arrow"][class*="placeholder"]');
      for (let i = 0; i < await activator.count(); i++) {
        if (await activator.nth(i).isVisible()) { await activator.nth(i).click({ timeout }); activated = true; break; }
      }
    }
    await sleep(200);
  }
  throw new SearchError('search_input_not_found');
}

async function parseResults(page, searchDomains) {
  const marker = randomUUID();
  return page.evaluate(({ selector, searchDomains, marker }) => {
    const ownDomain = hostname => searchDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    const collected = []; const seen = new Set();
    for (const item of document.querySelectorAll(selector)) {
      if (item.matches('[data-ad], [data-testid="ad"], [data-fast-name="adv"]') || /(?:^|[-_\s])(?:adv|advertisement|sponsored)(?:$|[-_\s])/i.test(item.className) ||
          item.querySelector('[data-ad], [data-testid="ad"], .AdvLabel, .ad-label') ||
          Array.from(item.querySelectorAll('[class*="Label"], [class*="label"]')).some(label => /^(?:Реклама|Advertisement|Sponsored)$/i.test(label.textContent.trim()))) continue;
      const anchors = item.querySelectorAll('h2 a[href], h3 a[href], a.OrganicTitle-Link, a.organic__url-link, a[data-testid="result-link"]');
      const candidates = anchors.length ? anchors : item.querySelectorAll('a[href]');
      for (const anchor of candidates) {
        const box = anchor.getBoundingClientRect(); const style = getComputedStyle(anchor);
        if (!box.width || !box.height || style.display === 'none' || style.visibility !== 'visible' || anchor.hasAttribute('download') || /\bsponsored\b/i.test(anchor.rel)) continue;
        try {
          const href = new URL(anchor.href, location.href);
          if (!['http:', 'https:'].includes(href.protocol) || href.username || href.password || /^(?:yabs|an|ads)\./i.test(href.hostname)) continue;
          let destination = href;
          if (ownDomain(href.hostname)) {
            const encoded = href.searchParams.get('url') ?? href.searchParams.get('target') ?? anchor.getAttribute('data-url');
            if (!encoded) continue;
            destination = new URL(encoded);
          }
          if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || ownDomain(destination.hostname) ||
              /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)/i.test(decodeURIComponent(destination.pathname + destination.search)) || seen.has(destination.href)) continue;
          seen.add(destination.href);
          const token = `${marker}-${collected.length}`; anchor.setAttribute('data-worker-search-result', token);
          collected.push({ token, href: href.href, destination: destination.href, domain: destination.hostname });
          break;
        } catch { /* Invalid or opaque tracking URLs cannot establish a target domain. */ }
      }
    }
    return collected;
  }, { selector: RESULT_ITEMS, searchDomains, marker });
}

async function nextPageLink(page, pageNumber) {
  const token = randomUUID();
  const found = await page.evaluate(({ token, number }) => {
    for (const element of document.querySelectorAll('a[href], button')) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
      const label = (element.getAttribute('aria-label') ?? element.textContent).trim();
      const pager = element.closest('[class*="Pager"], [class*="pager"], [class*="pagination"], [aria-label*="страниц"]');
      if (element.rel === 'next' || /^(?:Далее|Следующая(?: страница)?|Next(?: page)?)$/i.test(label) ||
          (number === 2 && /^Вторая страница$/i.test(label)) ||
          (pager && (label === String(number) || label === `Страница ${number}`))) {
        if (element.href) {
          try { const url = new URL(element.href); if (!['http:', 'https:'].includes(url.protocol)) continue; } catch { continue; }
        }
        element.setAttribute('data-worker-search-next', token); return true;
      }
    }
    return false;
  }, { token, number: pageNumber });
  return found ? page.locator(`[data-worker-search-next="${token}"]`) : null;
}

const choose = items => items[randomInt(0, items.length - 1)];

export async function typeTextHumanLike(input, text, { check, timeout, append = false }) {
  await check();
  if (!append) await input.fill('');
  await input.focus();
  if (append) await input.press('End');
  for (const character of text) {
    await check();
    await input.pressSequentially(character, { delay: randomInt(50, 200), timeout });
  }
}

export async function submitSearch(input, timeout, onBeforeSubmit = () => {}) {
  const form = input.locator('xpath=ancestor::form[1]');
  if (await form.count()) {
    const candidates = form.locator('button[type="submit"], input[type="submit"], button:not([type])');
    const enabled = [];
    for (let index = 0; index < await candidates.count(); index++) {
      const button = candidates.nth(index);
      if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
      const label = await button.evaluate(element => [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('value')].filter(Boolean).join(' '));
      enabled.push({ button, named: /найти|поиск|search|find/i.test(label), explicit: await button.getAttribute('type') === 'submit' });
    }
    const selected = enabled.find(item => item.named) ?? (enabled.filter(item => item.explicit).length === 1 ? enabled.find(item => item.explicit) : enabled.length === 1 ? enabled[0] : null);
    if (selected) { onBeforeSubmit('button'); await selected.button.click({ timeout, noWaitAfter: true }); return 'button'; }
  }
  onBeforeSubmit('enter');
  await input.press('Enter', { timeout, noWaitAfter: true });
  return 'enter';
}

async function waitForSerpChange(page, before, content, timeout, check = async () => {}) {
  let deadline = performance.now() + timeout;
  let changed = false;
  while (performance.now() < deadline) {
    if (await check()) deadline = performance.now() + timeout;
    try {
      await page.waitForFunction(({ before, content, selector }) => location.href !== before ||
        JSON.stringify(Array.from(document.querySelectorAll(selector)).map(el => el.textContent)) !== JSON.stringify(content),
      { before, content, selector: RESULT_ITEMS }, { timeout: Math.min(500, Math.max(1, deadline - performance.now())) });
      changed = true; break;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  if (!changed && await check()) {
    try {
      await page.waitForFunction(({ before, content, selector }) => location.href !== before ||
        JSON.stringify(Array.from(document.querySelectorAll(selector)).map(el => el.textContent)) !== JSON.stringify(content),
      { before, content, selector: RESULT_ITEMS }, { timeout });
      changed = true;
    } catch (error) { if (error.name !== 'TimeoutError') throw error; }
  }
  if (!changed) throw new SearchError('search_results_timeout');
  await page.waitForLoadState('domcontentloaded', { timeout });
}

export async function findInSerpOrPaginate(page, config, session) {
  for (let number = 1; number <= 5; number++) {
    await session.document(page);
    await page.locator(RESULT_ITEMS).first().waitFor({ state: 'attached', timeout: session.timeout });
    const results = await parseResults(page, session.searchDomains);
    session.log('search_page_scanned', { page: number, organicResults: results.length });
    await session.pause(randomInt(350, 900));
    const target = results.find(result => domainMatches(result.domain, config.targetDomain));
    if (target) return { target, results, pagesVisited: number };
    if (number === 5) return { target: null, results, pagesVisited: number };
    const next = await nextPageLink(page, number + 1);
    if (!next) throw new SearchError('search_pagination_not_found');
    const before = page.url(); const content = await page.locator(RESULT_ITEMS).allTextContents();
    await next.evaluate(el => { if (el.tagName === 'A') el.target = '_self'; });
    await next.click({ timeout: session.timeout });
    await waitForSerpChange(page, before, content, session.timeout, () => session.check(page));
  }
}

async function scrollAndMove(page, session, slow = false) {
  await session.check(page);
  await page.evaluate(pixels => window.scrollBy({ top: pixels, behavior: 'smooth' }), randomInt(slow ? 80 : 200, slow ? 300 : 750) * (Math.random() < 0.25 ? -1 : 1));
  const viewport = page.viewportSize() ?? { width: 360, height: 640 };
  await page.mouse.move(randomInt(15, viewport.width - 15), randomInt(15, viewport.height - 15), { steps: randomInt(8, 20) });
  session.log('visit_scroll', { domain: new URL(page.url()).hostname });
}

/** Return to the original SERP whether a result opened a popup or the same page. */
export async function visitCompetitors(page, results, target, config, session) {
  const targetIndex = results.findIndex(result => result.destination === target.destination);
  const candidates = results.slice(0, targetIndex + 3).filter(result => !domainMatches(result.domain, config.targetDomain) && !result.domain.startsWith(`${config.targetDomain}.`));
  const unique = [...new Map(candidates.map(result => [result.domain.replace(/^www\./, ''), result])).values()];
  const count = Math.min(randomInt(1, 3), unique.length);
  if (!count) session.log('competitors_unavailable');
  for (let i = 0; i < count; i++) {
    const competitor = unique.splice(randomInt(0, unique.length - 1), 1)[0];
    // AJAX/goBack may re-create anchors: never reuse an old locator/token.
    const current = (await parseResults(page, session.searchDomains)).find(result => result.destination === competitor.destination);
    if (!current) throw new SearchError('competitor_result_changed');
    const serpUrl = page.url();
    const child = await session.openResult(page, current);
    session.log('competitor_visit_started', { domain: new URL(child.url()).hostname, popup: child !== page });
    await scrollAndMove(child, session);
    await session.pause(randomInt(500, 1000), child);
    await scrollAndMove(child, session);
    // Pause budget excludes the two initial scrolls; the visit lasts about 10–15s.
    await session.pause(randomInt(10_000, 13_000), child);
    if (child !== page) { await child.close(); await page.bringToFront(); }
    else {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: session.timeout });
      if (page.url() !== serpUrl) throw new SearchError('serp_return_failed');
    }
    session.setOutbound(null);
    await session.document(page);
    await page.locator(RESULT_ITEMS).first().waitFor({ state: 'attached', timeout: session.timeout });
    session.log('competitor_returned');
    await session.pause(randomInt(500, 1200));
  }
  return count;
}

async function internalLinks(page, domain, visited) {
  const marker = randomUUID();
  return page.evaluate(({ domain, visited, marker }) => {
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL(a.href); const rect = a.getBoundingClientRect();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || a.hasAttribute('download') ||
            !(url.hostname === domain || url.hostname.endsWith(`.${domain}`)) || visited.includes(url.href.split('#')[0]) ||
            /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)/i.test(decodeURIComponent(url.pathname + url.search)) ||
            /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|webm|avi|exe|dmg)$/i.test(url.pathname) ||
            a.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], [role="button"], [aria-haspopup="dialog"]') ||
            !rect.width || !rect.height || getComputedStyle(a).visibility !== 'visible' || url.href.split('#')[0] === location.href.split('#')[0]) continue;
        // Closed popups can retain a nonzero box and visibility:visible.
        let hidden = false;
        for (let element = a; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.opacity === '0' || style.pointerEvents === 'none') { hidden = true; break; }
        }
        if (hidden) continue;
        const token = `${marker}-${links.length}`; a.setAttribute('data-worker-internal', token);
        links.push({ token, href: url.href });
      } catch { /* Skip non-navigation links. */ }
    }
    return links;
  }, { domain, visited, marker });
}

async function followInternalLink(page, link, session, domain) {
  const before = page.url();
  const actionTimeout = Math.min(3000, session.timeout);
  let requested = false; let committed = false; let failed = false;
  const isDocument = request => request.isNavigationRequest() && request.frame() === page.mainFrame();
  const onRequest = request => { if (isDocument(request)) requested = true; };
  const onFailure = request => { if (isDocument(request)) failed = true; };
  const onNavigation = frame => { if (frame === page.mainFrame()) committed = true; };
  const skip = code => { session.log('target_internal_link_skipped', { code }); return false; };
  page.on('request', onRequest); page.on('requestfailed', onFailure); page.on('framenavigated', onNavigation);
  try {
    session.log('target_internal_link_started');
    await session.check(page);
    const anchor = page.locator(`[data-worker-internal="${link.token}"]`);
    try {
      const href = await anchor.evaluate(a => { const href = a.href; a.target = '_self'; return href; }, undefined, { timeout: actionTimeout });
      if (href !== link.href) return skip('internal_link_changed');
      // Bound actionability separately: a covered link is optional, a failed document is not.
      await anchor.click({ timeout: actionTimeout, noWaitAfter: true });
    } catch (error) {
      await session.check(page);
      if (error.name !== 'TimeoutError') throw error;
      if (!requested && !committed && page.url() === before) return skip('target_internal_link_unavailable');
    }
    const started = performance.now();
    while (!requested && !committed && page.url() === before && performance.now() - started < actionTimeout) {
      await session.check(page);
      await sleep(Math.min(100, Math.max(1, actionTimeout - (performance.now() - started))), session.signal);
    }
    if (!requested && !committed && page.url() === before) return skip('target_internal_no_navigation');
    session.log('target_internal_navigation_started');
    const deadline = performance.now() + session.timeout;
    while (!committed && page.url() === before) {
      await session.check(page);
      if (failed) throw new SearchError('target_internal_navigation_failed');
      if (performance.now() >= deadline) throw new SearchError('target_internal_navigation_timeout');
      await sleep(Math.min(100, Math.max(1, deadline - performance.now())), session.signal);
    }
    if (failed) throw new SearchError('target_internal_navigation_failed');
    try { await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - performance.now()) }); }
    catch (error) {
      await session.check(page);
      if (error.name === 'TimeoutError') throw new SearchError('target_internal_navigation_timeout');
      throw error;
    }
    if (failed) throw new SearchError('target_internal_navigation_failed');
    await session.document(page);
    if (!domainMatches(new URL(page.url()).hostname, domain)) throw new SearchError('target_domain_changed');
    if (page.url().split('#')[0] === before.split('#')[0]) return skip('target_internal_no_navigation');
    return true;
  } catch (error) {
    session.log('target_internal_link_failed', { errorType: error.name, ...(error instanceof SearchError ? { code: error.code } : {}) });
    throw error;
  } finally {
    page.off('request', onRequest); page.off('requestfailed', onFailure); page.off('framenavigated', onNavigation);
  }
}

/** Keep the final visit on the target domain for a total of 1–5 minutes. */
export async function interactWithTargetSite(page, config, session, { durationMs = randomInt(60_000, 300_000) } = {}) {
  const end = session.now() + durationMs;
  const attempted = new Set([page.url().split('#')[0]]); const depth = randomInt(1, 2);
  let linksFollowed = 0;
  session.log('target_visit_started', { durationMs, domain: config.targetDomain });
  while (session.now() < end) {
    await session.document(page);
    if (!domainMatches(new URL(page.url()).hostname, config.targetDomain)) throw new SearchError('target_domain_changed');
    await scrollAndMove(page, session, true);
    if (linksFollowed < depth && session.now() < end - 3000) {
      const links = await internalLinks(page, config.targetDomain, [...attempted]);
      if (links.length) {
        const link = choose(links); attempted.add(link.href.split('#')[0]);
        if (await followInternalLink(page, link, session, config.targetDomain)) {
          attempted.add(page.url().split('#')[0]); linksFollowed++;
          session.log('target_internal_link', { linksFollowed });
        }
      }
    }
    await session.pause(Math.min(randomInt(2500, 6500), Math.max(0, end - session.now())), page);
  }
  await session.document(page);
  session.log('target_visit_finished', { linksFollowed });
  return { durationMs, linksFollowed };
}

export async function performSearchAndClick(page, task, {
  engines = SEARCH_ENGINES, navigationTimeoutMs = 30_000, signal,
  shouldContinue = async () => true, createCheckCaptcha = () => async () => false,
  waitFor = sleep, now = () => performance.now(), targetDurationMs,
  preparePage = async () => {}, log = () => {}, ownedOnly = false,
} = {}) {
  let config;
  try { config = searchTasks.searchTaskConfig(task); } catch { throw new SearchError('invalid_search_task'); }
  if (!config || !engines[config.searchEngine]) throw new SearchError('invalid_search_task');
  const engine = engines[config.searchEngine]; const context = page.context();
  const allowedSearchHost = host => engine.domains.some(domain => domainMatches(host, domain));
  let outboundDomain; let approvedPost; let activePage = page;
  const responses = new WeakMap(); const responseUrls = new Map(); const prepared = new WeakMap(); const children = new Set();
  const prepare = child => {
    if (child === page) return Promise.resolve();
    if (!prepared.has(child)) prepared.set(child, preparePage(child));
    return prepared.get(child);
  };
  const handler = async route => {
    const request = route.request();
    let frame;
    try { frame = request.frame(); } catch { /* The first popup request precedes frame creation. */ }
    if (request.isNavigationRequest() && (!frame || !frame.parentFrame())) {
      if (frame) await prepare(frame.page());
      const url = new URL(request.url()); const search = allowedSearchHost(url.hostname);
      const outbound = outboundDomain && domainMatches(url.hostname, outboundDomain);
      const captchaPost = request.method() === 'POST' && request.url() === approvedPost;
      if (captchaPost) approvedPost = undefined;
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (!search && !outbound) ||
          !(request.method() === 'GET' || (request.method() === 'POST' && (search || captchaPost)))) {
        await route.abort('blockedbyclient'); return;
      }
    }
    await route.fallback();
  };
  const policy = {
    allowCaptchaPost: url => {
      const action = new URL(url); action.hash = '';
      if (action.origin !== new URL(activePage.url()).origin) throw new SearchError('captcha_origin_changed');
      approvedPost = action.href;
    }, clearCaptchaPost: () => { approvedPost = undefined; },
  };
  const checkCaptcha = createCheckCaptcha(policy);
  const check = async (child = page) => {
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    if (child.isClosed()) throw new SearchError('search_page_closed');
    activePage = child;
    const handled = await checkCaptcha(child, signal); signal?.throwIfAborted(); return handled;
  };
  const document = async child => {
    const handled = await check(child); const response = responses.get(child) ?? responseUrls.get(child.url());
    if (response && !response.ok() && !handled) throw new SearchError('search_http_error');
  };
  const listener = response => {
    if (!response.request().isNavigationRequest()) return;
    responseUrls.set(response.url(), response);
    try { if (!response.frame().parentFrame()) responses.set(response.frame().page(), response); } catch { /* Popup frame not yet published. */ }
  };
  const popupListener = child => { children.add(child); };
  const abort = () => { for (const child of [page, ...children]) void child.close().catch(() => {}); };
  const session = {
    check, document, timeout: navigationTimeoutMs, searchDomains: engine.domains, now, signal,
    log: (event, data = {}) => log(event, { taskId: task.id, ...data }),
    setOutbound: domain => { outboundDomain = domain; },
    pause: async (ms, child = page) => {
      for (let left = ms; left > 0;) { await check(child); const chunk = Math.min(500, left); await waitFor(chunk, signal); left -= chunk; }
    },
    openResult: async (parent, result, domain = result.domain.replace(/^www\./, '')) => {
      await check(parent); outboundDomain = domain;
      const anchor = parent.locator(`[data-worker-search-result="${result.token}"]`);
      if (await anchor.evaluate(a => a.href) !== result.href) throw new SearchError('result_changed');
      // Both listeners start before the click. Promise.any consumes loser rejections.
      const popup = parent.waitForEvent('popup', { timeout: navigationTimeoutMs });
      const samePage = parent.waitForURL(url => domainMatches(url.hostname, domain) && !allowedSearchHost(url.hostname),
        { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }).then(() => parent);
      const destination = Promise.any([popup, samePage]);
      // Register rejection handling before a potentially failing click.
      void destination.catch(() => {});
      await anchor.click({ timeout: navigationTimeoutMs });
      const child = await destination; await prepare(child);
      await child.waitForURL(url => domainMatches(url.hostname, domain) && !allowedSearchHost(url.hostname), { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      await document(child);
      if (!domainMatches(new URL(child.url()).hostname, domain)) throw new SearchError('unexpected_result_domain');
      return child;
    },
  };
  await context.route('**/*', handler); context.on('response', listener); page.on('popup', popupListener);
  signal?.addEventListener('abort', abort, { once: true });
  const submit = async (query, suffix) => {
    const input = await findSearchInput(page, allowedSearchHost, navigationTimeoutMs, () => check(page));
    await page.locator('form[action*="search"]').evaluateAll(forms => { for (const form of forms) form.target = '_self'; });
    await input.evaluate(el => { const form = el.form ?? el.closest('form'); if (form) form.target = '_top'; });
    let append = false;
    if (suffix) append = await input.inputValue().catch(() => '') === query;
    await typeTextHumanLike(input, append ? ` ${suffix}` : suffix ? `${query} ${suffix}` : query, { check: () => check(page), timeout: navigationTimeoutMs, append });
    const before = page.url(); const content = await page.locator(RESULT_ITEMS).allTextContents();
    const method = await submitSearch(input, navigationTimeoutMs, method => session.log('search_submit_started', { method }));
    session.log('search_submit_completed', { method });
    await waitForSerpChange(page, before, content, navigationTimeoutMs, () => check(page)); await document(page);
  };
  try {
    await check(); session.log('search_started', { engine: config.searchEngine, targetDomain: config.targetDomain });
    session.log('search_home_opening', { engine: config.searchEngine });
    let response;
    try { response = await page.goto(engine.home, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }); }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      session.log('search_home_failed', { code: 'search_home_timeout' });
      throw new SearchError('search_home_timeout');
    }
    if (response) responses.set(page, response); await document(page);
    const query = choose(config.searchQueries); await session.pause(randomInt(500, 1200));
    await submit(query); session.log('search_query_entered', { characters: [...query].length });
    let found = await findInSerpOrPaginate(page, config, session); let totalPages = found.pagesVisited; let refined = false;
    if (!found.target && config.vitalPhrases.length) {
      await session.pause(randomInt(700, 1600));
      const suffix = choose(config.vitalPhrases); session.log('search_vital_refinement', { characters: [...suffix].length });
      await submit(query, suffix); refined = true;
      found = await findInSerpOrPaginate(page, config, session); totalPages += found.pagesVisited;
    }
    if (!found.target) { session.log('search_target_not_found', { pagesVisited: totalPages, refined }); return { found: false, pagesVisited: totalPages, refined }; }
    const competitorVisits = ownedOnly ? 0 : await visitCompetitors(page, found.results, found.target, config, session);
    const target = (await parseResults(page, engine.domains)).find(result => domainMatches(result.domain, config.targetDomain));
    if (!target) throw new SearchError('target_result_changed');
    const targetPage = await session.openResult(page, target, config.targetDomain);
    session.log('search_target_clicked', { domain: new URL(targetPage.url()).hostname, page: found.pagesVisited });
    const visit = await interactWithTargetSite(targetPage, config, session, { durationMs: targetDurationMs });
    return { found: true, pagesVisited: totalPages, refined, competitorVisits, domain: new URL(targetPage.url()).hostname, ...visit };
  } finally {
    for (const child of children) await child.close().catch(() => {});
    await context.unroute('**/*', handler).catch(() => {});
    context.off('response', listener); page.off('popup', popupListener); signal?.removeEventListener('abort', abort);
  }
}
