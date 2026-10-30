// Default donor pool; configured sites are stored in Settings.
// CommonJS keeps this .js module usable by the existing Node worker and Next.js.
const donorSites = Object.freeze([
  'https://dzen.ru',
  'https://ozon.ru',
  'https://wikipedia.org',
  'https://vk.com',
  'https://mail.ru',
  'https://lenta.ru',
  'https://yandex.ru',
  'https://rambler.ru',
  'https://rbc.ru',
  'https://ria.ru',
  'https://tass.ru',
  'https://gazeta.ru',
  'https://kp.ru',
  'https://kommersant.ru',
  'https://iz.ru',
  'https://avito.ru',
  'https://wildberries.ru',
  'https://sport-express.ru',
  'https://habr.com',
  'https://github.com',
]);

function normalizeDonorSites(sites) {
  if (!Array.isArray(sites) || sites.length < 3) throw new Error('Укажите минимум 3 сайта для прогрева');
  const normalized = sites.map(value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Адрес сайта должен быть строкой длиной до 2048 символов');
    let parsed;
    try { parsed = new URL(value.trim()); } catch { throw new Error('Укажите полный адрес сайта, например https://example.com'); }
    const host = parsed.hostname;
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        !/^[a-z0-9.-]+$/i.test(host) || !host.includes('.') || /^[\d.]+$/.test(host) ||
        /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
      throw new Error('Нужен HTTP(S) адрес публичного сайта без логина и пароля');
    }
    parsed.hash = '';
    return parsed.href;
  });
  const unique = [...new Set(normalized)];
  if (new Set(unique.map(value => new URL(value).hostname.replace(/^www\./, ''))).size < 3) throw new Error('Нужны минимум три разных сайта');
  return unique;
}

function resolveDonorSites(settings, env = process.env) {
  if (settings?.warmupSites != null) return normalizeDonorSites(settings.warmupSites);
  if (env.ORBIT_WARMUP_DONOR_SITES !== undefined) {
    try { return normalizeDonorSites(JSON.parse(env.ORBIT_WARMUP_DONOR_SITES)); }
    catch { throw Object.assign(new Error('invalid_warmup_donor_sites'), {code:'invalid_warmup_donor_sites'}); }
  }
  return [...donorSites];
}

module.exports = { donorSites, normalizeDonorSites, resolveDonorSites };
