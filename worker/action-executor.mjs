import { guardNavigationRedirects } from './navigation-redirects.mjs';
import { getDomain } from 'tldts';
import { sameSite, navigationAllowed } from './navigation-site.mjs';
import { chooseReadingLink } from './reading-semantics.mjs';
import { behaviorRandom } from './behavior-random.mjs';
import { withDeadline, WarmupTimeoutError } from './warmup-timing.mjs';
import { actionSnapshot,waitActionResult } from './action-result.mjs';
import { performance } from 'node:perf_hooks';
import { moveAlongBezier, randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { activateElement, scrollPage, usesTouch } from './mobile-input.mjs';

/** Safe GET navigation within the task's site; captcha POST stays origin-bound. */
export async function restrictNavigation(context, origin, { approvedRedirects = [] } = {}) {
  const stopRedirects = await guardNavigationRedirects(context, (url,{method='GET'}={}) => method==='GET'&&navigationAllowed(url, origin, approvedRedirects));
  let approvedPost;
  const handler = async route => {
    const request = route.request();
    let mainNavigation = request.isNavigationRequest();
    if (mainNavigation) {
      try {
        const frame=request.frame();mainNavigation=!frame.parentFrame();
      }
      catch (error) {
        if (!error.message?.startsWith('Frame for this navigation request is not available')) throw error;
      }
    }
    const captchaPost = mainNavigation && request.method() === 'POST' && request.url() === approvedPost;
    if (captchaPost) approvedPost = undefined;
    if (mainNavigation &&
        ((!captchaPost && request.method() !== 'GET') || !navigationAllowed(request.url(), origin, approvedRedirects))) {
      await route.abort('blockedbyclient');
    } else await route.fallback();
  };
  try { await context.route('**/*', handler); }
  catch(error) { await stopRedirects(); throw error; }
  return {
    allowCaptchaPost: url => {
      const action = new URL(url); action.hash = '';
      if (action.origin !== origin) throw new Error('Captcha form must stay on the task origin');
      approvedPost = action.href;
    },
    clearCaptchaPost: () => { approvedPost = undefined; },
    dispose: async () => { try { await context.unroute('**/*', handler); } finally { await stopRedirects(); } },
  };
}

export async function clickRandomLink(page, options) {
  const timeout = options.timeout ?? 15_000, controller = new AbortController();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), controller.signal]);
  const deadline = performance.now() + timeout;
  try {
    return await withDeadline(() => clickLinkWithinBudget(page, { ...options, signal, deadline }), {
      timeoutMs: timeout, signal: options.signal, code: 'navigation_timeout',
      onTimeout: error => controller.abort(error),
    });
  } catch (error) {
    if (error instanceof WarmupTimeoutError) error.name = 'TimeoutError';
    throw error;
  }
}
async function clickLinkWithinBudget(page, { origin, deadline, requireInViewport = true, signal,log=()=>{},intent='',random=behaviorRandom }) {
  const remaining = () => Math.max(1, deadline - performance.now());
  const source=new URL(origin),siteDomain=getDomain(source.hostname,{allowPrivateDomains:true});
  const links = page.locator('a[href]');
  const candidates = await links.evaluateAll((anchors, { allowedOrigin, siteDomain, requireInViewport }) => anchors.flatMap((anchor, index) => {
    const rect = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    if (!rect.width || !rect.height || (requireInViewport && (rect.bottom <= 0 || rect.top >= innerHeight)) ||
        style.visibility !== 'visible' || style.display === 'none' ||
        anchor.hasAttribute('download') || anchor.hasAttribute('onclick') ||
        (anchor.target && anchor.target !== '_self') || /\b(sponsored|nofollow)\b/i.test(anchor.rel)) return [];
    try {
      const url = new URL(anchor.href, location.href),source=new URL(allowedOrigin);
      const withinSite=url.protocol===source.protocol&&url.port===source.port&&(url.hostname===source.hostname||siteDomain&&(url.hostname===siteDomain||url.hostname.endsWith(`.${siteDomain}`)));
      if (!['http:', 'https:'].includes(url.protocol) || !withinSite || url.username || url.password ||
          (url.pathname === location.pathname && url.search === location.search) ||
          /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)/i.test(decodeURIComponent(url.pathname + url.search)) ||
          /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|csv|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|webm|avi|exe|dmg)$/i.test(url.pathname)) return [];
      return [{ index, href: url.href, text:(anchor.innerText||anchor.getAttribute('aria-label')||'').slice(0,300), rel:anchor.rel, context:[anchor.closest('section,article')?.querySelector('h1,h2,h3')?.innerText,document.querySelector('[aria-label*=breadcrumb i],.breadcrumbs')?.innerText].filter(Boolean).join(' ').slice(0,500), inViewport: rect.bottom > 0 && rect.top < innerHeight, contentLink: !anchor.closest('footer') }];
    } catch { return []; }
  }), { allowedOrigin: origin, siteDomain, requireInViewport });
  if (!candidates.length) return false;
  const visible = candidates.filter(link => link.inViewport);
  const content = candidates.filter(link => link.contentLink);
  const preferred = visible.length ? visible : content.length ? content : candidates;
  const candidate = chooseReadingLink(preferred,intent,random);
  if(!candidate)return false;
  const link = links.nth(candidate.index);
  if (await link.evaluate(anchor => anchor.href, undefined, { timeout: remaining() }) !== candidate.href) return false;
  const before=await actionSnapshot(page);
  await activateElement(link,{timeout:remaining(),signal,random});
  log('action_input_sent',{action:'click_random_link'});
  const outcome=await waitActionResult(page,before,{timeout:Math.max(1,remaining()-100),signal});
  if(!sameSite(page.url(),origin)){const error=new Error('Link navigation did not stay on the task origin');error.name='LinkNavigationError';error.code='site_navigation';throw error;}
  if(outcome.result==='url_changed')await page.waitForLoadState('domcontentloaded',{timeout:remaining()});
  if(outcome.result!=='no_change')log('action_result_verified',{action:'click_random_link',result:outcome.result});
  return outcome.result==='no_change'?false:outcome.result;
}

export async function executeActionPlan(page, actions, {
  durationMs, maxDurationMs, navigationTimeoutMs, origin, signal,
  shouldContinue = async () => true, checkCaptcha = async () => {}, log = () => {}, taskId,
}) {
  const started = performance.now();
  let captchaMs = 0; let checkingCaptcha = false;
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
          case 'scroll_down': {const result=await scrollPage(page,action.pixels,{signal:executionSignal,check});Object.assign(details,{inputMethod:result.method,result:result.result,movedPixels:result.movedPixels,scrollTarget:result.scrollTarget});skipped=result.result!=='scrolled';break;}
          case 'scroll_up': {const result=await scrollPage(page,-action.pixels,{signal:executionSignal,check});Object.assign(details,{inputMethod:result.method,result:result.result,movedPixels:result.movedPixels,scrollTarget:result.scrollTarget});skipped=result.result!=='scrolled';break;}
          case 'pause': await wait(action.durationMs); break;
          case 'move_mouse_randomly': {
            if (await usesTouch(page)) {
              details.inputMethod = 'touch_fidget';
              // Улучшенная имитация чтения текста с экрана (человек скроллит не 1 раз на 30px, а читает абзац)
              const pixels = randomInt(80, 240) * (behaviorRandom() < 0.3 ? -1 : 1);
              const result = await scrollPage(page, pixels, { signal: executionSignal, check });
              // Оставшееся время дожидаемся
              await wait(Math.max(0, action.durationMs - 600));
              break;
            }
            details.inputMethod = 'mouse';
            const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
            cursor = await moveAlongBezier(page, cursor, {
              x: randomInt(10, viewport.width - 10), y: randomInt(10, viewport.height - 10),
            }, { signal: executionSignal, durationMs: action.durationMs });
            break;
          }
          case 'click_random_link':
            details.result = (await clickRandomLink(page, { origin, timeout: Math.max(1, Math.min(navigationTimeoutMs, maxDurationMs + 1000 - elapsed())), signal: executionSignal,log:(event,data)=>log(event,{...details,...data}) }))||'no_change';
            skipped=details.result==='no_change';
            break;
          default: throw new Error('Unsupported action');
        }
        await check();
        log(skipped ? 'action_skipped' : 'action_completed', { ...details, ...(skipped ? { reason: details.result||'no_eligible_link' } : {}) });
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