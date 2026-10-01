import { performance } from 'node:perf_hooks';
import { moveAlongBezier, randomInt, sleep, TaskStoppedError } from './behavior.mjs';

/** Main-frame redirects and link navigations stay on the task's origin. */
export async function restrictNavigation(context, origin) {
  let approvedPost;
  const handler = async route => {
    const request = route.request();
    const mainNavigation = request.isNavigationRequest() && !request.frame().parentFrame();
    const captchaPost = mainNavigation && request.method() === 'POST' && request.url() === approvedPost;
    if (captchaPost) approvedPost = undefined;
    if (mainNavigation &&
        ((!captchaPost && request.method() !== 'GET') || new URL(request.url()).origin !== origin)) {
      await route.abort('blockedbyclient');
    } else await route.fallback();
  };
  await context.route('**/*', handler);
  return {
    allowCaptchaPost: url => {
      const action = new URL(url); action.hash = '';
      if (action.origin !== origin) throw new Error('Captcha form must stay on the task origin');
      approvedPost = action.href;
    },
    clearCaptchaPost: () => { approvedPost = undefined; },
    dispose: () => context.unroute('**/*', handler),
  };
}

export async function clickRandomLink(page, { origin, timeout, requireInViewport = true }) {
  const links = page.locator('a[href]');
  const candidates = await links.evaluateAll((anchors, { allowedOrigin, requireInViewport }) => anchors.flatMap((anchor, index) => {
    const rect = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    if (!rect.width || !rect.height || (requireInViewport && (rect.bottom <= 0 || rect.top >= innerHeight)) ||
        style.visibility !== 'visible' || style.display === 'none' ||
        anchor.hasAttribute('download') || anchor.hasAttribute('onclick') ||
        (anchor.target && anchor.target !== '_self') || /\b(sponsored|nofollow)\b/i.test(anchor.rel)) return [];
    try {
      const url = new URL(anchor.href, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== allowedOrigin || url.username || url.password ||
          (url.pathname === location.pathname && url.search === location.search) ||
          /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)/i.test(decodeURIComponent(url.pathname + url.search))) return [];
      return [{ index, href: url.href }];
    } catch { return []; }
  }), { allowedOrigin: origin, requireInViewport });
  if (!candidates.length) return false;
  const candidate = candidates[randomInt(0, candidates.length - 1)];
  const link = links.nth(candidate.index);
  // Recheck after candidate collection in case the DOM changed.
  if (await link.evaluate(anchor => anchor.href) !== candidate.href) return false;
  const previous = page.url();
  await Promise.all([
    page.waitForURL(url => url.href !== previous, { waitUntil: 'domcontentloaded', timeout }),
    link.click({ timeout }),
  ]);
  if (new URL(page.url()).origin !== origin) throw new Error('Link left the task origin');
  return true;
}

/** Executes only validated AI actions, in their original order. */
export async function executeActionPlan(page, actions, {
  durationMs, maxDurationMs, navigationTimeoutMs, origin, signal,
  shouldContinue = async () => true, checkCaptcha = async () => {}, log = () => {}, taskId,
}) {
  const started = performance.now();
  let captchaMs = 0; let checkingCaptcha = false;
  // Small allowance for Playwright/DB overhead, not additional behavior.
  const deadlineController = new AbortController();
  const executionSignal = AbortSignal.any([...(signal ? [signal] : []), deadlineController.signal]);
  const elapsed = () => performance.now() - started - captchaMs;
  const watchdog = setInterval(() => {
    if (!checkingCaptcha && elapsed() > maxDurationMs + 1000) deadlineController.abort(new Error('Session time exceeded'));
  }, 250);
  const closeOnAbort = () => { void page.close().catch(() => {}); };
  executionSignal.addEventListener('abort', closeOnAbort, { once: true });
  const check = async () => {
    executionSignal.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    if (page.isClosed()) throw new Error('Page closed before plan completed');
    const before = performance.now(); checkingCaptcha = true;
    try { await checkCaptcha(page, executionSignal); }
    finally { captchaMs += performance.now() - before; checkingCaptcha = false; }
    executionSignal.throwIfAborted();
  };
  const wait = async ms => {
    const until = elapsed() + ms;
    while (elapsed() < until) {
      await check();
      await sleep(Math.min(500, Math.max(0, until - elapsed())), executionSignal);
    }
    await check();
  };
  let cursor = { x: 0, y: 0 };
  try {
    for (const [index, action] of actions.entries()) {
      await check();
      const details = { taskId, step: index + 1, total: actions.length, action: action.type,
        ...(action.pixels === undefined ? {} : { pixels: action.pixels }),
        ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }) };
      log('action_started', details);
      let skipped = false;
      try {
        switch (action.type) {
          case 'scroll_down': await page.mouse.wheel(0, action.pixels); break;
          case 'scroll_up': await page.mouse.wheel(0, -action.pixels); break;
          case 'pause': await wait(action.durationMs); break;
          case 'move_mouse_randomly': {
            const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
            cursor = await moveAlongBezier(page, cursor, {
              x: randomInt(10, viewport.width - 10), y: randomInt(10, viewport.height - 10),
            }, { signal: executionSignal, durationMs: action.durationMs });
            break;
          }
          case 'click_random_link':
            skipped = !(await clickRandomLink(page, { origin, timeout: Math.max(1, Math.min(navigationTimeoutMs, maxDurationMs + 1000 - elapsed())) }));
            break;
          default: throw new Error('Unsupported action');
        }
        await check();
        log(skipped ? 'action_skipped' : 'action_completed', { ...details, ...(skipped ? { reason: 'no_eligible_link' } : {}) });
      } catch (error) {
        log('action_failed', { ...details, errorType: error.name });
        throw error;
      }
    }
    const remaining = durationMs - elapsed();
    if (remaining > 0) {
      log('session_wait', { taskId, durationMs: Math.ceil(remaining) });
      await wait(remaining);
    }
    await check();
  } finally {
    clearInterval(watchdog);
    executionSignal.removeEventListener('abort', closeOnAbort);
  }
}
