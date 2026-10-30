import { createImageCaptchaRouter } from './captcha-routing.mjs';
import { trackNavigationResponses } from './navigation-response.mjs';
import { retryAfterMs } from './http-retry.mjs';
import { activateElement } from './mobile-input.mjs';
import { touchTap } from './touch-tap.mjs';
import { CaptchaError, requestCaptchaSolution } from './captcha-provider.mjs';
import { behaviorRandom } from './behavior-random.mjs';
import { randomInt, TaskStoppedError, sleep } from './behavior.mjs';

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

function decodeBrokenYandexRedirect(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'ya.ru' && host !== 'yandex.ru' && !host.endsWith('.yandex.ru')) return null;
    const match = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{40,})/);
    if (!match) return null;
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const resolved = new URL(decoded, parsed.origin);
    if (/^https?:$/i.test(resolved.protocol) && (resolved.hostname === 'ya.ru' || resolved.hostname === 'yandex.ru' || resolved.hostname.endsWith('.yandex.ru'))) {
      return resolved.href;
    }
  } catch {}
  return null;
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
          const isTaskImg = node.matches('.TaskImage-Img, .AdvancedCaptcha-SilhouetteTask img, [class*="TaskImage"] img, [class*="SilhouetteTask"] img');
          const isMainWrapper = Boolean(node.closest('.AdvancedCaptcha-ImageWrapper, .AdvancedCaptcha-View'));
          return { index, width, height, natW, natH, cssW, cssH, visible, isTaskImg, isMainWrapper };
        });
      });
    } catch { continue; }

    const isMain = item => {
      if (!item.visible || item.isTaskImg) return false;
      if ((item.width >= 260 && item.width <= 380 && item.height >= 150 && item.height <= 220) ||
          (item.width >= 560 && item.width <= 760 && item.height >= 300 && item.height <= 440) ||
          (item.cssW >= 240 && item.cssW <= 400 && item.cssH >= 135 && item.cssH <= 240)) {
        const ratio = item.width / (item.height || 1);
        return ratio >= 1.45 && ratio <= 2.05;
      }
      if (item.isMainWrapper && item.width >= 200 && item.height >= 120) return true;
      return false;
    };

    const isInstruction = item => {
      if (!item.visible) return false;
      if (item.isTaskImg && item.width >= 80 && item.height >= 14) return true;
      if ((item.width >= 400 && item.width <= 560 && item.height >= 40 && item.height <= 220) ||
          (item.width >= 800 && item.width <= 1120 && item.height >= 80 && item.height <= 440) ||
          (item.cssW >= 100 && item.cssW <= 560 && item.cssH >= 16 && item.cssH <= 180 && (item.width / (item.height || 1)) >= 2.0)) {
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

export async function detectYandexTextPuzzle(page) {
  for (const frame of page.frames()) {
    let found;
    try {
      found = await frame.evaluate(async () => {
        if (document.querySelector('.AdvancedCaptcha_silhouette, .AdvancedCaptcha-SilhouetteTask, .TaskImage-Img')) {
          return null;
        }
        const isVisible = el => {
          if (!el) return false;
          const box = el.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
        };

        const inputs = Array.from(document.querySelectorAll(
          'input[name="rep"], .AdvancedCaptcha input[type="text"], form[action*="checkcaptcha"] input[type="text"], input[placeholder*="буквы" i], input[placeholder*="картинки" i], input[aria-label*="картинки" i], .Textinput-Control[type="text"]'
        )).filter(el => isVisible(el) && !el.disabled && !el.readOnly);

        if (!inputs.length) return null;

        const mediaNodes = Array.from(document.querySelectorAll('img, canvas'));
        await Promise.all(mediaNodes.map(node => {
          if (node instanceof HTMLImageElement && !node.complete && node.src) {
            return node.decode().catch(() => {});
          }
          return Promise.resolve();
        }));

        const candidates = mediaNodes.map((node, index) => {
          const box = node.getBoundingClientRect();
          const visible = isVisible(node);
          const natW = node.naturalWidth || node.width || 0;
          const natH = node.naturalHeight || node.height || 0;
          const cssW = Math.round(box.width);
          const cssH = Math.round(box.height);
          const width = natW || cssW;
          const height = natH || cssH;
          const isExplicit = node.matches('.AdvancedCaptcha-Image, img.captcha__image, .AdvancedCaptcha-ImageWrapper img, img[src*="captcha" i]');
          return { index, visible, width, height, cssW, cssH, isExplicit };
        }).filter(item => item.visible && item.cssW >= 120 && item.cssH >= 35 && item.cssW <= 600 && item.cssH <= 260);

        if (!candidates.length) return null;

        const coordMains = candidates.filter(item => {
          const r = item.width / (item.height || 1);
          return ((item.width >= 260 && item.width <= 380 && item.height >= 150 && item.height <= 220) ||
                  (item.cssW >= 240 && item.cssW <= 400 && item.cssH >= 135 && item.cssH <= 240)) && r >= 1.45 && r <= 2.05;
        });
        const coordInstr = candidates.filter(item => item.index !== coordMains[0]?.index && item.width >= 100 && item.height >= 16);
        if (coordMains.length >= 1 && coordInstr.length >= 1) return null;

        const targetImg = candidates.find(c => c.isExplicit) ?? candidates[0];
        const allInputs = Array.from(document.querySelectorAll('input'));
        const inputIndex = allInputs.indexOf(inputs[0]);
        if (inputIndex < 0) return null;

        return {
          imageIndex: targetImg.index,
          inputIndex,
          width: Math.min(600, Math.max(200, targetImg.width || targetImg.cssW || 248)),
          height: Math.min(240, Math.max(50, targetImg.height || targetImg.cssH || 82)),
        };
      });
    } catch { continue; }

    if (found) {
      return {
        frame,
        main: frame.locator('img, canvas').nth(found.imageIndex),
        input: frame.locator('input').nth(found.inputIndex),
        width: found.width,
        height: found.height,
      };
    }
  }
  return null;
}

async function renderAtSize(image, { width, height, base64, contentType, sourceUrl, bgColor }) {
  if (sourceUrl !== undefined && (image.currentSrc ?? '') !== sourceUrl) throw new Error('Image changed');
  const resolvedBg = bgColor || '#303035';
  let source = image;
  if (base64) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    source = new Blob([bytes], { type: contentType });
  } else if (image instanceof HTMLImageElement) await image.decode();

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = resolvedBg; 
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

async function snapshotCanvas(locator, width, height, signal, bgColor = '#303035') {
  signal?.throwIfAborted();
  const png = await locator.screenshot({ type: 'png', scale: 'css', timeout: 5_000 });
  signal?.throwIfAborted();
  return await locator.evaluate(renderAtSize, {
    width,
    height,
    contentType: 'image/png',
    base64: png.toString('base64'),
    bgColor,
  });
}

async function captureAtSize(locator, width, height, signal, frame, { log, taskId, sourceName, quiet = false, bgColor = '#303035' }) {
  let reason = 'browser_image_decode';
  let diagnostic = {};
  try {
    signal?.throwIfAborted();
    let base64; let method = 'browser_bitmap';
    try { 
      base64 = await locator.evaluate(renderAtSize, { width, height, bgColor }); 
    }
    catch (error) {
      if (!/SecurityError|tainted|origin.clean/i.test(String(error.message))) throw error;
    }
    if (!base64) {
      method = 'network_bitmap';
      reason = 'image_source_read';
      const source = await locator.evaluate(image => ({
        url: image.currentSrc ?? '',
        element: image.tagName.toLowerCase(),
      }));
      reason = 'original_response_missing';
      const frames = capturedImages.get(locator.page().context());
      const images = frames?.get(frame);
      const scheme = source.url.split(':', 1)[0];
      diagnostic = { element: source.element, sourceType: ['http', 'https', 'blob', 'data'].includes(scheme) ? scheme : source.url ? 'other' : 'none',
        captureState: frames ? 'active' : 'disabled', capturedResponses: new Set(images?.values()).size };
      if (source.element === 'canvas') {
        reason = 'canvas_snapshot';
        method = 'canvas_snapshot';
        base64 = await snapshotCanvas(locator, width, height, signal, bgColor);
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
          contentType, base64: body.toString('base64'), bgColor });
      }
    }
    signal?.throwIfAborted();
    if (!quiet) log('captcha_image_ready', { taskId, source: sourceName, method, width, height });
    return base64;
  } catch {
    signal?.throwIfAborted();
    if (!quiet) log('captcha_image_capture_failed', { taskId, source: sourceName, code: reason, ...diagnostic });
    throw new CaptchaError('image_capture_failed');
  }
}

async function resolveImageClickPoint(locator, point, random = behaviorRandom) {
  const geom = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const style = getComputedStyle(el);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    let left = rect.left + (el.clientLeft || 0) + padL;
    let top = rect.top + (el.clientTop || 0) + padT;
    let width = Math.max(1, rect.width - (el.clientLeft || 0) * 2 - padL - padR);
    let height = Math.max(1, rect.height - (el.clientTop || 0) * 2 - padT - padB);
    const natW = el.naturalWidth || el.width || width;
    const natH = el.naturalHeight || el.height || height;
    if (style.objectFit === 'contain' && natW > 0 && natH > 0) {
      const domScale = Math.min(width / natW, height / natH);
      const fitW = natW * domScale;
      const fitH = natH * domScale;
      left += (width - fitW) / 2;
      top += (height - fitH) / 2;
      width = fitW;
      height = fitH;
    }
    return { left, top, width, height, natW: natW || 320, natH: natH || 180 };
  });
  if (!geom) return null;

  const scale = Math.min(320 / geom.natW, 180 / geom.natH);
  const renderedWidth = geom.natW * scale;
  const renderedHeight = geom.natH * scale;
  const offsetX = (320 - renderedWidth) / 2;
  const offsetY = (180 - renderedHeight) / 2;

  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
  const u = clamp((point.x + 0.5 - offsetX) / renderedWidth, 0.02, 0.98);
  const v = clamp((point.y + 0.5 - offsetY) / renderedHeight, 0.02, 0.98);

  const jitterX = (random() - 0.5) * 2.4;
  const jitterY = (random() - 0.5) * 2.4;

  const x = clamp(geom.left + u * geom.width + jitterX, geom.left + 2, geom.left + geom.width - 2);
  const y = clamp(geom.top + v * geom.height + jitterY, geom.top + 2, geom.top + geom.height - 2);
  return { x, y };
}

async function waitForYandexPostSubmitSettle(page, navigationResponses, signal, timeoutMs = 15_000) {
  const brokenTarget = decodeBrokenYandexRedirect(page.url());
  if (brokenTarget) {
    await page.goto(brokenTarget, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
  }
  if (/^\/(?:showcaptchafast|checkcaptchafast)/i.test(new URL(page.url()).pathname)) {
    const fastDeadline = Date.now() + 5_500;
    while (Date.now() < fastDeadline && /^\/(?:showcaptchafast|checkcaptchafast)/i.test(new URL(page.url()).pathname)) {
      await sleep(250, signal);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  }
  let response = navigationResponses.current(page);
  let status = response?.status() ?? null;
  if (status === 429 && !/^\/showcaptcha/i.test(new URL(page.url()).pathname)) {
    const settleDeadline = Date.now() + 3_500;
    while (Date.now() < settleDeadline) {
      await sleep(300, signal);
      if (/^\/showcaptcha/i.test(new URL(page.url()).pathname)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        break;
      }
      const hasWidget = await page.evaluate(() => Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, form[action*="checkcaptcha"]')
      )).catch(() => false);
      if (hasWidget) break;
    }
    response = navigationResponses.current(page) ?? response;
    status = response?.status() ?? status;
  }
  return { response, status };
}

export async function solveYandexImagePuzzle(page, puzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy, router, onRequest = () => {} }) {
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  router ??= createImageCaptchaRouter(await prisma.settings.findUnique({ where: { id: 1 } }), { log: (event, data) => log(event, { taskId, ...data }) });
  const originalUrl = page.url();
  const image = await captureAtSize(puzzle.main, 320, 180, signal, puzzle.frame, { log, taskId, sourceName: 'main', bgColor: '#303035' });
  const imgInstructions = await captureAtSize(puzzle.instruction, 480, 180, signal, puzzle.frame, { log, taskId, sourceName: 'instruction', bgColor: '#FFFFFF' });
  const imgInstructionsCapGuru = await captureAtSize(puzzle.instruction, 480, 80, signal, puzzle.frame, { log, taskId, sourceName: 'instruction_native', quiet: true, bgColor: '#FFFFFF' }).catch(() => imgInstructions);
  log('captcha_requested', { taskId, provider: 'smartcaptcha_image' });
  
  const solution = await router.solve({ params: { image, imgInstructions, imgInstructionsCapGuru }, config, signal, shouldContinue }, onRequest);
  
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
        if (/^\/showcaptcha\/?$/i.test(u.pathname)) returnedChallenge = true;
      }
    } catch { }
  };
  const requested = request => {
    try {
      const frame = request.frame(), url = new URL(request.url());
      const navigation = request.isNavigationRequest() && frame === page.mainFrame();
      const verification = request.method() === 'POST' &&
        (frame === puzzle.frame || frame === page.mainFrame()) && url.origin === new URL(originalUrl).origin &&
        (url.pathname === '/checkcaptcha' || url.pathname === '/checkcaptcha/' || url.pathname === '/checkcaptchafast' ||
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
    
    await sleep(randomInt(320, 680, behaviorRandom), signal);
    
    for (const [index, point] of solution.coordinates.entries()) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      const targetPoint = await resolveImageClickPoint(puzzle.main, point, behaviorRandom);
      if (!targetPoint) throw new CaptchaError('image_changed');
      
      if (!touch) {
        const steps = randomInt(12, 28, behaviorRandom);
        await page.mouse.move(targetPoint.x, targetPoint.y, { steps });
      }
      
      if (touch) await touchTap(page, targetPoint.x, targetPoint.y, { signal });
      else await page.mouse.click(targetPoint.x, targetPoint.y, { delay: randomInt(40, 90, behaviorRandom) });
      
      log('captcha_coordinate_applied', { taskId, step: index + 1, total: solution.coordinates.length, method: touch ? 'touch' : 'mouse' });
      if (index + 1 < solution.coordinates.length) {
        await sleep(randomInt(420, 920, behaviorRandom), signal);
      }
    }
    log('captcha_coordinates_applied', { taskId, count: solution.coordinates.length });

    await sleep(randomInt(450, 880, behaviorRandom), signal);

    const scope = formDetails ? puzzle.main.locator('xpath=ancestor::form[1]') : puzzle.frame;
    const submitName = /^(?:continue|submit|done|verify|confirm|next|продолжить|готово|проверить|отправить|подтвердить|далее|дальше)(?:\s|$)/i;
    let submit = scope.getByRole('button', { name: submitName }).first();

    const explicitButtons = scope.locator(
      'button[type="submit"], input[type="submit"], .CaptchaButton, button[class*="Submit"], button[class*="Button_action"], button[class*="action"], [data-testid="submit"]'
    );
    if (!await submit.isVisible().catch(() => false) && await explicitButtons.count() > 0) {
      submit = explicitButtons.first();
    } else if (!await submit.isVisible().catch(() => false)) {
      const anyVisibleButton = scope.locator('button:visible, input[type="button"]:visible').first();
      if (await anyVisibleButton.isVisible().catch(() => false)) submit = anyVisibleButton;
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
    } else if (!submissionStarted) {
      log('captcha_submit_button_missing', { taskId, provider: 'smartcaptcha_image' });
      throw new CaptchaError('submission_rejected');
    }

    const navTimeout = Math.min(config.navigationTimeoutMs ?? 15_000, 15_000);
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeout }),
        puzzle.main.waitFor({ state: 'detached', timeout: navTimeout }),
      ]);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      const stillHasChallenge = await page.evaluate(() => Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, form[action*="checkcaptcha"]')
      )).catch(() => false);
      throw new CaptchaError((returnedChallenge || (submissionStarted && stillHasChallenge)) ? 'submission_rejected' : error.name === 'TimeoutError' ?
        submissionStarted ? 'submission_timeout' : 'submission_not_sent' : 'submission_navigation_failed');
    }

    const { response, status } = await waitForYandexPostSubmitSettle(page, navigationResponses, signal, navTimeout);
    const retryAfter = response ? retryAfterMs(response.headers()['retry-after']) : 0;

    const captchaStillPresent = await page.evaluate(() => {
      const host = location.hostname;
      const isYandex = host === 'ya.ru' || host === 'yandex.ru' || host.endsWith('.yandex.ru');
      if (!isYandex) return false;
      const bodyText = document.body?.innerText || '';
      return Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .CheckboxCaptcha-Button, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]') ||
        /showcaptcha/i.test(location.pathname) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText)
      );
    }).catch(() => false);

    const isYandexHost = (() => {
      try {
        const h = new URL(page.url()).hostname;
        return h === 'ya.ru' || h === 'yandex.ru' || h.endsWith('.yandex.ru');
      } catch { return false; }
    })();

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
      const err = new CaptchaError([400, 403, 404].includes(status) ? 'submission_rejected' : 'submission_http_error');
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

function normalizeCyrillicCaptchaText(raw) {
  if (typeof raw !== 'string') return '';
  const latinToCyrillic = {
    a: 'а', c: 'с', e: 'е', k: 'к', m: 'м',
    o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
  };
  return raw
    .toLowerCase()
    .replace(/[acekmoptxy]/g, ch => latinToCyrillic[ch] ?? ch)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function solveYandexTextPuzzle(page, puzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy, onRequest = () => {} }) {
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();

  const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { rucaptchaApiKey: true } });
  if (!settings?.rucaptchaApiKey) throw new CaptchaError('missing_api_key');

  const originalUrl = page.url();
  const captureW = puzzle.width || 248;
  const captureH = puzzle.height || 82;
  const image = await captureAtSize(puzzle.main, captureW, captureH, signal, puzzle.frame, { log, taskId, sourceName: 'main_text', bgColor: '#FFFFFF' });

  onRequest();
  log('captcha_requested', { taskId, provider: 'smartcaptcha_text' });

  const solution = await requestCaptchaSolution({
    apiKey: settings.rucaptchaApiKey,
    type: 'smartcaptcha_text',
    params: { image, comment: 'Введите русские слова с картинки через пробел' },
    config,
    signal,
    shouldContinue,
  });

  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  if (page.url() !== originalUrl || puzzle.frame.isDetached()) throw new CaptchaError('page_changed');

  const text = normalizeCyrillicCaptchaText(solution?.text);
  if (!text) throw new CaptchaError('INVALID_SOLUTION');
  log('captcha_text_received', { taskId, length: text.length });

  const formDetails = await puzzle.input.evaluate(input => {
    const form = input.closest('form');
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
        if (/^\/showcaptcha\/?$/i.test(u.pathname)) returnedChallenge = true;
      }
    } catch { }
  };
  const requested = request => {
    try {
      const frame = request.frame(), url = new URL(request.url());
      const navigation = request.isNavigationRequest() && frame === page.mainFrame();
      const verification = request.method() === 'POST' &&
        (frame === puzzle.frame || frame === page.mainFrame()) && url.origin === new URL(originalUrl).origin &&
        (url.pathname === '/checkcaptcha' || url.pathname === '/checkcaptcha/' || url.pathname === '/checkcaptchafast' ||
          (submissionAction && url.origin === submissionAction.origin && url.pathname === submissionAction.pathname));
      if (!submissionStarted && (navigation || verification)) {
        submissionStarted = true;
        log('captcha_submission_started', { taskId, provider: 'smartcaptcha_text', method: navigation ? 'navigation' : 'fetch' });
      }
    } catch { }
  };

  page.on('request', requested);
  page.on('framenavigated', navigated);
  const navigationResponses = trackNavigationResponses(page.context());

  try {
    await puzzle.input.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await sleep(randomInt(250, 550, behaviorRandom), signal);
    await activateElement(puzzle.input, { timeout: 5_000, signal });
    await puzzle.input.fill('');
    await sleep(randomInt(150, 320, behaviorRandom), signal);

    for (const char of text) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      await puzzle.input.pressSequentially(char, { delay: randomInt(75, 175, behaviorRandom) });
      await sleep(randomInt(35, 110, behaviorRandom), signal);
    }

    await puzzle.input.evaluate((el, val) => {
      if ((el.value ?? '').trim() !== val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, text);

    log('captcha_text_applied', { taskId, length: text.length });
    await sleep(randomInt(450, 900, behaviorRandom), signal);

    const scope = formDetails ? puzzle.input.locator('xpath=ancestor::form[1]') : puzzle.frame;
    const submitName = /^(?:continue|submit|done|verify|confirm|next|продолжить|готово|проверить|отправить|подтвердить|далее|дальше)(?:\s|$)/i;
    let submit = scope.getByRole('button', { name: submitName }).first();

    const explicitButtons = scope.locator(
      'button[type="submit"], input[type="submit"], .CaptchaButton, button[class*="Submit"], button[class*="Button_action"], button[class*="action"], [data-testid="submit"]'
    );
    if (!await submit.isVisible().catch(() => false) && await explicitButtons.count() > 0) {
      submit = explicitButtons.first();
    } else if (!await submit.isVisible().catch(() => false)) {
      const anyVisibleButton = scope.locator('button:visible, input[type="button"]:visible').first();
      if (await anyVisibleButton.isVisible().catch(() => false)) submit = anyVisibleButton;
    }

    if (!submissionStarted && await submit.isVisible().catch(() => false)) {
      const target = await submit.evaluate(button => ({
        action: button.hasAttribute('formaction') ? button.formAction : button.form?.action,
        method: button.hasAttribute('formmethod') ? button.formMethod : button.form?.method,
      }));
      if (target.method === 'post') approvePost(target.action);
      log('captcha_submitting', { taskId, provider: 'smartcaptcha_text' });
      await activateElement(submit, { timeout: config.navigationTimeoutMs ?? 15_000, signal });
      await sleep(Math.min(800, (config.navigationTimeoutMs ?? 15_000) / 10), signal);
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      if (!submissionStarted && page.url() === originalUrl && !puzzle.frame.isDetached() &&
          await submit.isVisible().catch(() => false) && await submit.isEnabled().catch(() => false)) {
        log('captcha_submitting', { taskId, provider: 'smartcaptcha_text', attempt: 2, reason: 'no_response' });
        await activateElement(submit, { timeout: config.navigationTimeoutMs ?? 15_000, signal });
      }
    } else if (!submissionStarted) {
      await page.keyboard.press('Enter');
      await sleep(500, signal);
      if (!submissionStarted) {
        log('captcha_submit_button_missing', { taskId, provider: 'smartcaptcha_text' });
        throw new CaptchaError('submission_rejected');
      }
    }

    const navTimeout = Math.min(config.navigationTimeoutMs ?? 15_000, 15_000);
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeout }),
        puzzle.main.waitFor({ state: 'detached', timeout: navTimeout }),
      ]);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      const stillHasChallenge = await page.evaluate(() => Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, form[action*="checkcaptcha"]')
      )).catch(() => false);
      throw new CaptchaError((returnedChallenge || (submissionStarted && stillHasChallenge)) ? 'submission_rejected' : error.name === 'TimeoutError' ?
        submissionStarted ? 'submission_timeout' : 'submission_not_sent' : 'submission_navigation_failed');
    }

    const { response, status } = await waitForYandexPostSubmitSettle(page, navigationResponses, signal, navTimeout);
    const retryAfter = response ? retryAfterMs(response.headers()['retry-after']) : 0;

    const captchaStillPresent = await page.evaluate(() => {
      const host = location.hostname;
      const isYandex = host === 'ya.ru' || host === 'yandex.ru' || host.endsWith('.yandex.ru');
      if (!isYandex) return false;
      const bodyText = document.body?.innerText || '';
      return Boolean(
        document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .CheckboxCaptcha-Button, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]') ||
        /showcaptcha/i.test(location.pathname) ||
        /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(bodyText)
      );
    }).catch(() => false);

    const isYandexHost = (() => {
      try {
        const h = new URL(page.url()).hostname;
        return h === 'ya.ru' || h === 'yandex.ru' || h.endsWith('.yandex.ru');
      } catch { return false; }
    })();

    if (captchaStillPresent || (isYandexHost && status === 429)) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_text', status, reason: 'captcha_still_present' });
      throw new CaptchaError('submission_rejected');
    }

    if (status === 429) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_text', status, retryAfterMs: retryAfter });
      const err = new CaptchaError('search_rate_limited');
      err.httpStatus = 429;
      err.retryDelayMs = retryAfter;
      throw err;
    }

    if (response && !response.ok()) {
      log('captcha_page_load_failed', { taskId, provider: 'smartcaptcha_text', status, retryAfterMs: retryAfter });
      const err = new CaptchaError([400, 403, 404].includes(status) ? 'submission_rejected' : 'submission_http_error');
      if (status) err.httpStatus = status;
      throw err;
    }

    log('captcha_submitted', { taskId, provider: 'smartcaptcha_text' });
    log('captcha_page_loaded', { taskId, provider: 'smartcaptcha_text', status, retryAfterMs: 0 });
    return true;
  } finally {
    navigationResponses.dispose();
    page.off('request', requested);
    page.off('framenavigated', navigated);
    navigationPolicy?.clearCaptchaPost();
  }
}