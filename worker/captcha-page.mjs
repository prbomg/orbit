import { createImageCaptchaRouter } from './captcha-routing.mjs';
import { retryAfterMs } from './http-retry.mjs';
import { activateElement } from './mobile-input.mjs';
import { requestCaptchaToken, CaptchaError } from './captcha-provider.mjs';
import { TaskStoppedError, sleep } from './behavior.mjs';
import {
  detectYandexImagePuzzle,
  solveYandexImagePuzzle,
  detectYandexTextPuzzle,
  solveYandexTextPuzzle,
} from './captcha-image.mjs';

function isYandexHostUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'ya.ru' || url.hostname === 'yandex.ru' || url.hostname.endsWith('.yandex.ru');
  } catch { return false; }
}

function isYandexVerificationUrl(value) {
  try {
    const url = new URL(value);
    if (!isYandexHostUrl(value)) return false;
    if (/^\/(?:showcaptcha|checkcaptcha)(?:fast)?\/?$/.test(url.pathname)) return true;
    return false;
  } catch { return false; }
}

async function isYandexBadChallengePage(page) {
  try {
    return await page.evaluate(() => {
      const path = location.pathname;
      const isCheckPath = /^\/(?:showcaptcha|checkcaptcha)(?:fast)?\/?$/.test(path);
      const isBrokenBase64Path = /^\/[a-zA-Z0-9_-]{40,}/.test(path);
      
      if (!isCheckPath && !isBrokenBase64Path) return false;
      
      const text = document.body?.innerText?.trim() || '';
      const title = document.title || '';
      const isErrorPage = /400\s*Bad\s*Request|Bad\s*Request|Ошибка\s*400|404\s*Not\s*Found|Ошибка\s*404|Ничего\s*не\s*нашлось/i.test(title + ' ' + text);
      
      return isErrorPage || 
        (/^\/checkcaptcha/i.test(path) && document.readyState === 'complete' && !document.querySelector('form, input, button, img, canvas, .CheckboxCaptcha, .AdvancedCaptcha'));
    });
  } catch { return false; }
}

async function isYandexChallengeState(page) {
  if (isYandexVerificationUrl(page.url())) return true;
  try {
    return await page.evaluate(() => {
      const isYandexHost = location.hostname === 'ya.ru' || location.hostname === 'yandex.ru' || location.hostname.endsWith('.yandex.ru');
      if (!isYandexHost) return false;
      const bodyText = document.body?.innerText || '';
      return Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .CheckboxCaptcha-Button, .AdvancedCaptcha, form[action*="checkcaptcha"], .smart-captcha, iframe[src*="captcha"]') ||
        (window.__SSR_DATA__ && (window.__SSR_DATA__.sitekey || window.__SSR_DATA__.captchaKey || window.__SSR_DATA__.smartCaptchaKey)) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText)
      );
    });
  } catch (error) {
    if (/Execution context was destroyed|Cannot find context/i.test(String(error?.message))) {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
      if (isYandexVerificationUrl(page.url())) return true;
    }
    return false;
  }
}

export async function detectCaptcha(page, { blockingOnly = false, allowSsrFallback = false } = {}) {
  const isDirectVerification = isYandexVerificationUrl(page.url());
  const challengeState = blockingOnly && (isDirectVerification || await isYandexChallengeState(page));
  for (const frame of page.frames()) {
    if (blockingOnly && !challengeState && frame !== page.mainFrame()) {
      const owner = await frame.frameElement().catch(() => null);
      if (!owner) continue;
      let visible;
      try {
        visible = await owner.evaluate(element => {
          const box = element.getBoundingClientRect();
          if (!box.width || !box.height) return false;
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          }
          return true;
        }).catch(() => false);
      } finally { await owner.dispose().catch(() => {}); }
      if (!visible) continue;
    }
    let challenge;
    try {
      challenge = await frame.evaluate(({ blockingOnly, challengeState, allowSsrFallback }) => {
        const hidden = element => {
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
          }
          return false;
        };

        const activeRecaptcha = blockingOnly && Array.from(document.querySelectorAll('iframe[src]')).some(element => {
          try {
            const url = new URL(element.src, location.href);
            if (!/^(?:www\.)?(?:google\.com|recaptcha\.net)$/.test(url.hostname) || !/\/recaptcha\/(?:api2|enterprise)\/bframe/.test(url.pathname) || hidden(element)) return false;
            const r = element.getBoundingClientRect();
            if (!(r.width > 100 && r.height > 100 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return false;
            const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
            const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
            return document.elementFromPoint(x, y) === element;
          } catch { return false; }
        });

        const candidates = Array.from(document.querySelectorAll('.g-recaptcha, .smart-captcha, iframe[src]'));
        for (let widgetIndex = 0; widgetIndex < candidates.length; widgetIndex++) {
          const element = candidates[widgetIndex];
          let type; let source; let sitekey = element.getAttribute('data-sitekey');
          if (element.classList.contains('g-recaptcha')) type = 'recaptcha';
          if (element.classList.contains('smart-captcha')) type = 'smartcaptcha';
          if (element.tagName === 'IFRAME') {
            try { source = new URL(element.getAttribute('src'), location.href); } catch { continue; }
            if (/^(?:www\.)?(?:google\.com|recaptcha\.net)$/.test(source.hostname) && /\/recaptcha\/(?:api2|enterprise)\//.test(source.pathname)) {
              type = 'recaptcha'; sitekey = source.searchParams.get('k') ?? sitekey;
            } else if (/(?:smartcaptcha|captcha-api|captcha)\.(?:yandexcloud\.net|yandex\.ru|cloud\.yandex\.ru|yandex\.net)$/i.test(source.hostname)) {
              type = 'smartcaptcha'; sitekey = source.searchParams.get('sitekey') ?? source.searchParams.get('k') ?? sitekey;
            } else continue;
            sitekey ??= element.closest('[data-sitekey]')?.getAttribute('data-sitekey');
          }
          if (!type) continue;
          const invisible = element.getAttribute('data-size') === 'invisible' || source?.searchParams.get('size') === 'invisible' || element.getAttribute('data-invisible') === 'true';
          if (blockingOnly) {
            const box = element.getBoundingClientRect();
            const inactive = hidden(element) || invisible || element.tagName === 'IFRAME' && (!box.width || !box.height);
            if (inactive && !challengeState && !(type === 'recaptcha' && activeRecaptcha)) continue;
            const form = element.closest('form');
            const inputFields = form && Array.from(form.querySelectorAll('input,textarea,select')).some(field =>
              !['g-recaptcha-response', 'smart-token'].includes(field.name) &&
              !['hidden', 'checkbox', 'submit', 'reset', 'button'].includes(field.type));
            if (inputFields && !challengeState && !activeRecaptcha) continue;
          }
          const fieldName = type === 'recaptcha' ? 'g-recaptcha-response' : 'smart-token';
          const scope = element.closest('form') ?? document;
          const field = scope.querySelector(`[name="${fieldName}"]`);
          if (field?.value) continue;

          return {
            type, sitekey, widgetIndex, fieldName,
            invisible,
            enterprise: source?.pathname.includes('/enterprise/') || Boolean(document.querySelector('script[src*="recaptcha/enterprise.js"]')),
            domain: source?.hostname.includes('recaptcha.net') ? 'recaptcha.net' : 'google.com',
            datas: element.getAttribute('data-s'),
          };
        }

        if (allowSsrFallback && window === window.top) {
          const hasActiveCheckbox = Boolean(document.querySelector('#checkbox-captcha-form [role="checkbox"], #checkbox-captcha-form input[type="checkbox"], .CheckboxCaptcha-Button, [class*="CaptchaButton"]'));
          if (!hasActiveCheckbox) {
            const ssrData = window.__SSR_DATA__ || window.Ya?.Captcha || {};
            let ssrSitekey = ssrData?.sitekey ?? ssrData?.captchaKey ?? ssrData?.smartCaptchaKey;
            
            if (!ssrSitekey) {
               const html = document.body.innerHTML;
               const match = html.match(/(?:sitekey|captchaKey|smartCaptchaKey)[ '"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{15,})['"]/i) ||
                             html.match(/data-sitekey=['"]([a-zA-Z0-9_-]{15,})['"]/i);
               if (match) ssrSitekey = match[1];
            }
            
            if (ssrSitekey && typeof ssrSitekey === 'string') {
              const field = document.querySelector('[name="smart-token"]');
              if (!field?.value) {
                return {
                  type: 'smartcaptcha', sitekey: ssrSitekey, widgetIndex: -1,
                  fieldName: 'smart-token', invisible: false, enterprise: false,
                  domain: 'yandex.ru', datas: null,
                };
              }
            }
          }
        }
        return null;
      }, { blockingOnly, challengeState, allowSsrFallback });
    } catch (error) {
      if (page.isClosed()) throw error;
      const navigationChangedContext = /Execution context was destroyed|Cannot find context with specified id|Failed to find a valid execution context/i.test(String(error?.message));
      if (!frame.isDetached() && !navigationChangedContext) throw error;
      continue;
    }
    if (challenge) return { ...challenge, frame, pageUrl: page.url(), frameUrl: frame.url() };
  }
  return null;
}

async function inspectYandexChallenge(page) {
  try {
    return await page.evaluate(() => {
      const ssr = window.__SSR_DATA__;
      const forms = Array.from(document.forms).slice(0, 5).map(form => ({ id: form.id.slice(0, 80), actionPath: new URL(form.action, location.href).pathname.slice(0, 100), inputNames: Array.from(form.elements).map(element => element.name).filter(Boolean).slice(0, 20) }));
      const captchaClasses = Array.from(document.querySelectorAll('[class*="captcha" i]')).slice(0, 12).map(element => typeof element.className === 'string' ? element.className.slice(0, 100) : '');
      const checkboxControls = Array.from(document.querySelectorAll('#checkbox-captcha-form [role="checkbox"], #checkbox-captcha-form input[type="checkbox"], #checkbox-captcha-form .CheckboxCaptcha-Button, .CheckboxCaptcha-Button')).slice(0, 5).map(element => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, role: element.getAttribute('role'), width: Math.round(box.width), height: Math.round(box.height), visible: box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden' };
      });
      const images = Array.from(document.images).slice(0, 12).map(image => ({ width: image.naturalWidth || Math.round(image.getBoundingClientRect().width), height: image.naturalHeight || Math.round(image.getBoundingClientRect().height), className: image.className.slice(0, 80) }));
      const frameHosts = Array.from(document.querySelectorAll('iframe[src]')).slice(0, 10).map(frame => { try { return new URL(frame.src, location.href).hostname; } catch { return ''; } });
      return { checkboxForm: Boolean(document.querySelector('#checkbox-captcha-form')), checkboxControls, ssrPresent: Boolean(ssr), ssrSitekeyPresent: Boolean(ssr?.sitekey), ssrCaptchaKeyPresent: Boolean(ssr?.captchaKey), forms, captchaClasses, images, frameHosts };
    });
  } catch { return null; }
}

async function openYandexChallenge(page, signal, beforeInput = () => {}) {
  const hasAdvancedPuzzle = await page.evaluate(() => Boolean(
    document.querySelector('.AdvancedCaptcha, .AdvancedCaptcha-View, .AdvancedCaptcha-ImageWrapper')
  )).catch(() => false);
  if (hasAdvancedPuzzle) return false;

  const selectors = [
    '#checkbox-captcha-form [role="checkbox"]',
    '#checkbox-captcha-form input[type="checkbox"]',
    '#checkbox-captcha-form .CheckboxCaptcha-Button',
    '#checkbox-captcha-form label',
    '.CheckboxCaptcha-Button',
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const control = frame.locator(selector).first();
      if (!await control.isVisible().catch(() => false)) continue;
      if (!await control.isEnabled().catch(() => false)) continue;
      signal?.throwIfAborted();
      beforeInput();
      await activateElement(control, { timeout: 5_000, signal });
      return true;
    }
  }
  return false;
}

function extractReturnUrlFromCaptchaUrl(urlStr, fallbackSearchUrl) {
  try {
    const parsed = new URL(urlStr);
    
    // Перехват битого Base64-пути Яндекса (например, /aHR0cHM...)
    const base64PathMatch = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{40,})/);
    if (base64PathMatch) {
      try {
        const b64 = base64PathMatch[1].replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const resolved = new URL(decoded, parsed.origin);
        if (/^https?:$/i.test(resolved.protocol) && isYandexHostUrl(resolved.href) && !isYandexVerificationUrl(resolved.href)) {
          return resolved.href;
        }
      } catch {}
    }

    for (const key of ['retpath', 'backpath', 'returnUrl', 'url']) {
      const val = parsed.searchParams.get(key);
      if (!val) continue;
      try {
        const resolved = new URL(val, parsed.origin);
        if (/^https?:$/i.test(resolved.protocol) && isYandexHostUrl(resolved.href) && !isYandexVerificationUrl(resolved.href)) {
          return resolved.href;
        }
      } catch {
        try {
          const decoded = Buffer.from(val, 'base64').toString('utf8');
          const resolved = new URL(decoded, parsed.origin);
          if (/^https?:$/i.test(resolved.protocol) && isYandexHostUrl(resolved.href) && !isYandexVerificationUrl(resolved.href)) {
            return resolved.href;
          }
        } catch { }
      }
    }
    if (fallbackSearchUrl && isYandexHostUrl(fallbackSearchUrl) && !isYandexVerificationUrl(fallbackSearchUrl)) {
      return fallbackSearchUrl;
    }
    return isYandexHostUrl(parsed.origin) ? `${parsed.origin}/` : 'https://ya.ru/';
  } catch {
    return (fallbackSearchUrl && isYandexHostUrl(fallbackSearchUrl)) ? fallbackSearchUrl : 'https://ya.ru/';
  }
}

async function prepareCaptchaRetry(page, fallbackUrl, { config, active, log, taskId, reuseCurrent, signal, lastSearchUrl, clearShowCaptchaUrl }) {
  const timeout = config.navigationTimeoutMs ?? 30_000;
  const inspectLoadedPage = async () => {
    try {
      await active();
      if (page.isClosed()) return null;
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 10_000) });
      await active();
      if (await isYandexBadChallengePage(page)) return null;
      const url = page.url();
      if (!await isYandexChallengeState(page)) {
        const is429 = await page.evaluate(() => document.title.includes('429') || (document.body && /^Too Many Requests$/i.test(document.body.innerText.trim())));
        if (!is429 && url !== fallbackUrl && /^https?:$/.test(new URL(url).protocol) &&
            isYandexHostUrl(url) &&
            await page.evaluate(() => Boolean(document.body) && document.readyState !== 'loading') &&
            !await detectCaptcha(page, { blockingOnly: true })) {
          return { url, reason: 'navigation_completed' };
        }
        return null;
      }
      if (await detectYandexImagePuzzle(page)) return { url, reason: 'image_puzzle_ready' };
      if (await detectYandexTextPuzzle(page)) return { url, reason: 'text_puzzle_ready' };
      const widget = await detectCaptcha(page, { blockingOnly: true, allowSsrFallback: true });
      if (widget?.sitekey) return { url, reason: 'widget_ready' };
      for (const frame of page.frames()) {
        const checkbox = frame.locator('#checkbox-captcha-form [role="checkbox"], #checkbox-captcha-form input[type="checkbox"], #checkbox-captcha-form label, .CheckboxCaptcha-Button').first();
        if (await checkbox.isVisible()) return { url, reason: 'checkbox_ready' };
      }
      return null;
    } catch {
      await active();
      return null;
    }
  };

  await active();
  const badPage = await isYandexBadChallengePage(page);
  if (badPage) {
    clearShowCaptchaUrl?.();
  }

  if (reuseCurrent && !badPage) {
    const waitDeadline = Date.now() + 6_000;
    while (Date.now() < waitDeadline) {
      const current = await inspectLoadedPage();
      if (current) {
        log('captcha_retry_page_reused', { taskId, ...current });
        return;
      }
      if (await isYandexBadChallengePage(page)) {
        clearShowCaptchaUrl?.();
        break;
      }
      await sleep(300, signal);
    }
  }

  if (!reuseCurrent && !await isYandexBadChallengePage(page)) {
    const refreshed = await page.evaluate(() => {
      const btn = document.querySelector('.AdvancedCaptcha-Refresh, button[class*="Refresh"], [aria-label*="Обновить" i], [title*="Обновить" i]');
      if (btn && btn instanceof HTMLElement) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (refreshed) {
      await sleep(1_200, signal);
      const afterRefresh = await inspectLoadedPage();
      if (afterRefresh) {
        log('captcha_retry_page_reused', { taskId, ...afterRefresh, refreshedInPlace: true });
        return;
      }
    }
  }

  const fromUrl = page.url();
  const isNowBad = await isYandexBadChallengePage(page);
  let retryUrl;

  if (isNowBad) {
    clearShowCaptchaUrl?.();
    retryUrl = extractReturnUrlFromCaptchaUrl(fallbackUrl || fromUrl, lastSearchUrl);
  } else {
    const candidate = (/^\/showcaptcha/i.test(new URL(fromUrl).pathname)) ? fromUrl : fallbackUrl;
    retryUrl = isYandexHostUrl(candidate) ? candidate : extractReturnUrlFromCaptchaUrl(fromUrl, lastSearchUrl);
  }

  try {
    await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout });
    await active();
    if (await isYandexBadChallengePage(page)) {
      clearShowCaptchaUrl?.();
      const cleanUrl = extractReturnUrlFromCaptchaUrl(retryUrl, lastSearchUrl);
      if (cleanUrl !== retryUrl) {
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout });
        await active();
      }
    }
  } catch (reloadError) {
    await active();
    log('captcha_reload_failed', {
      taskId, fromUrl, retryUrl, currentUrl: page.url(),
      errorType: reloadError.name, errorMessage: String(reloadError.message ?? reloadError),
    });
    if (/net::ERR_ABORTED|interrupted by another navigation/i.test(String(reloadError.message))) {
      const loaded = await inspectLoadedPage();
      if (loaded) {
        log('captcha_retry_page_reused', { taskId, ...loaded, interruptedNavigation: true });
        return;
      }
    }
    if (/net::ERR_BLOCKED_BY_CLIENT/i.test(String(reloadError.message))) {
      const safeYandexUrl = (lastSearchUrl && isYandexHostUrl(lastSearchUrl)) ? lastSearchUrl : 'https://ya.ru/';
      try {
        await page.goto(safeYandexUrl, { waitUntil: 'domcontentloaded', timeout });
        await active();
        return;
      } catch { }
    }
    const error = new CaptchaError('captcha_reload_failed');
    error.cause = reloadError;
    throw error;
  }
}

export function createCaptchaHandler({ prisma, config, proxy, userAgent, shouldContinue, log, taskId, navigationPolicy }) {
  let imageRouter;
  let attempts = 0;
  let incorrect = 0;
  let transientFailures = 0;
  let lastShowCaptchaUrl = null;
  let lastSearchUrl = null;
  
  const incorrectCodes = new Set([
    'ERROR_CAPTCHA_UNSOLVABLE',
    'submission_rejected',
    'invalid_coordinates',
    'INVALID_COORDINATES',
    'INVALID_SOLUTION',
    'invalid_token',
    'token_ip_mismatch_prevented',
  ]);
  
  const transientCodes = new Set([
    'page_changed',
    'image_capture_failed',
    'image_changed',
    'submission_timeout',
    'submission_not_sent',
    'submission_navigation_failed',
    'widget_not_detected',
    'checkbox_not_completed',
    'checkbox_navigation_timeout',
    'provider_error',
    'API_V2_ERROR',
    'API_V1_ERROR',
    'timeout',
    'client_exited'
  ]);

  const isRetriableError = code =>
    incorrectCodes.has(code) ||
    transientCodes.has(code) ||
    (typeof code === 'string' && /^(?:ERROR_|HTTP_)/.test(code) && !/ZERO_BALANCE|KEY_DOES_NOT_EXIST|WRONG_USER_KEY/i.test(code));

  const budget = () => {
    if (incorrect >= 20) throw new CaptchaError('incorrect_limit');
    if (attempts >= 20) throw new CaptchaError('solve_limit');
    if (transientFailures >= 30) throw new CaptchaError('solve_limit');
  };
  
  const openedCheckbox = new WeakMap();
  
  return async function handleCaptcha(page, signal) {
    signal?.throwIfAborted();
    const active = async () => { signal?.throwIfAborted(); if (shouldContinue && !await shouldContinue()) throw new TaskStoppedError(); };
    await active();
    
    const initialChallengeUrl = page.url();
    try {
      const parsedInitial = new URL(initialChallengeUrl);
      if (isYandexHostUrl(initialChallengeUrl)) {
        if (/^\/showcaptcha/i.test(parsedInitial.pathname)) {
          lastShowCaptchaUrl = initialChallengeUrl;
        } else if (!/^\/checkcaptcha/i.test(parsedInitial.pathname) && /^https?:$/i.test(parsedInitial.protocol)) {
          lastSearchUrl = initialChallengeUrl;
        }
      }
    } catch { }
    
    try {
      if (await isYandexBadChallengePage(page)) {
        lastShowCaptchaUrl = null;
        throw new CaptchaError('widget_not_detected');
      }

      const isYandexChallenge = async () => isYandexChallengeState(page);
      const detectBlockingCaptcha = (allowSsrFallback = false) => detectCaptcha(page, { blockingOnly: true, allowSsrFallback });
      
      let challenge = await detectBlockingCaptcha(false);
      let activeChallengePage = await isYandexChallenge();
      const waitMs = config.captchaWidgetWaitMs ?? 15_000;
      const retryDelay = Math.min(3_000, Math.max(100, waitMs / 3));

      const openCheckboxIfPresent = async () => {
        if (!activeChallengePage || challenge?.sitekey) return false;
        const currentUrl = page.url();
        try {
          if (isYandexHostUrl(currentUrl) && /^\/showcaptcha/i.test(new URL(currentUrl).pathname)) {
            lastShowCaptchaUrl = currentUrl;
          }
        } catch { }
        const documentReady = await page.evaluate(() => {
          return document.readyState === 'complete' || document.readyState === 'interactive';
        }).catch(() => false);
        if (!documentReady) return false;
        activeChallengePage = await isYandexChallenge();
        if (!activeChallengePage) return false;

        const previous = openedCheckbox.get(page);
        const same = previous?.url === currentUrl;
        if (previous && Date.now() - previous.lastAt < 4_000) return false;
        if (same && (previous.clicks >= 2 || previous.progress || Date.now() - previous.lastAt < retryDelay)) return false;
        await active();
        const state = same ? previous : { url: currentUrl, clicks: 0, progress: false };
        const opened = await openYandexChallenge(page, signal, () => {
          state.clicks++; state.lastAt = Date.now(); openedCheckbox.set(page, state);
        });
        if (opened) {
          if (state.clicks > 1) log('captcha_checkbox_retrying', { taskId, attempt: state.clicks, reason: 'no_response' });
          log('captcha_checkbox_clicked', { taskId, attempt: state.clicks });
          await sleep(Math.min(750, waitMs), signal);
        }
        return opened;
      };

      const pendingRequests = new Set();
      const requested = request => {
        const state = openedCheckbox.get(page);
        if (!state) return;
        try {
          const url = new URL(request.url());
          if (request.frame() === page.mainFrame() &&
            (request.isNavigationRequest() || request.method() === 'POST' && url.origin === new URL(state.url).origin && /^\/checkcaptcha/.test(url.pathname))) {
            state.progress = true; pendingRequests.add(request);
          }
        } catch { }
      };
      const settled = request => pendingRequests.delete(request);
      let imagePuzzle;
      let textPuzzle;
      page.on('request', requested); page.on('requestfinished', settled); page.on('requestfailed', settled);

      try {
        const opened = await openCheckboxIfPresent();
        if (!pendingRequests.size) {
          if (opened) challenge = await detectBlockingCaptcha(false);
          activeChallengePage = await isYandexChallenge();
          imagePuzzle = activeChallengePage && !challenge?.sitekey ? await detectYandexImagePuzzle(page) : null;
          textPuzzle = activeChallengePage && !challenge?.sitekey && !imagePuzzle ? await detectYandexTextPuzzle(page) : null;
        }
        if ((activeChallengePage || pendingRequests.size) && !challenge?.sitekey && !imagePuzzle && !textPuzzle) {
          log('captcha_widget_wait', { taskId, durationMs: waitMs });
          const deadline = Date.now() + waitMs;
          const navigationDeadline = Date.now() + Math.max(waitMs, Math.min(config.navigationTimeoutMs ?? waitMs, 30_000));
          let extended = false;
          const end = () => openedCheckbox.get(page)?.progress ? navigationDeadline : deadline;
          while (Date.now() < end() && (activeChallengePage || pendingRequests.size) && !challenge?.sitekey && !imagePuzzle && !textPuzzle) {
            await active();
            if (!extended && end() > deadline) {
              extended = true; log('captcha_widget_wait', { taskId, durationMs: navigationDeadline - deadline, reason: 'navigation_pending' });
            }
            await sleep(Math.max(1, Math.min(400, end() - Date.now())), signal);
            await active();
            if (pendingRequests.size) continue;
            if (await isYandexBadChallengePage(page)) {
              lastShowCaptchaUrl = null;
              throw new CaptchaError('widget_not_detected');
            }
            activeChallengePage = await isYandexChallenge();
            imagePuzzle = activeChallengePage ? await detectYandexImagePuzzle(page) : null;
            textPuzzle = activeChallengePage && !imagePuzzle ? await detectYandexTextPuzzle(page) : null;
            if (!imagePuzzle && !textPuzzle) challenge = await detectBlockingCaptcha(false);
            if (!challenge?.sitekey && !imagePuzzle && !textPuzzle && await openCheckboxIfPresent() && !pendingRequests.size) {
              activeChallengePage = await isYandexChallenge();
              imagePuzzle = activeChallengePage ? await detectYandexImagePuzzle(page) : null;
              textPuzzle = activeChallengePage && !imagePuzzle ? await detectYandexTextPuzzle(page) : null;
              if (!imagePuzzle && !textPuzzle) challenge = await detectBlockingCaptcha(false);
            }
          }
          if (pendingRequests.size) throw new CaptchaError('checkbox_navigation_timeout');
        }

        if (!activeChallengePage && openedCheckbox.has(page)) {
          try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(config.navigationTimeoutMs ?? waitMs, 30_000) }); }
          catch (error) { await active(); if (error.name !== 'TimeoutError') throw error; throw new CaptchaError('checkbox_navigation_timeout'); }
          challenge = await detectBlockingCaptcha(false);
        }

        activeChallengePage = await isYandexChallenge();
        if (activeChallengePage && !imagePuzzle && !textPuzzle && !challenge?.sitekey) {
          challenge = await detectBlockingCaptcha(true);
        }
      } finally { page.off('request', requested); page.off('requestfinished', settled); page.off('requestfailed', settled); }

      if (await isYandexBadChallengePage(page)) {
        lastShowCaptchaUrl = null;
        throw new CaptchaError('widget_not_detected');
      }

      if (!activeChallengePage && openedCheckbox.has(page) && !challenge) {
        openedCheckbox.delete(page);
        log('captcha_checkbox_completed', { taskId });
        return true;
      }

      if (activeChallengePage && imagePuzzle && !challenge?.sitekey) {
        try {
          const u = page.url();
          if (isYandexHostUrl(u) && /^\/showcaptcha/i.test(new URL(u).pathname)) lastShowCaptchaUrl = u;
        } catch { }
        budget();
        log('captcha_detected', { taskId, provider: 'smartcaptcha_image', attempt: attempts + 1, total: 20 });
        imageRouter ??= createImageCaptchaRouter(await prisma.settings.findUnique({ where: { id: 1 } }), { log: (event, data) => log(event, { taskId, ...data }) });
        const solved = await solveYandexImagePuzzle(page, imagePuzzle, { router: imageRouter, prisma, config, signal, shouldContinue, log, taskId, navigationPolicy, onRequest: () => { budget(); attempts++; } });
        if (solved) openedCheckbox.delete(page);
        transientFailures = 0;
        return solved;
      }

      if (activeChallengePage && textPuzzle && !challenge?.sitekey) {
        try {
          const u = page.url();
          if (isYandexHostUrl(u) && /^\/showcaptcha/i.test(new URL(u).pathname)) lastShowCaptchaUrl = u;
        } catch { }
        budget();
        log('captcha_detected', { taskId, provider: 'smartcaptcha_text', attempt: attempts + 1, total: 20 });
        const solved = await solveYandexTextPuzzle(page, textPuzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy, onRequest: () => { budget(); attempts++; } });
        if (solved) openedCheckbox.delete(page);
        transientFailures = 0;
        return solved;
      }

      if (activeChallengePage && !challenge?.sitekey && config.headless === false && config.captchaManualWaitMs > 0) {
        log('captcha_manual_required', { taskId, durationMs: config.captchaManualWaitMs });
        const deadline = Date.now() + config.captchaManualWaitMs;
        while (Date.now() < deadline && await isYandexChallenge() && !challenge?.sitekey) {
          signal?.throwIfAborted();
          if (!(await shouldContinue())) throw new TaskStoppedError();
          await sleep(Math.min(1_000, deadline - Date.now()), signal);
          if (await isYandexChallenge()) challenge = await detectBlockingCaptcha(true);
        }
        if (!await isYandexChallenge()) {
          openedCheckbox.delete(page);
          log('captcha_manual_completed', { taskId });
          return true;
        }
      }

      if (!challenge) {
        if (activeChallengePage) {
          const is429 = await page.evaluate(() => document.title.includes('429') || (document.body && /^Too Many Requests$/i.test(document.body.innerText.trim()))).catch(() => false);
          if (is429) {
            log('captcha_page_load_failed', { taskId, reason: 'yandex_challenge_429' });
            const err = new CaptchaError('search_rate_limited');
            err.httpStatus = 429;
            throw err;
          }
          const structure = await inspectYandexChallenge(page);
          const state = openedCheckbox.get(page);
          const code = structure?.checkboxForm && state?.url === page.url()
            ? state.progress ? 'checkbox_navigation_timeout' : 'checkbox_not_completed'
            : 'widget_not_detected';
          log('captcha_unrecognized', { taskId, code, structure });
          throw new CaptchaError(code);
        }
        return false;
      }

      const details = { taskId, provider: challenge.type, attempt: attempts + 1, total: 20 };
      log('captcha_detected', details);
      
      if (!challenge.sitekey || !/^[\w-]{10,500}$/.test(challenge.sitekey)) throw new CaptchaError('sitekey_missing');

      budget();
      const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { rucaptchaApiKey: true } });
      if (!settings?.rucaptchaApiKey) throw new CaptchaError('missing_api_key');
      attempts++;

      const rawCookies = await page.context().cookies(challenge.pageUrl).catch(() => []);
      const cookieString = rawCookies
        .filter(c => c.name && c.value && !/[\r\n;]/.test(c.name) && !/[\r\n;]/.test(c.value))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      const params = {
        pageurl: challenge.pageUrl,
        userAgent,
        ...(cookieString ? { cookies: cookieString } : {}),
        ...(challenge.type === 'recaptcha'
          ? { ...(proxy ? { proxy: `${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`, proxytype: config.proxyScheme.toUpperCase() } : {}),
            googlekey: challenge.sitekey, version: 'v2', invisible: challenge.invisible ? 1 : 0, domain: challenge.domain,
            ...(challenge.enterprise ? { enterprise: 1 } : {}), ...(challenge.datas ? { datas: challenge.datas } : {}) }
          : { sitekey: challenge.sitekey, ...(proxy ? { proxyType: config.proxyScheme.toLowerCase(), proxyAddress: proxy.host, proxyPort: proxy.port, proxyLogin: proxy.username, proxyPassword: proxy.password } : {}) }),
      };
      log('captcha_requested', details);
      const token = await requestCaptchaToken({ apiKey: settings.rucaptchaApiKey, type: challenge.type, params, config, signal, shouldContinue });
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      if (page.url() !== challenge.pageUrl || challenge.frame.isDetached() || challenge.frame.url() !== challenge.frameUrl) throw new CaptchaError('page_changed');
      log('captcha_token_received', details);

      const submitted = await challenge.frame.evaluate(({ widgetIndex, fieldName, token }) => {
        const candidates = Array.from(document.querySelectorAll('.g-recaptcha, .smart-captcha, iframe[src]'));
        const widget = (widgetIndex >= 0 ? candidates[widgetIndex] : null)
          ?? document.querySelector('.smart-captcha, .g-recaptcha');
        const fallbackForm = document.querySelector('form[action*="checkcaptcha"]') ?? document.forms[0] ?? null;

        if (!widget && !fallbackForm) return { error: 'widget_changed' };

        const scope = widget?.closest('form') ?? fallbackForm ?? document;
        let field = scope.querySelector(`[name="${fieldName}"]`) ?? document.querySelector(`[name="${fieldName}"]`);
        const form = widget?.closest('form') ?? field?.form ?? fallbackForm;
        if (form?.querySelector('input[type="password"]')) return { error: 'unsupported_form' };
        if (!field) {
          field = document.createElement('input');
          field.type = 'hidden';
          field.name = fieldName;
          (form ?? widget?.parentElement ?? document.body).appendChild(field);
        }

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          try { nativeSetter.call(field, token); } catch { field.value = token; }
        } else {
          field.value = token;
        }
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));

        const callbackName = widget?.getAttribute('data-callback') ?? widget?.closest('[data-callback]')?.getAttribute('data-callback');
        let hasCallback = false;
        if (callbackName && /^[\w$]+(?:\.[\w$]+)*$/.test(callbackName)) {
          const names = callbackName.split('.'); let owner = window;
          for (const name of names.slice(0, -1)) owner = owner?.[name];
          const fn = owner?.[names.at(-1)];
          hasCallback = typeof fn === 'function';
        }

        const allForms = Array.from(document.forms);
        const formIndex = form ? allForms.indexOf(form) : -1;
        const buttons = form ? Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')) : [];
        const submitIndex = buttons.findIndex(button => !button.disabled && button.getBoundingClientRect().width && button.getBoundingClientRect().height);
        return { hasForm: Boolean(form), formIndex, action: form?.action, method: form?.method, submitIndex, hasCallback, callbackName };
      }, { widgetIndex: challenge.widgetIndex ?? -1, fieldName: challenge.fieldName, token });

      if (submitted.error) throw new CaptchaError(submitted.error);
      log('captcha_token_applied', details);
      if (submitted.hasForm) {
        const action = new URL(submitted.action, challenge.pageUrl);
        if (action.origin !== new URL(challenge.pageUrl).origin) throw new CaptchaError('external_form_action');
        if (submitted.method === 'post') navigationPolicy.allowCaptchaPost(action.href);
      }
      let navigationStarted = false;
      const onRequest = request => {
        if (request.isNavigationRequest() && request.frame() === challenge.frame) navigationStarted = true;
      };
      page.on('request', onRequest);
      const navigation = submitted.hasForm ? challenge.frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
        .then(response => ({ response }), error => ({ error })) : null;
      let clicked = false;
      try {
        if (submitted.hasCallback) {
          try {
            await challenge.frame.evaluate(({ callbackName, token }) => {
              const names = callbackName.split('.'); let owner = window;
              for (const name of names.slice(0, -1)) owner = owner?.[name];
              const fn = owner?.[names.at(-1)];
              if (typeof fn !== 'function') throw new Error('Captcha callback changed');
              fn.call(owner, token);
            }, { callbackName: submitted.callbackName, token });
          } catch (error) { if (!navigationStarted) throw error; }
          log('captcha_callback_invoked', details);
          await sleep(250, signal);
        }
        if (!navigationStarted && submitted.hasForm && submitted.submitIndex >= 0) {
          const formScope = submitted.formIndex >= 0 ? challenge.frame.locator('form').nth(submitted.formIndex) : challenge.frame.locator('form').first();
          const buttons = formScope.locator('button[type="submit"], input[type="submit"], button:not([type])');
          const button = buttons.nth(submitted.submitIndex);
          log('captcha_submitting', details);
          await activateElement(button, { timeout: config.navigationTimeoutMs, signal });
          clicked = true;
        } else if (!navigationStarted && submitted.hasForm && submitted.formIndex >= 0) {
          log('captcha_submitting', details);
          await challenge.frame.evaluate(idx => {
            const f = document.forms[idx];
            if (!f) return;
            try {
              if (typeof f.requestSubmit === 'function') {
                f.requestSubmit();
                return;
              }
            } catch {}
            HTMLFormElement.prototype.submit.call(f);
          }, submitted.formIndex);
          clicked = true;
        } else if (!navigationStarted && !submitted.hasCallback) throw new CaptchaError('submit_control_missing');
        if ((navigationStarted || clicked) && navigation) {
          const result = await navigation;
          if (result.error) throw result.error;

          const status = result.response?.status() ?? null;
          const delay = result.response ? retryAfterMs(result.response.headers()['retry-after']) : 0;

          const captchaStillActive = await isYandexChallengeState(page);
          if (captchaStillActive) {
            log('captcha_page_load_failed', { ...details, status, reason: 'captcha_still_present' });
            throw new CaptchaError('submission_rejected');
          }

          if (status === 429) {
            const isYandex = await page.evaluate(() => {
              const host = location.hostname;
              return (host === 'ya.ru' || host === 'yandex.ru' || host.endsWith('.yandex.ru'));
            }).catch(() => false);
            
            if (isYandex) {
              log('captcha_page_load_failed', { ...details, status, reason: 'yandex_challenge_429' });
              throw new CaptchaError('submission_rejected');
            }

            log('captcha_page_load_failed', { ...details, status, retryAfterMs: delay });
            const error = new CaptchaError('search_rate_limited');
            error.httpStatus = status; error.retryDelayMs = delay;
            throw error;
          }

          if (!result.response?.ok()) {
            log('captcha_page_load_failed', { ...details, status, retryAfterMs: delay });
            const error = new CaptchaError([400, 403].includes(status) ? 'submission_rejected' : 'submission_http_error');
            if (status) error.httpStatus = status;
            throw error;
          }
          log('captcha_page_loaded', { ...details, status, retryAfterMs: 0 });
          log('captcha_submitted', details);
        }
      } finally { page.off('request', onRequest); }
      signal?.throwIfAborted();
      if (await isYandexChallengeState(page)) throw new CaptchaError('submission_rejected');
      openedCheckbox.delete(page);
      transientFailures = 0;
      return true;
      
    } catch (error) {
      if (error.code === 'submission_rejected') {
        imageRouter?.failed(error);
      }

      if (error instanceof CaptchaError && incorrectCodes.has(error.code)) incorrect++;
      else if (error instanceof CaptchaError && isRetriableError(error.code)) transientFailures++;
      
      log('captcha_failed', { taskId, provider: 'smartcaptcha', attempt: attempts, errorType: error.name,
        ...(error instanceof CaptchaError ? { code: error.code } : {}) });
        
      if (error instanceof CaptchaError && isRetriableError(error.code)) {
        budget(); await active();
        log('captcha_retrying', { taskId, attempt: attempts + 1, total: 20, code: error.code });
        await sleep(800, signal); await active(); openedCheckbox.delete(page);
        navigationPolicy.clearCaptchaPost();
        
        const currentUrl = page.url();
        const isCurrentBad = await isYandexBadChallengePage(page);
        if (isCurrentBad) lastShowCaptchaUrl = null;
        const safeInitial = isYandexHostUrl(initialChallengeUrl) ? initialChallengeUrl : 'https://ya.ru/';
        const fallback = (!isCurrentBad && isYandexHostUrl(currentUrl) && /^\/showcaptcha/i.test(new URL(currentUrl).pathname))
          ? currentUrl
          : (lastShowCaptchaUrl ?? lastSearchUrl ?? safeInitial);
        await prepareCaptchaRetry(page, fallback, {
          config, active, log, taskId, signal,
          lastSearchUrl,
          clearShowCaptchaUrl: () => { lastShowCaptchaUrl = null; },
          reuseCurrent: !isCurrentBad && (error.code === 'submission_rejected' || error.code === 'page_changed'),
        });
        return handleCaptcha(page, signal);
      }
      throw error;
    } finally {
      navigationPolicy.clearCaptchaPost();
    }
  };
}