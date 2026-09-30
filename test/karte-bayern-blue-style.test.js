'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const karteBayernBlueStyle = require('../styles/karte-bayern-blue.js');

function layer(style, id) {
  return style.layers.find(candidate => candidate.id === id);
}

test('Karte.Bayern blue profile keeps the overview road sweet spot and hides paths by default', () => {
  const style = karteBayernBlueStyle();

  assert.equal(style.name, 'karte-bayern-blue');
  assert.equal(style.tileSchema, 'karte-bayern-v1');
  assert.equal(style.background, '#f7f6f2');
  assert.deepEqual(layer(style, 'roads-major-low').filter, ['in', 'class', 'motorway', 'trunk', 'primary']);
  assert.deepEqual(layer(style, 'roads-connectors-mid').filter, ['in', 'class', 'secondary', 'tertiary']);
  assert.equal(layer(style, 'roads-connectors-mid').minzoom, 10);
  assert.equal(layer(style, 'roads-local').minzoom, 13);
  assert.deepEqual(layer(style, 'roads-local').filter, ['in', 'class', 'residential', 'unclassified', 'minor', 'living_street', 'service']);
  assert.deepEqual(layer(style, 'place-villages').filter, ['in', 'class', 'village']);
  assert.equal(layer(style, 'place-villages').minzoom, 10);
  assert.equal(layer(style, 'place-local').minzoom, 14);
  assert.deepEqual(layer(style, 'place-local').filter, ['in', 'class', 'hamlet', 'suburb', 'neighbourhood']);
  assert.ok(!style.layers.some(candidate => JSON.stringify(candidate.filter || []).match(/footway|path|track|cycleway/)));
});

test('Karte.Bayern blue keeps distant overviews intentionally sparse', () => {
  const style = karteBayernBlueStyle();
  assert.equal(layer(style, 'landuse-forest').minzoom, 10);
  assert.equal(layer(style, 'landuse-farmland').minzoom, 10);
  assert.equal(layer(style, 'buildings').minzoom, 13);
  assert.equal(layer(style, 'road-labels-major').minzoom, 11);
  assert.equal(layer(style, 'poi-circle').minzoom, 15);
});

test('Karte.Bayern blue enables pedestrian geometry only through its explicit outdoor option', () => {
  const style = karteBayernBlueStyle({ showOutdoorPaths: true });
  const outdoor = layer(style, 'outdoor-paths');

  assert.ok(outdoor);
  assert.equal(outdoor.minzoom, 16);
  assert.deepEqual(outdoor.filter, ['in', 'class', 'path', 'footway', 'cycleway', 'bridleway', 'steps', 'track']);
});

test('Karte.Bayern blue can opt into visible 2.5D building extrusions', () => {
  const style = karteBayernBlueStyle({ extrudeBuildings: true, buildingHeight: 18 });
  const extruded = layer(style, 'buildings');
  assert.equal(extruded.type, 'fill-extrusion');
  assert.deepEqual(extruded.paint.height, ['case', ['>', ['get', 'height'], 0], ['get', 'height'], 18]);
  assert.ok(style.layers.indexOf(extruded) > style.layers.indexOf(layer(style, 'roads-local')));
  assert.ok(style.layers.indexOf(extruded) < style.layers.indexOf(layer(style, 'road-labels-major')));
  assert.equal(extruded.paint.roofColor, '#e7e4df');
  assert.equal(layer(karteBayernBlueStyle({ buildings: false }), 'buildings'), undefined);
});

test('Karte.Bayern blue gives dense POIs room only at street-level zoom', () => {
  const style = karteBayernBlueStyle();
  assert.equal(layer(style, 'poi-circle').minzoom, 15);
  assert.equal(layer(style, 'poi-circle-detail').minzoom, 17);
  assert.equal(layer(style, 'poi-labels-detail').minzoom, 18);
  assert.ok(layer(style, 'poi-circle').filter.includes('defibrillator'));
  assert.equal(layer(style, 'poi-circle-detail').filter[0], '!in');
  assert.ok(layer(style, 'poi-circle-detail').filter.includes('defibrillator'));
});

test('Karte.Bayern themes keep layer order and change land, roads, water and labels together', () => {
  const baseline = karteBayernBlueStyle({ extrudeBuildings: true });
  assert.deepEqual(karteBayernBlueStyle.themes, ['warm', 'light', 'dark', 'night', 'contrast']);
  for (const theme of karteBayernBlueStyle.themes) {
    const style = karteBayernBlueStyle({ theme, extrudeBuildings: true });
    assert.deepEqual(style.layers.map(candidate => candidate.id), baseline.layers.map(candidate => candidate.id));
    assert.equal(style.tileSchema, baseline.tileSchema);
    assert.match(style.background, /^#[0-9a-f]{6}$/);
    assert.match(layer(style, 'water').paint.color, /^#[0-9a-f]{6}$/);
    assert.match(layer(style, 'roads-major-detail').paint.color, /^#[0-9a-f]{6}$/);
    assert.match(layer(style, 'buildings').paint.roofColor, /^#[0-9a-f]{6}$/);
    assert.match(layer(style, 'place-cities').paint['text-halo-color'], /^#[0-9a-f]{6}$/);
  }
  assert.equal(layer(karteBayernBlueStyle({ theme: 'dark' }), 'roads-major-detail').paint.color, '#efbd82');
  assert.equal(layer(karteBayernBlueStyle({ theme: 'night' }), 'roads-major-detail').paint.color, '#e7ae65');
  assert.equal(layer(karteBayernBlueStyle({ theme: 'contrast' }), 'roads-major-detail-casing').paint.color, '#111111');
  assert.equal(layer(karteBayernBlueStyle({ theme: 'contrast' }), 'place-cities').paint['text-color'], '#000000');
  assert.equal(karteBayernBlueStyle({ theme: 'invalid' }).name, baseline.name);
});

test('Karte.Bayern theme instances can be changed independently', () => {
  const first = karteBayernBlueStyle({ theme: 'dark' });
  first.layers[0].paint.color = '#ffffff';
  assert.equal(layer(karteBayernBlueStyle({ theme: 'dark' }), first.layers[0].id).paint.color, '#284038');
  assert.equal(layer(karteBayernBlueStyle(), first.layers[0].id).paint.color, '#d1e4d0');
});

test('Karte.Bayern can suppress dense secondary POIs without removing essential places', () => {
  const style = karteBayernBlueStyle({ theme: 'night', showDensePoints: false });
  assert.equal(layer(style, 'poi-circle-detail'), undefined);
  assert.equal(layer(style, 'poi-labels-detail'), undefined);
  assert.ok(layer(style, 'place-cities'));
  assert.ok(layer(style, 'poi-circle'));
});

test('Karte.Bayern blue validates the declared TileJSON source contract', () => {
  const tileJSON = {
    tilejson: '3.0.0',
    format: 'pbf',
    scheme: 'xyz',
    tiles: ['https://karte.bayern/tiles/{z}/{x}/{y}.mvt'],
    minzoom: 5,
    maxzoom: 14,
    bounds: [8.8, 47.2, 14, 50.6],
    'kb:tile_schema_version': '1',
    vector_layers: [
      { id: 'landuse', fields: { class: 'String' } },
      { id: 'water', fields: {} },
      { id: 'waterway', fields: { class: 'String', name: 'String' } },
      { id: 'building', fields: {} },
      { id: 'transportation', fields: { class: 'String', name: 'String' } },
      { id: 'poi', fields: { class: 'String', name: 'String' } },
      { id: 'housenumber', fields: { housenumber: 'String' } },
      { id: 'district', fields: { class: 'String' } }
    ]
  };

  assert.deepEqual(karteBayernBlueStyle.validateTileJSON(tileJSON), {
    valid: true,
    errors: [],
    warnings: []
  });
  for (const version of ['2', '3', 3]) {
    const result = karteBayernBlueStyle.validateTileJSON({ ...tileJSON, 'kb:tile_schema_version': version });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('Karte.Bayern blue rejects incompatible schema metadata before rendering', () => {
  const result = karteBayernBlueStyle.validateTileJSON({
    format: 'png',
    scheme: 'tms',
    tiles: ['https://example.test/tiles/{z}/{x}/{y}.png'],
    minzoom: 14,
    maxzoom: 5,
    bounds: [14, 50.6, 8.8, 47.2],
    'kb:tile_schema_version': '4',
    vector_layers: []
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('TileJSON format must be mvt or pbf.'));
  assert.ok(result.errors.includes('TileJSON scheme must be xyz.'));
  assert.ok(result.errors.includes('TileJSON needs a valid minzoom/maxzoom range.'));
  assert.ok(result.errors.includes('TileJSON needs valid geographic bounds.'));
  assert.ok(result.errors.includes('Unsupported Karte.Bayern tile schema version: 4.'));
  assert.ok(result.errors.includes('Missing required vector layer: transportation.'));
});
