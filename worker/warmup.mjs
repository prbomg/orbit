import donors from '../utils/donorSites.js';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { clickRandomLink, restrictNavigation } from './action-executor.mjs';

export function selectDonorSites(sites = donors.donorSites, count = 3) {
  const pool = [...new Set(sites)];
  if (pool.length < count) throw new Error('Warmup needs at least three different donor sites');
  // Fisher–Yates sampling without replacement.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i); [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export async function performWarmup(page, {
  sites = donors.donorSites, navigationTimeoutMs = 30_000, signal,
  shouldContinue = async () => true, createCheckCaptcha = () => async () => false,
  log = () => {}, taskId,
  // Dependency injection keeps tests local and fast; production uses real delays.
  waitFor = sleep,
} = {}) {
  const selected = selectDonorSites(sites);
  let policy; let latestResponse;
  const checkCaptcha = createCheckCaptcha({
    allowCaptchaPost: url => policy.allowCaptchaPost(url),
    clearCaptchaPost: () => policy?.clearCaptchaPost(),
  });
  const responseListener = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) latestResponse = response;
  };
  const closeOnAbort = () => { void page.close().catch(() => {}); };
  page.on('response', responseListener);
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  const check = async () => {
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    if (page.isClosed()) throw new Error('Warmup page closed');
    const handled = await checkCaptcha(page, signal);
    signal?.throwIfAborted();
    return handled;
  };
  const wait = async milliseconds => {
    let remaining = milliseconds;
    while (remaining > 0) {
      await check();
      const slice = Math.min(500, remaining);
      await waitFor(slice, signal); remaining -= slice;
    }
    await check();
  };
  try {
    log('warmup_started', { taskId, sitesCount: selected.length });
    for (const [index, url] of selected.entries()) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      // Remove only our navigation guard; retain the fingerprint header route.
      await policy?.dispose(); policy = undefined;
      log('warmup_site_started', { taskId, step: index + 1, total: selected.length, domain: new URL(url).hostname });
      latestResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      const origin = new URL(page.url()).origin;
      policy = await restrictNavigation(page.context(), origin);
      const handled = await check();
      if (!latestResponse?.ok() && !handled) throw new Error('Donor returned a non-success response');
      const initialPause = randomInt(3000, 7000);
      log('warmup_wait', { taskId, step: index + 1, phase: 'initial', durationMs: initialPause });
      await wait(initialPause);
      const scrolls = randomInt(2, 3); const direction = randomInt(0, 1) ? 1 : -1;
      for (let scroll = 0; scroll < scrolls; scroll++) {
        await check();
        const pixels = randomInt(200, 900) * direction * (scroll % 2 ? -1 : 1);
        await page.mouse.wheel(0, pixels);
        log('warmup_scroll', { taskId, step: index + 1, scroll: scroll + 1, pixels });
        await wait(randomInt(200, 700));
      }
      const clicked = await clickRandomLink(page, { origin, timeout: navigationTimeoutMs, requireInViewport: false });
      const captchaHandled = await check();
      if (clicked && !latestResponse?.ok() && !captchaHandled) throw new Error('Donor link returned a non-success response');
      log(clicked ? 'warmup_link_clicked' : 'warmup_link_skipped', { taskId, step: index + 1, ...(clicked ? {} : { reason: 'no_eligible_link' }) });
      const nextPause = randomInt(5000, 10_000);
      log('warmup_wait', { taskId, step: index + 1, phase: 'after_link', durationMs: nextPause });
      await wait(nextPause);
      log('warmup_site_completed', { taskId, step: index + 1, total: selected.length });
    }
    await check();
    log('warmup_completed', { taskId, sitesCount: selected.length });
  } finally {
    await policy?.dispose().catch(() => {});
    page.off('response', responseListener);
    signal?.removeEventListener('abort', closeOnAbort);
  }
}
