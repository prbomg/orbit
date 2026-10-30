const { createHash } = require('node:crypto');
const cache = new Map();
function endpoint(value = process.env.WORKER_CAPGURU_BASE_URL || 'https://api.cap.guru') {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (!local && !['https://api2.cap.guru','https://api.cap.guru'].includes(url.origin))) throw new Error('Invalid captcha endpoint');
  return url.origin;
}
const safeCode = value => typeof value === 'string' && /^(?:ERROR_[A-Z_0-9]+|CAPCHA_NOT_READY|IP_BANNED|HTTP_[0-9]{3})$/.test(value) && value.length <= 80 ? value : 'PROVIDER_ERROR';
function requestError(code) { const error = new Error('Captcha API request failed'); error.code = code; return error; }
async function request(base, path, params, { signal, fetchImpl = fetch, method = 'POST', timeoutMs = 15000 } = {}) {
  const url = new URL(path, endpoint(base));
  if (method === 'GET') url.search = new URLSearchParams(params).toString();
  try {
  const response = await fetchImpl(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) } : {}) });
  if (!response.ok) { const e = new Error('Captcha provider HTTP error'); e.code = `HTTP_${response.status}`; throw e; }
  const text = (await response.text()).trim();
  if (text.length > 30000) throw requestError('ERROR_INVALID_RESPONSE');
  if (text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { throw requestError('ERROR_INVALID_JSON_RESPONSE'); }
    if (!data || typeof data !== 'object') throw requestError('ERROR_INVALID_RESPONSE');
    return Number(data.status) === 1 ? `OK|${data.request}` : safeCode(data.request);
  }
  return text;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error.cause?.code)) throw requestError('ERROR_REQUEST_TIMEOUT');
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code)) throw requestError('ERROR_DNS');
    if (error instanceof TypeError) throw requestError('ERROR_NETWORK');
    throw error;
  }
}
async function getBalance(apiKey, { baseUrl = endpoint(), fetchImpl = fetch, refresh = false } = {}) {
  if (!apiKey) return { balance: null, checkedAt: null, errorCode: null };
  const id = createHash('sha256').update(baseUrl + ':' + apiKey).digest('hex');
  const old = cache.get(id); if (old && (old.pending || !refresh && old.expires > Date.now())) return old.value;
  const entry = { pending: true, expires: 0 };
  entry.value = (async () => {
    try {
      const text = await request(baseUrl, '/res.php', { key: apiKey, action: 'getbalance' }, { method: 'GET', fetchImpl, timeoutMs: 8000 });
      const raw = text.replace(/^OK\|/, '');
      if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) return { balance: null, checkedAt: new Date().toISOString(), errorCode: safeCode(raw) };
      return { balance: Number(raw), checkedAt: new Date().toISOString(), errorCode: null };
    } catch (error) { return { balance: null, checkedAt: new Date().toISOString(), errorCode: safeCode(error.code) }; }
    finally { entry.pending = false; entry.expires = Date.now() + 30000; }
  })();
  cache.set(id, entry); if (cache.size > 64) cache.delete(cache.keys().next().value);
  return entry.value;
}
module.exports = { endpoint, request, getBalance, safeCode };
