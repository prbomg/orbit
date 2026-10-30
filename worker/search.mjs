import { preSearchWarmup as visitPreSearchDonor } from './search-pre-warmup.mjs';
import { composeMobileCharacter } from './mobile-composition.mjs';
import { behaviorRandom, withBehaviorRandom } from './behavior-random.mjs';
import { previewPlan } from './search-preview-policy.mjs';
import { trackNavigationResponses } from './navigation-response.mjs';
import { retryAfterMs } from './http-retry.mjs';
import { dismissSearchOverlays } from './search-overlays.mjs';
import { openSearchHome } from './search-navigation.mjs';
import { inspectSite, waitForSiteReady, createPageBehavior, chooseSiteAction, observeScroll, canonicalVisitUrl } from './site-behavior.mjs';
import visitPolicy from '../utils/visitSettings.js';
import { actionSnapshot, waitActionResult } from './action-result.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import searchTasks from '../utils/searchTask.js';
import { activateElement, scrollPage, usesTouch } from './mobile-input.mjs';
import { safeTapPoint } from './tap-target.mjs';
import { sampleKeystrokeDelay } from './keystroke-cadence.mjs';
import { prepareSearchReferences, searchReference, withSameTabLink, withSameTabForm } from './search-dom.mjs';

export const SEARCH_ENGINES = searchTasks.SEARCH_ENGINES;
const INPUTS = 'textarea[name="text"], input[name="text"], input[name="q"], input[name="query"], input[type="search"], [role="searchbox"], [contenteditable="true"][role="combobox"]';
const RESULT_ITEMS = '.serp-item, .serp-list__item, .result__item, .SearchResult, [data-testid="search-result"]';

// Домены и пути основных систем аналитики (Яндекс.Метрика, Google Analytics, VK/Mail, Roistat и др.)
const METRIKA_AND_ANALYTICS_RE = /(?:^|\.)(?:mc\.yandex\.(?:ru|com|by|kz|ua|md)|mc\.webvisor\.org|mc\.webvisor\.com|yastatic\.net\/s3\/metrika|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|top-fwz1\.mail\.ru|vk\.com\/rtrg|roistat\.com|calltouch\.ru|clarity\.ms)(?:$|\/)|\/metrika\/(?:tag|watch)\.js|\/gtm\.js|\/analytics\.js/i;

export function isMetricsRequest(urlStr) {
  try {
    const u = new URL(urlStr);
    return METRIKA_AND_ANALYTICS_RE.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

export async function injectMetricsStub(page) {
  await page.addInitScript(() => {
    const noop = function () {};
    try {
      if (!window.ym) window.ym = noop;
      if (!window.gtag) window.gtag = noop;
      if (!window.ga) window.ga = noop;
      if (!window._tmr) window._tmr = { push: noop };
    } catch {}
  }).catch(() => {});
}

export class SearchError extends Error {
  constructor(code) { super('Search scenario could not complete'); this.name = 'SearchError'; this.code = code; }
}
export const domainMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

function isActiveSerpUrl(urlStr, searchDomains) {
  try {
    const u = new URL(urlStr);
    if (!searchDomains.some(d => domainMatches(u.hostname, d))) return false;
    if (/^\/(?:showcaptcha|checkcaptcha)/i.test(u.pathname)) return false;
    return /\/search/i.test(u.pathname) || u.searchParams.has('text') || u.searchParams.has('q') || u.searchParams.has('query');
  } catch {
    return false;
  }
}

async function waitForSerpAttached(page, timeout) {
  try {
    await page.waitForFunction(selector => {
      const bodyText = document.body?.innerText || '';
      const isCaptcha = Boolean(document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]')) ||
        /^\/(?:showcaptcha|checkcaptcha)/i.test(location.pathname) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText);
      if (!isCaptcha && (document.title.includes('429') || /^Too Many Requests$/i.test(bodyText.trim()))) {
        return 'rate_limited';
      }
      if (document.querySelector(selector)) return true;
      const links = Array.from(document.querySelectorAll('main a[href], #search-result a[href], body a[href]'));
      if (links.filter(a => {
        try {
          const u = new URL(a.href, location.href);
          return ['http:', 'https:'].includes(u.protocol) && !u.hostname.includes('yandex') && !u.hostname.includes('ya.ru');
        } catch { return false; }
      }).length >= 3) return true;
      return false;
    }, RESULT_ITEMS, { timeout });
    
    const isRateLimited = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const isCaptcha = Boolean(document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]')) ||
        /^\/(?:showcaptcha|checkcaptcha)/i.test(location.pathname) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText);
      return !isCaptcha && (document.title.includes('429') || /^Too Many Requests$/i.test(bodyText.trim()));
    });
    if (isRateLimited) {
      const err = new SearchError('search_rate_limited');
      err.httpStatus = 429; err.retryDelayMs = 0;
      throw err;
    }
  } catch (error) {
    if (error.name === 'TimeoutError') throw new SearchError('search_results_timeout');
    throw error;
  }
}

async function findSearchInput(page, allowedHost, timeout, check) {
  let deadline = performance.now() + timeout;
  let activated = false;
  while (performance.now() < deadline) {
    if (await check()) deadline = performance.now() + timeout;
    let fallback;
    const available = [];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
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
        if (await input.isVisible() && await input.isEditable({ timeout })) {
          if (await input.evaluate(el => el === el.ownerDocument.activeElement, undefined, { timeout })) return input;
          available.push(input);
          fallback ??= input;
        }
      }
    }
    for (const input of available) if (await safeTapPoint(input, Math.min(500, timeout))) return input;
    if (fallback) return fallback;
    if (!activated) {
      const activator = page.locator('form[action*="search"] [class*="search-arrow"][class*="overlay"], form[action*="search"] [class*="search-arrow"][class*="placeholder"]');
      for (let i = 0; i < await activator.count(); i++) {
        if (await activator.nth(i).isVisible()) { await activateElement(activator.nth(i), { timeout }); activated = true; break; }
      }
    }
    await sleep(200);
  }
  throw new SearchError('search_input_not_found');
}

async function parseResults(page, searchDomains) {
  await prepareSearchReferences(page, true);
  const marker = randomUUID();
  return page.evaluate(({ selector, searchDomains, marker }) => {
    const ownDomain = hostname => searchDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    const collected = []; const seen = new Set();
    
    let items = Array.from(document.querySelectorAll(selector));
    if (items.length === 0) {
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const fallbackItems = allLinks
        .filter(a => {
          try {
            const u = new URL(a.href, location.href);
            return ['http:', 'https:'].includes(u.protocol) && !ownDomain(u.hostname) && !u.hostname.includes('yandex') && !u.hostname.includes('ya.ru');
          } catch { return false; }
        })
        .map(a => a.closest('li, div[role="listitem"]') || a.parentElement)
        .filter(Boolean);
      items = [...new Set(fallbackItems)];
    }

    for (const item of items) {
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
          const token = `${marker}-${collected.length}`; window[Symbol.for('__ OrbitSearchRefs')].set(token, anchor);
          collected.push({ token, href: href.href, destination: destination.href, domain: destination.hostname });
          break;
        } catch { }
      }
    }
    return collected;
  }, { selector: RESULT_ITEMS, searchDomains, marker });
}

async function nextPageLink(page, pageNumber) {
  await prepareSearchReferences(page);
  const token = `next:${randomUUID()}`;
  const found = await page.evaluate(({ token, number }) => {
    for (const element of document.querySelectorAll('a[href], button, [role="button"]')) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
      const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ');
      const pager = element.closest('[class*="Pager"], [class*="pager"], [class*="Pagination"], [class*="pagination"], [aria-label*="страниц"]');
      const more = /^(?:Показать ещё(?: результаты| \d+ результатов)?|Ещё результаты|Show more(?: results)?)$/i.test(label) &&
        !element.closest('.serp-item, .serp-list__item, .result__item, .SearchResult, [data-testid="search-result"]') &&
        Boolean(element.closest('[class*="More"], [class*="more"], [class*="Pager"], [class*="pager"], [class*="Pagination"], [class*="pagination"]'));
      let pageByUrl = false;
      if (element.href) {
        try {
          const url = new URL(element.href);
          const current = new URL(location.href);
          pageByUrl = url.hostname === current.hostname && url.pathname === current.pathname &&
            (!current.searchParams.has('text') || url.searchParams.get('text') === current.searchParams.get('text')) &&
            (url.searchParams.get('p') === String(number - 1) || url.searchParams.get('page') === String(number));
        } catch { }
      }
      if (element.rel === 'next' || /^(?:Далее|Следующая(?: страница)?|Следующие(?: результаты)?|Next(?: page| results)?)$/i.test(label) ||
          (number === 2 && /^Вторая страница$/i.test(label)) ||
          (pager && (label === String(number) || label === `Страница ${number}` || more)) || pageByUrl || more) {
        if (element.href) {
          try { const url = new URL(element.href); if (!['http:', 'https:'].includes(url.protocol)) continue; } catch { continue; }
        }
        window[Symbol.for('__ OrbitSearchRefs')].set(token, element); return true;
      }
    }
    return false;
  }, { token, number: pageNumber });
  return found ? searchReference(page, token) : null;
}

const choose = items => items[randomInt(0, items.length - 1)];

export async function waitForSearchInputReady(input, { timeout, check }) {
  const deadline = performance.now() + timeout;
  const element = await input.elementHandle({ timeout });
  let previous;
  try {
    while (element && performance.now() < deadline) {
      await check();
      const state = await element.evaluate(el => {
        const box = el.getBoundingClientRect();
        return { ready: el.isConnected && el === el.ownerDocument.activeElement && !el.disabled && !el.readOnly && el.getAttribute('aria-disabled') !== 'true', box: [box.x, box.y, box.width, box.height] };
      });
      if (state.ready && await safeTapPoint(element, Math.max(1, deadline - performance.now()))) {
        if (previous && state.box.every((value, index) => Math.abs(value - previous[index]) < 1)) return;
        previous = state.box;
      } else previous = undefined;
      await sleep(Math.min(50, Math.max(1, deadline - performance.now())));
    }
  } finally { await element?.dispose(); }
  const error = new Error('Search editor did not become focused and stable');
  error.name = 'TimeoutError'; throw error;
}

export async function typeTextHumanLike(input, text, { check, timeout, append = false, log = () => {}, signal, random = behaviorRandom }) {
  const started = performance.now(), intervals = [];
  let checksMs = 0, previousInputAt, focusRecoveryCount = 0;
  const checked = async () => { const start = performance.now(); try { signal?.throwIfAborted(); return await check(); } finally { checksMs += performance.now() - start; } };
  const finish = corrected => {
    const sorted = [...intervals].sort((a, b) => a - b);
    log('search_input_metrics', { elapsedMs: Math.round(performance.now() - started), checksMs: Math.round(checksMs), characters: [...text].length, focusRecoveryCount, intervalCount: sorted.length,
      ...(sorted.length ? { intervalMedianMs: Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2), intervalMaxMs: Math.round(sorted.at(-1)) } : {}) });
    return { corrected };
  };
  await checked();
  const touch = await usesTouch(input.page());
  if (!(await input.evaluate(el => el === el.ownerDocument.activeElement, undefined, { timeout }))) await activateElement(input, { timeout, signal, random });
  const before = append ? await input.evaluate(el => el.value ?? el.textContent ?? '', undefined, { timeout }) : '';
  const prepareCaret = async replace => {
    if (replace) await input.selectText({ timeout });
    else await input.evaluate(el => {
      if ('setSelectionRange' in el) el.setSelectionRange(el.value.length, el.value.length);
      else { const range = el.ownerDocument.createRange(); range.selectNodeContents(el); range.collapse(false); const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    }, undefined, { timeout });
  };
  if (touch) await prepareCaret(!append);
  else {
    if (!append) await input.fill('', { timeout });
    if (append) await input.press('End', { timeout });
  }
  let inserted = 0, previousCharacter = [...before].at(-1);
  for (const character of text) {
    if (previousCharacter !== undefined) await sleep(sampleKeystrokeDelay(previousCharacter, character, random), signal);
    await checked();
    if (touch) {
      if (!(await input.evaluate(el => el === el.ownerDocument.activeElement, undefined, { timeout }))) {
        await activateElement(input, { timeout, signal, random });
        await prepareCaret(!append && !inserted);
        if (!(await input.evaluate(el => el === el.ownerDocument.activeElement, undefined, { timeout }))) throw new SearchError('search_input_typing_timeout');
        focusRecoveryCount++;
        log('search_input_focus_restored', { method: 'touch', focusRecoveryCount });
      }
      await composeMobileCharacter(input.page(), character, { signal, focused: () => input.evaluate(el => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus(), undefined, { timeout }) });
    } else {
      await input.pressSequentially(character, { delay: 0, timeout });
    }
    inserted++;
    previousCharacter = character;
    const at = performance.now(); if (previousInputAt !== undefined) intervals.push(at - previousInputAt); previousInputAt = at;
  }
  if(touch && !await input.evaluate(el=>el===el.ownerDocument.activeElement&&el.ownerDocument.hasFocus(),undefined,{timeout})){
    await checked();await activateElement(input,{timeout,signal,random});await prepareCaret(false);
    if(!await input.evaluate(el=>el===el.ownerDocument.activeElement&&el.ownerDocument.hasFocus(),undefined,{timeout}))throw new SearchError('search_input_typing_timeout');
    focusRecoveryCount++;log('search_input_focus_restored',{method:'touch',focusRecoveryCount});
  }
  const expected = before + text;
  const actual = await input.evaluate(el => el.value ?? el.textContent ?? '', undefined, { timeout });
  if (actual !== expected) {
    await checked();
    log('search_input_repair_started', { reason: 'value_mismatch', method: 'retype_char_by_char', characters: [...expected].length });
    const requireRepairFocus = async () => {
      await checked();
      if (!(await input.evaluate(el => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus(), undefined, { timeout }))) throw new SearchError('search_input_typing_timeout');
    };
    await activateElement(input, { timeout, signal, random });
    await input.selectText({ timeout });
    await requireRepairFocus();
    await input.page().keyboard.press('Backspace');
    await sleep(randomInt(600, 1400, random), signal);
    previousCharacter = undefined;
    for (const character of expected) {
      if (previousCharacter !== undefined) await sleep(sampleKeystrokeDelay(previousCharacter, character, random), signal);
      await requireRepairFocus();
      if (touch) await composeMobileCharacter(input.page(), character, { signal, focused: () => input.evaluate(el => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus(), undefined, { timeout }) });
      else await input.pressSequentially(character, { delay: 0, timeout });
      const at = performance.now(); if (previousInputAt !== undefined) intervals.push(at - previousInputAt); previousInputAt = at;
      previousCharacter = character;
    }
    await requireRepairFocus();
    if (await input.evaluate(el => el.value ?? el.textContent ?? '', undefined, { timeout }) !== expected) throw new SearchError('search_query_mismatch');
    return finish(true);
  }
  return finish(false);
}

export async function prepareSearchQuery(page, query, suffix, {
  allowedHost, home, timeout, check, document, log = () => {}, append = true, signal,
}) {
  const expected = suffix ? `${query} ${suffix}` : query;
  const inputTimeout = Math.min(5000, timeout);
  for (let attempt = 0; attempt < 2; attempt++) {
    let code = 'search_input_not_found';
    try {
      log('search_input_locating');
      let input = await findSearchInput(page, allowedHost, inputTimeout, check);
      code = 'search_input_activation_timeout';
      log('search_input_activating', { method: await usesTouch(page) ? 'touch' : 'button' });
      const activationStarted = performance.now();
      await check();
      await activateElement(input, { timeout: inputTimeout, signal });
      input = await findSearchInput(page, allowedHost, inputTimeout, check);
      if (!(await input.evaluate(el => el === el.ownerDocument.activeElement, undefined, { timeout: inputTimeout }))) await activateElement(input, { timeout: inputTimeout, signal });
      await waitForSearchInputReady(input, { timeout: inputTimeout, check });
      log('search_input_activated', { method: await usesTouch(page) ? 'touch' : 'button', elapsedMs: Math.round(performance.now() - activationStarted) });
      const canAppend = Boolean(append && !attempt && suffix && await input.evaluate(el => el.value ?? el.textContent ?? '', undefined, { timeout: inputTimeout }) === query);
      code = 'search_input_typing_timeout';
      log('search_input_typing', { method: await usesTouch(page) ? 'composition' : 'keyboard' });
      const typed = await typeTextHumanLike(input, canAppend ? ` ${suffix}` : expected, { check, timeout: inputTimeout, append: canAppend, log, signal });
      if (typed.corrected) log('search_query_corrected', { characters: [...expected].length });
      log('search_query_entered', { characters: [...expected].length });
      return { input, expected, ...typed };
    } catch (error) {
      if (error.name !== 'TimeoutError' && error.code !== 'search_input_not_found') throw error;
      if (error.code) code = error.code;
      await check();
      if (attempt) {
        log('search_input_failed', { code });
        throw new SearchError(code);
      }
      log('search_input_retry', { code });
      try { await openSearchHome(page, home, { allowedHost, timeout, shouldContinue: async () => { await check(); return true; }, log }); }
      catch (navigationError) {
        if (navigationError.name !== 'TimeoutError') throw navigationError;
        throw new SearchError('search_home_timeout');
      }
      await document(page);
    }
  }
}

export async function submitSearch(input, timeout, onBeforeSubmit = () => {}, options = {}) {
  return withSameTabForm(options.inputElement ?? input, () => submitSearchInSameTab(input, timeout, onBeforeSubmit, options), timeout);
}

async function submitSearchInSameTab(input, timeout, onBeforeSubmit, { expected, inputElement, formElement, log = () => {} }) {
  const guard = async button => {
    if (expected === undefined) return;
    const ownedButton = button?.elementHandle ? await button.elementHandle({ timeout }) : null;
    let reason;
    try { reason = await (inputElement ?? input).evaluate((el, { expected, button, originalForm }) => {
      const style = getComputedStyle(el);
      if (!el.isConnected || el.disabled || el.readOnly || !el.getClientRects().length || style.visibility !== 'visible') return 'editor_changed';
      if ((el.value ?? el.textContent ?? '') !== expected) return 'value_changed';
      const form = el.form ?? el.closest('form');
      if (!form || originalForm && form !== originalForm || button && (button.form ?? button.closest('form')) !== form) return 'form_changed';
      return null;
    }, { expected, button: ownedButton ?? button ?? null, originalForm: formElement ?? null }); }
    finally { await ownedButton?.dispose(); }
    if (reason) { log('search_submit_blocked', { reason, code: 'search_query_mismatch' }); throw new SearchError('search_query_mismatch'); }
  };
  const touch = await usesTouch(input.page());
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
    if (selected) {
      const method = touch ? 'touch' : 'button';
      await activateElement(selected.button, { timeout, beforeInput: async button => { await guard(button); onBeforeSubmit(method); } });
      return method;
    }
  }
  if (touch) throw new SearchError('search_submit_timeout');
  await guard();
  onBeforeSubmit('enter');
  await input.press('Enter', { timeout, noWaitAfter: true });
  return 'enter';
}

export async function waitForSerpChange(page, before, content, timeout, check = async () => {}) {
  let deadline = performance.now() + timeout;
  let changed = false;
  let captchaSolvedDuringWait = false;
  while (performance.now() < deadline) {
    const checkStarted = performance.now();
    const solved = await check();
    const checkElapsed = performance.now() - checkStarted;
    if (solved || checkElapsed > 2000) {
      if (solved) captchaSolvedDuringWait = true;
      deadline = performance.now() + timeout;
    }
    try {
      await page.waitForFunction(({ before, content, selector, captchaSolved }) => {
        const bodyText = document.body?.innerText || '';
        const isCaptcha = Boolean(document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]')) ||
          /^\/(?:showcaptcha|checkcaptcha)/i.test(location.pathname) ||
          /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText);
        if (isCaptcha) return false;
        if (document.title.includes('429') || /^Too Many Requests$/i.test(bodyText.trim())) {
          return true;
        }
        const items = Array.from(document.querySelectorAll(selector)).map(el => el.textContent);
        if (captchaSolved && items.length > 0) return true;
        return location.href !== before || JSON.stringify(items) !== JSON.stringify(content);
      }, { before, content, selector: RESULT_ITEMS, captchaSolved: captchaSolvedDuringWait }, { timeout: Math.min(500, Math.max(1, deadline - performance.now())) });
      changed = true; break;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  
  if (changed) {
     const isRateLimited = await page.evaluate(() => {
       const bodyText = document.body?.innerText || '';
       const isCaptcha = Boolean(document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]')) ||
         /^\/(?:showcaptcha|checkcaptcha)/i.test(location.pathname) ||
         /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText);
       return !isCaptcha && (document.title.includes('429') || /^Too Many Requests$/i.test(bodyText.trim()));
     });
     if (isRateLimited) {
       const err = new SearchError('search_rate_limited');
       err.httpStatus = 429; err.retryDelayMs = 0;
       throw err;
     }
  }

  if (!changed && await check()) {
    deadline = performance.now() + timeout;
    try {
      await page.waitForFunction(({ before, content, selector }) => location.href !== before ||
        JSON.stringify(Array.from(document.querySelectorAll(selector)).map(el => el.textContent)) !== JSON.stringify(content),
      { before, content, selector: RESULT_ITEMS }, { timeout });
      changed = true;
    } catch (error) { if (error.name !== 'TimeoutError') throw error; }
  }
  
  if (!changed) throw new SearchError('search_results_timeout');
  
  while (performance.now() < deadline) {
    if (await check()) deadline = performance.now() + timeout;
    try {
      await page.waitForLoadState('load', { timeout: Math.min(500, Math.max(1, deadline - performance.now())) });
      return;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  throw new SearchError('search_results_timeout');
}

export async function findInSerpOrPaginate(page, config, session) {
  const searchDepth = searchTasks.parseSearchDepth(config.searchDepth);
  for (let number = 1; number <= searchDepth; number++) {
    await session.document(page);
    await waitForSerpAttached(page, session.timeout);
    const results = await parseResults(page, session.searchDomains);
    session.log('search_page_scanned', { page: number, organicResults: results.length });
    const target = results.find(result => domainMatches(result.domain, config.targetDomain));
    if (target) { await session.pause(randomInt(900, 2200)); return { target, results, pagesVisited: number }; }
    
    if (number === 1 && results.length > 0 && !session.competitorBounced && (!session.ownedOnly || session.allowExternalOrigin)) {
      session.competitorBounced = true;
      const validCompetitors = results.filter(r => !domainMatches(r.domain, config.targetDomain));
      if (validCompetitors.length > 0) {
        const comp = choose(validCompetitors);
        const serpUrl = page.url();
        await session.pause(randomInt(1500, 3000));
        let child = page;
        let revokeExternal = null;
        try {
          if (session.allowExternalOrigin) {
            const compUrl = new URL(comp.destination);
            const altHost = compUrl.hostname.startsWith('www.') ? compUrl.hostname.slice(4) : `www.${compUrl.hostname}`;
            const rev1 = session.allowExternalOrigin(compUrl.origin);
            const rev2 = session.allowExternalOrigin(`${compUrl.protocol}//${altHost}`);
            revokeExternal = () => { try { rev1?.(); } finally { rev2?.(); } };
          }
          
          session.log('competitor_visit_started', { domain: comp.domain, popup: false });
          child = await session.openResult(page, comp);
          
          const bounceMs = randomInt(6000, 14000, session.random);
          const bounceEnd = performance.now() + bounceMs;
          while (performance.now() < bounceEnd) {
            session.signal?.throwIfAborted();
            await scrollAndMove(child, session, false, bounceEnd);
            const pauseMs = Math.max(0, Math.min(randomInt(1500, 3500), bounceEnd - performance.now()));
            if (pauseMs > 0) await session.pause(pauseMs, child);
          }
          
          if (child !== page) {
            await child.close().catch(() => {});
            await page.bringToFront();
          } else {
            for (let backStep = 0; backStep < 3; backStep++) {
              await page.goBack({ waitUntil: 'domcontentloaded', timeout: session.timeout }).catch(() => {});
              if (session.searchDomains.some(d => domainMatches(new URL(page.url()).hostname, d))) break;
            }
            if (!session.searchDomains.some(d => domainMatches(new URL(page.url()).hostname, d))) {
              throw new SearchError('serp_return_failed');
            }
          }
          session.setOutbound(null);
          revokeExternal?.(); revokeExternal = null;
          await session.document(page);
          await waitForSerpAttached(page, session.timeout);
          session.log('competitor_returned');
          await session.pause(randomInt(1000, 2000));
        } catch (err) {
          if (err instanceof TaskStoppedError || session.signal?.aborted) throw err;
          session.setOutbound(null);
          revokeExternal?.();
          session.log('competitor_visit_failed', { errorType: err.name, message: err.message });
          if (child && child !== page) await child.close().catch(() => {});
          const currentHost = (() => { try { return new URL(page.url()).hostname; } catch { return ''; } })();
          const onSearchHost = session.searchDomains.some(d => domainMatches(currentHost, d));
          if (!onSearchHost) {
            await page.goto(serpUrl, { waitUntil: 'domcontentloaded', timeout: session.timeout }).catch(() => {});
          }
          await session.document(page);
          await waitForSerpAttached(page, session.timeout);
        }
      }
    }

    if (number === searchDepth) return { target: null, results, pagesVisited: number };

    let next = await nextPageLink(page, number + 1);
    
    if (!next) {
      for (let left = randomInt(1, 2); left > 0; left--) {
        await session.pause(randomInt(1400, 2800));
        const input = await scrollPage(page, randomInt(260, 580), { signal: session.signal, check: () => session.check(page) });
        session.log('search_serp_scroll', { page: number, result: input.result, movedPixels: input.movedPixels });
        if (input.result === 'blocked' || !input.movedPixels) break;
      }
      next = await nextPageLink(page, number + 1);
    }

    if (!next) {
      session.log('search_pagination_unavailable', { page: number, organicResults: results.length });
      return { target: null, results, pagesVisited: number };
    }

    let blockedScrolls = 0;
    for (let scrollAttempts = 0; scrollAttempts < 15; scrollAttempts++) {
      const box = await next.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, vh: window.innerHeight };
      }).catch(() => null);

      if (!box) break;
      if (box.top >= 10 && box.bottom <= box.vh - 10) break;

      if (box.top > box.vh - 10) {
        const distance = Math.min(box.top - box.vh * 0.3, randomInt(300, 600));
        const input = await scrollPage(page, distance, { signal: session.signal, check: () => session.check(page) });
        session.log('search_serp_scroll', { page: number, result: input.result, movedPixels: input.movedPixels, reason: 'seek_pagination' });
        if (input.result === 'blocked' || !input.movedPixels) {
          if (++blockedScrolls >= 2) break;
        } else blockedScrolls = 0;
        await session.pause(randomInt(800, 2000));
      } 
      else if (box.bottom < 10) {
        const distance = Math.max(box.bottom - box.vh * 0.7, -randomInt(300, 600));
        const input = await scrollPage(page, distance, { signal: session.signal, check: () => session.check(page) });
        session.log('search_serp_scroll', { page: number, result: input.result, movedPixels: input.movedPixels, reason: 'seek_pagination' });
        if (input.result === 'blocked' || !input.movedPixels) {
          if (++blockedScrolls >= 2) break;
        } else blockedScrolls = 0;
        await session.pause(randomInt(800, 2000));
      } else {
        break; 
      }
    }

    await session.pause(randomInt(800, 1500));

    if (!(await usesTouch(page))) {
       const center = await next.evaluate(el => {
         const r = el.getBoundingClientRect();
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       }).catch(() => null);
       
       if (center) {
         await page.mouse.move(center.x + randomInt(-20, 20), center.y + randomInt(-10, 10), { steps: randomInt(10, 20) });
         await session.pause(randomInt(200, 400));
       }
    }

    const before = page.url(); const content = await page.locator(RESULT_ITEMS).allTextContents();
    await session.check(page);
    await withSameTabLink(next, () => activateElement(next, { timeout: session.timeout, signal: session.signal }), session.timeout);
    await waitForSerpChange(page, before, content, session.timeout, () => session.check(page));
  }
}

async function scrollAndMove(page, session, slow = false, deadline = Infinity) {
  await session.check(page);
  if (Number.isFinite(deadline) && (session.now?.() ?? performance.now()) >= deadline) return;
  const pixels = randomInt(slow ? 80 : 200, slow ? 300 : 750) * (behaviorRandom() < 0.25 ? -1 : 1);
  const input = await scrollPage(page, pixels, { signal: session.signal, check: () => session.check(page) });
  if (!(await usesTouch(page))) {
    const viewport = page.viewportSize() ?? { width: 360, height: 640 };
    await page.mouse.move(randomInt(15, viewport.width - 15), randomInt(15, viewport.height - 15), { steps: randomInt(8, 20) });
  }
  session.log('visit_scroll', { domain: new URL(page.url()).hostname, inputMethod: input.method, gestures: input.gestures,result:input.result,movedPixels:input.movedPixels,scrollTarget:input.scrollTarget });
}

export async function visitCompetitors(page, results, target, config, session) {
  return withBehaviorRandom(session.random, () => visitCompetitorsSession(page, results, target, config, session));
}

async function visitCompetitorsSession(page, results, target, config, session) {
  const previews=previewPlan(results,config.targetDomain);
  const count=previews.length;
  if(!count)session.log('competitor_preview_skipped');
  for (const competitor of previews) {
    const current = (await parseResults(page, session.searchDomains)).find(result => result.destination === competitor.destination);
    if (!current) throw new SearchError('competitor_result_changed');
    const serpUrl = page.url();
    const child = await session.openResult(page, current);
    const now = () => session.now?.() ?? performance.now();
    const visitStarted = now(), dwellMs = randomInt(10_000, 20_000), visitEnd = visitStarted + dwellMs;
    session.log('competitor_visit_started', { domain: new URL(child.url()).hostname, popup: child !== page });
    const intervals = dwellMs > 15_000 ? 4 : randomInt(3, 4);
    const minimum = Math.max(2500, Math.floor(dwellMs / intervals * .85));
    const maximum = Math.min(5000, Math.ceil(dwellMs / intervals * 1.15));
    let plannedMs = 0;
    for (let interval = 0; interval < intervals; interval++) {
      session.signal?.throwIfAborted();
      const remainingIntervals = intervals - interval - 1, remainingMs = dwellMs - plannedMs;
      plannedMs += randomInt(Math.max(minimum, remainingMs - remainingIntervals * maximum), Math.min(maximum, remainingMs - remainingIntervals * minimum));
      const readingEnd = visitStarted + plannedMs;
      if (now() >= visitEnd) break;
      if (now() >= readingEnd) continue;
      await scrollAndMove(child, session, false, readingEnd);
      const pauseMs = Math.max(0, readingEnd - now());
      if (pauseMs > 0) await session.pause(pauseMs, child);
    }
    if (child !== page) { await child.close(); await page.bringToFront(); }
    else {
      for (let backStep = 0; backStep < 3; backStep++) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: session.timeout }).catch(() => {});
        if (session.searchDomains.some(d => domainMatches(new URL(page.url()).hostname, d))) break;
      }
      if (!session.searchDomains.some(d => domainMatches(new URL(page.url()).hostname, d))) throw new SearchError('serp_return_failed');
    }
    session.setOutbound(null);
    await session.document(page);
    await waitForSerpAttached(page, session.timeout);
    session.log('competitor_returned');
    await session.pause(randomInt(500, 1200));
  }
  return count;
}

async function followInternalLink(page, link, session, domain) {
  const navTimeout = Math.max(12_000, session.timeout ?? 20_000);
  const deadline = performance.now() + navTimeout;
  const remaining = () => Math.max(1, deadline - performance.now());
  const before = page.url(), snapshot = await actionSnapshot(page);
  const actionTimeout = Math.min(5_000, remaining());
  let requested = false; let committed = false; let failed = false;
  const active = async () => { session.signal?.throwIfAborted(); await (session.active ?? session.check)(page); };
  const isDocument = request => request.isNavigationRequest() && request.frame() === page.mainFrame();
  const onRequest = request => { if (isDocument(request)) requested = true; };
  const onFailure = request => { if (isDocument(request)) failed = true; };
  const onNavigation = frame => { if (frame === page.mainFrame()) committed = true; };
  const skip = code => { session.onInternalSkip?.(code); session.log('target_internal_link_skipped', { code }); return false; };

  const checkDomainAndRecover = async () => {
    if (!domainMatches(new URL(page.url()).hostname, domain)) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: session.timeout }).catch(() => {});
      if (!domainMatches(new URL(page.url()).hostname, domain)) throw new SearchError('target_domain_changed');
      return false;
    }
    return true;
  };

  page.on('request', onRequest); page.on('requestfailed', onFailure); page.on('framenavigated', onNavigation);
  try {
    session.log('target_internal_link_started');
    await session.check(page);
    const anchor = searchReference(page, link.token);
    try {
      const href = await anchor.evaluate(a => a.href, undefined, { timeout: Math.min(actionTimeout, remaining()) });
      if (href !== link.href) return skip('internal_link_changed');
      const visible = await anchor.evaluate(a => { const r = a.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }, undefined, { timeout: remaining() });
      if (!visible) return skip('internal_link_outside_viewport');
      await withSameTabLink(anchor, () => activateElement(anchor, { timeout: Math.min(actionTimeout, remaining()), signal: session.signal }), remaining());
      session.log('action_input_sent', { action: 'click_internal_link' });
    } catch (error) {
      await active();
      if (error.name !== 'TimeoutError') throw error;
      if (!requested && !committed && page.url() === before) return skip('target_internal_link_unavailable');
    }
    const outcome = requested || committed ? { result: 'navigation_started' } : await waitActionResult(page, snapshot, { timeout: Math.min(actionTimeout, remaining()), signal: session.signal, check: () => requested || committed ? active() : session.check(page) });
    if (outcome.result === 'content_changed' && !requested && !committed) {
      if (!(await checkDomainAndRecover())) return skip('target_internal_navigation_failed');
      await session.document(page); session.log('action_result_verified', { action: 'click_internal_link', result: 'content_changed' }); return true;
    }
    if (!requested && !committed && page.url() === before) return skip('target_internal_no_navigation');
    session.log('target_internal_navigation_started');
    const navWaitDeadline = performance.now() + Math.max(10_000, remaining());
    while (!committed && page.url() === before) {
      await active();
      if (failed) {
        if (!(await checkDomainAndRecover())) return skip('target_internal_navigation_failed');
        return skip('target_internal_navigation_failed');
      }
      if (performance.now() >= navWaitDeadline) return skip('target_internal_navigation_timeout');
      await sleep(Math.min(100, Math.max(1, navWaitDeadline - performance.now())), session.signal);
    }
    if (failed) {
      if (!(await checkDomainAndRecover())) return skip('target_internal_navigation_failed');
      return skip('target_internal_navigation_failed');
    }
    for (;;) {
      await active();
      if (failed) {
        if (!(await checkDomainAndRecover())) return skip('target_internal_navigation_failed');
        return skip('target_internal_navigation_failed');
      }
      if (performance.now() >= navWaitDeadline) break;
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: Math.min(500, Math.max(1, navWaitDeadline - performance.now())) });
        break;
      } catch (error) {
        await active();
        if (error.name !== 'TimeoutError') throw error;
      }
    }
    await session.document(page);
    if (!(await checkDomainAndRecover())) return skip('target_internal_navigation_failed');
    if (page.url().split('#')[0] === before.split('#')[0]) return skip('target_internal_no_navigation');
    session.log('action_result_verified', { action: 'click_internal_link', result: 'url_changed' });
    return true;
  } catch (error) {
    session.log('target_internal_link_failed', { errorType: error.name, ...(error instanceof SearchError ? { code: error.code } : {}) });
    throw error;
  } finally {
    page.off('request', onRequest); page.off('requestfailed', onFailure); page.off('framenavigated', onNavigation);
  }
}

export async function interactWithTargetSite(page, config, session, options = {}) {
 return withBehaviorRandom(options.random ?? session.random, () => interactWithTargetSiteSession(page, config, session, options));
}

async function interactWithTargetSiteSession(page, config, session, { durationMs = config.visitSettings?randomInt(config.visitSettings.minSeconds*1000,config.visitSettings.maxSeconds*1000):randomInt(60_000, 300_000) } = {}) {
 const end=session.now()+durationMs,wallEnd=performance.now()+durationMs;
 const left=()=>Math.max(0,Math.min(end-session.now(),wallEnd-performance.now()));
 const depth=config.visitSettings?.maxInternalTransitions??randomInt(1,2),sections=config.visitSettings?.allowedSections||[],initial=page.url().split('#')[0];
 const disableMetrics = Boolean(config.visitSettings?.disableMetrics || config.visitSettings?.trackMetrics === false);
 const attempted=new Set([canonicalVisitUrl(page.url())]);let linksFollowed=0,marker=randomUUID(),state=createPageBehavior(session.now(),durationMs,depth),lastReason='',lastObstruction='';
 
 const sectionGuard = async route => {
   const request = route.request();
   const reqUrl = request.url();
   if (disableMetrics && isMetricsRequest(reqUrl)) {
     await route.abort('blockedbyclient');
     return;
   }
   if (sections.length && request.isNavigationRequest() && request.frame() === page.mainFrame() && reqUrl.split('#')[0] !== initial && !visitPolicy.allowsSection(reqUrl, sections)) {
     await route.abort('blockedbyclient');
   } else {
     await route.fallback();
   }
 };

 const pause=async ms=>{
  const untilTransition=linksFollowed<depth&&session.now()<state.due?state.due-session.now():Infinity;
  if(left()>0)await session.pause(Math.min(ms,left(),untilTransition),page);
 };
 const pagePlan=view=>session.log('visit_page_plan',{pageType:view.type,pageNumber:linksFollowed+1,budgetMs:Math.round(Math.min(left(),state.due-session.now())),blocksCount:view.blocks.length});
 if(sections.length || disableMetrics) await page.context().route('**/*',sectionGuard);
 if(disableMetrics) await injectMetricsStub(page);
 try{
  session.log('target_visit_started',{durationMs,domain:config.targetDomain});let announced=false;
  while(left()>0){
   await session.document(page);
   if(!domainMatches(new URL(page.url()).hostname,config.targetDomain)){
       await page.goBack({ waitUntil: 'domcontentloaded', timeout: session.timeout }).catch(() => {});
       if(!domainMatches(new URL(page.url()).hostname,config.targetDomain)) throw new SearchError('target_domain_changed');
       session.log('visit_behavior_changed', { action: 'recover', reason: 'domain_escaped', pageType: 'generic' });
   }
   const inspect=()=>inspectSite(page,{marker,domain:config.targetDomain,visited:[...attempted],sections,intent:config.intent||''});
   const settled=await waitForSiteReady(inspect,state,{timeout:Math.min(2500,left()*.25),signal:session.signal,check:()=>session.check(page)});
   const view=settled.view;
   if(!announced){pagePlan(view);announced=true;}
   if(!settled.ready){
    if(lastReason!==settled.reason){session.log('visit_behavior_changed',{action:'wait',reason:settled.reason,pageType:view.type});lastReason=settled.reason;}
    await pause(Math.min(500,left()));continue;
   }
   if(view.obstruction!=='none'&&view.obstruction!==lastObstruction){session.log('visit_obstacle',{reason:view.obstruction});lastObstruction=view.obstruction;}
   if(view.obstruction==='none')lastObstruction='';
   const action=chooseSiteAction(view,state,{now:session.now(),remaining:left(),canNavigate:linksFollowed<depth && left()>=15_000});
   if(action.reason!==lastReason){session.log('visit_behavior_changed',{action:action.type,reason:action.reason,pageType:view.type});lastReason=action.reason;}
   if(action.type==='navigate'){
    attempted.add(action.link.canonical);
    const budget=Math.min(session.timeout,Math.max(15_000,left()));
    session.log('visit_link_selected',{reason:action.reason,linkKind:action.link.kind,zone:action.link.zone,score:action.link.score});
    let transient=false;
    const onInternalSkip=code=>{transient=['internal_link_changed','internal_link_outside_viewport','target_internal_link_unavailable'].includes(code);};
    if(await followInternalLink(page,action.link,{...session,timeout:budget,onInternalSkip},config.targetDomain)){
     attempted.add(canonicalVisitUrl(page.url()));linksFollowed++;session.log('target_internal_link',{linksFollowed});
     marker=randomUUID();state=createPageBehavior(session.now(),left(),depth-linksFollowed);announced=false;lastReason='';
    }else if(transient){
     const retries=state.linkRetries.get(action.link.canonical)||0;
     if(retries<2){state.linkRetries.set(action.link.canonical,retries+1);attempted.delete(action.link.canonical);}
    }
    continue;
   }
   if(action.type==='read'){
    state.seen.add(action.block.id);const available=linksFollowed<depth&&session.now()<state.due?state.due-session.now():left();
    const ms=Math.min(action.pauseMs,Math.max(1,available),left());session.log('visit_content_pause',{blockKind:action.block.kind,words:action.block.words,durationMs:Math.round(ms)});await pause(ms);continue;
   }
   if(action.type==='scroll'||action.type==='reveal'){
    if(action.type==='reveal')state.reveals.set(action.link.canonical,(state.reveals.get(action.link.canonical)||0)+1);
    const target=action.link?{token:action.link.token}:action.block?{token:action.block.id}:undefined;
    const pixels=Math.round(action.pixels);state.direction=pixels>=0?1:-1;
    if(left()<900){await pause(left());continue;}
    const mode=target?(Math.abs(pixels)<=100?'precise':'reading'):'auto';
    const result=await scrollPage(page,pixels,{signal:session.signal,check:()=>session.check(page),target,scope:'content',mode});
    session.log('visit_scroll',{inputMethod:result.method,gestures:result.gestures,result:result.result,movedPixels:result.movedPixels,scrollTarget:result.scrollTarget,gestureMode:result.gestureMode,reason:result.reason});
    if(action.type==='reveal'&&result.result==='scrolled')state.reveals.set(action.link.canonical,0);
    observeScroll(state,result,view,{...action,pixels:result.requestedPixels??pixels});await pause(Math.min(900,left()));continue;
   }
   await pause(action.pauseMs);
  }
  await session.document(page);session.log('target_visit_finished',{linksFollowed});return {durationMs,linksFollowed};
 }finally{if(sections.length || disableMetrics) await page.context().unroute('**/*',sectionGuard);}
}

export async function performSearchAndClick(page, task, options = {}) {
  return withBehaviorRandom(options.random, () => performSearchAndClickSession(page, task, options));
}

async function performSearchAndClickSession(page, task, {
  selectQuery = async queries => choose(queries),
  engines = SEARCH_ENGINES, navigationTimeoutMs = 30_000, signal, random,
  shouldContinue = async () => true, createCheckCaptcha = () => async () => false,
  waitFor = sleep, now = () => performance.now(), targetDurationMs,
  preSearchWarmup = false, preSearchSites = [], resolvePreSearchSites, allowPreSearchSite, preSearchTimeoutMs = 20_000,
  preparePage = async () => {}, captureFailure = async () => {}, log = () => {}, ownedOnly = false, beforeTargetVisit = async () => {}, onTargetVisit = async () => {},
} = {}) {
  let config;
  try { config = searchTasks.searchTaskConfig(task); } catch { throw new SearchError('invalid_search_task'); }
  if (!config || !engines[config.searchEngine]) throw new SearchError('invalid_search_task');
  const engine = engines[config.searchEngine]; const context = page.context();
  const allowedSearchHost = host => engine.domains.some(domain => domainMatches(host, domain));
  let outboundDomain; let approvedPost; let activePage = page;
  const navigationResponses = trackNavigationResponses(context); const prepared = new WeakMap(); const children = new Set();
  const prepare = child => {
    if (child === page) return Promise.resolve();
    if (!prepared.has(child)) prepared.set(child, preparePage(child));
    return prepared.get(child);
  };
  const disableTargetMetrics = Boolean(
    task.disableMetrics ||
    task.trackMetrics === false ||
    task.visitSettings?.disableMetrics ||
    task.visitSettings?.trackMetrics === false
  );
  const handler = async route => {
    const request = route.request();
    const reqUrl = request.url();
    let frame;
    try { frame = request.frame(); } catch { }
    if (disableTargetMetrics && outboundDomain && domainMatches(outboundDomain, config.targetDomain) && isMetricsRequest(reqUrl)) {
      await route.abort('blockedbyclient'); return;
    }
    if (request.isNavigationRequest() && (!frame || !frame.parentFrame())) {
      if (frame) await prepare(frame.page());
      const url = new URL(reqUrl); const search = allowedSearchHost(url.hostname);
      const outbound = outboundDomain && domainMatches(url.hostname, outboundDomain);
      const captchaPost = request.method() === 'POST' && reqUrl === approvedPost;
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
  const active = async () => {
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
  };
  const check = async (child = page) => {
    await active();
    if (child.isClosed()) throw new SearchError('search_page_closed');
    activePage = child;
    await dismissSearchOverlays(child, { allowedHost: allowedSearchHost, signal, shouldContinue, log: (event, data) => log(event, { taskId: task.id, ...data }), timeout: Math.min(5000, navigationTimeoutMs) });
    let handled = false;
    try {
      handled = await checkCaptcha(child, signal);
    } catch (captchaError) {
      const isSearchHost = (() => {
        try { return allowedSearchHost(new URL(child.url()).hostname); } catch { return false; }
      })();
      if (!isSearchHost && !(captchaError instanceof TaskStoppedError) && !signal?.aborted) {
        log('donor_or_external_captcha_ignored', { taskId: task.id, code: captchaError.code ?? captchaError.name });
        return false;
      }
      throw captchaError;
    }
    if (handled) await dismissSearchOverlays(child, { allowedHost: allowedSearchHost, signal, shouldContinue, log: (event, data) => log(event, { taskId: task.id, ...data }), timeout: Math.min(5000, navigationTimeoutMs) });
    signal?.throwIfAborted(); return handled;
  };
  const document = async child => {
    const handled = await check(child); const response = navigationResponses.current(child);
    if (handled && response) session.log(response.ok() ? 'captcha_document_verified' : 'captcha_document_failed', { status: response.status() });
    if (!handled && response && !response.ok()) {
      const status = response.status();
      const isSearchHost = (() => {
        try { return allowedSearchHost(new URL(child.url()).hostname); } catch { return false; }
      })();
      if (!isSearchHost) return;
      if (status === 429) {
        const hasSerp = await child.locator(RESULT_ITEMS).count().catch(() => 0);
        if (hasSerp > 0) return;
      }
      const error = new SearchError(status === 429 ? 'search_rate_limited' : 'search_http_error');
      error.httpStatus = status;
      error.retryDelayMs = status === 429 ? retryAfterMs(response.headers()['retry-after']) : 0;
      session.log('search_http_failed', { status, code: error.code, retryAfterMs: error.retryDelayMs });
      throw error;
    }
  };
  const popupListener = child => { children.add(child); };
  const abort = () => { for (const child of [page, ...children]) void child.close().catch(() => {}); };
  let failureStage = "search_home_opening", stageStarted = performance.now();
  const session = {
    active, check, document, timeout: navigationTimeoutMs, searchDomains: engine.domains, now, signal, random,
    ownedOnly, allowExternalOrigin: allowPreSearchSite,
    log: (event, data = {}) => { failureStage = event; stageStarted = performance.now(); log(event, { taskId: task.id, ...data }); },
    setOutbound: domain => { outboundDomain = domain; },
    pause: async (ms, child = page) => {
      for (let left = ms; left > 0;) { await check(child); const chunk = Math.min(500, left); await waitFor(chunk, signal); left -= chunk; }
    },
    openResult: async (parent, result, domain = result.domain.replace(/^www\./, '')) => {
      await check(parent); outboundDomain = domain;
      const anchor = searchReference(parent, result.token);
      if (await anchor.evaluate(a => a.href) !== result.href) throw new SearchError('result_changed');

      let blockedScrolls = 0;
      for (let scrollAttempts = 0; scrollAttempts < 15; scrollAttempts++) {
        const box = await anchor.evaluate(el => {
          const item = el.closest('.serp-item, .serp-list__item, .result__item, .SearchResult, [data-testid="search-result"]');
          const rect = (item || el).getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, vh: window.innerHeight };
        }).catch(() => null);

        if (!box) break;
        if (box.top >= 20 && box.bottom <= box.vh - 20) break;

        if (box.top > box.vh - 20) {
          const distance = Math.min(box.top - box.vh * 0.3, randomInt(300, 600));
          const input = await scrollPage(parent, distance, { signal, check: () => check(parent) });
          session.log('search_serp_scroll', { result: input.result, movedPixels: input.movedPixels, reason: 'seek_snippet' });
          if (input.result === 'blocked' || !input.movedPixels) {
            if (++blockedScrolls >= 2) break;
          } else blockedScrolls = 0;
          await session.pause(randomInt(800, 2000));
        } else if (box.top < 20) {
          const distance = Math.max(box.top - box.vh * 0.1, -randomInt(300, 600));
          const input = await scrollPage(parent, distance, { signal, check: () => check(parent) });
          session.log('search_serp_scroll', { result: input.result, movedPixels: input.movedPixels, reason: 'seek_snippet' });
          if (input.result === 'blocked' || !input.movedPixels) {
            if (++blockedScrolls >= 2) break;
          } else blockedScrolls = 0;
          await session.pause(randomInt(800, 2000));
        } else break;
      }
      await session.pause(randomInt(600, 1500));
      
      if (!(await usesTouch(parent))) {
        const center = await anchor.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }).catch(() => null);
        if (center) {
          await parent.mouse.move(center.x + randomInt(-20, 20), center.y + randomInt(-10, 10), { steps: randomInt(10, 20) });
          await session.pause(randomInt(200, 400));
        }
      }

      const popup = parent.waitForEvent('popup', { timeout: navigationTimeoutMs });
      const samePage = parent.waitForURL(url => domainMatches(url.hostname, domain) && !allowedSearchHost(url.hostname),
        { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }).then(() => parent);
      const destination = Promise.any([popup, samePage]);
      void destination.catch(() => {});
      
      await withSameTabLink(anchor, () => activateElement(anchor, { timeout: navigationTimeoutMs, signal }), navigationTimeoutMs);
      
      session.log('action_input_sent',{action:'click_search_result'});
      const child = await destination; await prepare(child);
      await child.waitForURL(url => domainMatches(url.hostname, domain) && !allowedSearchHost(url.hostname), { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      await document(child);
      if (!domainMatches(new URL(child.url()).hostname, domain)) throw new SearchError('unexpected_result_domain');
      session.log('action_result_verified',{action:'click_search_result',result:'url_changed'});
      return child;
    },
  };
  page.on('popup', popupListener);
  signal?.addEventListener('abort', abort, { once: true });
  const submit = async (query, suffix, retry = false) => {
    const { input, expected } = await prepareSearchQuery(page, query, suffix, {
      allowedHost: allowedSearchHost, home: engine.home, timeout: navigationTimeoutMs,
      check: () => check(page), document, log: session.log, append: !retry, signal,
    });
    const before = page.url(); const content = await page.locator(RESULT_ITEMS).allTextContents();
    const inputElement = await input.elementHandle({ timeout: navigationTimeoutMs });
    let method, formElement;
    try {
      if (!inputElement) throw new SearchError('search_query_mismatch');
      formElement = await inputElement.evaluateHandle(el => el.form ?? el.closest('form'));
      await check(page);
      method = await submitSearch(input, navigationTimeoutMs, method => session.log('search_submit_started', { method }), { expected, inputElement, formElement, log: session.log });
    }
    catch (error) { if (error.name !== 'TimeoutError') throw error; throw new SearchError('search_submit_timeout'); }
    finally { await formElement?.dispose(); await inputElement?.dispose(); }
    session.log('search_submit_completed', { method });
    try {
      await waitForSerpChange(page, before, content, navigationTimeoutMs, () => check(page));
    } catch (error) {
      if (error.code !== 'search_results_timeout' || retry) throw error;
      await check(page);
      session.log('search_refinement_retry', { code: error.code, characters: [...expected].length });
      try {
        await openSearchHome(page, engine.home, { allowedHost: allowedSearchHost, timeout: navigationTimeoutMs, signal, shouldContinue, log: session.log });
      } catch (navigationError) {
        if (navigationError.name !== 'TimeoutError') throw navigationError;
        throw new SearchError('search_home_timeout');
      }
      await document(page);
      return submit(query, suffix, true);
    }
    await document(page);
    if (!isActiveSerpUrl(page.url(), engine.domains) && !retry) {
      session.log('search_query_retry', { characters: [...expected].length, reason: 'returned_to_home' });
      return submit(query, suffix, true);
    }
    session.log('search_results_ready');
    const url = new URL(page.url());
    const submitted = ['text', 'q', 'query'].map(key => url.searchParams.get(key)).find(value => value !== null);
    if (submitted !== undefined && submitted.normalize('NFC').replace(/\s+/g, ' ').trim() !== expected.normalize('NFC').replace(/\s+/g, ' ').trim()) {
      if (retry) throw new SearchError('search_query_mismatch');
      session.log('search_query_retry', { characters: [...expected].length });
      return submit(query, suffix, true);
    }
  };
  try {
    await active();
    if (preSearchWarmup) {
      try {
        await visitPreSearchDonor(page, {
          sites: preSearchSites, resolveSites: resolvePreSearchSites, allowSite: allowPreSearchSite,
          navigationTimeoutMs: Math.min(10_000, navigationTimeoutMs), timeoutMs: preSearchTimeoutMs,
          signal, active, waitFor, log: session.log,
        });
      } catch (donorError) {
        if (signal?.aborted || donorError instanceof TaskStoppedError) throw donorError;
        session.log('search_pre_warmup_error_ignored', { errorType: donorError.name, code: donorError.code ?? 'donor_error' });
      }
    }
    await context.route('**/*', handler);
    await active();
    session.log('search_started', { engine: config.searchEngine, targetDomain: config.targetDomain });
    session.log('search_home_opening', { engine: config.searchEngine });
    const homeStarted = performance.now();
    let response;
    try { response = await openSearchHome(page, engine.home, { allowedHost: allowedSearchHost, timeout: navigationTimeoutMs, signal, shouldContinue, log: session.log }); }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      session.log('search_home_failed', { code: 'search_home_timeout' });
      throw new SearchError('search_home_timeout');
    }
    await document(page);
    session.log('search_home_ready', { elapsedMs: Math.round(performance.now() - homeStarted) });
    const query = await selectQuery(config.searchQueries), pauseMs = randomInt(1800, 3800);
    session.log('search_pre_input_pause', { durationMs: pauseMs });
    await session.pause(pauseMs);
    await submit(query);
    let actualQuery = query;
    let found = await findInSerpOrPaginate(page, config, session); let totalPages = found.pagesVisited; let refined = false;
    if (!found.target && config.vitalPhrases.length) {
      await session.pause(randomInt(2000, 4200));
      const suffix = choose(config.vitalPhrases); session.log('search_vital_refinement', { characters: [...suffix].length });
      await submit(query, suffix); actualQuery = `${query} ${suffix}`; refined = true;
      found = await findInSerpOrPaginate(page, config, session); totalPages += found.pagesVisited;
    }
    if (!found.target) { session.log('search_target_not_found', { pagesVisited: totalPages, refined }); return { found: false, pagesVisited: totalPages, refined }; }
    const competitorVisits = ownedOnly ? 0 : await visitCompetitors(page, found.results, found.target, config, session);
    const target = (await parseResults(page, engine.domains)).find(result => domainMatches(result.domain, config.targetDomain));
    if (!target) throw new SearchError('target_result_changed');
    await beforeTargetVisit();
    if (disableTargetMetrics) {
      await injectMetricsStub(page);
      session.log('target_metrics_disabled', { domain: config.targetDomain });
    }
    const targetPage = await session.openResult(page, target, config.targetDomain);
    await onTargetVisit({ query, actualQuery, visitedAt: new Date() });
    session.log('search_target_clicked', { domain: new URL(targetPage.url()).hostname, page: found.pagesVisited });
    config.visitSettings=visitPolicy.visitSettings(task.visitSettings||{});
    config.intent=query;
    const visit = await interactWithTargetSite(targetPage, config, session, { durationMs: targetDurationMs });
    const finalHost = new URL(targetPage.url()).hostname;
    return {
      found: true,
      visited: true,
      target: config.targetDomain,
      pagesVisited: totalPages,
      refined,
      competitorVisits,
      domain: domainMatches(finalHost, config.targetDomain) ? config.targetDomain : finalHost,
      ...visit,
    };
  } catch (error) {
    if (!signal?.aborted && !(error instanceof TaskStoppedError)) {
      try { await captureFailure(activePage, { stage: failureStage, elapsedMs: Math.round(performance.now() - stageStarted), status: navigationResponses.current(activePage)?.status() ?? null }); } catch { }
    }
    session.log('search_failure_location', {
      errorType: error.name,
      locations: [...new Set(String(error.stack ?? '').match(/\/worker\/[a-zA-Z0-9_-]+\.mjs:\d+:\d+/g) ?? [])].slice(0, 8),
    });
    throw error;
  } finally {
    for (const child of children) await child.close().catch(() => {});
    await context.unroute('**/*', handler).catch(() => {});
    navigationResponses.dispose(); page.off('popup', popupListener); signal?.removeEventListener('abort', abort);
  }
}