import test from 'node:test';
import assert from 'node:assert/strict';
import regions from '../utils/projectRegions.js';
import catalog from '../utils/yandexRegions.json' with { type: 'json' };

test('region catalogue IDs stay unambiguous and every suggestion resolves to the same ID', () => {
  assert.equal(new Set(catalog.regions.map(r => r.id)).size, catalog.regions.length);
  for (const region of catalog.regions) {
    assert.match(region.id, /^[1-9]\d*$/);
    assert.ok(region.name.length <= 100);
    assert.deepEqual(regions.resolveRegion(`${region.name} (${region.id})`), region);
  }
});
test('name search handles case, ё, aliases and exact matches ahead of larger regions', () => {
  assert.equal(regions.searchRegions('моск')[0].id, '213');
  assert.equal(regions.resolveRegion(' МОСКВА ').id, '213');
  assert.equal(regions.resolveRegion('орел').id, '10');
  assert.equal(regions.searchRegions('спб')[0].id, '2');
  assert.equal(regions.resolveRegion('213').name, 'Москва');
  assert.equal(regions.searchRegions('Москва (213)')[0].id, '213');
  assert.equal(regions.resolveRegion('Моск'), null);
  assert.equal(regions.resolveRegion('несуществующий город'), null);
});
test('legacy and out-of-catalogue numeric regions survive without assigning another region', () => {
  assert.deepEqual(regions.resolveRegion('999999'), {id:'999999',name:''});
  for (const value of ['0','-1','2147483648','000213','213other','']) assert.equal(regions.resolveRegion(value), null);
  assert.equal(regions.regionLabel({yandexRegionId:'213',regionName:''}), 'Москва (213)');
  assert.equal(regions.regionLabel({yandexRegionId:'999999',regionName:'Сохранённый регион'}), 'Сохранённый регион (999999)');
  assert.equal(regions.regionLabel({yandexRegionId:'999999',regionName:''}), 'Регион (999999)');
});
