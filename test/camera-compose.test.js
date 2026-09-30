'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class Context {
  setTransform() {}
  clearRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  arc() {}
  fillText() {}
  save() {}
  restore() {}
  setLineDash() {}
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '', zIndex: '' };
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.clientWidth = 256;
    this.clientHeight = 256;
    if (this.tagName === 'CANVAS') this.context = new Context();
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { const index = this.children.indexOf(child); if (index > -1) this.children.splice(index, 1); child.parentNode = null; return child; }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  removeEventListener(type, handler) { const list = this.listeners[type] || []; const index = list.indexOf(handler); if (index > -1) list.splice(index, 1); }
  dispatch(type, values = {}) {
    const event = { type, target: this, pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...values };
    for (const handler of (this.listeners[type] || []).slice()) handler(event);
  }
  setAttribute() {}
  removeAttribute() {}
  getAttribute() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext(kind) { return kind === '2d' ? this.context : null; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
}

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio']) saved[name] = global[name];
global.document = { activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
global.getComputedStyle = () => ({ position: 'static' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.devicePixelRatio = 1;

const microMap = require('../lib/microMap.js');
const microMapGeoJSON = require('../lib/microMap.geojson.js');
const microMapCamera = require('../lib/microMap.camera.js');
const microMapCompose = require('../lib/microMap.compose.js');

function wait(milliseconds = 30) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createMap(overrides = {}) {
  const container = new Element();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1, zoomAnimation: false, ...overrides });
  return { container, map };
}

function assertCenter(actual, expected) {
  assert.equal(actual.length, 2);
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-8, `longitude ${actual[0]} != ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) < 1e-8, `latitude ${actual[1]} != ${expected[1]}`);
}

test('camera adapter supports bounded jump/ease/pan operations', async () => {
  const { map } = createMap({ center: [179, 0] });
  const camera = microMapCamera(map);
  camera.jumpTo({ center: { lng: -179, lat: 3 }, zoom: 2, bearing: 30, pitch: 10 });
  assertCenter(map.getCenter(), [-179, 3]);
  assert.equal(map.getZoom(), 2);
  assert.equal(map.getBearing(), 30);
  assert.equal(map.getPitch(), 10);
  assert.throws(() => camera.jumpTo({ center: [0, 0], padding: 4 }), /padding is not supported/);

  camera.easeTo({ center: [170, 4], zoom: 3, bearing: 350, pitch: 4, duration: 18, easing: value => value });
  await wait(50);
  assertCenter(map.getCenter(), [170, 4]);
  assert.equal(map.getZoom(), 3);
  assert.equal(map.getBearing(), 350);
  camera.panTo([171, 5], { duration: 0 });
  assertCenter(map.getCenter(), [171, 5]);
  camera.destroy();
  map.destroy();
});

test('compose facade combines GeoJSON queries, overlay bounds and camera helpers', async () => {
  const { map } = createMap();
  const vector = {
    getCanvas: () => ({ style: { zIndex: '1' } }),
    queryRenderedFeatures: () => [{ id: 'vector-feature', layer: { id: 'vector-layer' } }]
  };
  const composed = microMapCompose(map, { geojson: true, vectors: [vector], camera: true });
  composed.addSource('items', { data: { type: 'Feature', id: 'poi', properties: { name: 'POI' }, geometry: { type: 'Point', coordinates: [0, 0] } } })
    .addLayer({ id: 'poi-circle', type: 'circle', source: 'items', paint: { 'circle-radius': 8 } });
  await wait();
  const hits = composed.queryRenderedFeatures([128, 128]);
  assert.deepEqual(hits.map(feature => feature.id), ['poi', 'vector-feature']);
  assert.deepEqual(composed.getOverlayBounds('items'), [0, 0, 0, 0]);
  composed.jumpTo({ center: [4, 5], zoom: 2 });
  assertCenter(composed.getCenter(), [4, 5]);
  assert.equal(composed.getZoom(), 2);
  assert.equal(composed.getSource('items').type, 'geojson');
  assert.equal(composed.getStyle().sources.items.data.features[0].id, 'poi');
  assert.equal(composed.getStyle().layers[0].id, 'poi-circle');
  assert.throws(() => composed.addSource('items', { type: 'geojson' }), /source already exists/);
  assert.throws(() => composed.addLayer({ id: 'missing-source', type: 'line', source: 'missing' }), /existing GeoJSON source/);
  composed.destroy();
  assert.equal(composed.overlays.getCanvas().parentNode, null);
  map.destroy();
});

test('camera and compose distribution entries exist', () => {
  const projectRoot = path.resolve(__dirname, '..');
  for (const file of ['microMap.camera.min.js', 'microMap.compose.min.js']) assert.ok(fs.existsSync(path.join(projectRoot, 'lib', file)));
  assert.equal(typeof require(path.join(projectRoot, 'lib/microMap.camera.min.js')), 'function');
  assert.equal(typeof require(path.join(projectRoot, 'lib/microMap.compose.min.js')), 'function');
});

test('fitBounds keeps a rotated antimeridian tour inside asymmetric padding', () => {
  const { map } = createMap({ zoom: 7, bearing: 35, pitch: 40, maxZoom: 18 });
  const camera = microMapCamera(map);
  const bounds = [179.4, -0.1, -179.6, 0.4];
  const padding = { left: 70, right: 12, top: 15, bottom: 45 };
  const before = map.getCameraState();
  const target = camera.cameraForBounds(bounds, { padding, maxZoom: 14 });
  assert.deepEqual(map.getCameraState(), before, 'camera computation must have no side effects');
  assert.ok(target.zoom <= 14);
  camera.fitBounds(bounds, { padding, maxZoom: 14 });
  for (const point of [[179.4, -0.1], [179.4, 0.4], [-179.6, -0.1], [-179.6, 0.4]]) {
    const [x, y] = map.project(point);
    assert.ok(x >= padding.left - 1e-7 && x <= 256 - padding.right + 1e-7, 'longitude must fit: ' + x);
    assert.ok(y >= padding.top - 1e-7 && y <= 256 - padding.bottom + 1e-7, 'latitude must fit: ' + y);
  }
  assert.equal(map.getBearing(), 35);
  assert.equal(map.getPitch(), 40);
  map.destroy();
});

test('fitBounds handles one stop, symmetric padding and snaps zoom downward', () => {
  const { map } = createMap({ zoomSnap: 1, maxZoom: 18 });
  const camera = microMapCamera(map);
  camera.fitBounds([[12, 48], [12, 48]], { maxZoom: 13.8, padding: 12 });
  assert.equal(map.getZoom(), 13);
  assertCenter(map.getCenter(), [12, 48]);
  camera.fitBounds([11.9, 47.9, 12.1, 48.1], [20, 30]);
  for (const point of [[11.9, 47.9], [12.1, 48.1]]) {
    const [x, y] = map.project(point);
    assert.ok(x >= 20 && x <= 236);
    assert.ok(y >= 30 && y <= 226);
  }
  map.destroy();
});

test('fitBounds rejects invalid coordinates, padding and unavailable viewport without mutation', () => {
  const { map, container } = createMap();
  const camera = microMapCamera(map);
  const before = map.getCameraState();
  for (const bounds of [[1, 2, 3, 1], [0, 0, NaN, 1], [0, -91, 1, 0], [0, 0, 400, 1], [null, 0, 1, 1]]) {
    assert.throws(() => camera.fitBounds(bounds), /bounds need/);
  }
  for (const padding of [-1, NaN, [1], { left: Infinity }, { top: '5' }, '12']) {
    assert.throws(() => camera.fitBounds([0, 0, 1, 1], { padding }), /padding needs/);
  }
  assert.throws(() => camera.fitBounds([0, 0, 1, 1], { padding: 128 }), /no visible viewport/);
  assert.throws(() => camera.fitBounds([0, 0, 1, 1], { maxZoom: Infinity }), /maxZoom must/);
  assert.deepEqual(map.getCameraState(), before);
  container.clientWidth = 0;
  map.resize();
  assert.throws(() => camera.fitBounds([0, 0, 1, 1]), /no visible viewport/);
  map.destroy();
});

test('manual interaction and a new composed camera request cancel an ongoing animation', async () => {
  const { map, container } = createMap({ zoom: 4 });
  const composed = microMapCompose(map, { camera: true });
  composed.easeTo({ center: [20, 0], duration: 70 });
  await wait(10);
  container.dispatch('keydown', { key: 'ArrowRight' });
  const userCenter = map.getCenter();
  await wait(90);
  assertCenter(map.getCenter(), userCenter);
  composed.easeTo({ center: [30, 0], duration: 60 });
  composed.fitBounds([10, 0, 12, 1], { padding: 10 });
  const fit = map.getCameraState();
  await wait(80);
  assert.deepEqual(map.getCameraState(), fit);
  composed.remove();
});

test('fitting a tour cancels a previously animated core wheel zoom', async () => {
  const { map, container } = createMap({ zoom: 6, zoomAnimation: true });
  const composed = microMapCompose(map, { camera: true });
  container.dispatch('wheel', { clientX: 128, clientY: 128, deltaY: -120, deltaMode: 0 });
  composed.fitBounds([12, 48, 12.1, 48.1], { padding: 15 });
  const fitted = map.getCameraState();
  await wait(250);
  assert.deepEqual(map.getCameraState(), fitted);
  composed.remove();
});

test('composed delivery GeoJSON remains clickable after source updates and resize', async () => {
  const { map, container } = createMap({ center: [12, 48], zoom: 12 });
  const composed = microMapCompose(map, { geojson: true, camera: true });
  const stop = coordinates => ({ type: 'Feature', id: 'stop-1', properties: { color: '#123abc', radius: 8, label: '1' }, geometry: { type: 'Point', coordinates } });
  composed.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[12, 48], [12.02, 48.01]] } } });
  composed.addSource('stops', { type: 'geojson', data: stop([12, 48]) });
  composed.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-width': 5, 'line-color': '#123abc' } });
  composed.addLayer({ id: 'stops-circle', type: 'circle', source: 'stops', paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['get', 'radius'] } });
  composed.addLayer({ id: 'stops-label', type: 'symbol', source: 'stops', layout: { 'text-field': ['get', 'label'], 'text-size': 10 } });
  let clicked;
  composed.on('click', 'stops-circle', event => { clicked = event.features[0].id; });
  composed.getSource('stops').setData(stop([12.02, 48.01]));
  container.clientWidth = 512;
  assert.equal(composed.resize(), composed);
  assert.equal(composed.getContainer(), container);
  composed.fitBounds(composed.getOverlayBounds(), { padding: 20, maxZoom: 14 });
  await wait();
  const [clientX, clientY] = composed.project([12.02, 48.01]);
  container.dispatch('pointerdown', { clientX, clientY });
  container.dispatch('pointerup', { clientX, clientY });
  assert.equal(clicked, 'stop-1');
  assert.deepEqual(composed.queryRenderedFeatures([clientX, clientY], { layers: ['stops-circle'] }).map(feature => feature.id), ['stop-1']);
  composed.remove();
  assert.equal(container.children.length, 0);
  assert.deepEqual(composed.queryRenderedFeatures([clientX, clientY]), []);
});

test('compose cleanup owns its listeners, leaves external surfaces, and removes the full map explicitly', () => {
  const { map, container } = createMap();
  const overlays = microMapGeoJSON(map);
  const externalCamera = microMapCamera(map);
  let vectorDestroys = 0;
  const composed = microMapCompose(map, { overlays, camera: externalCamera, vectors: [{ destroy() { vectorDestroys++; } }] });
  let baseMoves = 0;
  let ownedMoves = 0;
  let onceMoves = 0;
  const onceMove = () => { onceMoves++; };
  map.on('move', () => { baseMoves++; });
  composed.on('move', () => { ownedMoves++; });
  composed.once('move', onceMove).off('move', onceMove);
  map.setCenter([1, 0]);
  assert.equal(onceMoves, 0);
  assert.equal(ownedMoves, 1);
  composed.destroy();
  assert.equal(overlays.getCanvas().parentNode, container);
  externalCamera.jumpTo({ center: [2, 0] });
  assertCenter(map.getCenter(), [2, 0]);
  assert.equal(ownedMoves, 1);
  assert.equal(baseMoves, 2);
  composed.setCenter([3, 0]);
  assertCenter(map.getCenter(), [2, 0]);
  composed.remove();
  composed.remove();
  assert.equal(vectorDestroys, 1);
  assert.equal(container.children.length, 0);
});

test('facade destroyed with its base does not retain external click handlers', async () => {
  const { map } = createMap();
  const composed = microMapCompose(map, { geojson: true, camera: true });
  let onceMoves = 0;
  composed.once('move', () => { onceMoves++; });
  map.setCenter([1, 0]);
  map.setCenter([2, 0]);
  assert.equal(onceMoves, 1);
  composed.easeTo({ center: [20, 0], duration: 80 });
  map.destroy();
  await wait(100);
  assertCenter(map.getCenter(), [2, 0]);
  assert.deepEqual(composed.queryRenderedFeatures([128, 128]), []);
});

test.after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test('compose forwards the image API and image events of the vector renderer', () => {
  const { map } = createMap();
  const listeners = {};
  const images = new Map();
  const vector = {
    on(type, handler) { (listeners[type] || (listeners[type] = [])).push(handler); return vector; },
    off(type, handler) { listeners[type] = (listeners[type] || []).filter(entry => entry !== handler); return vector; },
    addImage(id, image) { images.set(id, image); return vector; },
    hasImage(id) { return images.has(id); },
    removeImage(id) { images.delete(id); return vector; },
    listImages() { return [...images.keys()]; }
  };
  const composed = microMapCompose(map, { camera: false, vectors: [vector] });
  const seen = [];
  const onMissing = event => { seen.push(event.id); composed.addImage(event.id, { width: 1, height: 1 }); };
  composed.on('styleimagemissing', onMissing);
  listeners.styleimagemissing[0]({ type: 'styleimagemissing', id: 'shop' });
  assert.deepEqual(seen, ['shop']);
  assert.equal(composed.hasImage('shop'), true);
  assert.deepEqual(composed.listImages(), ['shop']);
  assert.equal(composed.removeImage('shop'), composed);
  assert.equal(composed.hasImage('shop'), false);
  composed.off('styleimagemissing', onMissing);
  assert.equal(listeners.styleimagemissing.length, 0);
  map.destroy();
});

test('compose returns MapLibre-shaped points, coordinates and bounds', () => {
  const { map } = createMap({ center: [11.5, 48.1], zoom: 8 });
  const composed = microMapCompose(map, { camera: false });
  const center = composed.getCenter();
  assert.ok(Math.abs(center.lng - 11.5) < 1e-9 && Math.abs(center.lat - 48.1) < 1e-9 && center[0] === center.lng);
  const point = composed.project({ lng: 11.5, lat: 48.1 });
  assert.equal(point.x, point[0]);
  assert.deepEqual([point.x, point.y].map(Math.round), map.project([11.5, 48.1]).map(Math.round));
  const back = composed.unproject({ x: point.x, y: point.y });
  assert.ok(Math.abs(back.lng - 11.5) < 1e-9 && Math.abs(back.lat - 48.1) < 1e-9);
  const bounds = composed.getBounds();
  assert.equal(bounds.getWest(), bounds[0]);
  assert.ok(bounds.contains([11.5, 48.1]) && !bounds.contains({ lng: 100, lat: 0 }));
  assert.deepEqual(bounds.toArray(), [[bounds[0], bounds[1]], [bounds[2], bounds[3]]]);
  composed.setCenter({ lng: 12, lat: 49 });
  assert.ok(Math.abs(map.getCenter()[0] - 12) < 1e-9);
  map.destroy();
});
