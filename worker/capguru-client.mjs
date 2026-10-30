import api from '../utils/capguruApi.js';

function normalizeProviderCode(raw) {
  const direct = api.safeCode(raw);
  if (direct && /^[A-Z_0-9]{1,80}$/.test(direct)) return direct;
  if (typeof raw === 'string') {
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    if (cleaned) return cleaned.startsWith('ERROR_') ? cleaned : `ERROR_${cleaned}`;
  }
  return 'ERROR_CAPTCHA_UNSOLVABLE';
}

export async function solveCapGuru(apiKey, baseUrl, pollingMs, params) {
  const base = api.endpoint(baseUrl);
  async function request(stage, path, payload, options) {
    try { return await api.request(base, path, payload, options); }
    catch (error) {
      if (error.code === 'ERROR_REQUEST_TIMEOUT') error.code = `ERROR_${stage}_TIMEOUT`;
      else if (error.code === 'ERROR_NETWORK') error.code = `ERROR_${stage}_NETWORK`;
      else if (error.code === 'ERROR_DNS') error.code = `ERROR_${stage}_DNS`;
      throw error;
    }
  }
  const instructionImage = params.imgInstructionsCapGuru ?? params.imgInstructions;
  const created = await request('SUBMIT', '/in.php', {
    key: apiKey,
    method: 'base64',
    body: params.image,
    body1: instructionImage,
    textinstructions: 'oth|yandex',
    coordinatescaptcha: '1',
  }, { timeoutMs: 30000 });
  if (!/^OK\|[a-zA-Z0-9_-]{1,100}$/.test(created)) {
    const e = new Error('Provider rejected task');
    e.code = normalizeProviderCode(created);
    throw e;
  }
  const id = created.slice(3);
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, Math.max(base.startsWith('http:') ? 1 : 5000, pollingMs || 5000)));
    const result = await request('POLL', '/res.php', { key: apiKey, action: 'get', id }, { method: 'GET' });
    if (result === 'CAPCHA_NOT_READY') continue;
    if (!result.startsWith('OK|')) {
      const e = new Error('Provider failed');
      e.code = normalizeProviderCode(result);
      throw e;
    }
    const raw = result.slice(3).replace(/^coordinates?:/, '');
    const entries = raw.split(';').filter(Boolean);
    const coordinates = entries.map(entry => {
      const match = /^x=(\d+),y=(\d+)$/.exec(entry.trim());
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    });
    if (!coordinates.length || coordinates.length > 20 || coordinates.some(p => !p || p.x >= 320 || p.y >= 180)) {
      const e = new Error('Invalid coordinates');
      e.code = 'INVALID_COORDINATES';
      throw e;
    }
    return { coordinates };
  }
}