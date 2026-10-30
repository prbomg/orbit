const SEARCH_ENGINES = Object.freeze({
  yandex: Object.freeze({ home: 'https://ya.ru/', domains: Object.freeze(['ya.ru', 'yandex.ru', 'yandex.com']) }),
  mail: Object.freeze({ home: 'https://mail.ru/', domains: Object.freeze(['mail.ru', 'ya.ru', 'yandex.ru', 'yandex.com']) }),
  dzen: Object.freeze({ home: 'https://dzen.ru/', domains: Object.freeze(['dzen.ru', 'ya.ru', 'yandex.ru', 'yandex.com']) }),
});
const SEARCH_ENGINE_NAMES = Object.freeze(Object.keys(SEARCH_ENGINES));
const DEFAULT_SEARCH_DEPTH = 3;
const MIN_SEARCH_DEPTH = 1;
const MAX_SEARCH_DEPTH = 10;

function parseSearchDepth(value = DEFAULT_SEARCH_DEPTH) {
  if (!Number.isInteger(value) || value < MIN_SEARCH_DEPTH || value > MAX_SEARCH_DEPTH) {
    throw new Error('Глубина поиска: целое число от 1 до 10 страниц.');
  }
  return value;
}

// Preserve the historical boolean option: true means Yandex, not every engine.
function searchEngineDomains(engine) {
  const name = engine === true ? 'yandex' : engine;
  return SEARCH_ENGINE_NAMES.includes(name) ? SEARCH_ENGINES[name].domains : [];
}

function normalizeTargetDomain(value) {
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  if (!name || /[\s/:@?#\\]/.test(name)) throw new Error('Target must be a bare hostname');
  const parsed = new URL(`https://${name}`);
  const hostname = parsed.hostname;
  if (hostname.length > 253 || !hostname.split('.').every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error('Invalid target hostname');
  return hostname;
}

function phraseList(value = []) {
  if (!Array.isArray(value) || value.length > 100 || value.some(phrase => typeof phrase !== 'string' || !phrase.trim() || phrase.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(phrase))) {
    throw new Error('Invalid phrase list');
  }
  return [...new Set(value.map(phrase => phrase.trim()))];
}

function searchTaskConfig(task) {
  const searchEngine = task.searchEngine ?? '';
  const searchQueries = phraseList(task.searchQueries);
  const vitalPhrases = phraseList(task.vitalPhrases);
  const targetDomain = task.targetDomain ?? (searchEngine && task.project?.targetUrl ? new URL(task.project.targetUrl).hostname : '');
  if (!searchEngine && !searchQueries.length && !vitalPhrases.length && !targetDomain) return null;
  if (!SEARCH_ENGINE_NAMES.includes(searchEngine) || !searchQueries.length || !targetDomain) throw new Error('Incomplete search task');
  return { searchEngine, searchQueries, vitalPhrases, searchDepth: parseSearchDepth(task.searchDepth), targetDomain: normalizeTargetDomain(targetDomain) };
}

module.exports = { SEARCH_ENGINES, SEARCH_ENGINE_NAMES, DEFAULT_SEARCH_DEPTH, MIN_SEARCH_DEPTH, MAX_SEARCH_DEPTH, parseSearchDepth, searchEngineDomains, normalizeTargetDomain, phraseList, searchTaskConfig };
