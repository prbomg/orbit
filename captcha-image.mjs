import { createImageCaptchaRouter } from './captcha-routing.mjs';
import { trackNavigationResponses } from './navigation-response.mjs';
import { retryAfterMs } from './http-retry.mjs';
import { activateElement } from './mobile-input.mjs';
import { touchTap } from './touch-tap.mjs';
import { CaptchaError, requestCaptchaSolution } from './captcha-provider.mjs';
import { TaskStoppedError, sleep } from './behavior.mjs';

const capturedImages = new WeakMap();
const MAX_FRAME_IMAGES = 32;

function imageUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch { return value; }
}

function isLikelyCaptchaContext(urlStr) {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    return (
      host.includes('captcha') ||
      host === 'ya.ru' ||
      host === 'yandex.ru' ||
      host.endsWith('.yandex.ru') ||
      host.endsWith('.yandex.net') ||
      host.endsWith('.yandexcloud.net')
    );
  } catch { return false; }
}

export function startCaptchaImageCapture(context) {
  const frames = new WeakMap();
  capturedImages.set(context, frames);
  const pages = new Set();
  const detached = frame => frames.delete(frame);
  const attach = page => {
    pages.add(page);
    page.on('framedetached', detached);
    page.once('close', () => {
      pages.delete(page);
      page.off('framedetached', detached);
    });
  };
  const receive = response => {
    try {
      const request = response.request();
      if (request.isNavigationRequest()) {
        if (response.status() >= 200 && (response.status() < 300 || response.status() >= 400)
            && ![204, 205].includes(response.status())
            && !/attachment/i.test(response.headers()['content-disposition'] ?? '')) frames.delete(response.frame());
        return;
      }
      if (request.resourceType() !== 'image' || !response.ok()) return;

      const reqUrl = request.url();
      const frame = response.frame();
      const frameUrl = frame?.url() || '';
      if (!isLikelyCaptchaContext(reqUrl) && !isLikelyCaptchaContext(frameUrl)) return;

      const contentLength = Number(response.headers()['content-length'] ?? 0);
      if (contentLength > 5_000_000) return;

      let images = frames.get(frame);
      if (!images) { images = new Map(); frames.set(frame, images); }

      if (images.size >= MAX_FRAME_IMAGES) {
        const oldestKey = images.keys().next().value;
        images.delete(oldestKey);
      }

      for (let source = request; source; source = source.redirectedFrom()) {
        images.set(imageUrl(source.url()), response);
      }
    } catch { }
  };
  context.on('response', receive);
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  return () => {
    context.off('response', receive);
    context.off('page', attach);
    for (const page of pages) page.off('framedetached', detached);
    capturedImages.delete(context);
  };
}

export async function detectYandexImagePuzzle(page) {
  for (const frame of page.frames()) {
    let elements;
    try {
      elements = await frame.locator('img, canvas').evaluateAll(async nodes => {
        await Promise.all(nodes.map(node => {
          if (node instanceof HTMLImageElement && !node.complete && node.src) {
            return node.decode().catch(() => {});
          }
          return Promise.resolve();
        }));
        return nodes.map((node, index) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const visible = box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
          const natW = (node.naturalWidth || node.width || 0);
          const natH = (node.naturalHeight || node.height || 0);
          const cssW = Math.round(box.width);
          const cssH = Math.round(box.height);
          const width = natW || cssW;
          const height = natH || cssH;
          return { index, width, height, natW, natH, cssW, cssH, visible };
        });
      });
    } catch { continue; }

    const isMain = item => {
      if (!item.visible) return false;
      if ((item.width >= 260 && item.width <= 380 && item.height >= 150 && item.height <= 220) ||
          (item.width >= 560 && item.width <= 760 && item.height >= 300 && item.height <= 440) ||
          (item.cssW >= 240 && item.cssW <= 400 && item.cssH >= 135 && item.cssH <= 240)) {
        const ratio = item.width / (item.height || 1);
        return ratio >= 1.45 && ratio <= 2.05;
      }
      return false;
    };

    const isInstruction = item => {
      if (!item.visible) return false;
      if ((item.width >= 400 && item.width <= 560 && item.height >= 40 && item.height <= 220) ||
          (item.width >= 800 && item.width <= 1120 && item.height >= 80 && item.height <= 440) ||
          (item.cssW >= 220 && item.cssW <= 560 && item.cssH >= 35 && item.cssH <= 180 && (item.width / (item.height || 1)) >= 2.0)) {
        return true;
      }
      return false;
    };

    const mains = elements.filter(isMain);
    const instructions = elements.filter(item => isInstruction(item) && item.index !== mains[0]?.index);
    if (mains.length >= 1 && instructions.length >= 1) {
      const locator = frame.locator('img, canvas');
      return { frame, main: locator.nth(mains[0].index), instruction: locator.nth(instructions[0].index) };
    }
  }
  return null;
}

async function renderAtSize(image, { width, height, base64, contentType, sourceUrl }) {
  if (sourceUrl !== undefined && (image.currentSrc ?? '') !== sourceUrl) throw new Error('Image changed');
  let source = image;
  if (base64) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    source = new Blob([bytes], { type: contentType });
  } else if (image instanceof HTMLImageElement) await image.decode();

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const renderedWidth = bitmap.width * scale; const renderedHeight = bitmap.height * scale;
    context.drawImage(bitmap, (width - renderedWidth) / 2, (height - renderedHeight) / 2, renderedWidth, renderedHeight);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('PNG encoding failed'));
      reader.readAsDataURL(blob);
    });
  } finally { bitmap.close(); }
}

async function snapshotCanvas(locator, width, height, signal) {
  signal?.throwIfAborted();
  const png = await locator.screenshot({ type: 'png', scale: 'css', timeout: 5_000 });
  signal?.throwIfAborted();
  return await locator.evaluate(renderAtSize, {
    width,
    height,
    contentType: 'image/png',
    base64: png.toString('base64'),
  });
}

async function captureAtSize(locator, width, height, signal, frame, { log, taskId, sourceName }) {
  let reason = 'browser_image_decode';
  let diagnostic = {};
  try {
    signal?.throwIfAborted();
    let base64; let method = 'browser_bitmap';
    try { base64 = await locator.evaluate(renderAtSize, { width, height }); }
    catch (error) {
      if (!/SecurityError|tainted|origin.clean/i.test(String(error.message))) throw error;
    }
    if (!base64) {
      method = 'network_bitmap';
      reason = 'image_source_read';
      const source = await locator.evaluate(image => ({ url: image.currentSrc ?? '', element: image.tagName.toLowerCase() }));
      reason = 'original_response_missing';
      const frames = capturedImages.get(locator.page().context());
      const images = frames?.get(frame);
      const scheme = source.url.split(':', 1)[0];
      diagnostic = { element: source.element, sourceType: ['http', 'https', 'blob', 'data'].includes(scheme) ? scheme : source.url ? 'other' : 'none',
        captureState: frames ? 'active' : 'disabled', capturedResponses: new Set(images?.values()).size };
      if (source.element === 'canvas') {
        reason = 'canvas_snapshot';
        method = 'canvas_snapshot';
        base64 = await snapshotCanvas(locator, width, height, signal);
      } else {
        const response = images?.get(imageUrl(source.url));
        if (!response) throw new Error('Original image response unavailable');
        const headerType = response.headers()['content-type']?.split(';')[0].trim().toLowerCase();
        const contentType = headerType?.startsWith('image/') ? headerType : 'application/octet-stream';
        reason = 'original_response_body';
        const body = await response.body();
        signal?.throwIfAborted();
        if (!body.length || body.length > 5_000_000) throw new Error('Invalid image size');
        reason = 'original_image_decode';
        base64 = await locator.evaluate(renderAtSize, { width, height, sourceUrl: source.url,
          contentType, base64: body.toString('base64') });
      }
    }
    signal?.throwIfAborted();
    log('captcha_image_ready', { taskId, source: sourceName, method, width, height });
    return base64;
  } catch {
    signal?.throwIfAborted();
    log('captcha_image_capture_failed', { taskId, source: sourceName, code: reason, ...diagnostic });
    throw new CaptchaError('image_capture_failed');
  }
}

export async function solveYandexImagePuzzle(page, puzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy, router, onRequest = () => {} }) {
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  router ??= createImageCaptchaRouter(await prisma.settings.findUnique({ where: { id: 1 } }), { log: (event, data) => log(event, { taskId, ...data }) });
  const originalUrl = page.url();
  const image = await captureAtSize(puzzle.main, 320, 180, signal, puzzle.frame, { log, taskId, sourceName: 'main' });
  const imgInstructions = await captureAtSize(puzzle.instruction, 480, 180, signal, puzzle.frame, { log, taskId, sourceName: 'instruction' });
  log('captcha_requested', { taskId, provider: 'smartcaptcha_image' });
  const solution = await router.solve({ params: { image, imgInstructions }, config, signal, shouldContinue }, onRequest);
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  if (page.url() !== originalUrl || puzzle.frame.isDetached()) throw new CaptchaError('page_changed');
  if (!Array.isArray(solution.coordinates)) throw new CaptchaError('invalid_coordinates');
  log('captcha_coordinates_received', { taskId, count: solution.coordinates.length });
  const formDetails = await puzzle.main.evaluate(image => {
    const form = image.closest('form');
    return form ? { action: form.action, method: form.method, hasPassword: Boolean(form.querySelector('input[type="password"]')) } : null;
  });
  let submissionAction = formDetails ? new URL(formDetails.action, originalUrl) : null;
  const approvePost = actionUrl => {
    const action = new URL(actionUrl, originalUrl);
    if (action.origin !== new URL(originalUrl).origin) throw new CaptchaError('external_form_action');
    navigationPolicy.allowCaptchaPost(action.href);
    submissionAction = action;
  };
  if (formDetails?.hasPassword) throw new CaptchaError('unsupported_form');
  if (formDetails?.method === 'post') approvePost(formDetails.action);
  let submissionStarted = false;
  let returnedChallenge = false;
  const navigated = frame => {
    try {
      if (frame === page.mainFrame() && submissionStarted) {
        const u = new URL(frame.url());
        if (/^\/showcaptcha(?:fast)?\/?$/.test(u.pathname)) returnedChallenge = true;
      }
    } catch { }
  };
  const requested = request => {
    try {
      const frame = request.frame(), url = new URL(request.url());
      const navigation = request.isNavigationRequest() && frame === page.mainFrame();
      const verification = request.method() === 'POST' &&
        (frame === puzzle.frame || frame === page.mainFrame()) && url.origin === new URL(originalUrl).origin &&
        (url.pathname === '/checkcaptcha' || url.pathname === '/checkcaptcha/' ||
          (submissionAction && url.origin === submissionAction.origin && url.pathname === submissionAction.pathname));
      if (!submissionStarted && (navigation || verification)) {
        submissionStarted = true;
        log('captcha_submission_started', { taskId, provider: 'smartcaptcha_image', method: navigation ? 'navigation' : 'fetch' });
      }
    } catch { }
  };
  page.on('request', requested);
  page.on('framenavigated', navigated);
  const navigationResponses = trackNavigationResponses(page.context());
  try {
    const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    await puzzle.main.scrollIntoViewIfNeeded({ timeout: 5_000 });
    for (const [index, point] of solution.coordinates.entries()) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      const box = await puzzle.main.boundingBox();
      if (!box) throw new CaptchaError('image_changed');
      const x = box.x + (point.x + 0.5) * box.width / 320;
      const y = box.y + (point.y + 0.5) * box.height / 180;
      if (touch) await touchTap(page, x, y, { signal });
      else await page.mouse.click(x, y);
      log('captcha_coordinate_applied', { taskId, step: index + 1, total: solution.coordinates.length, method: touch ? 'touch' : 'mouse' });
      const jitterDelay = 240 + Math.floor(Math.random() * 180);
      await sleep(jitterDelay, signal);
    }
    log('captcha_coordinates_applied', { taskId, count: solution.coordinates.length });
    const scope = formDetails ? puzzle.main.locator('xpath=ancestor::form[1]') : puzzle.frame;
    const submitName = /^(?:continue|submit|done|verify|confirm|next|продолжить|готово|проверить|отправить|подтвердить|далее|дальше)(?:\s|$)/i;
    let submit = scope.getByRole('button', { name: submitName }).first();
    if (formDetails) {
      const explicit = scope.locator('button[type="submit"]:visible, input[type="submit"]:visible, button[class*="Submit"]:visible, button[class*="action"]:visible').first();
      if (await explicit.count()) submit = explicit;
      else if (!await submit.count()) submit = scope.locator('button:not([type]):visible').first();
    }
    if (!submissionStarted && await submit.isVisible().catch(() => false)) {
      const target = await submit.evaluate(button => ({ action: button.hasAttribute('formaction') ? button.formAction : button.form?.action,
        method: button.hasAttribute('formmethod') ? button.formMethod : button.form?.method }));
      if (target.method === 'post') approvePost(target.action);
      log('captcha_submitting', { taskId, provider: 'smartcaptcha_image' });
      await activateElement(submit, { timeout: config.navigationTimeoutMs ?? 15_000, signal });
      await sleep(Math.min(800, (config.navigationTimeoutMs ?? 15_000) / 10), signal);
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      if (!submissionStarted && page.url() === originalUrl && !puzzle.frame.isDetached() &&
          await submit.isVisible().catch(() => false) && await submit.isEnabled().catch(() => false)) {
        log('captcha_submitting', { taskId, provider: 'smartcaptcha_image', attempt: 2, reason: 'no_response' });
        await activateElement(submit, { timeout: config.navigationTimeoutMs ?? 15_000, signal });
      }
    }
    try {
      await page.waitForURL(url => !/^\/showcaptcha(?:fast)?\/?$/.test(url.pathname), { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs ?? 15_000 });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      throw new CaptchaError(returnedChallenge ? 'submission_rejected' : error.name === 'TimeoutError' ?
        submissionStarted ? 'submission_timeout' : 'submission_not_sent' : 'submission_navigation_failed');
    }

    const response = navigationResponses.current(page);
    const status = response?.status() ?? null;
    const retryAfter = response ? retryAfterMs(response.headers()['retry-after']) : 0;

    // Проверяем, является ли текущая страница повторным вызовом проверки Яндекса (в т.ч. на /search/touch)
    const isYandexHost = ['ya.ru', 'yandex.ru'].includes(new URL(page.url()).hostname) || new URL(page.url()).hostname.endsWith('.yandex.ru');
    const captchaStillPresent = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      return Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .CheckboxCaptcha-Button, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]') ||
        /showcaptcha/i.test(location.pathname) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText)
      );
    }).catch(() => false);

    if (captchaStillPresent || (isYandexHost && status === 429)) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_image', status, reason: 'captcha_still_present' });
      throw new CaptchaError('submission_rejected');
    }

    if (status === 429) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_image', status, retryAfterMs: retryAfter });
      const err = new CaptchaError('search_rate_limited');
      err.httpStatus = 429;
      err.retryDelayMs = retryAfter;
      throw err;
    }

    if (response && !response.ok()) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_image', status, retryAfterMs: retryAfter });
      const err = new CaptchaError([400, 403].includes(status) ? 'submission_rejected' : 'submission_http_error');
      if (status) err.httpStatus = status;
      throw err;
    }

    log('captcha_submitted', { taskId, provider: 'smartcaptcha_image' });
    if (response?.ok()) router.accepted();
    log('captcha_page_loaded', { taskId, provider: 'smartcaptcha_image', status, retryAfterMs: 0 });
    return true;
  } finally {
    navigationResponses.dispose();
    page.off('request', requested);
    page.off('framenavigated', navigated);
    navigationPolicy?.clearCaptchaPost();
  }
}
