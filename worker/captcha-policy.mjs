// Keep the established effective budget while accepting legacy environment values.
export const CAPTCHA_MAX_SOLVES = 25;
export const CAPTCHA_MAX_INCORRECT = 20;
export const CAPTCHA_TIMEOUT_MS = 45_000;

export function captchaBudgets(config = {}) {
  const value = (input, fallback, name) => {
    if (input === undefined) return fallback;
    if (!Number.isSafeInteger(input) || input < 1 || input > 25) throw new Error(`Invalid ${name}`);
    // Previously values 1–10 were accepted but ignored by the handler's floors.
    return input < 20 ? fallback : input;
  };
  const maxSolves = value(config.captchaMaxSolves, CAPTCHA_MAX_SOLVES, 'WORKER_CAPTCHA_MAX_SOLVES');
  const maxIncorrect = Math.min(maxSolves, value(config.captchaMaxIncorrect, CAPTCHA_MAX_INCORRECT, 'WORKER_CAPTCHA_MAX_INCORRECT'));
  return { maxSolves, maxIncorrect };
}

export function captchaTimeout(config = {}) {
  const requestedMs = config.captchaTimeoutMs ?? CAPTCHA_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestedMs) || requestedMs < 1 || requestedMs > 3_600_000) throw new Error('Invalid WORKER_CAPTCHA_TIMEOUT_MS');
  return { requestedMs, effectiveMs: Math.min(requestedMs, CAPTCHA_TIMEOUT_MS) };
}
