'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class Context {
  constructor() { this.operations = []; }
  setTransform(...values) { this.operations.push(['setTransform', ...values]); }
  clearRect(...values) { this.operations.push(['clearRect', ...values]); }
  beginPath() { this.operations.push(['beginPath']); }
  moveTo(...values) { this.operations.push(['moveTo', ...values]); }
  lineTo(...values) { this.operations.push(['lineTo', ...values]); }
  closePath() { this.operations.push(['closePath']); }
  clip() { this.operations.push(['clip']); }
  drawImage(...values) { this.operations.push(['drawImage', ...values]); }
  save() { this.operations.push(['save']); }
  restore() { this.operations.push(['restore']); }
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
  setAttribute() {}
  removeAttribute() {}
  getAttribute() { return null; }
  getContext(kind) { return kind === '2d' ? this.context : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
}

const imageURLs = [];
class ImageMock {
  constructor() { this.width = 256; this.height = 256; this.onload = null; this.onerror = null; }
  set src(value) {
    this._src = value;
    if (!value) return;
    imageURLs.push(value);
    setTimeout(() => { if (value.includes('/fail/')) { if (this.onerror) this.onerror(new Error('fixture failure')); } else if (this.onload) this.onload(); }, 0);
  }
  get src() { return this._src || ''; }
}

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio', 'Image']) saved[name] = global[name];
global.document = { activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
global.getComputedStyle = () => ({ position: 'static' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.devicePixelRatio = 1;
global.Image = ImageMock;

const microMap = require('../lib/microMap.js');
const microMapRaster = require('../lib/microMap.raster.js');

function wait(milliseconds = 40) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function createMap() {
  const container = new Element();
  return { container, map: microMap(container, { tiles: false, center: [12.5, 48.6], zoom: 3, zoomAnimation: false }) };
}

test('renders XYZ and WMS raster layers with bounded mutable style', async t => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 12 });
  t.after(() => { raster.destroy(); map.destroy(); });
  let loads = 0;
  raster.on('tileload', () => loads++);
  raster.addSource('relief', { type: 'raster', tiles: 'https://tiles.test/{z}/{x}/{y}.png', minzoom: 0, maxzoom: 5 });
  raster.addSource('wms', { type: 'wms', url: 'https://wms.test/map?LAYERS=relief&BBOX={bbox-epsg-3857}&WIDTH={width}&HEIGHT={height}' });
  raster.addLayer({ id: 'relief-layer', type: 'raster', source: 'relief', paint: { 'raster-opacity': 0.6 } });
  raster.addLayer({ id: 'wms-layer', type: 'raster', source: 'wms', paint: { 'raster-opacity': 0.4 } });
  const deadline = Date.now() + 2000;
  while (!raster.getCanvas().getContext('2d').operations.some(operation => operation[0] === 'drawImage') && Date.now() < deadline) await wait(5);
  assert.ok(loads > 0);
  assert.ok(imageURLs.some(url => url.includes('/tiles.test/')));
  assert.ok(imageURLs.some(url => url.includes('BBOX=') && url.includes('WIDTH=256')));
  assert.equal(raster.getLayer('relief-layer').paint['raster-opacity'], 0.6);
  raster.setPaintProperty('relief-layer', 'raster-opacity', 0.8).setLayoutProperty('relief-layer', 'visibility', 'none');
  assert.equal(raster.getLayer('relief-layer').paint['raster-opacity'], 0.8);
  assert.equal(raster.getLayer('relief-layer').layout.visibility, 'none');
  assert.throws(() => raster.setPaintProperty('relief-layer', 'raster-contrast', 1), /only raster-opacity/);
  assert.throws(() => raster.removeSource('relief'), /remove layers/);
  const canvas = raster.getCanvas();
  assert.ok(canvas.getContext('2d').operations.some(operation => operation[0] === 'drawImage'));
  raster.removeLayer('relief-layer').removeLayer('wms-layer').removeSource('relief').removeSource('wms');
  raster.destroy();
  assert.equal(canvas.parentNode, null);
  map.destroy();
});

test('raster source changes and failed tiles remain bounded and observable', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 4 });
  let errors = 0;
  raster.on('tileerror', () => errors++);
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await wait(10);
    assert.ok(predicate(), message);
  }
  try {
    raster.addSource('dynamic', { tiles: 'https://tiles.test/fail/{z}/{x}/{y}.png', maxzoom: 3 });
    raster.addLayer({ id: 'dynamic-layer', type: 'raster', source: 'dynamic' });
    await waitFor(() => errors > 0, 'failed tiles emit tileerror within 2 seconds');
    raster.getSource('dynamic').setTiles('https://tiles.test/{z}/{x}/{y}.png');
    raster.redraw();
    const recoveredTile = /^https:\/\/tiles\.test\/3\/\d+\/\d+\.png$/;
    const context = raster.getCanvas().getContext('2d');
    await waitFor(() => context.operations.some(operation =>
      operation[0] === 'drawImage' && recoveredTile.test(operation[1].src)),
    'tiles from the replacement source render within 2 seconds');
    assert.ok(imageURLs.some(url => recoveredTile.test(url)), 'replacement source requests exclude the failed URL');
  } finally {
    raster.destroy();
    map.destroy();
  }
});

test('raster distribution exposes a package entry', () => {
  const projectRoot = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(projectRoot, 'lib/microMap.raster.min.js')));
  assert.equal(typeof require(path.join(projectRoot, 'lib/microMap.raster.min.js')), 'function');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./raster'], './lib/microMap.raster.js');
});

test.after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test('raster requests only tiles with screen bounds intersecting the viewport', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 128 });
  try {
    raster.addSource('visible', { tiles: 'https://visible.test/{z}/{x}/{y}.png', maxzoom: 3 });
    raster.addLayer({ id: 'visible', type: 'raster', source: 'visible' });
    await wait();
    assert.equal(imageURLs.length, 4, 'four visible tiles instead of the surrounding tile ring');
    const initial = imageURLs.length;
    raster.redraw();
    await wait();
    assert.equal(imageURLs.length, initial, 'the stationary view reuses its tiles');
    map.setBearing(40);
    map.setPitch(50);
    await wait();
    function assertCoverage() {
      for (const x of [1, 128, 255]) for (const y of [1, 128, 255]) {
        const coordinate = map.unproject([x, y]);
        const lon = Array.isArray(coordinate) ? coordinate[0] : coordinate.lng;
        const lat = Array.isArray(coordinate) ? coordinate[1] : coordinate.lat;
        // A tilted view may use a coarser level for far ground.
        const covered = [0, 1, 2, 3].some(z => {
          const count = Math.pow(2, z);
          const tileX = ((Math.floor((lon + 180) / 360 * count) % count) + count) % count;
          const tileY = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * count);
          return imageURLs.includes('https://visible.test/' + z + '/' + tileX + '/' + tileY + '.png');
        });
        assert.ok(covered, 'screen sample ' + x + ',' + y + ' must have a requested tile');
      }
    }
    assertCoverage();
    const context = raster.getCanvas().getContext('2d');
    assert.ok(context.operations.some(op => op[0] === 'drawImage'));
    const retained = imageURLs.length;
    raster.redraw();
    await wait();
    assert.equal(imageURLs.length, retained, 'rotated/pitched tiles also remain cached');
    map.setCenter([179, 30]);
    await wait();
    assertCoverage();
  } finally { raster.destroy(); map.destroy(); }
});

test('bulk raster eviction retains the most recently used source tiles', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 4 });
  try {
    for (const id of ['older', 'newer']) {
      raster.addSource(id, { tiles: 'https://' + id + '.test/{z}/{x}/{y}.png', maxzoom: 3 });
      raster.addLayer({ id, type: 'raster', source: id, layout: { visibility: id === 'older' ? 'visible' : 'none' } });
    }
    await wait();
    assert.equal(imageURLs.length, 4);
    raster.setLayoutProperty('older', 'visibility', 'none');
    raster.setLayoutProperty('newer', 'visibility', 'visible');
    await wait();
    assert.equal(imageURLs.length, 8);
    raster.redraw();
    await wait();
    assert.equal(imageURLs.length, 8, 'bulk eviction must retain all newer tiles');
    raster.setLayoutProperty('newer', 'visibility', 'none');
    raster.setLayoutProperty('older', 'visibility', 'visible');
    await wait();
    assert.equal(imageURLs.length, 12, 'older source tiles were evicted');
  } finally { raster.destroy(); map.destroy(); }
});

test('perspective raster tiles are drawn as clipped triangle grids from a level-of-detail cover', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  map.setBearing(35); map.setPitch(60);
  const raster = microMapRaster(map);
  raster.addSource('tilted', { type: 'raster', tiles: 'https://tilted.test/{z}/{x}/{y}.png', tileSize: 256 });
  raster.addLayer({ id: 'tilted', type: 'raster', source: 'tilted' });
  await wait();
  const ctx = raster.getCanvas().getContext('2d');
  ctx.operations.length = 0;
  raster.redraw();
  await wait();
  const draws = ctx.operations.filter(op => op[0] === 'drawImage');
  const clips = ctx.operations.filter(op => op[0] === 'clip');
  assert.ok(draws.length > 0 && clips.length === draws.length, 'each triangle is clipped');
  assert.ok(draws.length > new Set(draws.map(op => op[1])).size * 2, 'a tile is split into more than two triangles');
  const levels = new Set(imageURLs.map(url => url.split('/')[3]));
  assert.ok(levels.size >= 2, 'near and far tiles use different levels: ' + [...levels]);
  raster.destroy(); map.destroy();
});

test('affine raster tiles draw once without triangle clipping at a bearing', async () => {
  const { map } = createMap();
  map.setBearing(35);
  const raster = microMapRaster(map);
  raster.addSource('single', { type: 'raster', tiles: 'https://single.test/{z}/{x}/{y}.png' });
  raster.addLayer({ id: 'single', type: 'raster', source: 'single' });
  await wait();
  const ctx = raster.getCanvas().getContext('2d');
  ctx.operations.length = 0;
  raster.setPaintProperty('single', 'raster-opacity', 0.5);
  await wait();
  const draws = ctx.operations.filter(op => op[0] === 'drawImage');
  assert.ok(draws.length > 0);
  assert.equal(new Set(draws.map(op => op[1])).size, draws.length);
  assert.equal(ctx.operations.filter(op => op[0] === 'clip').length, 0);
  assert.equal(ctx.operations.filter(op => op[0] === 'save').length, draws.length);
  assert.equal(ctx.operations.filter(op => op[0] === 'restore').length, draws.length);
  raster.destroy(); map.destroy();
});

test('transparent raster layers do no requests or draws and load when made visible', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map);
  raster.addSource('hidden', { type: 'raster', tiles: 'https://hidden.test/{z}/{x}/{y}.png' });
  raster.addLayer({ id: 'hidden', type: 'raster', source: 'hidden', paint: { 'raster-opacity': 0 } });
  await wait();
  assert.equal(imageURLs.length, 0);
  assert.equal(raster.getCanvas().getContext('2d').operations.some(op => op[0] === 'drawImage'), false);
  raster.setPaintProperty('hidden', 'raster-opacity', 1);
  await wait();
  assert.ok(imageURLs.length > 0);
  assert.ok(raster.getCanvas().getContext('2d').operations.some(op => op[0] === 'drawImage'));
  raster.destroy(); map.destroy();
});

test('non-affine projection adapters retain triangle clipping', async () => {
  const { map } = createMap();
  const project = map.project;
  map.project = coordinate => { const p = project(coordinate); return [p[0], p[1] + p[0] * p[1] * 0.0001]; };
  const raster = microMapRaster(map);
  raster.addSource('warped', { type: 'raster', tiles: 'https://warped.test/{z}/{x}/{y}.png' });
  raster.addLayer({ id: 'warped', type: 'raster', source: 'warped' });
  await wait();
  const ops = raster.getCanvas().getContext('2d').operations;
  const clips = ops.filter(op => op[0] === 'clip').length;
  assert.ok(clips > 0);
  assert.equal(clips, ops.filter(op => op[0] === 'drawImage').length);
  raster.destroy(); map.destroy();
});

test('regional raster bounds avoid requests outside coverage and retain source snapshots', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map);
  const bounds = [8.97, 47.27, 13.84, 50.57];
  try {
    raster.addSource('bayern', { tiles: 'https://bounded.test/{z}/{x}/{y}.png', bounds });
    const snapshot = raster.getSource('bayern');
    assert.deepEqual(snapshot.bounds, bounds);
    bounds[0] = -180;
    snapshot.bounds[0] = -180;
    assert.equal(raster.getSource('bayern').bounds[0], 8.97, 'caller and getter edits do not change coverage');
    raster.addLayer({ id: 'bayern', source: 'bayern', type: 'raster' });
    await wait();
    assert.deepEqual(imageURLs, ['https://bounded.test/3/4/2.png'], 'only the visible tile intersecting Bavaria is requested');
    map.setCenter([-75, 20]);
    await wait();
    assert.equal(imageURLs.length, 1, 'views outside coverage make no new requests');
    map.setCenter([372.5, 48.6]);
    await wait();
    assert.equal(imageURLs.length, 1, 'a wrapped view shares the original image');
    assert.ok(raster.getCanvas().getContext('2d').operations.some(op => op[0] === 'drawImage'));
  } finally { raster.destroy(); map.destroy(); }
});

test('perspective raster bounds filter every requested level of detail', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  map.setZoom(10); map.setPitch(60); map.setBearing(35);
  const raster = microMapRaster(map);
  const bounds = [8.97, 47.27, 13.84, 50.57];
  try {
    raster.addSource('bayern', { tiles: 'https://tilt-bounds.test/{z}/{x}/{y}.png', bounds });
    raster.addLayer({ id: 'bayern', source: 'bayern', type: 'raster' });
    await wait();
    assert.ok(imageURLs.length > 0);
    const levels = new Set();
    for (const url of imageURLs) {
      const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url).map(Number);
      levels.add(z);
      const count = 2 ** z;
      const west = x / count * 360 - 180, east = (x + 1) / count * 360 - 180;
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI;
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / count))) * 180 / Math.PI;
      assert.ok(west < bounds[2] && east > bounds[0] && south < bounds[3] && north > bounds[1], 'requested tile intersects regional coverage: ' + url);
    }
    assert.ok(levels.size > 1, 'bounds work at multiple perspective detail levels');
    const count = imageURLs.length;
    map.setCenter([-75, 20]);
    await wait();
    assert.equal(imageURLs.length, count, 'far-away pitched views do not fetch Bavaria tiles');
  } finally { raster.destroy(); map.destroy(); }
});

test('raster bounds validate before registering a source', () => {
  const { map } = createMap();
  const raster = microMapRaster(map);
  try {
    for (const bounds of [[0, 1, 2], [10, 50, 9, 51], [9, 51, 10, 50], [-181, 0, 10, 50], [0, 0, 181, 50], [0, -86, 10, 50], [0, 0, 10, 86], [0, 0, NaN, 50], [null, 0, 10, 50], [0, 0, '10', 50]]) {
      assert.throws(() => raster.addSource('bad', { tiles: '/{z}/{x}/{y}.png', bounds }), /invalid bounds/);
      assert.equal(raster.getSource('bad'), null);
    }
  } finally { raster.destroy(); map.destroy(); }
});

test('wrapped world copies share one raster request and canonical tile event', async () => {
  imageURLs.length = 0;
  const { map, container } = createMap();
  container.clientWidth = 1024;
  map.setZoom(0); map.resize();
  const raster = microMapRaster(map, { maxTiles: 1 });
  const events = [];
  raster.on('tileload', event => events.push([event.z, event.x, event.y]));
  try {
    raster.addSource('world', { tiles: 'https://world.test/{z}/{x}/{y}.png' });
    raster.addLayer({ id: 'world', source: 'world', type: 'raster' });
    await wait();
    assert.deepEqual(imageURLs, ['https://world.test/0/0/0.png']);
    assert.deepEqual(events, [[0, 0, 0]], 'events expose canonical XYZ coordinates');
    raster.redraw(); await wait();
    assert.equal(imageURLs.length, 1, 'world copies cannot evict and reload each other');
  } finally { raster.destroy(); map.destroy(); }
});

test('visible raster tiles survive a cache budget smaller than their cover', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 1 });
  let loads = 0;
  raster.on('tileload', () => loads++);
  try {
    raster.addSource('cover', { tiles: 'https://cover.test/{z}/{x}/{y}.png' });
    raster.addLayer({ id: 'cover', source: 'cover', type: 'raster' });
    await wait();
    const original = imageURLs.slice();
    assert.equal(original.length, 4, 'all four visible images load once despite the one-tile soft cap');
    assert.equal(new Set(original).size, 4);
    assert.equal(loads, 4);
    raster.redraw(); await wait();
    assert.deepEqual(imageURLs, original, 'settled tile-load and explicit frames keep the working set');
    map.setCenter([-140, 48.6]);
    await wait();
    const afterPan = imageURLs.length;
    assert.ok(afterPan > original.length, 'panning loads the new visible cover');
    raster.redraw(); await wait();
    assert.equal(imageURLs.length, afterPan, 'the new cover also settles');
    map.setCenter([12.5, 48.6]);
    await wait();
    assert.ok(imageURLs.length > afterPan, 'offscreen old-cover entries were evicted and must load on return');
  } finally { raster.destroy(); map.destroy(); }
});

test('flat raster detail follows world scale and source tile size', async () => {
  for (const [coreSize, sourceSize, maxzoom, expectedZoom] of [[512, 256, 22, 4], [256, 512, 22, 2], [256, 256, 22, 3], [512, 256, 3, 3]]) {
    imageURLs.length = 0;
    const container = new Element();
    const map = microMap(container, { tiles: false, center: [12.5, 48.6], zoom: 3, tileSize: coreSize, zoomAnimation: false });
    const raster = microMapRaster(map);
    try {
      raster.addSource('detail', { tiles: 'https://detail.test/{z}/{x}/{y}.png', tileSize: sourceSize, maxzoom });
      raster.addLayer({ id: 'detail', source: 'detail', type: 'raster' });
      await wait();
      assert.ok(imageURLs.length > 0);
      assert.ok(imageURLs.every(url => url.startsWith('https://detail.test/' + expectedZoom + '/')), 'requested detail for core/source sizes ' + coreSize + '/' + sourceSize);
      const state = map.getCameraState();
      const tilePixels = state.worldSize / 2 ** expectedZoom;
      const scale = 2 ** (state.zoom + Math.log2(coreSize / sourceSize) - expectedZoom);
      assert.equal(tilePixels, sourceSize * scale, 'tile detail matches the actual projected world scale');
    } finally { raster.destroy(); map.destroy(); }
  }
});

test('hidden raster sources release surplus cover entries and replacement sources settle', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 1 });
  try {
    raster.addSource('cover', { tiles: 'https://hidden-cover.test/{z}/{x}/{y}.png' });
    raster.addLayer({ id: 'cover', source: 'cover', type: 'raster' });
    await wait();
    assert.equal(imageURLs.length, 4);
    raster.setLayoutProperty('cover', 'visibility', 'none'); await wait();
    raster.setLayoutProperty('cover', 'visibility', 'visible'); await wait();
    assert.equal(imageURLs.length, 7, 'only one of the now-offscreen cached images survives the soft cap');
    raster.getSource('cover').setTiles('https://replacement-cover.test/{z}/{x}/{y}.png');
    await wait();
    assert.equal(imageURLs.length, 11, 'source replacement releases all old entries and loads four new images');
    const requests = imageURLs.length;
    raster.redraw(); await wait();
    assert.equal(imageURLs.length, requests, 'replacement-source cover is retained');
  } finally { raster.destroy(); map.destroy(); }
});

test('stable raster draws keep their canvas buffer and CSS dimensions', async () => {
  const { map, container } = createMap();
  const raster = microMapRaster(map);
  const canvas = raster.getCanvas();
  let resizes = 0, styleWrites = 0;
  for (const key of ['width', 'height']) {
    let value = canvas[key];
    Object.defineProperty(canvas, key, { get: () => value, set: next => { value = next; resizes++; }, configurable: true });
  }
  canvas.style = new Proxy(canvas.style, { set(object, key, value) { if (key === 'width' || key === 'height') styleWrites++; object[key] = value; return true; } });
  const previousDpr = global.devicePixelRatio;
  try {
    await wait();
    assert.equal(resizes, 2); assert.equal(styleWrites, 2);
    raster.redraw(); await wait();
    assert.equal(resizes, 2, 'unchanged draw does not clear/reallocate the canvas through dimension setters');
    assert.equal(styleWrites, 2, 'unchanged draw does not rewrite CSS dimensions');
    global.devicePixelRatio = 2;
    raster.redraw(); await wait();
    assert.equal(resizes, 4); assert.equal(styleWrites, 2);
    assert.equal(canvas.width, 512);
    container.clientWidth = 300; map.resize();
    await wait();
    assert.equal(canvas.width, 600); assert.equal(canvas.style.width, '300px');
    assert.equal(resizes, 5); assert.equal(styleWrites, 3);
  } finally { global.devicePixelRatio = previousDpr; raster.destroy(); map.destroy(); }
});
