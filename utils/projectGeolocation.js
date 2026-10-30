const { randomBytes, createHash } = require('node:crypto');
const regions = require('./yandexRegions.json');
const byId = new Map(regions.regions.map(region => [region.id, region]));
const EARTH_KM = 6371.0088;
const rad = value => value * Math.PI / 180;
const deg = value => value * 180 / Math.PI;

function locationArea(project) {
  const config = project.geolocation ?? { mode: 'region' };
  if (!['off', 'region', 'manual'].includes(config.mode)) throw Error('invalid_project_geolocation');
  if (config.mode === 'off') return null;
  const city = byId.get(project.yandexRegionId)?.geolocation;
  // An omitted radius preserves the catalog radius of existing projects.
  const area = config.mode === 'manual' ? config : city && { ...city, radiusKm: config.radiusKm ?? city.radiusKm };
  if (!area) return null; // Countries and unknown IDs have no invented city coordinates.
  if (![area.latitude, area.longitude, area.radiusKm].every(Number.isFinite) ||
      Math.abs(area.latitude) > 85 || Math.abs(area.longitude) > 180 || area.radiusKm < 0 || area.radiusKm > 50) {
    throw new Error('invalid_project_geolocation');
  }
  return { latitude: area.latitude, longitude: area.longitude, radiusKm: area.radiusKm,
    source: config.mode === 'manual' ? 'project-settings' : area.source };
}
function locationKey(project, area = locationArea(project)) {
  return area ? createHash('sha256').update(JSON.stringify([1, project.id, project.yandexRegionId, area])).digest('hex') : null;
}
function createProjectLocation(project, { random = () => randomBytes(4).readUInt32BE(0) / 0x100000000, now = new Date() } = {}) {
  const area = locationArea(project);
  if (!area) return null;
  // Uniform surface area within the configured spherical cap, not uniform radius.
  const unit = () => { const n = random(); if (!(n >= 0 && n < 1)) throw Error('invalid_location_random'); return n; };
  const distance = Math.acos(1 - unit() * (1 - Math.cos(area.radiusKm / EARTH_KM)));
  const bearing = 2 * Math.PI * unit(), lat = rad(area.latitude), lon = rad(area.longitude);
  const latitude = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
  const longitude = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(latitude));
  return { version: 1, projectId: project.id, regionId: project.yandexRegionId,
    // Seven decimal places survive the Prisma/SQLite JSON round trip exactly.
    configurationKey: locationKey(project, area), latitude: Number(deg(latitude).toFixed(7)), longitude: Number((((deg(longitude) + 540) % 360) - 180).toFixed(7)),
    accuracy: 14 + Math.floor(unit() * 25), createdAt: now.toISOString(), source: 'project-geolocation-emulation', area };
}
function validProjectLocation(value, project) {
  const area = locationArea(project);
  if (!area) return false;
  const a = rad(value?.latitude), b = rad(area.latitude), delta = rad(value?.longitude - area.longitude);
  const cosine = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(delta);
  const distanceKm = EARTH_KM * Math.acos(Math.max(-1, Math.min(1, cosine)));
  return value?.version === 1 && value.projectId === project.id && value.regionId === project.yandexRegionId &&
    value.configurationKey === locationKey(project) && distanceKm <= area.radiusKm + 0.0002 && [value.latitude, value.longitude, value.accuracy].every(Number.isFinite) &&
    Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180 && value.accuracy >= 14 && value.accuracy <= 38;
}
function browserGeolocation(location) {
  if (!location) return undefined;
  const { latitude, longitude, accuracy } = location;
  if (![latitude, longitude, accuracy].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 14 || accuracy > 38) throw Error('invalid_project_geolocation');
  return { latitude, longitude, accuracy };
}
function locationOrigins(project) {
  const origins = new Set(['https://ya.ru', 'https://yandex.ru', 'https://www.yandex.ru']);
  try { const url = new URL(project.targetUrl); if (['https:', 'http:'].includes(url.protocol)) origins.add(url.origin); } catch { /* validated by project API */ }
  return [...origins];
}
module.exports = { locationArea, locationKey, createProjectLocation, validProjectLocation, browserGeolocation, locationOrigins };
