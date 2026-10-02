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
    this.state.push({
      globalAlpha: this.globalAlpha,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline
    });
  }
  restore() {
    this.operations.push(['restore']);
    Object.assign(this, this.state.pop() || {});
  }
  beginPath() { this.operations.push(['beginPath']); }
  rect(...values) { this.operations.push(['rect', ...values]); }
  clip() { this.operations.push(['clip']); }
  moveTo(...values) { this.operations.push(['moveTo', ...values]); }
  lineTo(...values) { this.operations.push(['lineTo', ...values]); }
  closePath() { this.operations.push(['closePath']); }
  drawImage(...values) { this.operations.push(['drawImage', ...values, { globalAlpha: this.globalAlpha }]); }
  createPattern(image, repetition) { return { pattern: image, repetition, transforms: [], setTransform(matrix) { this.transforms.push(matrix); } }; }
  stroke(...values) { this.operations.push(['stroke', this.strokeStyle, this.lineWidth, ...values]); }
  putImageData(...values) { this.operations.push(['putImageData', ...values]); }
  createLinearGradient(...values) {
    const stops = [];
    return { stops, values, addColorStop: (offset, color) => stops.push([offset, color]), toString: () => 'gradient(' + stops.map(stop => stop[1]).join(' ') + ')' };
  }
  fill(...values) {
    const operation = ['fill', ...values];
    Object.defineProperty(operation, 'fillStyle', { value: this.fillStyle });
    this.operations.push(operation);
  }
  arc(...values) { this.operations.push(['arc', ...values]); }
  translate(...values) { this.operations.push(['translate', ...values]); }
  rotate(...values) { this.operations.push(['rotate', ...values]); }
  scale(...values) { this.operations.push(['scale', ...values]); }
  measureText(text) { return { width: String(text).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; }
  fillText(text, ...values) {
    this.operations.push(['fillText', text, ...values, {
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline
    }]);
  }
  strokeText(text, ...values) {
    this.operations.push(['strokeText', text, ...values, {
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      font: this.font
    }]);
  }
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

  addEventListener(type, handler) {
    (this.listeners[type] || (this.listeners[type] = [])).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(handler);
    if (index > -1) list.splice(index, 1);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getContext(kind) { return kind === '2d' ? this.context : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const originalGlobals = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio']) {
  originalGlobals[name] = global[name];
}

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
const microMapVector = require('../lib/microMap.vector.js');
const karteBayernBlueStyle = require('../styles/karte-bayern-blue.js');

function wait(milliseconds = 20) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function varint(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value ? next + 128 : next);
  } while (value);
  return Uint8Array.from(bytes);
}

function varint64(value) {
  const bytes = [];
  value = BigInt(value);
  do {
    const next = Number(value & BigInt(127));
    value >>= BigInt(7);
    bytes.push(value ? next + 128 : next);
  } while (value);
  return Uint8Array.from(bytes);
}

function bytes(value) {
  return Uint8Array.from(Buffer.from(value, 'utf8'));
}

function field(number, wire, value) {
  return concat([varint(number * 8 + wire), value]);
}

function bytesField(number, value) {
  return field(number, 2, concat([varint(value.length), value]));
}

function stringField(number, value) {
  return bytesField(number, bytes(value));
}

function packedField(number, values) {
  return bytesField(number, concat(values.map(varint)));
}

function valueString(value) {
  return stringField(1, value);
}

function feature(type, commands) {
  return concat([
    field(1, 0, varint(7)),
    packedField(2, [0, 0]),
    field(3, 0, varint(type)),
    packedField(4, commands)
  ]);
}

function pointFeature(fields = []) {
  return concat([
    ...fields,
    field(3, 0, varint(1)),
    packedField(4, [9, 0, 0])
  ]);
}

function pointLayer(name, featureBytes, keys = [], values = []) {
  return concat([
    stringField(1, name),
    bytesField(2, featureBytes),
    ...keys.map(key => stringField(3, key)),
    ...values.map(value => bytesField(4, value)),
    field(5, 0, varint(4096)),
    field(15, 0, varint(2))
  ]);
}

function layer(name, type, commands, className) {
  return concat([
    stringField(1, name),
    bytesField(2, feature(type, commands)),
    stringField(3, 'class'),
    bytesField(4, valueString(className)),
    field(5, 0, varint(4096)),
    field(15, 0, varint(2))
  ]);
}

function namedLayer(name, type, commands, label) {
  return concat([
    stringField(1, name),
    bytesField(2, concat([
      field(1, 0, varint(7)),
      packedField(2, [0, 0]),
      field(3, 0, varint(type)),
      packedField(4, commands)
    ])),
    stringField(3, 'name'),
    bytesField(4, valueString(label)),
    field(5, 0, varint(4096)),
    field(15, 0, varint(2))
  ]);
}

function taggedFeature(type, commands, tags = []) {
  return concat([
    ...(tags.length ? [packedField(2, tags)] : []),
    field(3, 0, varint(type)),
    packedField(4, commands)
  ]);
}

function identifiedFeature(id, type, commands, tags = []) {
  return concat([
    field(1, 0, varint(id)),
    ...(tags.length ? [packedField(2, tags)] : []),
    field(3, 0, varint(type)),
    packedField(4, commands)
  ]);
}

function featureLayer(name, features, keys = [], values = []) {
  return concat([
    stringField(1, name),
    ...features.map(value => bytesField(2, value)),
    ...keys.map(key => stringField(3, key)),
    ...values.map(value => bytesField(4, value)),
    field(5, 0, varint(4096)),
    field(15, 0, varint(2))
  ]);
}

function fixture() {
  const line = layer('transportation', 2, [9, 0, 0, 10, 8192, 0], 'primary');
  const polygon = layer('landcover', 3, [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15], 'forest');
  const point = layer('place', 1, [9, 8192, 8192], 'town');
  return concat([bytesField(3, line), bytesField(3, polygon), bytesField(3, point)]);
}

function tinyTilesDetailFixture() {
  const primary = taggedFeature(2, [9, 0, 0, 10, 8192, 0], [0, 0]);
  const minor = taggedFeature(2, [9, 0, 8192, 10, 8192, 0], [0, 1]);
  const local = taggedFeature(2, [9, 0, 4096, 10, 8192, 0], [0, 2]);
  const footway = taggedFeature(2, [9, 0, 6144, 10, 8192, 0], [0, 3]);
  const building = taggedFeature(3, [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15]);
  return concat([
    bytesField(3, featureLayer('transportation', [primary, minor, local, footway], ['class'], [valueString('primary'), valueString('secondary'), valueString('residential'), valueString('footway')])),
    bytesField(3, featureLayer('building', [building]))
  ]);
}

function queryFixture() {
  // Circle and road overlap deliberately: query order must mirror Canvas
  // paint order, so the final circle style appears before the road line.
  const area = identifiedFeature(10, 3, [
    9, 1024, 4096,
    26, 2048, 0, 0, 3072, 2047, 0,
    15
  ], [0, 0]);
  const road = identifiedFeature(20, 2, [9, 1024, 2048, 10, 6144, 0], [0, 0]);
  const poi = identifiedFeature(30, 1, [9, 6144, 2048], [0, 0]);
  return concat([
    bytesField(3, featureLayer('land', [area], ['kind'], [valueString('area')])),
    bytesField(3, featureLayer('road', [road], ['kind'], [valueString('road')])),
    bytesField(3, featureLayer('poi', [poi], ['kind'], [valueString('poi')]))
  ]);
}

function asArrayBuffer(data) {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function createMap(overrides = {}) {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 0, zoomAnimation: false, ...overrides });
  return { container, map };
}

test('decodes real MVT protobuf layers, tags and geometry commands', () => {
  const tile = microMapVector.decodeMVT(fixture());
  assert.deepEqual(tile.layers.map(layer => layer.name), ['transportation', 'landcover', 'place']);
  const road = tile.layers[0].features[0];
  assert.equal(road.type, 2);
  assert.equal(road.properties.class, 'primary');
  assert.deepEqual(road.geometry, [[[0, 0], [4096, 0]]]);
  const land = tile.layers[1].features[0];
  assert.equal(land.type, 3);
  assert.equal(land.geometry[0].closed, true);
  assert.deepEqual(land.geometry[0].slice(0, 2), [[0, 0], [4096, 0]]);
  assert.deepEqual(tile.layers[2].features[0].geometry, [[[4096, 4096]]]);
});

test('preserves MVT 64-bit IDs and values without silently rounding them', () => {
  const tooLarge = BigInt('9007199254740993');
  const unsigned = field(5, 0, varint64(tooLarge));
  const signedMinusTwo = field(4, 0, varint64((BigInt(1) << BigInt(64)) - BigInt(2)));
  const vectorFeature = concat([
    field(1, 0, varint64(tooLarge)),
    packedField(2, [0, 0, 1, 1]),
    field(3, 0, varint(1)),
    packedField(4, [9, 0, 0])
  ]);
  const tile = microMapVector.decodeMVT(bytesField(3, pointLayer('values', vectorFeature, ['wide', 'negative'], [unsigned, signedMinusTwo])));
  const feature = tile.layers[0].features[0];
  assert.equal(feature.id, tooLarge);
  assert.equal(feature.properties.wide, tooLarge);
  assert.equal(feature.properties.negative, -2);
});

test('enforces aggregate limits across repeated packed MVT fields', () => {
  const repeatedTags = concat([
    packedField(2, [0]),
    packedField(2, [0]),
    field(3, 0, varint(1)),
    packedField(4, [9, 0, 0])
  ]);
  const repeatedGeometry = concat([
    field(3, 0, varint(1)),
    packedField(4, [9, 0]),
    packedField(4, [0])
  ]);
  assert.throws(
    () => microMapVector.decodeMVT(bytesField(3, pointLayer('tags', repeatedTags, ['kind'], [valueString('test')])), { maxTags: 1 }),
    /packed field is too large/
  );
  assert.throws(
    () => microMapVector.decodeMVT(bytesField(3, pointLayer('geometry', repeatedGeometry)), { maxCommands: 2 }),
    /packed field is too large/
  );
});

test('draws distinct unwrapped world copies instead of collapsing them at the center', async () => {
  const data = fixture();
  const { container, map } = createMap();
  container.clientWidth = 640;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    style: [{ sourceLayer: 'transportation', type: 'line', paint: { color: '#d75d38', width: 2 } }],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  await wait();
  // Each unwrapped copy keeps its own geometry origin on the main canvas.
  const xOrigins = new Set(
    layer.getCanvas().getContext('2d').operations
      .filter(operation => operation[0] === 'moveTo')
      .map(operation => Math.round(operation[1]))
  );
  assert.ok(xOrigins.has(-64), 'origins: ' + JSON.stringify([...xOrigins]));
  assert.ok(xOrigins.has(192), 'origins: ' + JSON.stringify([...xOrigins]));
  assert.ok(xOrigins.has(448), 'origins: ' + JSON.stringify([...xOrigins]));
  map.destroy();
});

// The tilted renderer's DOM: a host transformed by the camera, panes of
// cell canvases inside it.
function tiltedView(container) {
  const host = container.children.find(child => child.tagName === 'DIV' && /matrix3d/.test(child.style.cssText));
  const cells = host ? host.children.flatMap(pane => pane.children) : [];
  return { host, cells, operations: cells.flatMap(cell => cell.context.operations) };
}

test('uses the core bearing matrix for flat views and its perspective camera when pitched', async () => {
  const { container, map } = createMap({ zoom: 2, bearing: 45 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) })
  });
  await wait();
  const operations = layer.getCanvas().getContext('2d').operations;
  assert.ok(operations.some(operation => operation[0] === 'rotate' && Math.abs(operation[1] + Math.PI / 4) < 1e-9));
  assert.equal(tiltedView(container).host, undefined, 'a flat view needs no perspective host');

  map.setPitch(30);
  await wait();
  const tilted = tiltedView(container);
  assert.ok(tilted.host, 'a pitched view paints cells under a CSS perspective host');
  assert.ok(tilted.host.style.cssText.endsWith('transform:' + map.getCamera().cssTransform()));
  assert.ok(tilted.cells.length > 0);
  assert.ok(tilted.operations.some(operation => operation[0] === 'lineTo'), 'cells hold the painted tile geometry');

  map.setBearing(90);
  await wait();
  assert.ok(tiltedView(container).host.style.cssText.includes('rotate(-90deg)'));
  map.setPitch(0);
  await wait();
  assert.equal(tiltedView(container).cells.length, 0, 'flattening releases the cells');
  map.destroy();
});

test('uses the core camera state without inferring scale through project()', async () => {
  for (const pitch of [0, 15]) {
    const { container, map } = createMap({ zoom: 2, bearing: 20, pitch });
    map.project = () => { throw new Error('vector renderer should use getCameraState'); };
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt',
      tileBuffer: 0,
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) })
    });
    await wait();
    const painted = pitch ? tiltedView(container).operations : layer.getCanvas().getContext('2d').operations;
    assert.ok(painted.some(operation => operation[0] === 'lineTo'), 'pitch ' + pitch);
    map.destroy();
  }
});

test('the perspective cover paints near cells finer than far ones and reuses painted cells', async () => {
  const urls = [];
  const { container, map } = createMap({ center: [11.5, 48.1], zoom: 12, pitch: 70 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    maxZoom: 14,
    fetch(url) {
      urls.push(url);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) });
    }
  });
  await wait(40);
  const levels = new Set(urls.map(url => +url.split('/')[2]));
  assert.ok(levels.size >= 2, 'several levels of detail: ' + [...levels]);
  assert.ok(Math.max(...levels) >= 12 && Math.min(...levels) < 12);
  const view = tiltedView(container);
  assert.ok(view.cells.length > 4);
  const painted = view.operations.length;
  map.setBearing(1);
  await wait(30);
  assert.equal(tiltedView(container).operations.length, painted, 'a small rotation repaints no cell');
  assert.ok(layer.areTilesLoaded());
  map.destroy();
});

test('queries visible MVT features in Canvas paint order with MapLibre-shaped copies', async () => {
  const { map } = createMap({ zoom: 0 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    style: { layers: [
      { id: 'area-fill', sourceLayer: 'land', type: 'fill', paint: { color: '#dfe9d7' } },
      { id: 'road-line', sourceLayer: 'road', type: 'line', paint: { color: '#d75d38', width: 4 } },
      { id: 'poi-circle', sourceLayer: 'poi', type: 'circle', paint: { color: '#263238', radius: 6 } }
    ] },
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(queryFixture())) })
  });
  await wait(35);

  const overlap = layer.queryRenderedFeatures({ x: 192, y: 64 });
  assert.deepEqual(overlap.map(feature => feature.layer.id), ['poi-circle', 'road-line']);
  assert.equal(overlap[0].id, 30);
  assert.equal(overlap[0].sourceLayer, 'poi');
  assert.deepEqual(overlap[0].layer, { id: 'poi-circle', type: 'circle', 'source-layer': 'poi' });
  assert.equal(overlap[0].geometry.type, 'Point');
  assert.equal(overlap[1].geometry.type, 'LineString');

  const onlyRoad = layer.queryRenderedFeatures([192, 64], { layers: ['road-line'], radius: 0 });
  assert.deepEqual(onlyRoad.map(feature => feature.layer.id), ['road-line']);
  const area = layer.queryRenderedFeatures([64, 150], { layers: ['area-fill'] });
  assert.equal(area.length, 1);
  assert.equal(area[0].geometry.type, 'Polygon');

  overlap[0].properties.kind = 'mutated';
  overlap[0].geometry.coordinates[0] = 0;
  const fresh = layer.queryRenderedFeatures([192, 64], { layers: ['poi-circle'] });
  assert.equal(fresh[0].properties.kind, 'poi');
  assert.notEqual(fresh[0].geometry.coordinates[0], 0);
  assert.deepEqual(layer.queryRenderedFeatures([250, 240]), []);
  assert.throws(() => layer.queryRenderedFeatures([192, 64], { layers: 'poi-circle' }), /array of style-layer ids/);

  const poiPosition = fresh[0].geometry.coordinates;
  map.setBearing(45).setPitch(30);
  await wait();
  const rotatedPoint = map.project(poiPosition);
  const rotated = layer.queryRenderedFeatures(rotatedPoint, { layers: ['poi-circle'], radius: 0 });
  assert.equal(rotated.length, 1, 'bearing and pitch use the same hit transform as Canvas drawing');
  map.destroy();
  assert.deepEqual(layer.queryRenderedFeatures([192, 64]), []);
});

test('stays empty below a vector source minZoom instead of allocating an impossible tile grid', async () => {
  let requests = 0;
  const { map } = createMap({ zoom: 0 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 14,
    maxZoom: 14,
    fetch() {
      requests++;
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) });
    }
  });
  await wait();
  assert.equal(requests, 0);
  assert.equal(layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'lineTo').length, 0);
  map.destroy();
});

test('tinyTilesStyle keeps the useful road hierarchy but excludes dense footways', async () => {
  const data = tinyTilesDetailFixture();

  async function drawAt(zoom) {
    const { container, map } = createMap({ center: [0.1, 0.1], zoom });
    container.clientWidth = 200;
    container.clientHeight = 200;
    map.resize();
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt',
      minZoom: 0,
      maxZoom: 14,
      tileBuffer: 0,
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
    });
    await wait(35);
    const operations = layer.getCanvas().getContext('2d').operations.slice();
    map.destroy();
    return operations;
  }

  const overview = await drawAt(8);
  const overviewStrokes = overview.filter(operation => operation[0] === 'stroke').map(operation => operation[1]);
  assert.ok(overviewStrokes.includes('#e48c62'), 'primary roads remain useful at overview zoom');
  assert.ok(!overviewStrokes.includes('#f9f6ef'), 'secondary roads wait for the mid-zoom band');
  assert.ok(!overviewStrokes.includes('#ffffff'), 'local roads must not be drawn at overview zoom');
  assert.equal(overview.filter(operation => operation[0] === 'fill').length, 0, 'buildings must not be drawn at overview zoom');

  const middle = await drawAt(10);
  const middleStrokes = middle.filter(operation => operation[0] === 'stroke').map(operation => operation[1]);
  assert.ok(middleStrokes.includes('#e48c62'), 'primary roads remain visible in the mid-zoom band');
  assert.ok(middleStrokes.includes('#f9f6ef'), 'secondary and tertiary connectors form the overview sweet spot');
  assert.ok(!middleStrokes.includes('#ffffff'), 'local roads wait for the town-level zoom');

  const detail = await drawAt(15);
  const detailStrokes = detail.filter(operation => operation[0] === 'stroke').map(operation => operation[1]);
  assert.ok(detailStrokes.includes('#e48c62'), 'primary roads remain visible at detail zoom');
  assert.ok(detailStrokes.includes('#f9f6ef'), 'secondary roads remain visible at detail zoom');
  assert.ok(detailStrokes.includes('#ffffff'), 'local roads appear at detail zoom');
  assert.equal(
    detailStrokes.filter(color => color === '#ffffff').length,
    detailStrokes.filter(color => color === '#f9f6ef').length,
    'footways are excluded instead of multiplying the local-road draw pass'
  );
  assert.ok(detail.some(operation => operation[0] === 'fill'), 'buildings appear at detail zoom');
  assert.ok(
    overview.filter(operation => operation[0] === 'lineTo').length < detail.filter(operation => operation[0] === 'lineTo').length,
    'overview geometry is simplified while close geometry keeps its detail'
  );
});

// A closed MVT square ring (tile units) for building fixtures.
function square(x, y, size) {
  const zz = value => (value << 1) ^ (value >> 31);
  return [9, zz(x), zz(y), 26, zz(size), 0, 0, zz(size), zz(-size), 0, 15];
}

async function drawBuildings(features, style, camera, keys = [], values = [], vectorOptions = {}) {
  const data = concat([bytesField(3, featureLayer('building', features, keys, values))]);
  const { container, map } = createMap({ center: [0.1, 0.1], zoom: 16, ...camera });
  container.clientWidth = 200;
  container.clientHeight = 200;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 18,
    tileBuffer: 0,
    style,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) }),
    ...vectorOptions
  });
  await wait(35);
  const operations = layer.getCanvas().getContext('2d').operations.slice();
  return { map, layer, operations, fills: operations.filter(operation => operation[0] === 'fill') };
}

function rgbOf(fill) {
  return fill.fillStyle.match(/[\d.]+/g).slice(0, 3).map(Number);
}

test('fill-extrusion draws lit walls below a roof when pitched, and a flat roof at pitch 0', async () => {
  const style = [{ sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#c8bfae', roofColor: '#e2dcce', height: 12 } }];
  const building = [taggedFeature(3, square(1024, 1024, 2048))];
  const flat = await drawBuildings(building, style, { pitch: 0 });
  flat.map.destroy();
  assert.ok(flat.fills.length > 0, 'the building must still render at pitch 0');
  assert.ok(flat.fills.every(fill => fill.fillStyle === 'rgba(226,220,206,1)'), 'a flat building is its lit roof');

  const pitched = await drawBuildings(building, style, { pitch: 45, bearing: 30 });
  pitched.map.destroy();
  assert.ok(pitched.fills.length > flat.fills.length, 'pitching the camera must reveal extruded walls in addition to the roof');
  const walls = pitched.fills.filter(fill => fill.fillStyle !== 'rgba(226,220,206,1)');
  assert.ok(walls.length > 0);
  for (const wall of walls) {
    const [r, g, b] = rgbOf(wall);
    assert.ok(r < 200 && g < 191 && b < 174, 'walls are shaded darker than their base colour: ' + wall.fillStyle);
  }
  // A perspective camera sees one or two sides of a square, never its back.
  const roofs = pitched.fills.length - walls.length;
  assert.ok(walls.length >= roofs && walls.length <= roofs * 2, walls.length + ' walls for ' + roofs + ' roofs');
  const affine = await drawBuildings(building, style, { pitch: 45, bearing: 30 }, [], [], { perspective: false });
  affine.map.destroy();
  const affineWalls = affine.fills.filter(fill => fill.fillStyle !== 'rgba(226,220,206,1)');
  assert.equal(affineWalls.length, (affine.fills.length - affineWalls.length) * 2, 'the affine renderer sees two sides at this bearing');
});

test('fill-extrusion reads per-feature height from MVT properties via a get expression', async () => {
  const features = [taggedFeature(3, square(512, 512, 1024), [0, 0]), taggedFeature(3, square(2560, 2560, 1024), [0, 0])];
  const style = [{ sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#c8bfae', height: ['get', 'render_height'] } }];
  const untagged = await drawBuildings(features, style, { pitch: 45, bearing: 30 }, ['render_height'], [valueString('0')]);
  untagged.map.destroy();
  assert.ok(untagged.fills.length > 0, 'both buildings must still render flat when render_height is absent or zero');
  const tagged = await drawBuildings(features, style, { pitch: 45, bearing: 30 }, ['render_height'], [valueString('20')]);
  tagged.map.destroy();
  assert.ok(tagged.fills.length > untagged.fills.length, 'a real render_height read via [\'get\', ...] must extrude walls in addition to the roof');
});

test('Karte.Bayern 3D profile uses measured building height and extrudes untagged buildings', async () => {
  const building = square(1024, 1024, 2048);
  const style = karteBayernBlueStyle({ extrudeBuildings: true, buildingHeight: 10 }).layers.filter(candidate => candidate.id === 'buildings');
  const fallback = await drawBuildings([taggedFeature(3, building)], style, { pitch: 45, bearing: 25 });
  fallback.map.destroy();
  assert.ok(fallback.fills.length > 1, 'an untagged building gets visible walls');

  const measured = await drawBuildings([taggedFeature(3, building, [0, 0])], style,
    { pitch: 45, bearing: 25 }, ['height'], [field(5, 0, varint(30))]);
  measured.map.destroy();
  assert.ok(measured.fills.length > 1, 'a measured building gets visible walls');
  assert.notDeepEqual(measured.operations.filter(operation => operation[0] === 'moveTo'),
    fallback.operations.filter(operation => operation[0] === 'moveTo'),
    '30 m measured height must project differently from the 10 m fallback');
});

test('fill-extrusion draws buildings back to front across tiles', async () => {
  const features = [taggedFeature(3, square(1024, 256, 1024)), taggedFeature(3, square(1024, 2816, 1024))];
  const style = [{ sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#a05030', roofColor: '#ffffff', height: 30 } }];
  const { map, operations } = await drawBuildings(features, style, { pitch: 50 });
  map.destroy();
  // At bearing 0 the viewer looks north: a larger raw y is nearer.
  const roofs = [];
  let points = [];
  for (const operation of operations) {
    if (operation[0] === 'beginPath') points = [];
    else if (operation[0] === 'moveTo' || operation[0] === 'lineTo') points.push(operation[2]);
    else if (operation[0] === 'fill' && operation.fillStyle === 'rgba(255,255,255,1)') roofs.push(points.reduce((sum, y) => sum + y, 0) / points.length);
  }
  assert.ok(roofs.length >= 3, 'buildings of several tiles are drawn');
  for (let i = 1; i < roofs.length; i++) assert.ok(roofs[i] >= roofs[i - 1] - 1e-6, 'roof ' + i + ' is not behind the one before');
});

test('rotated pitched buildings use projected screen depth for roof order', async () => {
  const features = [taggedFeature(3, square(256, 256, 512)), taggedFeature(3, square(2048, 2048, 512))];
  const style = [{ sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#a05030', roofColor: '#ffffff', height: 30 } }];
  const affine = await drawBuildings(features, style, { pitch: 60, bearing: 61 }, [], [], { perspective: false });
  affine.map.destroy();
  const roofs = [];
  let points = [];
  for (const operation of affine.operations) {
    if (operation[0] === 'beginPath') points = [];
    else if (operation[0] === 'moveTo' || operation[0] === 'lineTo') points.push([operation[1], operation[2]]);
    else if (operation[0] === 'fill' && operation.fillStyle === 'rgba(255,255,255,1)' && points.length) {
      const center = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
      roofs.push(-Math.sin(61 * Math.PI / 180) * center[0] / points.length +
        Math.cos(61 * Math.PI / 180) * center[1] / points.length);
    }
  }
  assert.ok(roofs.length >= 2, 'both buildings render roofs');
  for (let i = 1; i < roofs.length; i++) {
    assert.ok(roofs[i] >= roofs[i - 1] - 1e-6, 'nearer roofs must cover farther roofs at pitch 60° and bearing 61°');
  }

  // Perspective: roofs are painted in order of decreasing distance from the
  // camera's position over the ground.
  const tilted = await drawBuildings(features, style, { pitch: 60, bearing: 61 });
  const camera = tilted.map.getCamera();
  const perMeter = tilted.map.getCameraState().worldSize / (40075016.68557849 * Math.cos(0.1 * Math.PI / 180));
  const eye = [camera.distance * camera.sinPitch * camera.sinBearing, camera.distance * camera.sinPitch * camera.cosBearing];
  const distances = [];
  points = [];
  for (const operation of tilted.operations) {
    if (operation[0] === 'beginPath') points = [];
    else if (operation[0] === 'moveTo' || operation[0] === 'lineTo') points.push([operation[1], operation[2]]);
    else if (operation[0] === 'fill' && operation.fillStyle === 'rgba(255,255,255,1)' && points.length) {
      const center = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
      const ground = camera.unprojectAt(center[0], center[1], 30 * perMeter);
      distances.push(Math.hypot(ground[0] - eye[0], ground[1] - eye[1]));
    }
  }
  tilted.map.destroy();
  assert.ok(distances.length >= 2, 'tilted roofs render');
  for (let i = 1; i < distances.length; i++) assert.ok(distances[i] <= distances[i - 1] + 1, 'roof ' + i + ' is not farther than the one before');
});

test('fill-extrusion treats the tile square as a seam, not as a wall', async () => {
  const style = [{ sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#c8bfae', height: 20 } }];
  let inside = 0;
  let crossing = 0;
  for (const bearing of [30, -30]) {
    const a = await drawBuildings([taggedFeature(3, square(3000, 1000, 900))], style, { pitch: 45, bearing }, [], [], { perspective: false });
    a.map.destroy();
    const b = await drawBuildings([taggedFeature(3, square(3000, 1000, 2000))], style, { pitch: 45, bearing }, [], [], { perspective: false });
    b.map.destroy();
    inside += a.fills.length;
    crossing += b.fills.length;
  }
  assert.ok(crossing < inside, 'the clipped edge at x = extent draws no wall');
});

test('queryRenderedFeatures finds a pitched building by its walls and roof', async () => {
  const style = [{ id: 'b3d', sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#c8bfae', height: 400 } }];
  // Only the centre tile holds the building, so every hit is that one.
  const data = concat([bytesField(3, featureLayer('building', [taggedFeature(3, square(1024, 1024, 2048))]))]);
  const empty = concat([bytesField(3, featureLayer('building', []))]);
  const count = 65536;
  const centre = [Math.floor((0.1 + 180) / 360 * count), Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + 0.1 * Math.PI / 360)) / (2 * Math.PI)) * count)];
  const { container, map } = createMap({ center: [0.1, 0.1], zoom: 16, pitch: 45 });
  container.clientWidth = 200;
  container.clientHeight = 200;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', minZoom: 0, maxZoom: 18, tileBuffer: 0, style,
    fetch: url => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(url === '/vectors/16/' + centre[0] + '/' + centre[1] + '.mvt' ? data : empty)) })
  });
  await wait(35);
  const operations = layer.getCanvas().getContext('2d').operations;
  const end = operations.map(operation => operation[0]).lastIndexOf('fill');
  const start = operations.map(operation => operation[0]).lastIndexOf('beginPath', end);
  const points = operations.slice(start, end).filter(operation => operation[0] === 'moveTo' || operation[0] === 'lineTo');
  const roof = [points.reduce((sum, point) => sum + point[1], 0) / points.length, points.reduce((sum, point) => sum + point[2], 0) / points.length];
  assert.deepEqual(layer.queryRenderedFeatures(roof, { layers: ['b3d'] }).map(feature => feature.layer.id), ['b3d'], 'the view ray meets the roof');
  map.setPitch(0);
  await wait(35);
  assert.deepEqual(layer.queryRenderedFeatures(roof, { layers: ['b3d'], radius: 0 }), [], 'the roof point lies outside the footprint');
  map.destroy();
});

test('Karte.Bayern profile draws connector roads before local detail and preserves casing order', async () => {
  const data = tinyTilesDetailFixture();

  async function drawAt(zoom) {
    const { container, map } = createMap({ center: [0.1, 0.1], zoom });
    container.clientWidth = 200;
    container.clientHeight = 200;
    map.resize();
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt',
      minZoom: 0,
      maxZoom: 14,
      tileBuffer: 0,
      style: karteBayernBlueStyle(),
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
    });
    await wait(35);
    const operations = layer.getCanvas().getContext('2d').operations.slice();
    map.destroy();
    return operations;
  }

  const middle = await drawAt(10);
  const middleStrokes = middle.filter(operation => operation[0] === 'stroke').map(operation => operation[1]);
  assert.ok(middleStrokes.includes('#d8c3a5'), 'road casings render in the overview band');
  assert.ok(middleStrokes.includes('#fff5df'), 'major road cores render in the overview band');
  assert.ok(middleStrokes.includes('#ffffff'), 'secondary connectors render in the overview band');
  assert.ok(middleStrokes.indexOf('#d8c3a5') < middleStrokes.indexOf('#fff5df'), 'casings paint before their road cores');

  const detail = await drawAt(14);
  const detailStrokes = detail.filter(operation => operation[0] === 'stroke').map(operation => operation[1]);
  assert.equal(
    detailStrokes.filter(color => color === '#ffffff').length,
    detailStrokes.filter(color => color === '#fff5df').length * 2,
    'only connector and local streets join the detail band; footways remain absent'
  );
});

test('loads, draws and keeps a lower vector zoom visible while a higher zoom is pending', async () => {
  const requests = [];
  let resolveHigherZoom;
  const data = fixture();
  const { container, map } = createMap();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 2,
    tileBuffer: 0,
    style: [
      { sourceLayer: 'landcover', type: 'fill', paint: { color: '#dfe9d7' } },
      { sourceLayer: 'transportation', type: 'line', filter: ['==', 'class', 'primary'], paint: { color: '#d75d38', width: 2 } },
      { sourceLayer: 'transportation', type: 'line', filter: ['==', 'class', 'secondary'], paint: { color: '#2468aa', width: 2 } },
      { sourceLayer: 'place', type: 'circle', paint: { color: '#263238', radius: 3 } }
    ],
    fetch(url) {
      requests.push(url);
      if (url.indexOf('/1/') > -1) return new Promise(resolve => { resolveHigherZoom = resolve; });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });

  await wait();
  const canvas = layer.getCanvas();
  const context = canvas.getContext('2d');
  assert.equal(canvas.parentNode, container);
  assert.ok(requests.some(url => url === '/vectors/0/0/0.mvt'));
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'));
  assert.ok(context.operations.some(operation => operation[0] === 'fill'));
  assert.ok(context.operations.some(operation => operation[0] === 'arc'));
  assert.ok(context.operations.some(operation => operation[0] === 'stroke' && operation[1] === '#d75d38'));
  assert.ok(!context.operations.some(operation => operation[0] === 'stroke' && operation[1] === '#2468aa'));

  context.operations.length = 0;
  map.setZoom(1);
  await wait();
  assert.ok(requests.some(url => url.indexOf('/vectors/1/') === 0), 'the target zoom must start loading');
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'), 'the loaded lower zoom remains drawn behind pending target tiles');

  resolveHigherZoom({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
  map.destroy();
  assert.equal(canvas.parentNode, null, 'map destruction tears down the vector canvas');
});

test('keeps a cached higher vector zoom visible while a lower zoom is pending', async () => {
  const requests = [];
  const data = fixture();
  const { map } = createMap({ zoom: 1 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 2,
    tileBuffer: 0,
    style: [{ sourceLayer: 'transportation', type: 'line', paint: { color: '#d75d38', width: 2 } }],
    fetch(url) {
      requests.push(url);
      if (url.indexOf('/0/') > -1) return new Promise(() => {});
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait(35);
  const context = layer.getCanvas().getContext('2d');
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'), 'initial higher zoom must render');

  context.operations.length = 0;
  map.setZoom(0);
  await wait();
  assert.ok(requests.some(url => url === '/vectors/0/0/0.mvt'));
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'), 'the cached higher zoom must fill a pending lower target');
  map.destroy();
});

test('does not redraw a far more detailed fallback during a zoom-out', async () => {
  const data = fixture();
  const { map } = createMap({ zoom: 3 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 3,
    tileBuffer: 0,
    maxFallbackZoomDelta: 1,
    style: [{ sourceLayer: 'transportation', type: 'line', paint: { color: '#d75d38', width: 2 } }],
    fetch(url) {
      if (url.indexOf('/0/') > -1) return new Promise(() => {});
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait(40);
  const context = layer.getCanvas().getContext('2d');
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'), 'initial detail zoom must render');

  context.operations.length = 0;
  map.setZoom(0);
  await wait();
  assert.ok(!context.operations.some(operation => operation[0] === 'lineTo'), 'z3 fallback exceeds the configured z1 limit for a z0 target');
  map.destroy();
});

test('does not repaint every previously visited zoom level while a zoom-out target is pending', async () => {
  const data = fixture();
  const { map } = createMap({ center: [11, 48], zoom: 0 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 10,
    tileBuffer: 0,
    style: [{ sourceLayer: 'transportation', type: 'line', paint: { color: '#d75d38', width: 2 } }],
    fetch(url) {
      if (url.indexOf('/vectors/10/') === 0) return new Promise(() => {});
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });

  // An ordinary session that gradually zoomed in caches a tile at every
  // level along the way, not just the one it started or ended on.
  for (let z = 0; z <= 9; z++) {
    map.setZoom(z);
    await wait();
  }

  const context = layer.getCanvas().getContext('2d');
  context.operations.length = 0;
  map.setZoom(10);
  await wait();

  const clips = context.operations.filter(operation => operation[0] === 'clip').length;
  assert.equal(
    clips, 1,
    'the cached z0 tile alone already covers the whole viewport; the other nine cached zooms from the same session must not also be repainted underneath it while z10 is still loading'
  );
  map.destroy();
});

test('applies the fallback detail cap below a vector source minZoom', async () => {
  const data = fixture();
  const { map } = createMap({ zoom: 3 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    minZoom: 3,
    maxZoom: 3,
    tileBuffer: 0,
    maxFallbackZoomDelta: 1,
    style: [{ sourceLayer: 'transportation', type: 'line', paint: { color: '#d75d38', width: 2 } }],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  await wait(40);
  const context = layer.getCanvas().getContext('2d');
  assert.ok(context.operations.some(operation => operation[0] === 'lineTo'), 'the source-level tile must render initially');

  context.operations.length = 0;
  map.setZoom(0);
  await wait();
  assert.ok(!context.operations.some(operation => operation[0] === 'lineTo'), 'a z3 cache is not a useful fallback for a z0 camera');
  map.destroy();
});

test('retries transient vector failures after retryDelay while the map is idle', async () => {
  const failures = [
    { label: 'network error', response: () => Promise.reject(new TypeError('network unavailable')) },
    { label: 'request timeout', response: () => Promise.resolve({ ok: false, status: 408 }) },
    { label: 'rate limit', response: () => Promise.resolve({ ok: false, status: 429 }) },
    { label: 'server error', response: () => Promise.resolve({ ok: false, status: 503 }) }
  ];

  for (const failure of failures) {
    let requests = 0;
    const data = fixture();
    const { map } = createMap();
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt',
      tileBuffer: 0,
      retryDelay: 12,
      fetch() {
        requests++;
        if (requests === 1) return failure.response();
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
      }
    });
    await wait(60);
    assert.equal(requests, 2, failure.label);
    assert.ok(layer.getCanvas().getContext('2d').operations.some(operation => operation[0] === 'lineTo'), failure.label);
    map.destroy();
  }
});

test('does not retry permanent vector client errors while the map is idle', async () => {
  for (const status of [400, 401, 403, 404, 410]) {
    let requests = 0;
    const { map } = createMap();
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt',
      tileBuffer: 0,
      retryDelay: 12,
      fetch() {
        requests++;
        return Promise.resolve({ ok: false, status: status });
      }
    });
    await wait(45);
    layer.redraw();
    await wait(20);
    assert.equal(requests, 1, 'HTTP ' + status + ' must stay suppressed until the source changes');
    map.destroy();
  }
});

test('tries a permanently failed vector tile again after its source changes', async () => {
  const data = fixture();
  const requests = [];
  const { map } = createMap();
  const layer = microMapVector(map, {
    tiles: '/old/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    retryDelay: 12,
    fetch(url) {
      requests.push(url);
      if (url.indexOf('/recovered/') === 0) {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }
  });
  await wait(45);
  assert.ok(requests.some(url => url.indexOf('/old/') === 0));
  layer.setTiles('/recovered/{z}/{x}/{y}.mvt');
  await wait(45);
  assert.ok(requests.some(url => url.indexOf('/recovered/') === 0));
  map.destroy();
});

test('switching a vector source cannot be blocked by an old fetch that ignores abort', async () => {
  const data = fixture();
  const requests = [];
  const { map } = createMap();
  const layer = microMapVector(map, {
    tiles: '/old/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    maxConcurrent: 1,
    fetch(url) {
      requests.push(url);
      if (url.indexOf('/old/') === 0) return new Promise(() => {});
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait();
  assert.ok(requests.some(url => url.indexOf('/old/') === 0));
  layer.setTiles('/new/{z}/{x}/{y}.mvt');
  await wait();
  assert.ok(requests.some(url => url.indexOf('/new/') === 0), 'the new source must receive a free request slot');
  map.destroy();
});

test('preloads a bounded surrounding ring and an ahead detail zoom', async () => {
  const data = fixture();
  const urls = [];
  const { map } = createMap({ zoom: 2 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    minZoom: 0,
    maxZoom: 4,
    preload: {
      around: 1,
      zoom: 1,
      direction: { bearing: 90, distance: 2, width: 0 },
      maxTiles: 12,
      delay: 0
    },
    fetch(url) {
      urls.push(url);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait(80);
  const tiles = urls.map(url => url.match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/).slice(1).map(Number));
  const preloadedDetail = tiles.filter(tile => tile[0] === 3);
  assert.ok(tiles.some(tile => tile[0] === 2 && (tile[1] === 0 || tile[1] >= 3)), 'expected an outside ring: ' + JSON.stringify(tiles));
  assert.ok(preloadedDetail.length > 0, 'expected detail zoom requests: ' + JSON.stringify(tiles));
  assert.ok(preloadedDetail.every(tile => tile[1] >= 5), 'bearing 90 must bias the extra zoom east: ' + JSON.stringify(preloadedDetail));
  assert.ok(urls.length <= 16, 'four visible plus at most twelve speculative requests');
  map.destroy();
});

test('preload true uses the shared surrounding-ring and detail-zoom defaults', () => {
  const { map } = createMap({ zoom: 2 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    preload: true,
    fetch() { return new Promise(() => {}); }
  });
  assert.deepEqual(layer.getPreload(), {
    around: 1, zoom: [1], direction: null, maxTiles: 48, delay: 120
  });
  layer.destroy();
  map.destroy();
});

test('uses core navigation state as the vector preload focus and heading', async () => {
  const data = fixture();
  const urls = [];
  const { map } = createMap({ center: [-1, 0], zoom: 12 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    preload: { around: 1, zoom: [], maxTiles: 8, delay: 0 },
    fetch(url) {
      urls.push(url);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  map.setNavigation({ position: [0, 0], heading: 90, speed: 1000, lookAhead: 120 });
  await wait(80);
  const tileXs = urls
    .map(url => url.match(/\/12\/(\d+)\/(\d+)\.mvt$/))
    .filter(Boolean)
    .map(match => Number(match[1]));
  assert.ok(tileXs.some(x => x > 2050), 'navigation focus and heading must request ahead of the camera: ' + JSON.stringify(tileXs));
  assert.equal(layer.getNavigation().heading, 90);
  map.setNavigation(null);
  assert.equal(layer.getNavigation(), null, 'navigationchange from the core must clear vector state too');
  map.destroy();
});

test('keeps visible vector tiles ahead of speculative preload work', async () => {
  const pending = [];
  const urls = [];
  const { map } = createMap({ zoom: 2 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    maxConcurrent: 1,
    preload: { around: 1, zoom: 1, maxTiles: 12, delay: 0 },
    fetch(url) {
      urls.push(url);
      return new Promise(resolve => pending.push(resolve));
    }
  });
  await wait(20);
  assert.equal(urls.length, 1);
  pending.shift()({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) });
  await wait(20);
  const next = urls[1].match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/).slice(1).map(Number);
  assert.equal(next[0], 2, 'the second request remains a visible current-zoom tile');
  assert.ok(next[1] >= 1 && next[1] <= 2 && next[2] >= 1 && next[2] <= 2, 'visible range: ' + JSON.stringify(next));
  layer.destroy();
  map.destroy();
});

test('cleans scheduled vector preloads on source changes and destruction', async () => {
  const data = fixture();
  const urls = [];
  const { map } = createMap({ zoom: 2 });
  const layer = microMapVector(map, {
    tiles: '/old/{z}/{x}/{y}.mvt',
    preload: { around: 2, zoom: 1, maxTiles: 32, delay: 30 },
    fetch(url) {
      urls.push(url);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  layer.setTiles('/new/{z}/{x}/{y}.mvt');
  await wait(80);
  assert.ok(urls.length > 0);
  assert.ok(urls.every(url => url.indexOf('/new/') === 0), 'old scheduled preload leaked: ' + JSON.stringify(urls));
  const beforeDestroy = urls.length;
  layer.destroy();
  await wait(50);
  assert.equal(urls.length, beforeDestroy, 'destroy must cancel any delayed preload');
  map.destroy();
});

test('loads MVT TileJSON and preserves its metadata on the layer', async () => {
  const data = fixture();
  const { map } = createMap();
  const layer = await microMapVector.fromTileJSON(map, '/tilejson.json', {
    fetch(url) {
      if (url === '/tilejson.json') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tiles: ['/tiles/{z}/{x}/{y}.mvt'], format: 'mvt', minzoom: 2, maxzoom: 9 })
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait();
  assert.equal(layer.getTileJSON().format, 'mvt');
  map.destroy();
});

test('resolves relative MVT TileJSON templates against the TileJSON endpoint', async () => {
  const data = fixture();
  const requested = [];
  const { map } = createMap();
  const tileJSONURL = 'https://tiles.example.test/catalog/tilejson.json';
  await microMapVector.fromTileJSON(map, tileJSONURL, {
    tileBuffer: 0,
    fetch(url) {
      requested.push(url);
      if (url === tileJSONURL) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tiles: ['./mvt/{z}/{x}/{y}.mvt'], format: 'mvt' })
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    }
  });
  await wait();
  assert.ok(requested.includes('https://tiles.example.test/catalog/mvt/0/0/0.mvt'), JSON.stringify(requested));
  map.destroy();
});

test('draws MapLibre-style symbol labels above geometry with a halo and upright line placement', async () => {
  const data = concat([
    bytesField(3, namedLayer('place', 1, [9, 4096, 4096], 'Dingolfing')),
    bytesField(3, namedLayer('waterway', 2, [9, 0, 4096, 10, 8192, 4096], 'Isar'))
  ]);
  const { container, map } = createMap();
  // Avoid a second world copy sitting exactly on a 256px boundary.
  container.clientWidth = 254;
  container.clientHeight = 254;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    style: { layers: [
      { sourceLayer: 'waterway', type: 'line', paint: { color: '#569fca', width: 1.5 } },
      {
        sourceLayer: 'place',
        type: 'symbol',
        layout: { 'text-field': ['get', 'name'], 'text-size': 13, 'text-font': ['serif'] },
        paint: { 'text-color': '#263238', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }
      },
      {
        sourceLayer: 'waterway',
        type: 'symbol',
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'symbol-placement': 'line' },
        paint: { 'text-color': '#397da5', 'text-halo-color': '#fff', 'text-halo-width': 1 }
      }
    ] },
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  await wait();
  const operations = layer.getCanvas().getContext('2d').operations;
  const labels = operations.filter(operation => operation[0] === 'fillText').map(operation => operation[1]);
  assert.ok(labels.includes('Dingolfing'), JSON.stringify(labels));
  // A line label is drawn glyph by glyph along its line.
  assert.ok(labels.join('').includes('Isar'), JSON.stringify(labels));
  const halo = operations.findIndex(operation => operation[0] === 'strokeText' && operation[1] === 'Dingolfing');
  const text = operations.findIndex(operation => operation[0] === 'fillText' && operation[1] === 'Dingolfing');
  assert.ok(halo >= 0 && halo < text, 'halo must be drawn before text');
  assert.ok(operations.some(operation => operation[0] === 'rotate' && Number.isFinite(operation[1]) && operation[1] !== 0), 'line label should rotate with its river');
  map.destroy();
});

test('accepts callback style arrays so a feature can draw geometry and a text label together', async () => {
  const data = bytesField(3, namedLayer('waterway', 2, [9, 0, 4096, 10, 8192, 0], 'Isar'));
  const { container, map } = createMap();
  container.clientWidth = 254;
  container.clientHeight = 254;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    style(sourceLayer, feature) {
      if (sourceLayer !== 'waterway') return null;
      return [
        { type: 'line', color: '#569fca', width: 1.5 },
        { type: 'symbol', text: feature.properties.name, placement: 'line', color: '#397da5', haloColor: '#fff', haloWidth: 1 }
      ];
    },
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  await wait();
  const operations = layer.getCanvas().getContext('2d').operations;
  assert.ok(operations.some(operation => operation[0] === 'lineTo'));
  assert.ok(operations.some(operation => operation[0] === 'fillText' && operation[1] === 'Isar'));
  map.destroy();
});

test('rejects TileJSON that is not an unambiguous XYZ MVT source', async () => {
  const { map } = createMap();
  await assert.rejects(
    () => microMapVector.fromTileJSON(map, '/bad.json', {
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ tiles: ['/tiles/{z}/{x}/{y}.png'], format: 'mvt' }) })
    }),
    /MVT\/PBF/
  );
  await assert.rejects(
    () => microMapVector.fromTileJSON(map, '/missing-token.json', {
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ tiles: ['/tiles/{z}/{x}.mvt'], format: 'mvt' }) })
    }),
    /must contain \{z\}, \{x\} and \{y\}/
  );
  map.destroy();
});

test('rejects MapLibre style features that this renderer cannot render honestly', () => {
  const { map } = createMap();
  const tiles = '/tiles/{z}/{x}/{y}.mvt';
  const fetch = () => new Promise(() => {});
  try {
    assert.throws(() => microMapVector(map, { tiles, fetch, style: { layers: [{ type: 'raster' }] } }), /style layer type raster is not supported/);
    assert.throws(() => microMapVector(map, {
      tiles, fetch, style: { layers: [{ type: 'line', paint: { 'line-color': ['within', { type: 'Polygon', coordinates: [] }] } }] }
    }), /unsupported expression within/);
    assert.throws(() => microMapVector(map, {
      tiles, fetch, style: { layers: [{ type: 'symbol', layout: { 'text-field': ['get', 'name'], 'text-writing-mode': ['vertical'] } }] }
    }), /property text-writing-mode is not supported/);
    assert.throws(() => microMapVector(map, {
      tiles, fetch, style: { layers: [{ type: 'fill', paint: { 'fill-color': ['match', ['get', 'class'], 'a', '#fff'] } }] }
    }), /match needs label\/output pairs/);
    // Zoom and data expressions are part of the supported MapLibre subset.
    const layer = microMapVector(map, {
      tiles, fetch, style: { layers: [{ type: 'line', paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1, 10, ['match', ['get', 'class'], 'primary', 4, 2]] } }] }
    });
    layer.destroy();
    // strict: false skips an unsupported property and reports it instead.
    const lenient = microMapVector(map, {
      tiles, fetch, strict: false,
      style: { layers: [{ id: 'poi', type: 'symbol', layout: { 'text-field': ['get', 'name'], 'text-writing-mode': ['vertical'] } }] }
    });
    assert.deepEqual(lenient.getStyleReport().ignored, ['poi text-writing-mode']);
    lenient.destroy();
    // Icon-only symbol layers are supported; an empty symbol layer is not.
    const icons = microMapVector(map, { tiles, fetch, style: { layers: [{ id: 'arrows', type: 'symbol', layout: { 'icon-image': 'arrow' } }] } });
    assert.deepEqual(icons.getStyleReport().ignored, []);
    icons.destroy();
    assert.throws(() => microMapVector(map, { tiles, fetch, style: { layers: [{ type: 'symbol', layout: {} }] } }), /need a text-field or an icon-image/);
    const patterned = microMapVector(map, { tiles, fetch, style: { layers: [{ id: 'area', type: 'fill', paint: { 'fill-pattern': 'dots' } }] } });
    assert.deepEqual(patterned.getStyleReport().ignored, []);
    patterned.destroy();
  } finally {
    map.destroy();
  }
});

test('generated vector distribution exports the decoder in CommonJS', () => {
  const minifiedPath = path.resolve(__dirname, '..', 'lib', 'microMap.vector.min.js');
  delete require.cache[minifiedPath];
  const minified = require(minifiedPath);
  assert.equal(typeof minified, 'function');
  assert.equal(typeof minified.decodeMVT, 'function');
  assert.equal(minified.decodeMVT(fixture()).layers.length, 3);
});

test('optional vector distribution has its own package entry and size budget', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const minified = fs.readFileSync(path.join(projectRoot, 'lib/microMap.vector.min.js'));
  assert.ok(zlib.gzipSync(minified, { level: 9 }).length < 57344);
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./vector'], './lib/microMap.vector.js');
  assert.ok(packageJson.files.includes('lib'));
});

test.after(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test('point labels stay upright under bearing while line labels follow their line', async () => {
  const place = taggedFeature(1, [9, 4096, 4096], [0, 0]);
  const road = taggedFeature(2, [9, 0, 1024, 10, 8190, 0], [0, 1]);
  const data = concat([
    bytesField(3, featureLayer('place', [place], ['name'], [valueString('Dingolfing'), valueString('Hauptstraße')])),
    bytesField(3, featureLayer('road', [road], ['name'], [valueString('Dingolfing'), valueString('Hauptstraße')]))
  ]);
  const { container, map } = createMap({ center: [0, 0], zoom: 3, bearing: 30 });
  container.clientWidth = 400;
  container.clientHeight = 400;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt',
    tileBuffer: 0,
    style: [
      { sourceLayer: 'place', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
      { sourceLayer: 'road', type: 'symbol', layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line' } }
    ],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  await wait(35);
  const operations = layer.getCanvas().getContext('2d').operations;
  const rotationBefore = text => {
    const index = operations.findIndex(operation => operation[0] === 'fillText' && operation[1] === text);
    assert.ok(index > 0, text + ' is drawn');
    const save = operations.map(operation => operation[0]).lastIndexOf('save', index);
    return operations.slice(save, index).find(operation => operation[0] === 'rotate');
  };
  assert.equal(rotationBefore('Dingolfing'), undefined, 'a point label is not rotated with the map');
  // Line labels are drawn glyph by glyph; each glyph turns with the road.
  const roadRotation = rotationBefore('H');
  assert.ok(roadRotation && Math.abs(roadRotation[1] + Math.PI / 6) < 1e-6, 'a horizontal road label turns with the map plane (-30° for bearing 30)');
  const glyphs = operations.filter(operation => operation[0] === 'fillText').map(operation => operation[1]).join('');
  assert.ok(glyphs.includes('Hauptstraße'), glyphs);
  map.destroy();
});

test('line labels bend with their line, respect text-max-angle and keep shaped scripts whole', async () => {
  const zz = value => (value << 1) ^ (value >> 31);
  // A gentle arc and a hairpin, in tile units.
  const arc = Array.from({ length: 25 }, (_, i) => {
    const angle = (-115 + i * 50 / 24) * Math.PI / 180;
    return [Math.round(2048 + 2200 * Math.cos(angle)), Math.round(4300 + 2200 * Math.sin(angle))];
  });
  const hairpin = [[600, 1000], [2400, 1000], [2400, 1300], [600, 1300]];
  const commands = points => [9, zz(points[0][0]), zz(points[0][1]), 8 * (points.length - 1) + 2,
    ...points.slice(1).flatMap((point, index) => [zz(point[0] - points[index][0]), zz(point[1] - points[index][1])])];
  async function drawn(points, name) {
    const data = concat([bytesField(3, featureLayer('road', [taggedFeature(2, commands(points), [0, 0])], ['name'], [valueString(name)]))]);
    const { container, map } = createMap({ center: [0, 0], zoom: 0 });
    container.clientWidth = 256;
    container.clientHeight = 256;
    map.resize();
    const layer = microMapVector(map, {
      tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, maxZoom: 0,
      // The test canvas measures 0.07 em per glyph: a large size gives a long run.
      style: [{ sourceLayer: 'road', type: 'symbol', layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line', 'text-size': 90 } }],
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
    });
    await wait(35);
    const operations = layer.getCanvas().getContext('2d').operations.slice();
    map.destroy();
    const texts = [];
    for (let i = 0; i < operations.length; i++) {
      if (operations[i][0] !== 'fillText') continue;
      const save = operations.map(operation => operation[0]).lastIndexOf('save', i);
      const rotate = operations.slice(save, i).find(operation => operation[0] === 'rotate');
      texts.push({ text: operations[i][1], angle: rotate ? rotate[1] : 0 });
    }
    return texts;
  }
  const curved = await drawn(arc, 'Ringstraße');
  assert.equal(curved.map(entry => entry.text).join(''), 'Ringstraße', 'drawn glyph by glyph');
  const angles = curved.map(entry => entry.angle);
  assert.ok(Math.max(...angles) - Math.min(...angles) > 0.1, 'glyphs follow the curve: ' + angles.map(a => a.toFixed(2)));
  assert.ok(angles.every(angle => Math.abs(angle) < Math.PI / 2), 'the text stays upright');
  assert.deepEqual(await drawn(hairpin, 'Kehre am Berg'), [], 'a hairpin exceeds text-max-angle');
  const arabic = await drawn(arc, 'شارع');
  assert.deepEqual(arabic.map(entry => entry.text), ['شارع'], 'a shaped script is drawn as one straight run');
});

test('point labels follow the pitched, rotated core camera', async () => {
  const { map } = createMap({ bearing: 30, pitch: 20 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, maxZoom: 0,
    style: [{ id: 'places', sourceLayer: 'place', type: 'symbol', layout: { 'text-field': ['get', 'name'] } }],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }),
    decodeTile: () => ({ layers: [{ name: 'place', extent: 4096, features: [
      { id: 1, type: 1, properties: { name: 'East' }, parts: [[[2560, 2048]]] }
    ] }] })
  });
  await wait(35);
  const operations = layer.getCanvas().getContext('2d').operations;
  const labelIndex = operations.findIndex(operation => operation[0] === 'fillText' && operation[1] === 'East');
  assert.ok(labelIndex > 0, 'the point label is drawn');
  const translate = operations.slice(0, labelIndex).reverse().find(operation => operation[0] === 'translate');
  const expected = map.project([45, 0]);
  assert.ok(Math.abs(translate[1] - expected[0]) < 1e-6);
  assert.ok(Math.abs(translate[2] - expected[1]) < 1e-6);
  map.destroy();
});

test('tile-local MVT clustering keeps selected source layers and query results', async () => {
  const count = Math.pow(2, 12);
  const longitude = (count / 2 + 0.5) / count * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (count / 2 + 0.5) / count))) * 180 / Math.PI;
  const { map } = createMap({ center: [longitude, latitude], zoom: 12 });
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, maxZoom: 12,
    clusterMVT: { maxZoom: 14, sourceLayers: ['poi'] },
    style: [
      { id: 'clusters', sourceLayer: 'poi', type: 'circle', filter: ['has', 'point_count'], paint: { radius: 10 } },
      { id: 'single', sourceLayer: 'other', type: 'circle', paint: { radius: 5 } }
    ],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }),
    decodeTile: () => ({ layers: [
      { name: 'poi', extent: 4096, features: [
        { id: 1, type: 1, properties: { name: 'A' }, parts: [[[2048, 2048]]] },
        { id: 2, type: 1, properties: { name: 'B' }, parts: [[[2060, 2048]]] }
      ] },
      { name: 'other', extent: 4096, features: [
        { id: 3, type: 1, properties: { name: 'C' }, parts: [[[2048, 2048]]] }
      ] }
    ] })
  });
  await wait(40);
  const clusters = layer.queryRenderedFeatures([128, 128], { layers: ['clusters'], radius: 8 });
  assert.ok(clusters.some(feature => feature.properties.point_count === 2), 'close MVT points form a cluster');
  const singles = layer.queryRenderedFeatures([128, 128], { layers: ['single'], radius: 8 });
  assert.ok(singles.some(feature => feature.properties.name === 'C' && !feature.properties.cluster), 'unselected MVT layers remain unclustered');
  map.destroy();
});

test('custom tile decoding still enforces the tag limit', async () => {
  const { map } = createMap();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, maxZoom: 0, maxTags: 1,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }),
    decodeTile: () => ({ layers: [{ name: 'poi', extent: 4096, features: [
      { id: 1, type: 1, properties: { name: 'A' }, parts: [[[2048, 2048]]] }
    ] }] })
  });
  const errors = [];
  layer.on('tileerror', event => errors.push(event.error));
  await wait(35);
  assert.ok(errors.some(error => /too many tags/.test(error.message)));
  map.destroy();
});

test('a pattern layer whose image is missing paints nothing instead of default black', async () => {
  const { container, map } = createMap({ center: [0.1, 0.1], zoom: 3 });
  container.clientWidth = 200;
  container.clientHeight = 200;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, strict: false,
    style: { layers: [{ id: 'area', sourceLayer: 'landcover', type: 'fill', paint: { 'fill-pattern': 'dots' } }] },
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(fixture())) })
  });
  await wait(35);
  assert.equal(layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'fill').length, 0);
  map.destroy();
});

// A point at the tile centre with a `kind` tag, for icon tests.
function iconFixture(kinds) {
  const features = kinds.map(() => taggedFeature(1, [9, 4096, 4096], [0, 0]));
  return concat([bytesField(3, featureLayer('poi', features, ['kind'], [valueString(kinds[0])]))]);
}

async function iconMap(style, data, setup, zoom = 0) {
  const { container, map } = createMap({ center: [0, 0], zoom });
  container.clientWidth = 256;
  container.clientHeight = 256;
  map.resize();
  const layer = microMapVector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', tileBuffer: 0, maxZoom: zoom ? 1 : 0, style,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  if (setup) setup(layer);
  await wait(35);
  const draws = layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'drawImage');
  return { map, layer, draws };
}

test('icon-image draws registered images at the anchor, scaled by icon-size', async () => {
  const pin = { width: 32, height: 48 }; // stands in for an image or canvas
  const style = { layers: [{ id: 'pins', sourceLayer: 'poi', type: 'symbol', layout: { 'icon-image': ['get', 'kind'], 'icon-size': 0.5, 'icon-anchor': 'bottom' } }] };
  const { map, layer, draws } = await iconMap(style, iconFixture(['pin']), layer => layer.addImage('pin', pin, { pixelRatio: 2 }));
  const icon = draws.find(operation => operation[1] === pin);
  assert.ok(icon, 'the registered image is drawn');
  // 32x48 at pixelRatio 2 is 16x24 CSS px, halved by icon-size; anchored at its bottom centre.
  assert.deepEqual(icon.slice(2, 10), [0, 0, 32, 48, -4, -12, 8, 12]);
  assert.equal(layer.hasImage('pin'), true);
  assert.deepEqual(layer.listImages(), ['pin']);
  assert.throws(() => layer.addImage('pin', pin), /already exists/);
  layer.removeImage('pin');
  assert.equal(layer.hasImage('pin'), false);
  map.destroy();
});

test('styleimagemissing fires once and an image added by the listener is used', async () => {
  const marker = { width: 10, height: 10 };
  let asked = [];
  const style = { layers: [{ id: 'pins', sourceLayer: 'poi', type: 'symbol', layout: { 'icon-image': 'marker-{kind}' } }] };
  const { map, draws } = await iconMap(style, iconFixture(['shop']), layer => layer.on('styleimagemissing', event => {
    asked.push(event.id);
    layer.addImage(event.id, marker);
  }));
  assert.deepEqual(asked, ['marker-shop'], 'legacy {tokens} resolve in icon-image');
  assert.ok(draws.some(operation => operation[1] === marker));
  map.destroy();
});

test('overlapping icons collide unless icon-allow-overlap is set', async () => {
  const dot = { width: 20, height: 20 };
  const draw = async overlap => {
    const style = { layers: [{ id: 'dots', sourceLayer: 'poi', type: 'symbol', layout: { 'icon-image': 'dot', 'icon-allow-overlap': overlap } }] };
    const result = await iconMap(style, iconFixture(['a', 'b']), layer => layer.addImage('dot', dot));
    result.map.destroy();
    return result.draws.filter(operation => operation[1] === dot).length;
  };
  assert.equal(await draw(false), 1);
  assert.equal(await draw(true), 2);
});

test('text-optional drops a colliding label but keeps its icon', async () => {
  const dot = { width: 20, height: 20 };
  const data = concat([
    bytesField(3, featureLayer('poi', [taggedFeature(1, [9, 4096, 4096], [0, 0])], ['name'], [valueString('Rathaus')])),
    bytesField(3, featureLayer('block', [taggedFeature(1, [9, 4096, 4096], [0, 0])], ['name'], [valueString('Blocker')]))
  ]);
  const style = { layers: [
    { id: 'poi', sourceLayer: 'poi', type: 'symbol', layout: { 'icon-image': 'dot', 'text-field': ['get', 'name'], 'text-offset': [0, 1.5], 'text-optional': true } },
    { id: 'block', sourceLayer: 'block', type: 'symbol', layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 1.5] } }
  ] };
  const { map, layer, draws } = await iconMap(style, data, layer => layer.addImage('dot', dot));
  const texts = layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'fillText').map(operation => operation[1]);
  assert.ok(draws.some(operation => operation[1] === dot), 'the icon is placed');
  assert.equal(texts.filter(text => text === 'Rathaus').length + texts.filter(text => text === 'Blocker').length, 1, 'only one of the colliding labels is drawn');
  map.destroy();
});

test('fill-pattern and line-pattern paint with the registered image', async () => {
  const stripes = { width: 8, height: 8 };
  const data = concat([
    bytesField(3, featureLayer('land', [taggedFeature(3, square(512, 512, 2048))])),
    bytesField(3, featureLayer('border', [taggedFeature(2, [9, 1024, 3000, 10, 4000, 0])]))
  ]);
  const style = { layers: [
    { id: 'mask', sourceLayer: 'land', type: 'fill', paint: { 'fill-pattern': 'stripes' } },
    { id: 'edge', sourceLayer: 'border', type: 'line', paint: { 'line-pattern': 'stripes', 'line-width': 6 } }
  ] };
  const { map, layer } = await iconMap(style, data, layer => layer.addImage('stripes', stripes));
  const operations = layer.getCanvas().getContext('2d').operations;
  const fills = operations.filter(operation => operation[0] === 'fill');
  const strokes = operations.filter(operation => operation[0] === 'stroke');
  assert.ok(fills.some(operation => operation.fillStyle && operation.fillStyle.pattern === stripes), 'the area is filled with the pattern');
  const patterned = strokes.filter(operation => operation[1] && operation[1].pattern === stripes);
  assert.ok(patterned.length > 0 && patterned.every(operation => operation[2] === 6), 'the line is stroked with the pattern at its width');
  map.destroy();
});

test('line-offset shifts a line to the right of its direction', async () => {
  const data = concat([bytesField(3, featureLayer('road', [taggedFeature(2, [9, 1024, 2048, 10, 4096, 0])]))]);
  const draw = async offset => {
    const style = { layers: [{ id: 'road', sourceLayer: 'road', type: 'line', paint: { 'line-color': '#f00', 'line-width': 2, 'line-offset': offset } }] };
    const result = await iconMap(style, data);
    const moves = result.layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'moveTo');
    result.map.destroy();
    return moves;
  };
  const plain = await draw(0.0001);
  const shifted = await draw(10);
  assert.ok(plain.length > 0 && shifted.length === plain.length);
  // An eastbound line: "right" is south, i.e. +y on screen.
  for (let i = 0; i < plain.length; i++) {
    assert.ok(Math.abs(shifted[i][1] - plain[i][1]) < 1e-6);
    assert.ok(Math.abs(shifted[i][2] - plain[i][2] - 10) < 1e-3, 'moved 10px down: ' + (shifted[i][2] - plain[i][2]));
  }
});

test('line-gap-width draws two lines either side of the gap; line-translate shifts by pixels', async () => {
  const data = concat([bytesField(3, featureLayer('road', [taggedFeature(2, [9, 1024, 2048, 10, 4096, 0])]))]);
  const draw = async paint => {
    const style = { layers: [{ id: 'road', sourceLayer: 'road', type: 'line', paint: { 'line-color': '#f00', 'line-width': 2, ...paint } }] };
    const result = await iconMap(style, data);
    const operations = result.layer.getCanvas().getContext('2d').operations.slice();
    result.map.destroy();
    return operations;
  };
  const gap = await draw({ 'line-gap-width': 6 });
  const moves = gap.filter(operation => operation[0] === 'moveTo');
  const ys = [...new Set(moves.map(operation => Math.round(operation[2] * 1000) / 1000))].sort((a, b) => a - b);
  assert.equal(ys.length, 2, 'two parallel lines');
  assert.ok(Math.abs(ys[1] - ys[0] - 8) < 1e-3, 'separated by gap + width: ' + (ys[1] - ys[0]));
  const shifted = await draw({ 'line-translate': [5, -3] });
  assert.ok(shifted.some(operation => operation[0] === 'translate' && operation[1] === 5 && operation[2] === -3));
});

test('feature-state drives paint per feature and shows up in queries', async () => {
  const data = concat([bytesField(3, featureLayer('land', [
    identifiedFeature(1, 3, square(256, 256, 1024)),
    identifiedFeature(2, 3, square(2304, 2304, 1024))
  ]))]);
  const style = { version: 8, sources: { base: { type: 'vector', tiles: ['/t/{z}/{x}/{y}.pbf'] } }, layers: [
    { id: 'land', type: 'fill', source: 'base', 'source-layer': 'land', paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff0000', '#00ff00'] } }
  ] };
  const { map, layer } = await iconMap(style, data, null, 1);
  const fillsOf = () => layer.getCanvas().getContext('2d').operations.filter(operation => operation[0] === 'fill').map(operation => operation.fillStyle);
  assert.ok(fillsOf().includes('#00ff00') && !fillsOf().includes('#ff0000'), 'before: ' + fillsOf());
  layer.setFeatureState({ source: 'base', sourceLayer: 'land', id: 2 }, { hover: true });
  assert.deepEqual(layer.getFeatureState({ source: 'base', sourceLayer: 'land', id: 2 }), { hover: true });
  layer.getCanvas().getContext('2d').operations.length = 0;
  await wait(35);
  const after = fillsOf();
  assert.ok(after.includes('#ff0000') && after.includes('#00ff00'), 'only the hovered feature turns red: ' + after);
  layer.removeFeatureState({ source: 'base', sourceLayer: 'land', id: 2 }, 'hover');
  assert.deepEqual(layer.getFeatureState({ source: 'base', sourceLayer: 'land', id: 2 }), {});
  map.destroy();
});

test('clustered GeoJSON sources merge close points like MapLibre', async () => {
  const point = (lon, lat, value) => ({ type: 'Feature', properties: { value }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  const style = { version: 8, sources: {
    base: { type: 'vector', tiles: ['/t/{z}/{x}/{y}.pbf'] },
    stops: { type: 'geojson', cluster: true, clusterRadius: 50, clusterMaxZoom: 10, clusterProperties: { total: ['+', ['get', 'value']] },
      data: { type: 'FeatureCollection', features: [point(10, 48, 1), point(10.2, 48.1, 2), point(10.1, 47.9, 3), point(60, 10, 4)] } }
  }, layers: [
    { id: 'clusters', type: 'circle', source: 'stops', filter: ['has', 'point_count'], paint: { 'circle-radius': 12 } },
    { id: 'single', type: 'circle', source: 'stops', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 4 } }
  ] };
  const { map, layer } = await iconMap(style, concat([]), null, 1);
  const source = layer.getSource('stops');
  // The three close points form one cluster at low zoom.
  const all = [];
  for (let x = 0; x < 256; x += 8) for (let y = 0; y < 256; y += 8) all.push(...layer.queryRenderedFeatures([x, y], { layers: ['clusters'], radius: 8 }));
  const cluster = all.find(feature => feature.properties.cluster);
  assert.ok(cluster, 'a cluster is rendered');
  assert.equal(cluster.properties.point_count, 3);
  assert.equal(cluster.properties.point_count_abbreviated, '3');
  assert.equal(cluster.properties.total, 6, 'clusterProperties reduce the members');
  const leaves = await source.getClusterLeaves(cluster.properties.cluster_id, 10, 0);
  assert.deepEqual(leaves.map(leaf => leaf.properties.value).sort(), [1, 2, 3]);
  const expansion = await source.getClusterExpansionZoom(cluster.properties.cluster_id);
  assert.ok(expansion > 1 && expansion <= 11, 'expansion zoom ' + expansion);
  const children = await new Promise((resolve, reject) => source.getClusterChildren(cluster.properties.cluster_id, (error, value) => error ? reject(error) : resolve(value)));
  assert.ok(children.length >= 1);
  map.destroy();
});

// Minimal affine Canvas model to exercise the browser's offscreen cache path.
class TestMatrix {
  constructor(values = [1, 0, 0, 1, 0, 0]) {
    if (!Array.isArray(values)) values = ['a', 'b', 'c', 'd', 'e', 'f'].map(key => values[key]);
    [this.a, this.b, this.c, this.d, this.e, this.f] = values;
  }
  multiply(m) {
    return new TestMatrix([
      this.a * m.a + this.c * m.b, this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d, this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e, this.b * m.e + this.d * m.f + this.f
    ]);
  }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    return new TestMatrix([this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det]);
  }
}
class AffineContext extends RecordingContext {
  constructor(canvas) { super(); this.canvas = canvas; this.matrix = new TestMatrix(); this.matrices = []; }
  getTransform() { return new TestMatrix(this.matrix); }
  setTransform(...values) { super.setTransform(...values); this.matrix = new TestMatrix(values.length === 1 ? values[0] : values); }
  translate(x, y) { this.matrix = this.matrix.multiply(new TestMatrix([1, 0, 0, 1, x, y])); }
  scale(x, y) { this.matrix = this.matrix.multiply(new TestMatrix([x, 0, 0, y, 0, 0])); }
  rotate(angle) { this.matrix = this.matrix.multiply(new TestMatrix([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0])); }
  save() { super.save(); this.matrices.push(this.getTransform()); }
  restore() { super.restore(); this.matrix = this.matrices.pop(); }
}

function observedExtrusions() {
  const canvases = [];
  const prismCalls = [];
  const jobs = [];
  const observations = { styleChecks: 0 };
  const frames = new Map();
  let manualFrames = false;
  let clock = 0, clockStep = 0;
  const idle = new Map();
  let nextIdle = 1000000;
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../lib/microMap.vector.js'), 'utf8')
    .replace('function extrusionPrism(feature) {', 'function extrusionPrism(feature) { root.observePrism(feature);')
    .replace('function layerVisible(layer, zoom) {', 'function layerVisible(layer, zoom) { root.observeStyle();')
    .replace('function runExtrusionJob(job, budget) {', 'function runExtrusionJob(job, budget) { root.observeJob(job, budget);');
  // A read-only observer counts geometry work without adding a production API.
  require('node:vm').runInNewContext(source, {
    module, require: () => microMap, DOMMatrix: TestMatrix,
    document: { ...global.document, createElement(tag) {
      const element = new FakeElement(tag);
      if (tag === 'canvas') { element.context = new AffineContext(element); canvases.push(element); }
      return element;
    } },
    requestAnimationFrame(callback) {
      if (!manualFrames) return global.requestAnimationFrame(callback);
      const id = nextIdle++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { if (!frames.delete(id)) global.cancelAnimationFrame(id); },
    setTimeout(callback, delay) {
      if (delay === 16) { const id = nextIdle++; idle.set(id, callback); return id; }
      return setTimeout(callback, delay);
    },
    clearTimeout(id) { if (!idle.delete(id)) clearTimeout(id); },
    performance: { now: () => (clock += clockStep) },
    observePrism: feature => prismCalls.push(feature),
    observeStyle: () => observations.styleChecks++,
    observeJob: (job, budget) => jobs.push({ bearing: job.metrics.bearing, budget })
  });
  return {
    vector: module.exports, canvases, prismCalls, idle, jobs, observations,
    pauseFrames() { manualFrames = true; },
    setClockStep(step) { clockStep = step; },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    runIdle() { const [id, callback] = idle.entries().next().value; idle.delete(id); callback(); },
    fills() { return canvases.slice(1).reduce((sum, canvas) => sum + canvas.context.operations.filter(op => op[0] === 'fill').length, 0); }
  };
}

async function cachedBuildings(extra = {}) {
  const observed = observedExtrusions();
  const data = concat([bytesField(3, featureLayer('building', [identifiedFeature(1, 3, square(512, 512, 3072))]))]);
  const { container, map } = createMap({ center: [0, 0], zoom: 16, pitch: 45 });
  container.clientWidth = 100;
  container.clientHeight = 100;
  map.resize();
  const layer = observed.vector(map, {
    tiles: '/vectors/{z}/{x}/{y}.mvt', minZoom: 0, maxZoom: 18, tileBuffer: 0,
    // The 2.5D image cache belongs to the affine renderer, used for map
    // adapters without a perspective camera (or perspective: false).
    perspective: false,
    style: [{ id: 'buildings', sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#abcdef', height: 20 } }],
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) }),
    ...extra
  });
  await wait(35);
  return { ...observed, map, layer };
}

test('2.5D cache avoids per-building work on redraw/pan and ignores unrelated preloads', async () => {
  const scene = await cachedBuildings();
  try {
    const calls = scene.prismCalls.length;
    const fills = scene.fills();
    assert.ok(calls > 0 && fills > 0);
    scene.layer.redraw();
    scene.map.panBy([2, 0]);
    await wait(25);
    assert.equal(scene.prismCalls.length, calls, 'cache hits must not reconstruct building pieces');
    assert.equal(scene.fills(), fills, 'cached image is reused');
    let loaded = 0;
    scene.layer.on('tileload', event => { if (event.preload) loaded++; });
    scene.layer.setPreload({ around: 1, zoom: [], maxTiles: 4, delay: 0 });
    await wait(40);
    assert.ok(loaded > 0);
    assert.equal(scene.prismCalls.length, calls, 'preloads do not invalidate the visible cache');
    assert.equal(scene.fills(), fills);
    assert.ok(scene.idle.size > 0, 'preloaded geometry is prepared outside the render frame');
    scene.runIdle();
    assert.ok(scene.prismCalls.length > calls);
    assert.equal(scene.fills(), fills, 'preparation does not draw offscreen tiles');
    scene.layer.setPaintProperties('buildings', { 'fill-extrusion-height': 40, 'fill-extrusion-color': '#ff0000' });
    await wait(30);
    assert.ok(scene.fills() > fills, 'paint changes invalidate the image');
    const updated = scene.fills();
    scene.map.setPitch(60);
    await wait(25);
    assert.ok(scene.fills() > updated, 'large camera changes rerender the geometry');
  } finally { scene.map.destroy(); }
  assert.equal(scene.idle.size, 0, 'destroy cancels preparation');
});

test('2.5D cache refreshes progressively before a pan exhausts the image margin', async () => {
  const scene = await cachedBuildings();
  try {
    scene.map.setCenter([180 / 65536, -180 / 65536]);
    await wait(30);
    const calls = scene.prismCalls.length;
    scene.map.panBy([70, 0]);
    await wait(35);
    assert.ok(scene.prismCalls.length > calls, 'approaching the 96px margin starts a replacement image');
    const refreshed = scene.prismCalls.length;
    scene.layer.redraw();
    await wait(20);
    assert.equal(scene.prismCalls.length, refreshed, 'the completed replacement is reused');
  } finally { scene.map.destroy(); }
});

test('2.5D speculative preparation is bounded and cancelled when preloading stops', async () => {
  const data = concat([bytesField(3, featureLayer('building', Array.from({ length: 150 }, () => taggedFeature(3, square(512, 512, 64)))))]);
  const scene = await cachedBuildings({ fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) }) });
  try {
    scene.layer.setPreload({ around: 1, zoom: [], maxTiles: 4, delay: 0 });
    await wait(40);
    const before = scene.prismCalls.length;
    scene.runIdle();
    assert.equal(scene.prismCalls.length - before, 64, 'one background slice prepares at most 64 features');
    assert.ok(scene.idle.size > 0, 'remaining work yields to a later turn');
    scene.layer.setPreload(false);
    assert.equal(scene.idle.size, 0);
    scene.map.destroy();
    assert.equal(scene.idle.size, 0);
  } finally { scene.map.destroy(); }
});

test('2.5D cache invalidates feature-state colors even when heights and counts stay equal', async () => {
  const scene = await cachedBuildings({
    style: [{ id: 'buildings', sourceLayer: 'building', type: 'fill-extrusion', paint: {
      color: ['case', ['boolean', ['feature-state', 'selected'], false], '#ff0000', '#0000ff'], height: 20
    } }]
  });
  try {
    // Read the fixture feature's id from the geometry observer, as its roof
    // can lie away from the viewport center at this pitch.
    const feature = scene.prismCalls[0];
    assert.ok(feature);
    const before = scene.fills();
    scene.layer.setFeatureState({ sourceLayer: 'building', id: feature.id }, { selected: true });
    await wait(25);
    assert.ok(scene.fills() > before, 'a state-driven color change must rerender');
    const colors = scene.canvases.slice(1).flatMap(canvas => canvas.context.operations.filter(op => op[0] === 'fill').map(op => op.fillStyle));
    assert.ok(colors.includes('rgba(255,0,0,1)'), 'updated roof is red');
  } finally { scene.map.destroy(); }
});

test('2.5D image is rebuilt after replacing source data with equal feature counts', async () => {
  const scene = await cachedBuildings();
  try {
    const before = scene.fills();
    scene.layer.setTiles('/replacement/{z}/{x}/{y}.mvt');
    await wait(35);
    assert.ok(scene.fills() > before, 'new tile contents must not reuse an old image');
  } finally { scene.map.destroy(); }
});

test('late speculative tile responses cannot restart cancelled 2.5D preparation', async () => {
  const pending = [];
  let defer = false;
  const data = concat([bytesField(3, featureLayer('building', [taggedFeature(3, square(512, 512, 64))]))]);
  const response = () => ({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
  const scene = await cachedBuildings({ fetch: () => defer ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response()) });
  try {
    defer = true;
    scene.layer.setPreload({ around: 1, zoom: [], maxTiles: 4, delay: 0 });
    await wait(25);
    assert.ok(pending.length > 0);
    scene.layer.setPreload(false);
    for (const resolve of pending) resolve(response());
    await wait(25);
    assert.equal(scene.idle.size, 0);
  } finally { scene.map.destroy(); }
});

test('audit: invalid vector source options preserve in-flight requests and source', async () => {
  const urls = [];
  const pending = [];
  const { map } = createMap({ center: [0, 0], zoom: 2 });
  const data = fixture();
  const layer = microMapVector(map, {
    tiles: '/original/{z}/{x}/{y}.mvt', tileBuffer: 0,
    fetch(url) {
      urls.push(url);
      return new Promise(resolve => pending.push(resolve));
    }
  });
  try {
    let loaded = 0;
    layer.on('tileload', () => loaded++);
    await wait(20);
    const count = pending.length;
    assert.ok(count > 0);
    assert.throws(() => layer.setTiles('/invalid/{z}/{x}/{y}.mvt', { subdomains: '' }), /subdomains/);
    for (const resolve of pending) resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) });
    await wait(25);
    assert.equal(loaded, count, 'rejected input must not discard valid pending responses');
    layer.redraw();
    await wait(20);
    assert.equal(urls.length, count, 'completed requests remain cached');
    map.setCenter([100, 0]);
    await wait(20);
    assert.ok(urls.length > count);
    assert.ok(urls.every(url => url.startsWith('/original/')), 'the original source is retained');
  } finally { map.destroy(); }
});

test('audit: an obsolete 2.5D job is discarded before doing more drawing', async () => {
  const scene = await cachedBuildings();
  try {
    scene.pauseFrames();
    scene.map.setBearing(5);
    scene.flushFrames(); // starts a replacement, keeping the existing image
    scene.jobs.length = 0;
    scene.map.setBearing(35);
    scene.flushFrames();
    assert.ok(scene.jobs.length > 0, 'a large camera change needs a new image');
    assert.ok(scene.jobs.every(job => job.budget == null && job.bearing === -35),
      'do not spend a progressive slice on the obsolete 5-degree job: ' + JSON.stringify(scene.jobs));
  } finally { scene.map.destroy(); }
});

test('audit: progressive 2.5D layers share one frame budget and all eventually finish', async () => {
  const features = Array.from({ length: 150 }, () => taggedFeature(3, square(512, 512, 64)));
  const data = concat([bytesField(3, featureLayer('building', features))]);
  const scene = await cachedBuildings({
    style: [1, 2, 3].map(i => ({ id: 'b' + i, sourceLayer: 'building', type: 'fill-extrusion', paint: { color: '#abcdef', height: i * 10 } })),
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) })
  });
  try {
    scene.pauseFrames();
    scene.map.setBearing(5);
    scene.flushFrames();
    scene.jobs.length = 0;
    await wait(5); // also lets the baseline timer enqueue its next frame
    scene.setClockStep(1);
    scene.flushFrames();
    assert.equal(scene.jobs.filter(job => job.budget != null).length, 1,
      'an exhausted cooperative budget must defer other layers');
    scene.setClockStep(0);
    for (let i = 0; i < 5; i++) scene.flushFrames();
    const completed = scene.jobs.length;
    scene.layer.redraw();
    scene.flushFrames();
    assert.equal(scene.jobs.length, completed, 'all completed images are reused without starvation');
  } finally { scene.map.destroy(); }
});

test('audit: background preparation resolves styles per layer instead of per feature', async () => {
  const data = concat([bytesField(3, featureLayer('building', Array.from({ length: 150 }, () => taggedFeature(3, square(512, 512, 64)))))]);
  const scene = await cachedBuildings({ fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(asArrayBuffer(data)) }) });
  try {
    scene.layer.setPreload({ around: 1, zoom: [], maxTiles: 4, delay: 0 });
    await wait(35);
    const before = scene.observations.styleChecks;
    const prepared = scene.prismCalls.length;
    scene.runIdle();
    assert.equal(scene.prismCalls.length - prepared, 64);
    assert.equal(scene.observations.styleChecks - before, 1, 'one style check for 64 building features');
    scene.layer.setLayoutProperty('buildings', 'visibility', 'none');
    const hidden = scene.prismCalls.length;
    scene.runIdle();
    assert.equal(scene.prismCalls.length, hidden, 'the next slice observes the visibility change');
  } finally { scene.map.destroy(); }
});
