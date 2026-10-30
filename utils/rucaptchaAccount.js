const { createHash } = require('node:crypto');
const cache = new Map();

function endpoint() {
  const legacy = process.env.WORKER_CAPTCHA_BASE_URL || 'https://rucaptcha.com';
  const base = new URL(process.env.WORKER_CAPTCHA_V2_BASE_URL || (legacy.startsWith('http://') ? legacy : new URL(legacy).hostname === '2captcha.com' ? 'https://api.2captcha.com' : 'https://api.rucaptcha.com'));
  const local = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (!local && !['https://api.rucaptcha.com','https://api.2captcha.com'].includes(base.origin))) throw new Error('Invalid captcha endpoint');
  return base.origin;
}

async function getBalance(apiKey, { baseUrl = endpoint(), fetchImpl = fetch, refresh = false } = {}) {
  if (!apiKey) return { balance: null, checkedAt: null, errorCode: null };
  const identity = createHash('sha256').update(baseUrl + ':' + apiKey).digest('hex');
  const previous = cache.get(identity);
  if (previous && (previous.pending || (!refresh && previous.expiresAt > Date.now()))) return previous.value;
  const entry = { pending: true, expiresAt: 0, value: null };
  entry.value = (async () => {
    try {
      const response = await fetchImpl(baseUrl + '/getBalance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey }), signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) return { balance: null, checkedAt: new Date().toISOString(), errorCode: 'HTTP_' + response.status };
      const body = await response.json();
      if (body?.errorId !== 0) return { balance: null, checkedAt: new Date().toISOString(), errorCode: /^[A-Z_0-9]{1,80}$/.test(body?.errorCode || '') ? body.errorCode : 'PROVIDER_ERROR' };
      if (typeof body.balance !== 'number' || !Number.isFinite(body.balance) || body.balance < 0) throw new Error('Invalid balance');
      return { balance: body.balance, checkedAt: new Date().toISOString(), errorCode: null };
    } catch { return { balance: null, checkedAt: new Date().toISOString(), errorCode: 'BALANCE_UNAVAILABLE' }; }
    finally { entry.pending = false; entry.expiresAt = Date.now() + 30000; }
  })();
  cache.set(identity, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return entry.value;
}
module.exports = { getBalance, endpoint };
