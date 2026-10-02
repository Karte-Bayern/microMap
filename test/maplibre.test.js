'use strict';

// The MapLibre-shaped entry point: new Map({ container, style }) loads a
// whole style, fires MapLibre's lifecycle events and exposes its API.
const test = require('node:test');
const assert = require('node:assert/strict');

class ClassList {
  constructor() { this.names = []; }
  add(name) { if (!this.names.includes(name)) this.names.push(name); }
  remove(name) { this.names = this.names.filter(entry => entry !== name); }
  contains(name) { return this.names.includes(name); }
  toggle(name, force) { const on = force == null ? !this.contains(name) : force; if (on) this.add(name); else this.remove(name); return on; }
  set(value) { this.names = String(value).split(/\s+/).filter(Boolean); }
  toString() { return this.names.join(' '); }
}

class FakeEvent {
  constructor(type, init) {
    Object.assign(this, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: 0, clientY: 0, key: '' }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

class Node {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.classList = new ClassList();
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set(value); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }
  removeChild(child) { const index = this.children.indexOf(child); if (index > -1) this.children.splice(index, 1); child.parentNode = null; return child; }
  replaceChild(next, old) { const index = this.children.indexOf(old); this.children[index] = next; next.parentNode = this; old.parentNode = null; return old; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener(type, listener) { (this.listeners[type] || (this.listeners[type] = [])).push(listener); }
  removeEventListener(type, listener) { const list = this.listeners[type] || []; const index = list.indexOf(listener); if (index > -1) list.splice(index, 1); }
  dispatch(type, init) {
    const event = new FakeEvent(type, init);
    event.target = this;
    for (let node = this; node && !event.stopped; node = node.parentNode) {
      for (const listener of (node.listeners[type] || []).slice()) {
        if (typeof listener === 'function') listener.call(node, event);
        else listener.handleEvent(event);
      }
    }
    return event;
  }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() {
    return new Proxy({}, { get: (target, key) => key in target ? target[key] : () => ({ width: 10 }), set: (target, key, value) => { target[key] = value; return true; } });
  }
}

const documentNode = {
  activeElement: null,
  createElement(tag) { return new Node(tag, documentNode); },
  createElementNS(namespace, tag) { return new Node(tag, documentNode); },
  createTextNode(value) { return { nodeType: 3, textContent: String(value), parentNode: null }; },
  addEventListener() {},
  removeEventListener() {}
};
documentNode.head = new Node('head', documentNode);

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio', 'matchMedia', 'navigator']) saved[name] = Object.getOwnPropertyDescriptor(global, name);
global.document = documentNode;
global.getComputedStyle = () => ({ position: 'relative' });
global.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 4);
global.cancelAnimationFrame = clearTimeout;
global.devicePixelRatio = 1;


const microMap = require('../lib/microMap.js');
const microMapVector = require('../lib/microMap.vector.js');
const maplibre = require('../lib/microMap.maplibre.js');
const packageVersion = require('../package.json').version;

test.after(() => {
  for (const name in saved) {
    if (saved[name]) Object.defineProperty(global, name, saved[name]);
    else delete global[name];
  }
});

test('MapLibre facade reports the package version', () => {
  assert.equal(maplibre.version, packageVersion);
  assert.equal(maplibre.getVersion(), packageVersion);
});

const wait = (milliseconds = 30) => new Promise(resolve => setTimeout(resolve, milliseconds));

// A tiny MVT tile with one road; enough to exercise loading and queries.
function varint(value) {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(value ? next + 128 : next); } while (value);
  return bytes;
}
function field(number, wire, payload) { return [...varint(number * 8 + wire), ...payload]; }
function bytesField(number, payload) { return field(number, 2, [...varint(payload.length), ...payload]); }
function text(value) { return [...Buffer.from(value)]; }
function roadTile() {
  const geometry = [9, 0, 4096, 10, 8192, 0].flatMap(varint);
  const feature = [...field(1, 0, varint(1)), ...bytesField(2, [0, 0]), ...field(3, 0, varint(2)), ...bytesField(4, geometry)];
  const layer = [...bytesField(1, text('roads')), ...bytesField(2, feature), ...bytesField(3, text('class')),
    ...bytesField(4, bytesField(1, text('primary'))), ...field(5, 0, varint(4096)), ...field(15, 0, varint(2))];
  return Uint8Array.from(bytesField(3, layer)).buffer;
}

function response(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(body) });
}

function style() {
  return {
    version: 8,
    center: [11.5, 48.1],
    zoom: 9,
    sources: {
      base: { type: 'vector', url: 'https://tiles.test/tiles.json' },
      extra: { type: 'vector', tiles: ['https://extra.test/{z}/{x}/{y}.pbf'], maxzoom: 10 },
      places: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      dem: { type: 'raster-dem', tiles: ['https://dem.test/{z}/{x}/{y}.png'] }
    },
    sky: { 'sky-color': '#123456' },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f0ede5' } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#c00', 'line-width': 4 } },
      { id: 'extra-roads', type: 'line', source: 'extra', 'source-layer': 'roads', paint: { 'line-color': '#00c' } },
      { id: 'hills', type: 'hillshade', source: 'dem' }
    ]
  };
}

function createMap(options = {}) {
  const container = new Node('div', documentNode);
  container.clientWidth = 400;
  container.clientHeight = 300;
  const requests = [];
  const map = new maplibre.Map({
    container,
    style: style(),
    webgl: false,
    fetch(url) {
      requests.push(url);
      if (url === 'https://tiles.test/tiles.json') return response({ tilejson: '3.0.0', tiles: ['https://tiles.test/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: '© Test data' });
      return response(roadTile());
    },
    ...options
  });
  return { container, map, requests };
}

test('new Map() loads a whole MapLibre style and fires its lifecycle events in order', async () => {
  const { map, requests } = createMap();
  const events = [];
  for (const type of ['style.load', 'styledata', 'load', 'idle', 'error']) map.on(type, event => events.push(type + (event.error ? ':' + event.error.message : '')));
  await wait(150);
  assert.deepEqual(events.filter(type => type !== 'styledata').slice(0, 3), ['style.load', 'load', 'idle']);
  assert.equal(map.isStyleLoaded(), true);
  assert.ok(map.loaded());
  // The style's camera applies when the map options do not set one.
  assert.ok(Math.abs(map.getCenter().lng - 11.5) < 1e-9 && Math.abs(map.getCenter().lat - 48.1) < 1e-9);
  assert.equal(map.getZoom(), 9);
  assert.ok(requests.some(url => url.startsWith('https://tiles.test/9/')), 'the base source loads through its TileJSON');
  assert.ok(requests.some(url => url.startsWith('https://extra.test/9/')), 'a second vector source loads too');
  assert.deepEqual(map._vector.getStyleReport().skippedLayers, ['hills'], 'unsupported sources are reported, not fatal');
  assert.equal(map.getSky().skyColor, '#123456');
  assert.deepEqual(map.getStyle().layers.map(layer => layer.id), ['background', 'roads', 'extra-roads']);
  map.remove();
});

test('MapLibre zoom levels: a 512px world, and project/unproject with LngLat objects', async () => {
  const { map } = createMap({ center: { lng: 0, lat: 0 }, zoom: 0 });
  await wait(60);
  const corner = map.project([90, 0]);
  assert.ok(Math.abs(corner.x - (200 + 128)) < 1e-6, 'zoom 0 shows the world 512px wide: ' + corner.x);
  const lngLat = map.unproject({ x: 200, y: 150 });
  assert.ok(lngLat instanceof maplibre.LngLat);
  assert.ok(Math.abs(lngLat.lng) < 1e-9 && Math.abs(lngLat.lat) < 1e-9);
  assert.ok(map.getBounds() instanceof maplibre.LngLatBounds);
  map.remove();
});

test('sources, layers, events and controls work after load as in MapLibre', async () => {
  const { map } = createMap();
  await map.once('load');
  map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'LineString', coordinates: [[11.4, 48.1], [11.6, 48.1]] } } });
  assert.equal(map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#e63946', 'line-width': 6 } }), map, 'calls chain on the map');
  assert.ok(map.getLayer('route'));
  map.setPaintProperty('route', 'line-width', 8);
  assert.equal(map.getPaintProperty('route', 'line-width'), 8);
  let clicks = 0;
  const handler = event => { clicks++; assert.equal(event.target, map); };
  map.on('click', handler);
  map.getContainer().dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 100 });
  map.getContainer().dispatch('pointerup', { pointerId: 2, clientX: 100, clientY: 100 });
  map.off('click', handler);
  map.getContainer().dispatch('pointerdown', { pointerId: 3, clientX: 100, clientY: 100 });
  map.getContainer().dispatch('pointerup', { pointerId: 3, clientX: 100, clientY: 100 });
  assert.equal(clicks, 1, 'off() removes a handler registered with on()');
  const navigation = new maplibre.NavigationControl();
  map.addControl(navigation, 'top-left');
  assert.ok(map.hasControl(navigation));
  const marker = new maplibre.Marker().setLngLat([11.5, 48.1]).addTo(map);
  assert.ok(marker.getElement().parentNode);
  map.remove();
});

test('addProtocol routes custom URL schemes and transformRequest rewrites requests', async () => {
  const seen = [];
  maplibre.addProtocol('custom', params => {
    seen.push(params.url + ' ' + params.type);
    return Promise.resolve({ data: roadTile() });
  });
  try {
    const custom = style();
    custom.sources = { base: { type: 'vector', tiles: ['custom://tiles/{z}/{x}/{y}'] } };
    custom.layers = custom.layers.slice(0, 2);
    const { map } = createMap({
      style: custom,
      transformRequest(url, kind) { return kind === 'Tile' ? { url: url + '?key=abc' } : undefined; }
    });
    await wait(120);
    assert.ok(seen.some(entry => /^custom:\/\/tiles\/9\/\d+\/\d+\?key=abc arrayBuffer$/.test(entry)), JSON.stringify(seen));
    map.remove();
  } finally {
    maplibre.removeProtocol('custom');
  }
});

test('LngLat and LngLatBounds follow MapLibre', () => {
  const point = maplibre.LngLat.convert({ lng: 190, lat: 10 });
  assert.deepEqual(point.wrap().toArray(), [-170, 10]);
  assert.ok(Math.abs(new maplibre.LngLat(0, 0).distanceTo([0, 1]) - 111195) < 10);
  const bounds = new maplibre.LngLatBounds([10, 40], [12, 42]).extend([13, 39]);
  assert.deepEqual(bounds.toArray(), [[10, 39], [13, 42]]);
  assert.ok(bounds.contains([11, 41]));
  assert.deepEqual(bounds.getCenter().toArray(), [11.5, 40.5]);
  assert.throws(() => new maplibre.LngLat(0, 100), /latitude/);
});

test('a style URL is fetched and its relative source URLs resolve against it', async () => {
  const container = new Node('div', documentNode);
  container.clientWidth = 400;
  container.clientHeight = 300;
  const requests = [];
  const map = new maplibre.Map({
    container, webgl: false, style: 'https://styles.test/v1/style.json',
    fetch(url) {
      requests.push(url);
      if (url === 'https://styles.test/v1/style.json') return response({ version: 8, sources: { base: { type: 'vector', tiles: ['tiles/{z}/{x}/{y}.pbf'] } }, layers: [] });
      return response(roadTile());
    }
  });
  await map.once('load');
  await wait(40);
  assert.ok(requests.some(url => url.startsWith('https://styles.test/v1/tiles/0/')), JSON.stringify(requests));
  map.remove();
});

test('camera helpers, zoom and pitch limits and querySourceFeatures', async () => {
  const { map } = createMap();
  await map.once('load');
  await wait(40);
  map.setMaxZoom(12).setMinZoom(3);
  assert.equal(map.getMaxZoom(), 12);
  map.zoomTo(15, { duration: 0 });
  await wait(20);
  assert.equal(map.getZoom(), 12, 'the zoom is clamped to the new maximum');
  map.setMaxPitch(30);
  map.setPitch(50);
  assert.equal(map.getPitch(), 30);
  map.rotateTo(40, { duration: 0 });
  await wait(20);
  assert.equal(map.getBearing(), 40);
  map.resetNorthPitch({ duration: 0 });
  await wait(20);
  assert.equal(map.getBearing(), 0);
  assert.equal(map.getPitch(), 0);
  const roads = map.querySourceFeatures('base', { sourceLayer: 'roads', filter: ['==', ['get', 'class'], 'primary'] });
  assert.ok(roads.length > 0);
  assert.equal(roads[0].geometry.type, 'LineString');
  assert.equal(roads[0].properties.class, 'primary');
  assert.deepEqual(map.querySourceFeatures('base', { sourceLayer: 'roads', filter: ['==', ['get', 'class'], 'minor'] }), []);
  assert.deepEqual(map.getLayersOrder(), ['background', 'roads', 'extra-roads']);
  map.remove();
});
