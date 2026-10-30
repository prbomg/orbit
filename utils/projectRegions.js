const catalog = require('./yandexRegions.json');
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[\s-]+/g, ' ');
const byId = new Map(catalog.regions.map(region => [region.id, region]));
const aliases = { 'спб': '2', 'питер': '2', 'мск': '213' };
function regionLabel(project) {
  const name = byId.get(project.yandexRegionId)?.name || project.regionName?.trim();
  return name ? `${name} (${project.yandexRegionId})` : `Регион (${project.yandexRegionId})`;
}
function resolveRegion(value) {
  const text = String(value ?? '').trim(), key = normalize(text);
  const known = byId.get(text) || byId.get(aliases[key]);
  if (known) return known;
  const exact = catalog.regions.filter(region => normalize(region.name) === key || normalize(`${region.name} (${region.id})`) === key);
  if (exact.length === 1) return exact[0];
  return /^[1-9]\d{0,9}$/.test(text) && Number(text) <= 2147483647 ? { id: text, name: '' } : null;
}
function searchRegions(value, limit = 12) {
  const exact = resolveRegion(value);
  const key = normalize(exact?.name || value), alias = aliases[normalize(value)];
  if (!key) return ['213', '2', '54', '65', '43', '47'].map(id => byId.get(id));
  return catalog.regions.filter(region => region.id.startsWith(key) || normalize(region.name).includes(key) || region.id === alias)
    .sort((a, b) => Number(b.id === alias || b.id === key || normalize(b.name) === key) - Number(a.id === alias || a.id === key || normalize(a.name) === key) || Number(normalize(b.name).startsWith(key)) - Number(normalize(a.name).startsWith(key)) || a.name.localeCompare(b.name, 'ru'))
    .slice(0, limit);
}
module.exports = { regionLabel, resolveRegion, searchRegions };
