'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

class RecordingContext {
  constructor() {
    this.operations = [];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.state = [];
  }
  setTransform(...values) { this.operations.push(['setTransform', ...values]); }
  clearRect(...values) { this.operations.push(['clearRect', ...values]); }
  save() {
    this.operations.push(['save']);
    this.state.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline });
  }
  restore() { this.operations.push(['restore']); Object.assign(this, this.state.pop() || {}); }
  beginPath() { this.operations.push(['beginPath']); }
  moveTo(...values) { this.operations.push(['moveTo', ...values]); }
  lineTo(...values) { this.operations.push(['lineTo', ...values]); }
  closePath() { this.operations.push(['closePath']); }
  fill(...values) { this.operations.push(['fill', this.fillStyle, this.globalAlpha, ...values]); }
  stroke(...values) { this.operations.push(['stroke', this.strokeStyle, this.lineWidth, this.globalAlpha, ...values]); }
  arc(...values) { this.operations.push(['arc', ...values]); }
  fillText(...values) { this.operations.push(['fillText', ...values]); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.clientWidth = 256;
    this.clientHeight = 256;
    if (this.tagName === 'CANVAS') this.context = new RecordingContext();
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index > -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(handler);
    if (index > -1) list.splice(index, 1);
  }
  dispatch(type, values = {}) {
    const event = { type, target: this, pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...values };
    for (const handler of (this.listeners[type] || []).slice()) handler(event);
    return event;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext(kind) { return kind === '2d' ? this.context : null; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  focus() { global.document.activeElement = this; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const originalGlobals = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio']) originalGlobals[name] = global[name];

global.document = {
  activeElement: null,
  querySelector() { return null; },
  createElement(tagName) { return new FakeElement(tagName); },
  addEventListener() {},
  removeEventListener() {}
};
global.getComputedStyle = () => ({ position: 'static' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = FakeResizeObserver;
global.devicePixelRatio = 1;

const microMap = require('../lib/microMap.js');
const microMapGeoJSON = require('../lib/microMap.geojson.js');
const microMapField = require('../lib/microMap.field.js');

function wait(milliseconds = 25) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createMap(overrides = {}) {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 0, zoomAnimation: false, ...overrides });
  return { container, map };
}

test('renders mutable GeoJSON source/layer overlays and returns topmost feature copies', async () => {
  const { container, map } = createMap();
  const overlay = microMapGeoJSON(map);
  overlay.addSource('shapes', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'area', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[[-135, -35], [-45, -35], [-45, 35], [-135, 35]]] } },
        { type: 'Feature', id: 'route', properties: { kind: 'road', color: '#c33' }, geometry: { type: 'LineString', coordinates: [[-90, 0], [90, 0]] } },
        { type: 'Feature', id: 'poi', properties: { kind: 'poi' }, geometry: { type: 'Point', coordinates: [90, 0] } }
      ]
    }
  });
  overlay.addLayer({ id: 'area-fill', type: 'fill', source: 'shapes', paint: { 'fill-color': '#8ca', 'fill-opacity': 0.7 } });
  overlay.addLayer({ id: 'route-line', type: 'line', source: 'shapes', filter: ['==', 'kind', 'road'], paint: { 'line-color': ['get', 'color'], 'line-width': 4 } });
  overlay.addLayer({ id: 'poi-circle', type: 'circle', source: 'shapes', filter: ['==', 'kind', 'poi'], paint: { 'circle-color': '#148', 'circle-radius': 6 } });
  await wait();

  const canvas = overlay.getCanvas();
  const operations = canvas.getContext('2d').operations;
  assert.ok(operations.some(operation => operation[0] === 'fill'));
  assert.ok(operations.some(operation => operation[0] === 'stroke' && operation[1] === '#c33'));
  assert.ok(operations.some(operation => operation[0] === 'arc'));

  const hits = overlay.queryRenderedFeatures([192, 128]);
  assert.deepEqual(hits.map(feature => feature.layer.id), ['poi-circle', 'route-line']);
  assert.equal(hits[0].id, 'poi');
  assert.deepEqual(hits[0].layer, { id: 'poi-circle', type: 'circle', source: 'shapes' });
  assert.deepEqual(overlay.queryRenderedFeatures([192, 128], { layers: ['route-line'], radius: 0 }).map(feature => feature.id), ['route']);
  assert.deepEqual(overlay.queryRenderedFeatures([64, 128], { layers: ['area-fill'] }).map(feature => feature.id), ['area']);

  hits[0].properties.kind = 'mutated';
  hits[0].geometry.coordinates[0] = 0;
  const fresh = overlay.queryRenderedFeatures([192, 128], { layers: ['poi-circle'] });
  assert.equal(fresh[0].properties.kind, 'poi');
  assert.notEqual(fresh[0].geometry.coordinates[0], 0);

  overlay.setLayoutProperty('poi-circle', 'visibility', 'none');
  assert.deepEqual(overlay.queryRenderedFeatures([192, 128]).map(feature => feature.layer.id), ['route-line']);
  overlay.setLayoutProperty('poi-circle', 'visibility', 'visible');

  let clicked;
  overlay.on('click', 'poi-circle', event => { clicked = event; });
  container.dispatch('pointerdown', { clientX: 192, clientY: 128 });
  container.dispatch('pointerup', { clientX: 192, clientY: 128 });
  assert.ok(clicked);
  assert.deepEqual(clicked.features.map(feature => feature.id), ['poi']);

  const source = overlay.getSource('shapes');
  source.setData({ type: 'Feature', id: 'new-poi', properties: { kind: 'poi' }, geometry: { type: 'Point', coordinates: [0, 0] } });
  await wait();
  assert.deepEqual(overlay.queryRenderedFeatures([192, 128], { layers: ['poi-circle'] }), []);
  assert.deepEqual(overlay.queryRenderedFeatures([128, 128], { layers: ['poi-circle'] }).map(feature => feature.id), ['new-poi']);
  const data = source.getData();
  data.features[0].properties.kind = 'mutated';
  assert.equal(source.getData().features[0].properties.kind, 'poi');

  map.setBearing(40).setPitch(30);
  await wait();
  const transformed = map.project([0, 0]);
  assert.deepEqual(overlay.queryRenderedFeatures(transformed, { layers: ['poi-circle'], radius: 0 }).map(feature => feature.id), ['new-poi']);
  overlay.destroy();
  assert.equal(canvas.parentNode, null);
  assert.deepEqual(overlay.queryRenderedFeatures([128, 128]), []);
  map.destroy();
});

test('keeps unsupported data and invalid layer/source transitions explicit', () => {
  const { map } = createMap();
  const overlay = microMap.geojson(map, { maxFeatures: 1, maxCoordinates: 8 });
  assert.throws(() => overlay.addSource('bad', { data: { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 0] } } }), /finite longitude/);
  const cyclicProperties = {};
  cyclicProperties.self = cyclicProperties;
  assert.throws(() => overlay.addSource('cyclic', { data: { type: 'Feature', properties: cyclicProperties, geometry: { type: 'Point', coordinates: [0, 0] } } }), /must not contain cycles/);
  overlay.addSource('items', { data: { type: 'FeatureCollection', features: [] } });
  assert.throws(() => overlay.addLayer({ id: 'unknown', type: 'line', source: 'missing' }), /existing GeoJSON source/);
  assert.throws(() => overlay.addLayer({ id: 'unsupported-expression', type: 'line', source: 'items', paint: { 'line-width': ['+', 1, 2] } }), /unsupported expression operator/);
  overlay.addLayer({ id: 'line', type: 'line', source: 'items' });
  assert.throws(() => overlay.removeSource('items'), /remove layers/);
  assert.throws(() => overlay.setLayoutProperty('line', 'visibility', 'maybe'), /visible or none/);
  assert.throws(() => overlay.getSource('items').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }, { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] } }] }), /too many features/);
  overlay.removeLayer('line').removeSource('items');
  overlay.destroy();
  map.destroy();
});

test('keeps nested GeoJSON properties isolated at every source boundary', async () => {
  const { map } = createMap();
  const overlay = microMap.geojson(map);
  const initial = {
    type: 'Feature', id: 'poi',
    properties: { metadata: { state: 'original' }, tags: ['a'] },
    geometry: { type: 'Point', coordinates: [0, 0] }
  };
  overlay.addSource('items', { data: initial });
  overlay.addLayer({ id: 'poi-circle', type: 'circle', source: 'items', paint: { 'circle-radius': 6 } });
  await wait();

  initial.properties.metadata.state = 'caller-mutated';
  initial.properties.tags.push('caller-mutated');
  const source = overlay.getSource('items');
  assert.deepEqual(source.getData().features[0].properties, { metadata: { state: 'original' }, tags: ['a'] });

  const snapshot = source.getData();
  snapshot.features[0].properties.metadata.state = 'snapshot-mutated';
  snapshot.features[0].properties.tags.push('snapshot-mutated');
  assert.deepEqual(source.getData().features[0].properties, { metadata: { state: 'original' }, tags: ['a'] });

  const hit = overlay.queryRenderedFeatures([128, 128], { layers: ['poi-circle'], radius: 0 })[0];
  hit.properties.metadata.state = 'query-mutated';
  hit.properties.tags.push('query-mutated');
  assert.deepEqual(source.getData().features[0].properties, { metadata: { state: 'original' }, tags: ['a'] });

  const replacement = {
    type: 'Feature', id: 'replacement',
    properties: { metadata: { state: 'replacement' }, tags: ['b'] },
    geometry: { type: 'Point', coordinates: [0, 0] }
  };
  source.setData(replacement);
  replacement.properties.metadata.state = 'replacement-mutated';
  replacement.properties.tags.push('replacement-mutated');
  assert.deepEqual(source.getData().features[0].properties, { metadata: { state: 'replacement' }, tags: ['b'] });

  overlay.destroy();
  map.destroy();
});

test('supports the phase-one GeoJSON expression subset and geometry filters', async () => {
  const { map } = createMap({ zoom: 1 });
  const overlay = microMap.geojson(map);
  overlay.addSource('styled', {
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { class: 'route' }, geometry: { type: 'LineString', coordinates: [[-90, 0], [90, 0]] } },
        { type: 'Feature', properties: { class: 'other' }, geometry: { type: 'Polygon', coordinates: [[[-45, -20], [45, -20], [45, 20], [-45, -20]]] } }
      ]
    }
  });
  overlay.addLayer({
    id: 'route-line', type: 'line', source: 'styled',
    filter: ['all', ['==', '$type', 'LineString'], ['==', ['get', 'class'], 'route']],
    paint: {
      'line-color': ['match', ['get', 'class'], 'route', '#d00', '#999'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 2, 6]
    }
  });
  overlay.addLayer({
    id: 'area-fill', type: 'fill', source: 'styled', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#8ca' }
  });
  await wait();
  const operations = overlay.getCanvas().getContext('2d').operations;
  assert.ok(operations.some(operation => operation[0] === 'stroke' && operation[1] === '#d00' && operation[2] === 4));
  assert.ok(operations.some(operation => operation[0] === 'fill' && operation[1] === '#8ca'));

  map.setZoom(2);
  await wait();
  assert.ok(overlay.getCanvas().getContext('2d').operations.some(operation => operation[0] === 'stroke' && operation[2] === 6));
  assert.deepEqual(overlay.queryRenderedFeatures([128, 128], { layers: ['route-line'], radius: 0 }).map(feature => feature.geometry.type), ['LineString']);
  overlay.destroy();
  map.destroy();
});

test('returns a compact antimeridian-aware extent for overlay data', () => {
  const { map } = createMap();
  const overlay = microMap.geojson(map);
  overlay.addSource('dateline', {
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [170, -8] } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[175, 2], [-170, 12]] } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[178, -4], [-175, -4], [-175, 4], [178, 4]]] } }
      ]
    }
  });
  overlay.addSource('empty', { data: { type: 'FeatureCollection', features: [] } });
  assert.deepEqual(overlay.getBounds('dateline'), [170, -8, -170, 12]);
  assert.deepEqual(overlay.getBounds(), [170, -8, -170, 12]);
  assert.equal(overlay.getBounds('empty'), null);
  assert.equal(overlay.getBounds('missing'), null);
  overlay.destroy();
  assert.equal(overlay.getBounds(), null);
  map.destroy();
});

test('caps GeoJSON canvas pixels by default and allows an explicit higher cap', async () => {
  global.devicePixelRatio = 3;
  const { map } = createMap();
  const normal = microMap.geojson(map);
  const detailed = microMap.geojson(map, { maxDpr: 3 });
  await wait();
  assert.equal(normal.getCanvas().width, 512);
  assert.equal(detailed.getCanvas().width, 768);
  normal.destroy();
  detailed.destroy();
  map.destroy();
  global.devicePixelRatio = 1;
});

test('field module edits application GeoJSON without including draft vertices in exports', async () => {
  const { container, map } = createMap({ center: [12, 48], zoom: 8 });
  const changes = [];
  const field = microMapField(map, { onChange: value => changes.push(value.features.length) });
  const pointID = field.addPoint([12, 48], { label: 'Meeting point', kind: 'location' });
  assert.equal(field.getData().features[0].id, pointID);
  assert.deepEqual(field.getBounds(), [12, 48, 12, 48]);
  field.setTool('line', { color: '#dd3322', kind: 'route' });
  container.dispatch('pointerdown', { clientX: 128, clientY: 128 });
  container.dispatch('pointerup', { clientX: 128, clientY: 128 });
  container.dispatch('pointerdown', { clientX: 140, clientY: 128 });
  container.dispatch('pointerup', { clientX: 140, clientY: 128 });
  assert.equal(field.getData().features.length, 1);
  const routeID = field.finish();
  assert.ok(routeID);
  assert.equal(field.getData().features[1].geometry.type, 'LineString');
  field.setTool('area');
  assert.equal(field.finish(), null);
  field.cancel();
  const areaID = field.addArea([[12, 48], [12.01, 48], [12.01, 48.01]], { label: 'Absperrung' });
  assert.deepEqual(field.getData().features[2].geometry.coordinates[0][3], [12, 48]);
  await wait();
  assert.ok(field.queryRenderedFeatures([128, 128]).length);
  assert.equal(field.remove(areaID), true);
  assert.equal(field.remove('missing'), false);
  const exported = field.getData();
  field.setData(exported);
  exported.features[0].properties.label = 'changed outside';
  assert.equal(field.getData().features[0].properties.label, 'Meeting point');
  assert.deepEqual(changes, [1, 2, 3, 2, 2]);
  field.destroy();
  assert.equal(field.getOverlay().getCanvas().parentNode, null);
  map.destroy();
});

test('generated field distribution stays optional and below its size budget', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const minifiedPath = path.join(projectRoot, 'lib/microMap.field.min.js');
  const minified = fs.readFileSync(minifiedPath);
  assert.ok(zlib.gzipSync(minified, { level: 9 }).length < 4096);
  assert.equal(typeof require(minifiedPath), 'function');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./field'], './lib/microMap.field.js');
  assert.ok(packageJson.files.includes('lib'));
  assert.equal(Object.keys(packageJson.dependencies || {}).length, 0);
});

test('generated GeoJSON distribution has a separate package entry and budget', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const minifiedPath = path.join(projectRoot, 'lib/microMap.geojson.min.js');
  const minified = fs.readFileSync(minifiedPath);
  assert.ok(zlib.gzipSync(minified, { level: 9 }).length < 16384);
  delete require.cache[minifiedPath];
  assert.equal(typeof require(minifiedPath), 'function');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./geojson'], './lib/microMap.geojson.js');
  assert.ok(packageJson.files.includes('lib'));
});

test.after(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test('query projects each line vertex once on a miss and stops at the first hit', () => {
  const { map } = createMap();
  const overlay = microMapGeoJSON(map);
  const coordinates = Array.from({ length: 1000 }, (_, i) => [-20 + i * 0.01, 0]);
  const project = map.project;
  let calls = 0;
  map.project = value => { calls++; return project(value); };
  try {
    overlay.addSource('track', { type: 'geojson', data: { type: 'Feature', id: 'track', properties: {}, geometry: { type: 'LineString', coordinates } } });
    overlay.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-width': 2 } });
    calls = 0;
    assert.deepEqual(overlay.queryRenderedFeatures([128, 20], { radius: 0 }), []);
    assert.equal(calls, coordinates.length, 'shared segment endpoints are projected once');
    const point = project(coordinates[0]);
    calls = 0;
    const hits = overlay.queryRenderedFeatures(point, { radius: 0 });
    assert.deepEqual(hits.map(hit => hit.id), ['track']);
    assert.equal(calls, 2, 'the first segment is sufficient');
    hits[0].geometry.coordinates[0][0] = 99;
    assert.equal(overlay.queryRenderedFeatures(point, { radius: 0 })[0].geometry.coordinates[0][0], -20);
    map.setBearing(40);
    map.setPitch(50);
    assert.equal(overlay.queryRenderedFeatures(project(coordinates[0]), { radius: 0 })[0].id, 'track');
  } finally { overlay.destroy(); map.destroy(); }
});

test('optimized polygon queries preserve holes, boundaries and layer ordering', () => {
  const { map } = createMap();
  const overlay = microMapGeoJSON(map);
  const outer = [[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]];
  const hole = [[-5,-5],[-5,5],[5,5],[5,-5],[-5,-5]];
  const project = map.project;
  let calls = 0;
  map.project = value => { calls++; return project(value); };
  try {
    overlay.addSource('area', { type: 'geojson', data: { type: 'Polygon', coordinates: [outer, hole] } });
    overlay.addLayer({ id: 'fill', type: 'fill', source: 'area' });
    calls = 0;
    assert.deepEqual(overlay.queryRenderedFeatures(project([0, 0])), []);
    assert.equal(calls, outer.length + hole.length + 2);
    assert.equal(overlay.queryRenderedFeatures(project([10, 0])).length, 1);
    assert.equal(overlay.queryRenderedFeatures(project([5, 0])).length, 1, 'hole boundary remains a hit');
    overlay.addLayer({ id: 'outline', type: 'line', source: 'area', paint: { 'line-width': 2 } });
    assert.deepEqual(overlay.queryRenderedFeatures(project([-20, 0]), { radius: 0 }).map(hit => hit.layer.id), ['outline', 'fill']);
  } finally { overlay.destroy(); map.destroy(); }
});

test('query skips remaining MultiPoint and MultiLineString parts after a hit', () => {
  const { map } = createMap();
  const overlay = microMapGeoJSON(map);
  const project = map.project;
  let calls = 0;
  map.project = value => { calls++; return project(value); };
  try {
    overlay.addSource('many', { type: 'geojson', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', id: 'points', properties: {}, geometry: { type: 'MultiPoint', coordinates: Array.from({ length: 1000 }, () => [0, 0]) } },
      { type: 'Feature', id: 'lines', properties: {}, geometry: { type: 'MultiLineString', coordinates: Array.from({ length: 1000 }, () => [[-1, 0], [1, 0]]) } }
    ] } });
    overlay.addLayer({ id: 'points', type: 'circle', source: 'many', filter: ['==', '$type', 'Point'] });
    overlay.addLayer({ id: 'lines', type: 'line', source: 'many', filter: ['==', '$type', 'LineString'] });
    calls = 0;
    const hits = overlay.queryRenderedFeatures([128, 128], { radius: 0 });
    assert.deepEqual(hits.map(hit => hit.id), ['lines', 'points']);
    assert.equal(calls, 3);
  } finally { overlay.destroy(); map.destroy(); }
});

test('click picking skips unobserved overlays and limits layer-specific queries', () => {
  const { map, container } = createMap();
  const overlay = microMapGeoJSON(map);
  overlay.addSource('points', { type: 'geojson', data: { type: 'Point', coordinates: [0, 0] } });
  overlay.addLayer({ id: 'a', type: 'circle', source: 'points' });
  overlay.addLayer({ id: 'b', type: 'circle', source: 'points' });
  const project = map.project; let projections = 0;
  map.project = value => { projections++; return project(value); };
  const click = () => { container.dispatch('pointerdown', { clientX: 128, clientY: 128 }); container.dispatch('pointerup', { clientX: 128, clientY: 128 }); };
  click(); assert.equal(projections, 0);
  let result; overlay.on('click', 'a', event => { result = event.features; });
  click(); assert.equal(projections, 1); assert.equal(result[0].layer.id, 'a');
  overlay.on('click', event => { result = event.features; });
  projections = 0; click(); assert.equal(projections, 2); assert.equal(result.length, 2);
  overlay.destroy(); map.destroy();
});

test('measurements append new geometry and labels without replacing existing routes', async () => {
  const measure = require('../lib/microMap.measure.js');
  const { map } = createMap();
  const overlay = microMapGeoJSON(map);
  const coordinates = Array.from({ length: 1000 }, (_, i) => [i / 1000, 0]);
  const tool = measure(map, { overlay, id: 'incremental', router: () => coordinates });
  const source = overlay.getSource('incremental-data');
  const update = source.updateData, set = source.setData;
  let additions = [], replacements = 0;
  source.updateData = diff => { additions.push(diff.add.length); return update(diff); };
  source.setData = data => { replacements++; return set(data); };
  const route = await tool.route([0, 0], [1, 0]);
  tool.line([0, 0], [0, 1]);
  assert.deepEqual(additions, [2, 2]); assert.equal(replacements, 0);
  assert.equal(source.getData().features.length, 4);
  route.geometry.coordinates[0][0] = 80; coordinates[1][0] = 90;
  assert.equal(source.getData().features[0].geometry.coordinates[0][0], 0);
  assert.equal(source.getData().features[0].geometry.coordinates[1][0], 0.001);
  tool.clear(); assert.equal(source.getData().features.length, 0);
  tool.destroy(); overlay.destroy(); map.destroy();
});

test('measurement append failure rolls back records and supports setData-only adapters', () => {
  const measure = require('../lib/microMap.measure.js');
  const { map } = createMap();
  const overlay = microMapGeoJSON(map);
  const tool = measure(map, { overlay, id: 'rollback' });
  const source = overlay.getSource('rollback-data');
  source.updateData = () => { throw new Error('capacity'); };
  assert.throws(() => tool.line([0, 0], [1, 0]), /capacity/);
  assert.equal(tool.getMeasurements().length, 0);
  assert.equal(source.getData().features.length, 0);
  source.updateData = undefined;
  tool.line([0, 0], [1, 0]);
  assert.equal(source.getData().features.length, 2);
  tool.destroy(); overlay.destroy(); map.destroy();
});
