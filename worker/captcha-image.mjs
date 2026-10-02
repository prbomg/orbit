import { CaptchaError, requestCaptchaSolution } from './captcha-provider.mjs';
import { TaskStoppedError, sleep } from './behavior.mjs';
// Keep responses from the current document, never refetch a challenge URL.
const capturedImages = new WeakMap();

export function startCaptchaImageCapture(context) {
  const frames = new WeakMap();
  capturedImages.set(context, frames);
  const pages = new Set();
  const navigated = frame => frames.delete(frame);
  const attach = page => {
    pages.add(page);
    page.on('framenavigated', navigated);
  };
  const receive = response => {
    try {
      if (response.request().resourceType() !== 'image' || !response.ok()) return;
      const frame = response.frame();
      let images = frames.get(frame);
      if (!images) { images = new Map(); frames.set(frame, images); }
      // Store only response handles; read bytes only for a detected puzzle.
      images.delete(response.url());
      images.set(response.url(), response);
      if (images.size > 32) images.delete(images.keys().next().value);
    } catch { /* Detached frame or unavailable response. */ }
  };
  context.on('response', receive);
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  return () => {
    context.off('response', receive);
    context.off('page', attach);
    for (const page of pages) page.off('framenavigated', navigated);
    capturedImages.delete(context);
  };
}

export async function detectYandexImagePuzzle(page) {
  for (const frame of page.frames()) {
    let elements;
    try {
      elements = await frame.locator('img, canvas').evaluateAll(nodes => nodes.map((node, index) => {
        const box = node.getBoundingClientRect();
        return { index, width: node.naturalWidth ?? node.width, height: node.naturalHeight ?? node.height,
          visible: box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden' };
      }));
    } catch { continue; }
    const mains = elements.filter(item => item.visible && item.width === 320 && item.height === 180);
    // Yandex's silhouette challenge uses a 480×80 instruction strip. RuCaptcha
    // expects a 480×180 instruction image, so captureAtSize adds padding.
    const instructions = elements.filter(item => item.visible && item.width === 480 && item.height >= 60 && item.height <= 180);
    if (mains.length === 1 && instructions.length === 1) {
      const locator = frame.locator('img, canvas');
      return { frame, main: locator.nth(mains[0].index), instruction: locator.nth(instructions[0].index) };
    }
  }
  return null;
}

async function renderAtSize(image, { width, height, dataUrl, sourceUrl }) {
  if (dataUrl) {
    if ((image.currentSrc ?? '') !== sourceUrl) throw new Error('Image changed');
    image = new Image(); image.src = dataUrl;
  }
  if (image instanceof HTMLImageElement) await image.decode();
  const sourceWidth = image.naturalWidth ?? image.width;
  const sourceHeight = image.naturalHeight ?? image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('Image not decoded');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#303035'; context.fillRect(0, 0, width, height);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const renderedWidth = sourceWidth * scale; const renderedHeight = sourceHeight * scale;
  context.drawImage(image, (width - renderedWidth) / 2, (height - renderedHeight) / 2, renderedWidth, renderedHeight);
  return canvas.toDataURL('image/png').split(',')[1];
}

async function captureAtSize(locator, width, height, signal, frame) {
  try {
    // Draw the decoded source at its intrinsic resolution. A screenshot of the
    // instruction strip can be only 120×20 CSS pixels on mobile; enlarging that
    // screenshot loses the shapes the solver needs to distinguish.
    try { return await locator.evaluate(renderAtSize, { width, height }); }
    catch (error) {
      if (!String(error.message).includes('SecurityError')) throw error;
    }
    // Read the exact HTTP response used by this document. Re-requesting the
    // URL can return a different puzzle. Resizing the live element for a
    // screenshot can clip it inside transformed/overflow-hidden containers.
    signal?.throwIfAborted();
    const source = await locator.evaluate(image => ({ url: image.currentSrc ?? '' }));
    const response = capturedImages.get(locator.page().context())?.get(frame)?.get(source.url);
    if (!response) throw new Error('Original image response unavailable');
    const contentType = response.headers()['content-type']?.split(';')[0].trim().toLowerCase();
    if (!contentType?.startsWith('image/')) throw new Error('Invalid image response');
    const body = await response.body();
    signal?.throwIfAborted();
    if (!body.length || body.length > 5_000_000) throw new Error('Invalid image size');
    return await locator.evaluate(renderAtSize, { width, height, sourceUrl: source.url,
      dataUrl: `data:${contentType};base64,${body.toString('base64')}` });
  } catch {
    signal?.throwIfAborted();
    throw new CaptchaError('image_capture_failed');
  }
}

export async function solveYandexImagePuzzle(page, puzzle, { prisma, config, signal, shouldContinue, log, taskId, navigationPolicy }) {
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { rucaptchaApiKey: true } });
  if (!settings?.rucaptchaApiKey) throw new CaptchaError('missing_api_key');
  const originalUrl = page.url();
  const image = await captureAtSize(puzzle.main, 320, 180, signal, puzzle.frame);
  const imgInstructions = await captureAtSize(puzzle.instruction, 480, 180, signal, puzzle.frame);
  log('captcha_requested', { taskId, provider: 'smartcaptcha_image' });
  const solution = await requestCaptchaSolution({ apiKey: settings.rucaptchaApiKey, type: 'smartcaptcha_image',
    params: { image, imgInstructions }, config, signal, shouldContinue });
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  if (page.url() !== originalUrl || puzzle.frame.isDetached()) throw new CaptchaError('page_changed');
  if (!Array.isArray(solution.coordinates)) throw new CaptchaError('invalid_coordinates');
  log('captcha_coordinates_received', { taskId, count: solution.coordinates.length });
  const formDetails = await puzzle.main.evaluate(image => {
    const form = image.closest('form');
    return form ? { action: form.action, method: form.method, hasPassword: Boolean(form.querySelector('input[type="password"]')) } : null;
  });
  const approvePost = actionUrl => {
    const action = new URL(actionUrl, originalUrl);
    if (action.origin !== new URL(originalUrl).origin) throw new CaptchaError('external_form_action');
    navigationPolicy.allowCaptchaPost(action.href);
  };
  if (formDetails?.hasPassword) throw new CaptchaError('unsupported_form');
  // Authorize before the last coordinate: some widgets submit automatically.
  if (formDetails?.method === 'post') approvePost(formDetails.action);
  try {
    // Yandex receives input on a layer over its <img>. Locator.click waits for
    // the image itself to receive events and times out when that layer covers it.
    const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    await puzzle.main.scrollIntoViewIfNeeded({ timeout: 5_000 });
    for (const [index, point] of solution.coordinates.entries()) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      const box = await puzzle.main.boundingBox();
      if (!box) throw new CaptchaError('image_changed');
      const x = box.x + (point.x + 0.5) * box.width / 320;
      const y = box.y + (point.y + 0.5) * box.height / 180;
      if (touch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      log('captcha_coordinate_applied', { taskId, step: index + 1, total: solution.coordinates.length, method: touch ? 'touch' : 'mouse' });
      await sleep(300, signal);
    }
    log('captcha_coordinates_applied', { taskId, count: solution.coordinates.length });
    const scope = formDetails ? puzzle.main.locator('xpath=ancestor::form[1]') : puzzle.frame;
    const submitName = /^(?:continue|submit|done|verify|confirm|next|продолжить|готово|проверить|отправить|подтвердить|далее|дальше)(?:\s|$)/i;
    let submit = scope.getByRole('button', { name: submitName }).first();
    if (formDetails) {
      const explicit = scope.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if (await explicit.count()) submit = explicit;
      else if (!await submit.count()) submit = scope.locator('button:not([type]):visible').first();
    }
    if (await submit.isVisible().catch(() => false)) {
      const target = await submit.evaluate(button => ({ action: button.hasAttribute('formaction') ? button.formAction : button.form?.action,
        method: button.hasAttribute('formmethod') ? button.formMethod : button.form?.method }));
      if (target.method === 'post') approvePost(target.action);
      log('captcha_submitting', { taskId, provider: 'smartcaptcha_image' });
      await submit.click({ timeout: config.navigationTimeoutMs ?? 15_000 });
    }
    try {
      await page.waitForURL(url => !/^\/showcaptcha(?:fast)?\/?$/.test(url.pathname), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch {
      signal?.throwIfAborted();
      throw new CaptchaError('submission_rejected');
    }
    log('captcha_submitted', { taskId, provider: 'smartcaptcha_image' });
    return true;
  } finally { navigationPolicy?.clearCaptchaPost(); }
}
