import { CaptchaError, requestCaptchaSolution } from './captcha-provider.mjs';

const ignored = new Set([
  'aborted',
  'task_check_failed',
  'solve_limit',
  'incorrect_limit',
  'page_changed',
  'image_changed',
  'image_capture_failed',
  'submission_timeout',
  'submission_not_sent',
  'submission_navigation_failed',
  'search_rate_limited',
]);

export function createImageCaptchaRouter(settings, { log = () => {}, request = requestCaptchaSolution } = {}) {
  const apiKey = settings?.rucaptchaApiKey;
  let failures = 0;

  const failed = error => {
    if (!(error instanceof CaptchaError) || ignored.has(error.code)) return false;
    failures++;
    log('captcha_service_failed', { service: 'rucaptcha', code: error.code, failures, threshold: 20 });
    return false;
  };

  return {
    failed,
    accepted() { failures = 0; },
    async solve(options, onRequest) {
      if (!apiKey) throw new CaptchaError('missing_api_key');
      options.signal?.throwIfAborted();
      onRequest();
      log('captcha_service_selected', { service: 'rucaptcha' });
      try {
        return await request({ ...options, service: 'rucaptcha', apiKey, type: 'smartcaptcha_image' });
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof CaptchaError) || ignored.has(error.code)) throw error;
        failed(error);
        throw error;
      }
    },
  };
}