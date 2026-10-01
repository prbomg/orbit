import { randomUUID } from 'node:crypto';
import { requestCaptchaToken, CaptchaError } from './captcha-provider.mjs';
import { TaskStoppedError, sleep } from './behavior.mjs';
import { detectYandexImagePuzzle, solveYandexImagePuzzle } from './captcha-image.mjs';

export async function detectCaptcha(page) {
  for (const frame of page.frames()) {
    const marker = randomUUID();
    let challenge;
    try {
      challenge = await frame.evaluate(marker => {
        for (const element of document.querySelectorAll('.g-recaptcha, .smart-captcha, iframe[src]')) {
          let type; let source; let sitekey = element.getAttribute('data-sitekey');
          if (element.classList.contains('g-recaptcha')) type = 'recaptcha';
          if (element.classList.contains('smart-captcha')) type = 'smartcaptcha';
          if (element.tagName === 'IFRAME') {
            try { source = new URL(element.getAttribute('src'), location.href); } catch { continue; }
            if (/^(?:www\.)?(?:google\.com|recaptcha\.net)$/.test(source.hostname) && /\/recaptcha\/(?:api2|enterprise)\//.test(source.pathname)) {
              type = 'recaptcha'; sitekey = source.searchParams.get('k') ?? sitekey;
            } else if (['smartcaptcha.yandexcloud.net', 'captcha-api.yandex.ru', 'smartcaptcha.cloud.yandex.ru'].includes(source.hostname)) {
              type = 'smartcaptcha'; sitekey = source.searchParams.get('sitekey') ?? source.searchParams.get('k') ?? sitekey;
            } else continue;
            sitekey ??= element.closest('[data-sitekey]')?.getAttribute('data-sitekey');
          }
          if (!type) continue;
          const fieldName = type === 'recaptcha' ? 'g-recaptcha-response' : 'smart-token';
          const scope = element.closest('form') ?? document;
          const field = scope.querySelector(`[name="${fieldName}"]`);
          if (field?.value) continue;
          element.setAttribute('data-worker-captcha', marker);
          return {
            type, sitekey, marker, fieldName,
            invisible: element.getAttribute('data-size') === 'invisible' || source?.searchParams.get('size') === 'invisible',
            enterprise: source?.pathname.includes('/enterprise/') || Boolean(document.querySelector('script[src*="recaptcha/enterprise.js"]')),
            domain: source?.hostname.includes('recaptcha.net') ? 'recaptcha.net' : 'google.com',
            datas: element.getAttribute('data-s'),
          };
        }
        return null;
      }, marker);
    } catch (error) {
      if (page.isClosed()) throw error;
      // Yandex can navigate from /showcaptchafast to /showcaptcha while we
      // inspect the DOM. The main frame survives but its execution context does not.
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
      const forms = Array.from(document.forms).slice(0, 5).map(form => ({ id: form.id.slice(0, 80), actionPath: new URL(form.action).pathname.slice(0, 100), inputNames: Array.from(form.elements).map(element => element.name).filter(Boolean).slice(0, 20) }));
      const captchaClasses = Array.from(document.querySelectorAll('[class*="captcha" i]')).slice(0, 12).map(element => typeof element.className === 'string' ? element.className.slice(0, 100) : '');
      const checkboxControls = Array.from(document.querySelectorAll('#checkbox-captcha-form [role="checkbox"], #checkbox-captcha-form input[type="checkbox"], #checkbox-captcha-form .CheckboxCaptcha-Button, .CheckboxCaptcha-Button')).slice(0, 5).map(element => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, role: element.getAttribute('role'), width: Math.round(box.width), height: Math.round(box.height), visible: box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden' };
      });
      const images = Array.from(document.images).slice(0, 12).map(image => ({ width: image.naturalWidth, height: image.naturalHeight, className: image.className.slice(0, 80) }));
      const frameHosts = Array.from(document.querySelectorAll('iframe[src]')).slice(0, 10).map(frame => { try { return new URL(frame.src).hostname; } catch { return ''; } });
      return { checkboxForm: Boolean(document.querySelector('#checkbox-captcha-form')), checkboxControls, ssrPresent: Boolean(ssr), ssrSitekeyPresent: Boolean(ssr?.sitekey), ssrCaptchaKeyPresent: Boolean(ssr?.captchaKey), forms, captchaClasses, images, frameHosts };
    });
  } catch { return null; }
}

async function openYandexChallenge(page, signal) {
  // The first Yandex verification screen often contains only a checkbox. Its
  // sitekey or visual puzzle is created after that control is pressed.
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
      signal?.throwIfAborted();
      await control.click({ timeout: 5_000 });
      return true;
    }
  }
  return false;
}

export function createCaptchaHandler({ prisma, config, proxy, userAgent, shouldContinue, log, taskId, navigationPolicy }) {
  let attempts = 0;
  const openedCheckbox = new WeakMap();
  return async function handleCaptcha(page, signal) {
    signal?.throwIfAborted();
    const isYandexChallengePage = () => {
      try {
        const url = new URL(page.url());
        return (url.hostname === 'ya.ru' || url.hostname === 'yandex.ru' || url.hostname.endsWith('.yandex.ru')) && /^\/showcaptcha(?:fast)?\/?$/.test(url.pathname);
      } catch { return false; }
    };
    let challenge = await detectCaptcha(page);
    const openCheckboxIfPresent = async () => {
      if (!isYandexChallengePage() || challenge?.sitekey || openedCheckbox.get(page) === page.url()) return false;
      const challengeUrl = page.url();
      const opened = await openYandexChallenge(page, signal);
      if (opened) {
        openedCheckbox.set(page, challengeUrl);
        log('captcha_checkbox_clicked', { taskId });
        challenge = await detectCaptcha(page);
      }
      return opened;
    };
    await openCheckboxIfPresent();
    let imagePuzzle = isYandexChallengePage() && !challenge?.sitekey ? await detectYandexImagePuzzle(page) : null;
    // The full-page challenge can render a token widget or image puzzle later.
    if (isYandexChallengePage() && !challenge?.sitekey && !imagePuzzle) {
      const waitMs = config.captchaWidgetWaitMs ?? 15_000;
      log('captcha_widget_wait', { taskId, durationMs: waitMs });
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && isYandexChallengePage() && !challenge?.sitekey && !imagePuzzle) {
        await sleep(Math.min(400, deadline - Date.now()), signal);
        challenge = await detectCaptcha(page);
        if (!challenge?.sitekey) await openCheckboxIfPresent();
        if (!challenge?.sitekey) imagePuzzle = await detectYandexImagePuzzle(page);
      }
    }
    if (isYandexChallengePage() && imagePuzzle && !challenge?.sitekey) {
      if (attempts >= config.captchaMaxSolves) throw new CaptchaError('solve_limit');
      attempts++;
      log('captcha_detected', { taskId, provider: 'smartcaptcha_image', attempt: attempts });
      try {
        return await solveYandexImagePuzzle(page, imagePuzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy });
      } catch (error) {
        log('captcha_failed', { taskId, provider: 'smartcaptcha_image', attempt: attempts, errorType: error.name,
          ...(error instanceof CaptchaError ? { code: error.code } : {}) });
        if (error instanceof CaptchaError && ['ERROR_CAPTCHA_UNSOLVABLE', 'submission_rejected'].includes(error.code)) {
          if (attempts >= config.captchaMaxSolves) throw new CaptchaError('solve_limit');
          signal?.throwIfAborted();
          if (!(await shouldContinue())) throw new TaskStoppedError();
          log('captcha_retrying', { taskId, attempt: attempts + 1, total: config.captchaMaxSolves, code: error.code });
          await sleep(2_000, signal);
          openedCheckbox.delete(page);
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }); }
          catch (reloadError) {
            signal?.throwIfAborted();
            if (reloadError instanceof TaskStoppedError) throw reloadError;
            throw new CaptchaError('captcha_reload_failed');
          }
          return handleCaptcha(page, signal);
        }
        throw error;
      }
    }
    if (isYandexChallengePage() && !challenge?.sitekey && config.headless === false && config.captchaManualWaitMs > 0) {
      log('captcha_manual_required', { taskId, durationMs: config.captchaManualWaitMs });
      const deadline = Date.now() + config.captchaManualWaitMs;
      while (Date.now() < deadline && isYandexChallengePage() && !challenge?.sitekey) {
        signal?.throwIfAborted();
        if (!(await shouldContinue())) throw new TaskStoppedError();
        await sleep(Math.min(1_000, deadline - Date.now()), signal);
        if (isYandexChallengePage()) challenge = await detectCaptcha(page);
      }
      if (!isYandexChallengePage()) {
        log('captcha_manual_completed', { taskId });
        return true;
      }
    }
    if (!challenge) {
      // Some Yandex verification pages never expose a SmartCaptcha sitekey.
      if (isYandexChallengePage()) {
        log('captcha_unrecognized', { taskId, code: 'widget_not_detected', structure: await inspectYandexChallenge(page) });
        throw new CaptchaError('widget_not_detected');
      }
      return false;
    }
    const details = { taskId, provider: challenge.type, attempt: attempts + 1 };
    log('captcha_detected', details);
    try {
      if (!challenge.sitekey || !/^[\w-]{10,500}$/.test(challenge.sitekey)) throw new CaptchaError('sitekey_missing');
      if (attempts >= config.captchaMaxSolves) throw new CaptchaError('solve_limit');
      const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { rucaptchaApiKey: true } });
      if (!settings?.rucaptchaApiKey) throw new CaptchaError('missing_api_key');
      attempts++;
      const params = {
        pageurl: challenge.pageUrl, userAgent,
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
      const submitted = await challenge.frame.evaluate(({ marker, fieldName, token }) => {
        const widget = document.querySelector(`[data-worker-captcha="${marker}"]`);
        if (!widget) return { error: 'widget_changed' };
        let field = (widget.closest('form') ?? document).querySelector(`[name="${fieldName}"]`);
        const form = widget.closest('form') ?? field?.form;
        if (form?.querySelector('input[type="password"]')) return { error: 'unsupported_form' };
        if (!field) {
          field = document.createElement('input'); field.type = 'hidden'; field.name = fieldName;
          (form ?? widget.parentElement ?? document.body).appendChild(field);
        }
        field.value = token;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        const callbackName = widget.getAttribute('data-callback') ?? widget.closest('[data-callback]')?.getAttribute('data-callback');
        let hasCallback = false;
        if (callbackName && /^[\w$]+(?:\.[\w$]+)*$/.test(callbackName)) {
          const names = callbackName.split('.'); let owner = window;
          for (const name of names.slice(0, -1)) owner = owner?.[name];
          const fn = owner?.[names.at(-1)];
          hasCallback = typeof fn === 'function';
        }
        if (form) form.setAttribute('data-worker-captcha-form', marker);
        const buttons = form ? Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')) : [];
        const submitIndex = buttons.findIndex(button => !button.disabled && button.getBoundingClientRect().width && button.getBoundingClientRect().height);
        return { hasForm: Boolean(form), action: form?.action, method: form?.method, submitIndex, hasCallback, callbackName };
      }, { marker: challenge.marker, fieldName: challenge.fieldName, token });
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
        // A callback may submit the form itself. Do not issue a second submission.
        if (!navigationStarted && submitted.hasForm && submitted.submitIndex >= 0) {
          const button = challenge.frame.locator(`[data-worker-captcha-form="${challenge.marker}"]`)
            .locator('button[type="submit"], input[type="submit"], button:not([type])').nth(submitted.submitIndex);
          log('captcha_submitting', details);
          await button.click({ timeout: config.navigationTimeoutMs });
          clicked = true;
        } else if (!navigationStarted && !submitted.hasCallback) throw new CaptchaError('submit_control_missing');
        if ((navigationStarted || clicked) && navigation) {
          const result = await navigation;
          if (result.error) throw result.error;
          if (!result.response?.ok()) throw new CaptchaError('submission_rejected');
          log('captcha_submitted', details);
        }
      } finally { page.off('request', onRequest); }
      signal?.throwIfAborted();
      return true;
    } catch (error) {
      log('captcha_failed', { ...details, errorType: error.name, ...(error instanceof CaptchaError ? { code: error.code } : {}) });
      throw error;
    } finally { navigationPolicy.clearCaptchaPost(); }
  };
}
