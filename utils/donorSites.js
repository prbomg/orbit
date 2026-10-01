// Editable donor pool; each warmup session samples three different sites.
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

module.exports = { donorSites };
