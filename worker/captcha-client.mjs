import { solveCapGuru } from './capguru-client.mjs';
import Captcha from '2captcha';

const safeCode = code => typeof code === 'string' && /^[A-Za-z_0-9-]{1,80}$/.test(code) ? code : null;

function providerError(code) {
  const error = new Error('Captcha provider request failed');
  error.code = safeCode(code) ?? 'provider_error';
  return error;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw providerError(`HTTP_${response.status}`);
  const result = await response.json();
  if (!result || result.errorId !== 0) {
    throw providerError(result?.errorCode || result?.errorDescription || 'API_V2_ERROR');
  }
  return result;
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw providerError(`HTTP_${response.status}`);
  const result = await response.json();
  if (!result || result.status !== 1) {
    throw providerError(result?.request || 'API_V1_ERROR');
  }
  return result;
}

function normalizePoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return null;
  const points = rawPoints.map(p => ({
    x: Math.round(Number(p?.x)),
    y: Math.round(Number(p?.y)),
  }));
  if (points.length < 1 || points.length > 20 || !points.every(point =>
    Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 320 && point.y >= 0 && point.y <= 180)) {
    return null;
  }
  return points.map(p => ({
    x: Math.min(319, Math.max(0, p.x)),
    y: Math.min(179, Math.max(0, p.y)),
  }));
}

function parseV1Coordinates(raw) {
  if (Array.isArray(raw)) return normalizePoints(raw);
  if (typeof raw !== 'string') return null;
  const points = [];
  for (const match of raw.matchAll(/x=(\d+(?:\.\d+)?),y=(\d+(?:\.\d+)?)/g)) {
    points.push({ x: parseFloat(match[1]), y: parseFloat(match[2]) });
  }
  return normalizePoints(points);
}

async function solveSmartCaptcha(apiKey, baseUrl, pollingMs, params, imageMode = false, textMode = false) {
  const targetUrl = (baseUrl || 'https://api.rucaptcha.com').replace(/\/+$/, '');
  const isApiV2 = targetUrl.includes('api.rucaptcha.com') || targetUrl.includes('api.2captcha.com') || targetUrl.includes('createTask');
  const withProxy = Boolean(params.proxyAddress && params.proxyPort);

  if (isApiV2) {
    const cleanBaseUrl = targetUrl.replace(/\/(?:api\/v2|createTask|getTaskResult)\/?$/, '');

    const task = textMode ? {
      type: 'ImageToTextTask',
      body: params.image,
      phrase: false,
      case: false,
      numeric: 2,
      comment: params.comment || 'Введите русские слова с картинки через пробел',
    } : imageMode ? {
      type: 'CoordinatesTask',
      body: params.image,
      imgInstructions: params.imgInstructions,
      comment: 'Кликните в таком порядке | Select objects in the order shown by the instruction',
    } : {
      type: withProxy ? 'YandexSmartCaptchaTask' : 'YandexSmartCaptchaTaskProxyless',
      websiteURL: params.pageurl,
      websiteKey: params.sitekey,
      userAgent: params.userAgent,
      ...(params.cookies ? { cookies: params.cookies } : {}),
      ...(withProxy ? {
        proxyType: params.proxyType?.toLowerCase() || 'http',
        proxyAddress: params.proxyAddress,
        proxyPort: Number(params.proxyPort),
        ...(params.proxyLogin ? { proxyLogin: params.proxyLogin } : {}),
        ...(params.proxyPassword ? { proxyPassword: params.proxyPassword } : {}),
      } : {}),
    };

    const created = await postJson(`${cleanBaseUrl}/createTask`, {
      clientKey: apiKey,
      task,
      ...(textMode || imageMode ? { languagePool: 'rn' } : {}),
    });
    if (!Number.isSafeInteger(created.taskId) || created.taskId <= 0) throw providerError('INVALID_TASK_ID');

    for (;;) {
      await new Promise(resolve => setTimeout(resolve, pollingMs));
      const result = await postJson(`${cleanBaseUrl}/getTaskResult`, { clientKey: apiKey, taskId: created.taskId });
      if (result.status === 'processing') continue;
      if (result.status !== 'ready') throw providerError('INVALID_SOLUTION');

      if (textMode) {
        const text = result.solution?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 200) {
          throw providerError('INVALID_SOLUTION');
        }
        return { text: text.trim() };
      }

      if (imageMode) {
        const rawPoints = result.solution?.coordinates ?? result.solution?.points;
        const points = normalizePoints(rawPoints);
        if (!points) throw providerError('INVALID_COORDINATES');
        return { coordinates: points };
      }

      if (typeof result.solution?.token !== 'string' || !result.solution.token || result.solution.token.length > 30_000) {
        throw providerError('INVALID_TOKEN');
      }
      return { token: result.solution.token };
    }
  } else {
    const cleanBaseUrl = targetUrl.replace(/\/(?:in\.php|res\.php)\/?$/, '');
    const payload = textMode ? {
      key: apiKey,
      method: 'base64',
      body: params.image,
      language: 1,
      lang: 'ru',
      regsense: 0,
      numeric: 2,
      json: 1,
      ...(params.comment ? { textinstructions: params.comment } : {}),
    } : imageMode ? {
      key: apiKey,
      method: 'base64',
      coordinatescaptcha: 1,
      body: params.image,
      imginstructions: params.imgInstructions,
      textinstructions: 'Кликните в таком порядке | Select objects in the order shown by the instruction',
      lang: 'ru',
      json: 1,
    } : {
      key: apiKey,
      method: 'yandex',
      sitekey: params.sitekey,
      pageurl: params.pageurl,
      json: 1,
      ...(withProxy ? {
        proxy: `${params.proxyLogin ? `${params.proxyLogin}:${params.proxyPassword}@` : ''}${params.proxyAddress}:${params.proxyPort}`,
        proxytype: params.proxyType?.toUpperCase() || 'HTTP',
      } : {}),
    };

    const created = await postForm(`${cleanBaseUrl}/in.php`, payload);
    const taskId = created.request;

    for (;;) {
      await new Promise(resolve => setTimeout(resolve, pollingMs));
      const res = await fetch(`${cleanBaseUrl}/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(taskId)}&json=1`);
      if (!res.ok) throw providerError(`HTTP_${res.status}`);
      const result = await res.json();
      if (result.status === 0 && result.request === 'CAPCHA_NOT_READY') continue;
      if (result.status !== 1) throw providerError(result.request);

      if (textMode) {
        if (typeof result.request !== 'string' || !result.request.trim() || result.request.length > 200) {
          throw providerError('INVALID_SOLUTION');
        }
        return { text: result.request.trim() };
      }

      if (imageMode) {
        const points = parseV1Coordinates(result.request);
        if (!points) throw providerError('INVALID_COORDINATES');
        return { coordinates: points };
      }

      if (typeof result.request !== 'string' || !result.request || result.request.length > 30_000) {
        throw providerError('INVALID_TOKEN');
      }
      return { token: result.request };
    }
  }
}

class ProviderSolver extends Captcha.Solver {
  constructor(key, baseUrl, pollingMs) {
    super(key, pollingMs, false);
    this.baseUrl = (baseUrl || 'https://rucaptcha.com').replace(/\/+$/, '');
  }
  get in() { return `${this.baseUrl}/in.php`; }
  get res() { return `${this.baseUrl}/res.php`; }
}

process.once('message', async ({ apiKey, baseUrl, v2BaseUrl, pollingMs, type, params, service, capguruBaseUrl }) => {
  try {
    const solution = service === 'capguru'
      ? await solveCapGuru(apiKey, capguruBaseUrl, pollingMs, params)
      : (type === 'smartcaptcha' || type === 'smartcaptcha_image' || type === 'smartcaptcha_text')
        ? await solveSmartCaptcha(
            apiKey,
            v2BaseUrl || baseUrl,
            pollingMs,
            params,
            type === 'smartcaptcha_image',
            type === 'smartcaptcha_text'
          )
        : { token: (await new ProviderSolver(apiKey, baseUrl, pollingMs).recaptcha(params)).data };

    if (solution.token !== undefined && (typeof solution.token !== 'string' || !solution.token || solution.token.length > 30_000)) {
      throw providerError('INVALID_TOKEN');
    }
    if (solution.text !== undefined && (typeof solution.text !== 'string' || !solution.text || solution.text.length > 200)) {
      throw providerError('INVALID_SOLUTION');
    }
    process.send({ ok: true, solution }, () => process.disconnect());
  } catch (error) {
    const rawError = String(error?.code ?? error?.err ?? error?.message ?? 'provider_error').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    process.send({
      ok: false,
      code: safeCode(rawError) ?? 'provider_error',
    }, () => process.disconnect());
  }
});