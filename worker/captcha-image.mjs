import { CaptchaError, requestCaptchaSolution } from './captcha-provider.mjs';
import { TaskStoppedError, sleep } from './behavior.mjs';

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

async function captureAtSize(locator, width, height) {
  try {
    // Draw the decoded source at its intrinsic resolution. A screenshot of the
    // instruction strip can be only 120×20 CSS pixels on mobile; enlarging that
    // screenshot loses the shapes the solver needs to distinguish.
    return await locator.evaluate(async (image, { width, height }) => {
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
    }, { width, height });
  } catch { throw new CaptchaError('image_capture_failed'); }
}

export async function solveYandexImagePuzzle(page, puzzle, { prisma, config, signal, shouldContinue, log, taskId }) {
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { rucaptchaApiKey: true } });
  if (!settings?.rucaptchaApiKey) throw new CaptchaError('missing_api_key');
  const originalUrl = page.url();
  const image = await captureAtSize(puzzle.main, 320, 180);
  const imgInstructions = await captureAtSize(puzzle.instruction, 480, 180);
  log('captcha_requested', { taskId, provider: 'smartcaptcha_image' });
  const solution = await requestCaptchaSolution({ apiKey: settings.rucaptchaApiKey, type: 'smartcaptcha_image',
    params: { image, imgInstructions }, config, signal, shouldContinue });
  signal?.throwIfAborted();
  if (!(await shouldContinue())) throw new TaskStoppedError();
  if (page.url() !== originalUrl || puzzle.frame.isDetached()) throw new CaptchaError('page_changed');
  if (!Array.isArray(solution.coordinates)) throw new CaptchaError('invalid_coordinates');
  log('captcha_coordinates_received', { taskId, count: solution.coordinates.length });
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
  const submit = puzzle.frame.getByRole('button', { name: /^(?:continue|submit|done|verify|продолжить|готово|проверить|отправить)$/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    log('captcha_submitting', { taskId, provider: 'smartcaptcha_image' });
    await submit.click();
  }
  try {
    await page.waitForURL(url => !/^\/showcaptcha(?:fast)?\/?$/.test(url.pathname), { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch { throw new CaptchaError('submission_rejected'); }
  log('captcha_submitted', { taskId, provider: 'smartcaptcha_image' });
  return true;
}
