'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sources = require('../lib/microMap.sources.js');

test('OSM preset uses the official HTTPS endpoint, attribution and no prefetch policy', () => {
  const source = sources.osm();
  assert.deepEqual(source.tiles, ['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
  assert.equal(source.tileSize, 256); assert.equal(source.maxzoom, 19);
  assert.match(source.attribution, /openstreetmap.org\/copyright/);
  assert.equal(source.preload, undefined);
  assert.equal(source.referrerPolicy, undefined);
  source.tiles[0] = '/custom';
  assert.equal(sources.osm().tiles[0], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 'each call returns an independent definition');
});

test('Bayern WMTS presets select smerc matrices and retain provider coverage and credits', () => {
  for (const name of ['by_webkarte', 'by_webkarte_grau', 'by_label', 'by_amtl_karte', 'by_dop', 'by_dop_cir']) {
    const source = sources.bayernRaster(name);
    assert.equal(source.tiles[0], 'https://wmtsod1.bayernwolke.de/wmts/' + name + '/smerc/{z}/{x}/{y}');
    assert.equal(source.tileSize, 256); assert.equal(source.minzoom, 0); assert.equal(source.maxzoom, 19);
    assert.deepEqual(source.bounds, [8.945107890491915, 47.248466288051446, 13.90891310401004, 50.57987000589413]);
    assert.match(source.attribution, /Bayerische Vermessungsverwaltung/);
    assert.match(source.attribution, name.includes('dop') ? /Copernicus/ : /BKG/);
  }
  const source = sources.bayernRaster();
  source.bounds[0] = 0;
  assert.equal(sources.bayernRaster().bounds[0], 8.945107890491915);
  for (const name of ['invalid', '__proto__', 'toString']) assert.throws(() => sources.bayernRaster(name), /unknown Bayern raster/);
});

test('Bayern vector URLs use the official style catalogue with light as default', () => {
  assert.equal(sources.bayernVector(), 'https://vtod1.bayernwolke.de/styles/by_style_light.json');
  for (const style of ['standard', 'grau', 'luftbild', 'nacht', 'wandern', 'radln', 'oepnv', 'baeume', 'gelaende', 'hangneigung', 'winter']) {
    assert.equal(sources.bayernVector(style), 'https://vtod1.bayernwolke.de/styles/by_style_' + style + '.json');
  }
  assert.throws(() => sources.bayernVector('../other'), /unknown Bayern vector/);
});

test('source presets require no DOM or renderer and also expose browser globals', () => {
  const source = fs.readFileSync(require.resolve('../lib/microMap.sources.js'), 'utf8');
  const standalone = {}; vm.runInNewContext(source, standalone);
  assert.equal(typeof standalone.microMapSources.bayernRaster, 'function');
  const attached = { microMap() {} }; vm.runInNewContext(source, attached);
  assert.equal(attached.microMap.sources, attached.microMapSources);
});
