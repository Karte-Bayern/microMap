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

test('renders XYZ and WMS raster layers with bounded mutable style', async () => {
  imageURLs.length = 0;
  const { map } = createMap();
  const raster = microMapRaster(map, { maxTiles: 12 });
  let loads = 0;
  raster.on('tileload', () => loads++);
  raster.addSource('relief', { type: 'raster', tiles: 'https://tiles.test/{z}/{x}/{y}.png', minzoom: 0, maxzoom: 5 });
  raster.addSource('wms', { type: 'wms', url: 'https://wms.test/map?LAYERS=relief&BBOX={bbox-epsg-3857}&WIDTH={width}&HEIGHT={height}' });
  raster.addLayer({ id: 'relief-layer', type: 'raster', source: 'relief', paint: { 'raster-opacity': 0.6 } });
  raster.addLayer({ id: 'wms-layer', type: 'raster', source: 'wms', paint: { 'raster-opacity': 0.4 } });
  await wait();
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
  raster.addSource('dynamic', { tiles: 'https://tiles.test/fail/{z}/{x}/{y}.png', maxzoom: 3 });
  raster.addLayer({ id: 'dynamic-layer', type: 'raster', source: 'dynamic' });
  await wait();
  assert.ok(errors > 0);
  raster.getSource('dynamic').setTiles('https://tiles.test/{z}/{x}/{y}.png');
  raster.redraw();
  await wait();
  assert.ok(imageURLs.some(url => url === 'https://tiles.test/3/4/2.png' || url.includes('https://tiles.test/')));
  raster.destroy();
  map.destroy();
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
        const tileX = ((Math.floor((lon + 180) / 360 * 8) % 8) + 8) % 8;
        const tileY = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 8);
        assert.ok(imageURLs.includes('https://visible.test/3/' + tileX + '/' + tileY + '.png'),
          'screen sample ' + x + ',' + y + ' must have a requested tile');
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

test('affine raster tiles draw once without triangle clipping at bearing and pitch', async () => {
  const { map } = createMap();
  map.setBearing(35); map.setPitch(50);
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
