import Captcha from '2captcha';

const safeCode = code => typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code) ? code : null;

function providerError(code) {
  const error = new Error('Captcha provider request failed');
  error.code = safeCode(code) ?? 'provider_error';
  return error;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw providerError(`HTTP_${response.status}`);
  const result = await response.json();
  if (!result || result.errorId !== 0) throw providerError(result?.errorCode);
  return result;
}

async function solveSmartCaptcha(apiKey, baseUrl, pollingMs, params, imageMode = false) {
  const withProxy = Boolean(params.proxyAddress);
  const task = imageMode ? {
    type: 'SmartCaptchaTask', image: params.image, imgInstructions: params.imgInstructions,
    comment: 'Select objects in the order shown by the instruction',
  } : {
    type: withProxy ? 'YandexSmartCaptchaTask' : 'YandexSmartCaptchaTaskProxyless',
    websiteURL: params.pageurl, websiteKey: params.sitekey, userAgent: params.userAgent,
    ...(withProxy ? { proxyType: params.proxyType, proxyAddress: params.proxyAddress, proxyPort: Number(params.proxyPort),
      proxyLogin: params.proxyLogin, proxyPassword: params.proxyPassword } : {}),
  };
  const created = await postJson(`${baseUrl}/createTask`, { clientKey: apiKey, task });
  if (!Number.isSafeInteger(created.taskId) || created.taskId <= 0) throw providerError('INVALID_TASK_ID');
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, pollingMs));
    const result = await postJson(`${baseUrl}/getTaskResult`, { clientKey: apiKey, taskId: created.taskId });
    if (result.status === 'processing') continue;
    if (result.status !== 'ready') throw providerError('INVALID_SOLUTION');
    if (imageMode) {
      const points = result.solution?.coordinates;
      if (!Array.isArray(points) || points.length < 1 || points.length > 20 || !points.every(point =>
        Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.x < 320 && point.y >= 0 && point.y < 180)) throw providerError('INVALID_COORDINATES');
      return { coordinates: points };
    }
    if (typeof result.solution?.token !== 'string' || !result.solution.token || result.solution.token.length > 30_000) throw providerError('INVALID_TOKEN');
    return { token: result.solution.token };
  }
}

// SDK endpoint getters are overridden to select RuCaptcha, 2Captcha or a local test server.
class ProviderSolver extends Captcha.Solver {
  constructor(key, baseUrl, pollingMs) { super(key, pollingMs, false); this.baseUrl = baseUrl; }
  get in() { return `${this.baseUrl}/in.php`; }
  get res() { return `${this.baseUrl}/res.php`; }
}

// Keep the SDK's recursive polling isolated so cancellation kills all outstanding timers/requests.
process.once('message', async ({ apiKey, baseUrl, v2BaseUrl, pollingMs, type, params }) => {
  try {
    const solution = type === 'smartcaptcha' || type === 'smartcaptcha_image'
      ? await solveSmartCaptcha(apiKey, v2BaseUrl, pollingMs, params, type === 'smartcaptcha_image')
      : { token: (await new ProviderSolver(apiKey, baseUrl, pollingMs).recaptcha(params)).data };
    if (solution.token !== undefined && (typeof solution.token !== 'string' || !solution.token || solution.token.length > 30_000)) throw providerError('INVALID_TOKEN');
    process.send({ ok: true, solution }, () => process.disconnect());
  } catch (error) {
    // Never forward provider exceptions: some include the key or request URL.
    // The v1 SDK uses numeric .code and keeps the provider string in .err.
    process.send({ ok: false, code: safeCode(error.code) ?? safeCode(error.err) ?? 'provider_error' }, () => process.disconnect());
  }
});
