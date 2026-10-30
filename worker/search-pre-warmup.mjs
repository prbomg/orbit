import { performance } from 'node:perf_hooks';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { selectDonorSites } from './warmup.mjs';
import { restrictNavigation } from './action-executor.mjs';
import { scrollPage } from './mobile-input.mjs';

export async function preSearchWarmup(page, {
  sites = [], resolveSites = async () => sites, allowSite = () => () => {},
  navigationTimeoutMs = 10_000, timeoutMs = 20_000, signal,
  active = async () => {}, waitFor = sleep, log = () => {},
} = {}) {
  const controller = new AbortController();
  const hopSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const actualTimeoutMs = Math.max(timeoutMs, 75_000);
  const timer = setTimeout(() => controller.abort(), actualTimeoutMs);
  const started = performance.now();
  const existingPages = new Set(page.context().pages());
  let policy, revoke, donorDomain, visited = false, success = false;
  
  const check = async () => { hopSignal.throwIfAborted(); await active(); hopSignal.throwIfAborted(); };
  const pause = async ms => {
    for (let left = ms; left > 0; left -= 500) { await check(); await waitFor(Math.min(500, left), hopSignal); }
    await check();
  };
  
  try {
    await check();
    const pool = await resolveSites();
    await check();
    if (!pool.length) { log('search_pre_warmup_skipped', { code: 'donor_pool_empty' }); return; }
    
    const candidates = selectDonorSites(pool, Math.min(3, pool.length));
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!candidates.length) break;
      const targetUrl = candidates.shift();
      const url = new URL(targetUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      
      donorDomain = url.hostname;
      const altHost = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;
      const altOrigin = `${url.protocol}//${altHost}${url.port ? `:${url.port}` : ''}`;
      
      policy = await restrictNavigation(page.context(), url.origin, { approvedRedirects: [altOrigin] });
      const revokeMain = allowSite(url.origin);
      const revokeAlt = allowSite(altOrigin);
      revoke = () => { try { revokeMain?.(); } finally { revokeAlt?.(); } };
      
      await check();
      visited = true;
      
      try {
        log('search_pre_warmup_started', { attempt, donorDomain, url: url.href });
        
        const navTimeout = Math.max(navigationTimeoutMs, 30_000);
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        await check();
        
        if (!response?.ok()) {
          log('search_pre_warmup_failed', { attempt, donorDomain, url: url.href, code: 'donor_http_error', status: response?.status() });
          throw new Error('donor_http_error');
        }
        
        log('search_pre_warmup_loaded', { attempt, donorDomain, url: url.href, status: response.status() });
        
        const retentionMs = randomInt(15_000, 30_000);
        const retentionEnd = performance.now() + retentionMs;
        const count = randomInt(2, 4);
        
        for (let index = 0; index < count; index++) {
          await scrollPage(page, randomInt(220, 580), { signal: hopSignal, check });
          const timeLeft = retentionEnd - performance.now();
          if (index + 1 < count && timeLeft > 0) {
            await pause(Math.min(randomInt(3000, 8000), timeLeft));
          }
        }
        
        const finalTimeLeft = retentionEnd - performance.now();
        if (finalTimeLeft > 0) await pause(finalTimeLeft);
        
        let screenshot = undefined;
        try {
          const buffer = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css', timeout: 5000 });
          screenshot = buffer.toString('base64');
        } catch (e) {}
        
        log('search_pre_warmup_completed', { 
          attempt, donorDomain, url: url.href, scrolls: count, elapsedMs: Math.round(performance.now() - started), screenshot 
        });
        success = true;
        break;
        
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TaskStoppedError || (error.name === 'AbortError' && !controller.signal.aborted)) throw error;
        await active();
        const reason = controller.signal.aborted || error.name === 'TimeoutError' ? 'donor_timeout' : (error.message === 'donor_http_error' ? 'donor_http_error' : 'donor_unavailable');
        log('search_pre_warmup_failed', { attempt, donorDomain, url: url.href, code: reason });
        try { revoke?.(); } finally { await policy?.dispose(); policy = null; revoke = null; }
      }
    }
    
    if (!success) log('search_pre_warmup_skipped', { code: 'all_attempts_failed' });
    
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TaskStoppedError || (error.name === 'AbortError' && !controller.signal.aborted)) throw error;
    await active();
    log('search_pre_warmup_skipped', { donorDomain, code: 'unexpected_error' });
  } finally {
    clearTimeout(timer);
    try {
      await Promise.all(page.context().pages().filter(child => child !== page && !existingPages.has(child)).map(child => child.close().catch(() => {})));
      if (!success && visited && !page.isClosed()) await page.goto('about:blank', { timeout: 3000 }).catch(() => {});
    }
    finally { try { revoke?.(); } finally { await policy?.dispose(); } }
  }
}