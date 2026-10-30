import { readingPause, inspectReadingBlock } from './reading-semantics.mjs';
import { behaviorRandom, withBehaviorRandom } from './behavior-random.mjs';
import { assessVisit, inspectContent } from './warmup-quality.mjs';
import donors from '../utils/donorSites.js';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { clickRandomLink, restrictNavigation } from './action-executor.mjs';
import { CaptchaError } from './captcha-provider.mjs';
import { scrollPage } from './mobile-input.mjs';
import { performance } from 'node:perf_hooks';
import { trackNavigationResponses } from './navigation-response.mjs';
import { withDeadline, warmupLimits, WarmupTimeoutError, warmupSessionBudget } from './warmup-timing.mjs';
export class WarmupSiteError extends Error {
  constructor(code) { super('Warmup sites could not be visited'); this.name = 'WarmupSiteError'; this.code = code; }
}

export function selectDonorSites(sites = donors.donorSites, count = 3) {
  const groups = new Map();
  for (const site of new Set(sites)) {
    const host = new URL(site).host.replace(/^www\./, '');
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(site);
  }
  const pool = [...groups.values()];
  if (pool.length < count) throw new WarmupSiteError('warmup_sites_unavailable');
  // Fisher–Yates sampling without replacement.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i); [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).map(group => group[randomInt(0, group.length - 1)]);
}

export function selectAvailableDonorSites(sites, count, history = [], now = Date.now()) {
  const latest = new Map();
  for (const entry of history) {
    const host = entry.details?.domain?.replace(/^www\./, '');
    const time = new Date(entry.createdAt).getTime();
    if (!host || !Number.isFinite(time) || time < now - 24 * 60 * 60_000 || time > now || !['warmup_site_completed', 'warmup_site_skipped'].includes(entry.event)) continue;
    if (!latest.has(host) || latest.get(host).time < time) latest.set(host, { time, event: entry.event });
  }
  const hostCount = new Set(sites.map(site => new URL(site).host.replace(/^www\./, ''))).size;
  const shuffled = selectDonorSites(sites, hostCount);
  const healthy = [], unknown = [], deferred = [];
  for (const site of shuffled) {
    const state = latest.get(new URL(site).host.replace(/^www\./, ''));
    if (state?.event === 'warmup_site_completed') healthy.push(site);
    else if (state && now - state.time < 15 * 60_000) deferred.push(site);
    else unknown.push(site);
  }
  // Keep discovering available sites without repeatedly starting on donors that
  // just failed on this proxy. Never add URLs outside the user's configured pool.
  return [...healthy.slice(0, 2), ...unknown.slice(0, 1), ...healthy.slice(2), ...unknown.slice(1), ...deferred].slice(0, count);
}

export async function performWarmup(page, options = {}) {
  return withBehaviorRandom(options.random, () => performWarmupSession(page, options));
}

async function performWarmupSession(page, {
  sites = donors.resolveDonorSites(), requiredSites = 3, requirements = 'interaction', navigationTimeoutMs = 30_000, signal,
  shouldContinue = async () => true, createCheckCaptcha = () => async () => false,
  log = () => {}, taskId, intent = '',
  // Dependency injection keeps tests local and fast; production uses real delays.
  waitFor = sleep,
  siteHistory = [], preferredDomains = [], sessionMinutes = 0,
  sessionTimeoutMs,
  operationTimeoutMs = warmupLimits.operationMs, siteTimeoutMs = warmupLimits.siteMs, cleanupTimeoutMs = warmupLimits.cleanupMs,
  reserveSite = async () => true, finishSite = async () => {}, releaseSite = async () => {},
  chooseSites = (pool, count) => selectAvailableDonorSites(pool, count, siteHistory),
} = {}) {
  if (!Number.isInteger(requiredSites) || requiredSites < 1 || requiredSites > 12 || !['content','interaction','return','navigation'].includes(requirements)) throw new Error('invalid_warmup_plan');
  const controller = new AbortController();
  signal = AbortSignal.any([...(signal ? [signal] : []), controller.signal]);
  const started = performance.now(), targetEnd = sessionMinutes > 0 ? started + sessionMinutes * 60_000 : Infinity;
  // Keep a hard limit while allowing failed donors to be replaced after planned reading.
  const sessionEnd = started + warmupSessionBudget({ sessionMinutes, requiredSites, navigationTimeoutMs, timeoutMs: sessionTimeoutMs });
  let siteEnd = sessionEnd, operation = 'prepare', operationStarted = started, failureOperation = null, domain;
  const responses = trackNavigationResponses(page.context());
  const responseDetails = () => responses.describe(page);
  const stop = error => { controller.abort(error); void page.close().catch(() => {}); };
  const run = async (name, action, { timeoutMs = operationTimeoutMs, record = true } = {}) => {
    signal.throwIfAborted();
    const previous = operation, previousStarted = operationStarted;
    operation = name; operationStarted = performance.now();
    const began = operationStarted, navigationBefore = responseDetails().navigationId;
    if (record) log('warmup_operation_started', { taskId, domain, operation: name, ...responseDetails() });
    const available = Math.min(timeoutMs, siteEnd - began, sessionEnd - began);
    const code = sessionEnd - began <= Math.min(timeoutMs, siteEnd - began) ? 'warmup_session_timeout' : siteEnd - began <= timeoutMs ? 'warmup_site_timeout' : 'warmup_operation_timeout';
    try {
      const value = await withDeadline(action, { timeoutMs: available, signal, code, onTimeout: stop });
      if (record) log('warmup_operation_completed', { taskId, domain, operation: name, durationMs: Math.round(performance.now() - began), ...responseDetails() });
      return value;
    } catch (error) {
      // A redirect/reload can invalidate DOM/CDP handles during an input or read.
      // Only classify it as a donor failure when a new main-frame request proves it.
      if (!signal.aborted && !page.isClosed() && !(error instanceof WarmupTimeoutError) && ['scroll', 'content_check', 'navigation_guard'].includes(name) && responseDetails().navigationId !== navigationBefore) error = new WarmupSiteError('site_navigation');
      failureOperation ||= name;
      if (!signal.aborted || error instanceof WarmupTimeoutError) log('warmup_operation_failed', { taskId, domain, operation: name, durationMs: Math.round(performance.now() - began), reason: error.code || (error.name === 'TimeoutError' ? 'navigation_timeout' : 'operation_failed'), errorType: /^[a-zA-Z]{1,40}$/.test(error.name)?error.name:'Error', source: /[/\\]worker[/\\]([a-z-]+)\.mjs/.exec(error.stack||'')?.[1], documentMissing: /Cannot read properties of null/.test(error.message||''), ...responseDetails() });
      throw error;
    } finally { operation = previous; operationStarted = previousStarted; }
  };
  const hosts = new Set(sites.map(site => new URL(site).host.replace(/^www\./, '')));
  if (hosts.size < requiredSites) { responses.dispose(); throw new WarmupSiteError('warmup_sites_unavailable'); }
  const candidates = chooseSites(sites, hosts.size);
  const returns = candidates.filter(url => preferredDomains.includes(new URL(url).hostname)).slice(0, 2);
  // Return only to configured, currently healthy origins; failed sites keep their cooldown.
  const recentFailed = new Set(siteHistory.filter(e => e.event === 'warmup_site_skipped' && Date.now() - new Date(e.createdAt).getTime() < 15 * 60_000).map(e => e.details?.domain));
  const preferred = returns.filter(url => !recentFailed.has(new URL(url).hostname));
  const selected = requirements === 'return' ? preferred : [...preferred, ...candidates.filter(url => !preferred.includes(url))];
  let completedSites = 0, attemptedSites = 0;
  let policy;
  const checkCaptcha = createCheckCaptcha({
    allowCaptchaPost: url => policy.allowCaptchaPost(url),
    clearCaptchaPost: () => policy?.clearCaptchaPost(),
  });
  const closeOnAbort = () => { void page.close().catch(() => {}); };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  const check = async () => {
    signal?.throwIfAborted();
    if (!(await run('active_check', shouldContinue, { record: false }))) throw new TaskStoppedError();
    if (page.isClosed()) throw new Error('Warmup page closed');
    const handled = await run('page_check', () => checkCaptcha(page, signal), { timeoutMs: siteTimeoutMs, record: false });
    signal?.throwIfAborted();
    return handled;
  };
  const wait = async (milliseconds, phase) => {
    const began = performance.now();
    let remaining = Math.min(milliseconds, Math.max(0, Math.min(siteEnd, sessionEnd) - began - 1000));
    const plannedMs = Math.round(remaining);
    while (remaining > 0) {
      const sliceStarted = performance.now();
      await check();
      remaining = Math.max(0, remaining - (performance.now() - sliceStarted));
      if (!remaining) break;
      const slice = Math.min(500, remaining);
      const sleepStarted = performance.now();
      await waitFor(slice, signal);
      remaining -= Math.max(slice, performance.now() - sleepStarted);
    }
    await check();
    log('warmup_wait', { taskId, domain, phase, plannedMs, durationMs: Math.round(performance.now() - began) });
  };
  const resetNavigation = async () => {
    // A failed HTTPS navigation can still commit Chrome's error page after goto
    // rejects. Settle that navigation before trying the next donor site.
    await run('navigation_cleanup', async () => { await policy?.dispose(); policy = undefined; });
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      if (page.isClosed() || !(await shouldContinue())) throw new TaskStoppedError();
      try {
        await run('navigation_reset', () => page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: Math.min(navigationTimeoutMs, 3000) }));
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (page.isClosed() || !(await shouldContinue())) throw new TaskStoppedError();
        if (!/interrupted by another navigation/.test(error?.message ?? '') && error?.name !== 'TimeoutError') throw error;
        if (attempt === 2) throw new WarmupSiteError('warmup_sites_unavailable');
        await waitFor(100, signal);
      }
    }
  };
  try {
    log('warmup_started', { taskId, sitesCount: requiredSites });
    for (const url of selected) {
      if (completedSites >= requiredSites || attemptedSites >= 12) break;
      const index = completedSites; const siteStartedAt = performance.now();
      domain = new URL(url).hostname; failureOperation = null;
      siteEnd = Math.min(sessionEnd, siteStartedAt + siteTimeoutMs);
      const pacingEnd = Number.isFinite(targetEnd) ? siteStartedAt + Math.max(0, targetEnd - siteStartedAt) / (requiredSites - completedSites) : siteStartedAt;
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      // Remove only our navigation guard; retain the fingerprint header route.
      await run('navigation_cleanup', async () => { await policy?.dispose(); policy = undefined; }, { record: false });
      const reservation = await run('site_reservation', () => reserveSite(url), { record: false });
      if (!reservation) { log('warmup_site_deferred', { taskId, domain: new URL(url).hostname, reason: 'site_cooldown_or_busy' }); continue; }
      attemptedSites++;
      let result;
      log('warmup_site_started', { taskId, step: index + 1, total: requiredSites, domain: new URL(url).hostname });
      try {
        await run('navigation', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }));
        const origin = new URL(page.url()).origin;
        policy = await run('navigation_guard', () => restrictNavigation(page.context(), origin), { record: false });
        const handled = await check();
        let response = responses.current(page);
        if (response?.status() === 429 || response && !response.ok() && !handled) { failureOperation = 'navigation'; throw new WarmupSiteError('warmup_site_http'); }
        const initialPause = readingPause(await run('content_check',()=>inspectReadingBlock(page)),behaviorRandom);
        await wait(initialPause, 'initial');
        const initialContent = await run('content_check', () => inspectContent(page));
        if (!initialContent.content) throw new WarmupSiteError('content_unavailable');
        let movedPixels = 0;
        const interactionRequired = ['interaction','navigation'].includes(requirements);
        const downwardScrolls = interactionRequired ? randomInt(2, 4) : 0;
        // Re-reading is an optional final adjustment after 2–4 downward moves.
        const reread = interactionRequired && behaviorRandom() < .25;
        const scrolls = downwardScrolls + Number(reread);
        for (let scroll = 0; scroll < scrolls; scroll++) {
          await check();
          const direction = scroll === 0 || scroll < downwardScrolls ? 1 : -1;
          const pixels = direction === 1 ? randomInt(220, 680) : -randomInt(120, 280);
          const input = await run('scroll', () => scrollPage(page, pixels, { signal, check }));
          movedPixels += Math.abs(input.movedPixels || 0);
          log('warmup_scroll', { taskId, domain, step: index + 1, scroll: scroll + 1, pixels, inputMethod: input.method, gestures: input.gestures, movedPixels: input.movedPixels, result: input.result, scrollTarget: input.scrollTarget, reason: input.reason, ...responseDetails() });
          await wait(Math.max(1800,Math.min(4200,readingPause(await run('content_check',()=>inspectReadingBlock(page)),behaviorRandom))), 'after_scroll');
        }
        const clicked = interactionRequired ? await run('internal_link', () => clickRandomLink(page, { origin, timeout: Math.min(navigationTimeoutMs, 10_000), requireInViewport: false, signal, intent })) : false;
        const captchaHandled = await check();
        response = responses.current(page);
        if (clicked && (response?.status() === 429 || response && !response.ok() && !captchaHandled)) { failureOperation = 'internal_link'; throw new WarmupSiteError('warmup_site_http'); }
        if (interactionRequired) log(clicked ? 'warmup_link_clicked' : 'warmup_link_skipped', { taskId, domain, step: index + 1, result: clicked || 'no_change', ...responseDetails(), ...(clicked ? {} : { reason: 'no_confirmed_transition' }) });
        const nextPause = readingPause(await run('content_check',()=>inspectReadingBlock(page)),behaviorRandom);
        await wait(nextPause, interactionRequired ? 'after_link' : 'reading');
        if (sessionMinutes > 0) await wait(Math.max(0, pacingEnd - performance.now()), 'reading');
        const finalContent = await run('content_check', () => inspectContent(page));
        const quality = assessVisit({ requirements, content: initialContent.content && finalContent.content, shortPage: initialContent.shortPage, movedPixels, linkResult: clicked, returned: preferredDomains.includes(new URL(url).hostname) && new URL(page.url()).hostname.replace(/^www\./, '') === new URL(url).hostname.replace(/^www\./, '') });
        log('warmup_visit_quality', { taskId, domain, ...quality, ...responseDetails() });
        if (quality.quality !== 'passed') {
          result = { success: false, reason: quality.reason, status: responses.current(page)?.status() ?? null, durationMs: Math.round(performance.now() - siteStartedAt) };
          const health = await run('site_save', () => finishSite(reservation, result), { record: false });
          log('warmup_site_partial', { taskId, domain, ...quality, durationMs: result.durationMs, ...responseDetails(), ...(health?.cooldownUntil ? { retryAfter: health.cooldownUntil } : {}) });
          continue;
        }
        result = { success: true, status: responses.current(page)?.status() ?? null, durationMs: Math.round(performance.now() - siteStartedAt) };
        await run('site_save', () => finishSite(reservation, result), { record: false });
        completedSites++;
        log('warmup_site_completed', { ...quality, durationMs: Math.round(performance.now() - siteStartedAt), taskId, step: index + 1, total: requiredSites, domain, ...responseDetails() });
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TaskStoppedError || page.isClosed() || !(await shouldContinue())) throw new TaskStoppedError();
        const message = error?.message ?? '';
        if (/net::ERR_(PROXY_CONNECTION_FAILED|PROXY_AUTH_UNSUPPORTED|INVALID_AUTH_CREDENTIALS)/.test(message)) throw new WarmupSiteError('proxy_check_failed');
        const reason = error.code === 'site_navigation' ? 'site_navigation' : error instanceof WarmupSiteError ? error.code : error.name === 'TimeoutError' ? 'navigation_timeout' : error instanceof CaptchaError ? error.code : /net::ERR_/.test(message) ? 'site_network' : /interrupted by another navigation|Execution context was destroyed, most likely because of a navigation/.test(message) ? 'site_navigation' : null;
        if (!reason) throw error;
        const details = responseDetails(), response = responses.navigation(page);
        const status = details.status ?? null;
        result = { success: false, reason: status === 429 ? 'site_rate_limited' : reason, status, retryAfter: response?.headers()?.['retry-after'] ?? null, durationMs: Math.round(performance.now() - siteStartedAt) };
        const health = await run('site_save', () => finishSite(reservation, result), { record: false });
        log('warmup_site_skipped', { taskId, domain, operation: failureOperation || operation, reason: result.reason, ...details, completedSites, durationMs: result.durationMs, ...(health?.cooldownUntil ? { retryAfter: health.cooldownUntil } : {}) });
        siteEnd = sessionEnd;
        await resetNavigation();
      } finally { await withDeadline(() => releaseSite(reservation), { timeoutMs: cleanupTimeoutMs, code: 'warmup_cleanup_timeout' }); }
    }
    if (completedSites < requiredSites) throw new WarmupSiteError('warmup_sites_unavailable');
    await check();
    log('warmup_completed', { taskId, sitesCount: completedSites });
  } finally {
    await withDeadline(async () => { await policy?.dispose(); }, { timeoutMs: cleanupTimeoutMs, code: 'warmup_cleanup_timeout' }).catch(() => {});
    responses.dispose();
    signal?.removeEventListener('abort', closeOnAbort);
    log('warmup_duration', { taskId, durationMs: Math.round(performance.now() - started), plannedMs: Math.round(sessionMinutes * 60_000), budgetMs: Math.round(sessionEnd - started) });
  }
}
