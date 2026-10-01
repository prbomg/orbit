const SEARCH_ENGINE_NAMES = Object.freeze(['yandex', 'mail', 'dzen']);

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
  return { searchEngine, searchQueries, vitalPhrases, targetDomain: normalizeTargetDomain(targetDomain) };
}

module.exports = { SEARCH_ENGINE_NAMES, normalizeTargetDomain, phraseList, searchTaskConfig };
