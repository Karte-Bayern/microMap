'use strict';

// MapLibre style-spec subset of microMap.vector: expressions, legacy
// filters, MapLibre zoom semantics, cached group paths, the layer API and
// MapLibre label rules. Runs against a recording Canvas with Path2D.
const test = require('node:test');
const assert = require('node:assert/strict');

class RecordingPath {
  constructor() { this.ops = []; }
  moveTo(x, y) { this.ops.push(['M', x, y]); }
  lineTo(x, y) { this.ops.push(['L', x, y]); }
  closePath() { this.ops.push(['Z']); }
  arc(x, y, r) { this.ops.push(['A', x, y, r]); }
}

class RecordingContext {
  constructor() {
    this.ops = [];
    this.stack = [];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.dash = [];
    this.filter = 'none';
  }
  state() { return { fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, globalAlpha: this.globalAlpha, dash: this.dash, filter: this.filter }; }
  save() { this.stack.push(this.state()); }
  restore() { Object.assign(this, this.stack.pop() || {}); }
  setTransform() {}
  clearRect() {}
  fillRect(...args) { this.ops.push({ op: 'fillRect', args, fillStyle: this.fillStyle, alpha: this.globalAlpha }); }
  beginPath() {}
  rect() {}
  clip() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  translate() {}
  rotate() {}
  scale() {}
  setLineDash(dash) { this.dash = dash.slice(); }
  drawImage(image, ...args) { this.ops.push({ op: 'drawImage', src: image.src, args, alpha: this.globalAlpha, filter: this.filter }); }
  fill(path) { this.ops.push({ op: 'fill', path, fillStyle: this.fillStyle, alpha: this.globalAlpha }); }
  stroke(path) { this.ops.push({ op: 'stroke', path, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, dash: this.dash, alpha: this.globalAlpha }); }
  measureText(text) {
    const size = +(/([\d.]+)px/.exec(this.font) || [0, 10])[1];
    return { width: String(text).length * size * 0.5, actualBoundingBoxAscent: size * 0.75, actualBoundingBoxDescent: size * 0.2 };
  }
  fillText(text, x, y) { this.ops.push({ op: 'text', text, x, y, font: this.font, fillStyle: this.fillStyle, textAlign: this.textAlign, textBaseline: this.textBaseline }); }
  strokeText() {}
  // Pixels read back are a Terrarium DEM rising 30 m per pixel eastwards.
  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const metres = 32768 + column * 30;
      const o = 4 * (row * width + column);
      data[o] = Math.floor(metres / 256);
      data[o + 1] = metres % 256;
      data[o + 3] = 255;
    }
    return { data, width, height };
  }
  createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; }
  putImageData(image) {
    let shaded = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) shaded++;
    this.ops.push({ op: 'putImageData', width: image.width, shaded });
  }
}

class FakeElement {
  static images = [];

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.clientWidth = 512;
    this.clientHeight = 512;
    if (this.tagName === 'CANVAS') this.context = new RecordingContext();
    if (this.tagName === 'IMG') {
      // Images "load" asynchronously unless their URL contains "fail".
      this.naturalWidth = 256;
      Object.defineProperty(this, 'src', {
        get: () => this._src,
        set: value => {
          this._src = value;
          FakeElement.images.push(value);
          if (FakeElement.hold) return;
          setTimeout(() => { if (/fail/.test(value)) { if (this.onerror) this.onerror(); } else if (this.onload) this.onload(); }, 1);
        }
      });
    }
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getContext(kind) { return kind === '2d' ? this.context : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio', 'Path2D']) saved[name] = global[name];
global.document = { querySelector() { return null; }, createElement: tagName => new FakeElement(tagName), addEventListener() {}, removeEventListener() {} };
global.getComputedStyle = () => ({ position: 'relative' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.devicePixelRatio = 1;
global.Path2D = RecordingPath;

const microMap = require('../lib/microMap.js');
const microMapVector = require('../lib/microMap.vector.js');

test.after(() => { for (const name in saved) global[name] = saved[name]; });

// ---- Minimal MVT encoder -------------------------------------------------
function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function varint(value) {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(value ? next + 128 : next); } while (value);
  return Uint8Array.from(bytes);
}
const zz = value => (value << 1) ^ (value >> 31);
const field = (number, wire, value) => concat([varint(number * 8 + wire), value]);
const bytesField = (number, value) => field(number, 2, concat([varint(value.length), value]));
const stringField = (number, value) => bytesField(number, Uint8Array.from(Buffer.from(value, 'utf8')));
const packedField = (number, values) => bytesField(number, concat(values.map(varint)));
const stringValue = value => stringField(1, value);
const numberValue = value => field(5, 0, varint(value));

// A line from point to point in tile units, as MVT commands.
function lineCommands(points) {
  const commands = [9, zz(points[0][0]), zz(points[0][1]), 2 + (points.length - 1) * 8];
  for (let i = 1; i < points.length; i++) commands.push(zz(points[i][0] - points[i - 1][0]), zz(points[i][1] - points[i - 1][1]));
  return commands;
}
function polygonCommands(x0, y0, x1, y1) {
  return [9, zz(x0), zz(y0), 26, zz(x1 - x0), 0, 0, zz(y1 - y0), zz(x0 - x1), 0, 15];
}

// features: [{ type, commands, props: { key: value } }]
function tile(layers) {
  return concat(Object.entries(layers).map(([name, features]) => {
    const keys = [];
    const values = [];
    const encoded = features.map(feature => {
      const tags = [];
      for (const [key, value] of Object.entries(feature.props || {})) {
        if (!keys.includes(key)) keys.push(key);
        let index = values.findIndex(existing => existing === value);
        if (index < 0) index = values.push(value) - 1;
        tags.push(keys.indexOf(key), index);
      }
      return concat([...(tags.length ? [packedField(2, tags)] : []), field(3, 0, varint(feature.type)), packedField(4, feature.commands)]);
    });
    return bytesField(3, concat([
      stringField(1, name),
      ...encoded.map(bytes => bytesField(2, bytes)),
      ...keys.map(key => stringField(3, key)),
      ...values.map(value => bytesField(4, typeof value === 'number' ? numberValue(value) : stringValue(value))),
      field(5, 0, varint(4096)),
      field(15, 0, varint(2))
    ]));
  }));
}

const wait = (milliseconds = 30) => new Promise(resolve => setTimeout(resolve, milliseconds));
const arrayBuffer = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

function setup(style, data, mapOptions = {}, vectorOptions = {}) {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1, zoomAnimation: false, ...mapOptions });
  const requested = [];
  const layer = microMapVector(map, {
    tiles: '/{z}/{x}/{y}.mvt', tileBuffer: 0, style,
    fetch: url => { requested.push(url); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(data)) }); },
    ...vectorOptions
  });
  const context = layer.getCanvas().getContext('2d');
  return { map, layer, context, requested, frame() { context.ops.length = 0; } };
}

const roads = tile({
  transportation: [
    { type: 2, commands: lineCommands([[0, 1024], [4096, 1024]]), props: { class: 'primary', name: 'Hauptstraße' } },
    { type: 2, commands: lineCommands([[0, 2048], [4096, 2048]]), props: { class: 'residential', name: 'Nebenweg' } },
    { type: 2, commands: lineCommands([[0, 3072], [4096, 3072]]), props: { class: 'residential' } }
  ],
  building: [{ type: 3, commands: polygonCommands(512, 512, 1024, 1024), props: { height: 12 } }]
});

test('standalone base style reports all supported layers without ignored properties', () => {
  // Authored here: this public repository must not read a private application's
  // style from a parent checkout. Exercise the style contract independently.
  const style = {
    version: 8,
    sources: { 'bayern-tiles': { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef2ee' } },
      { id: 'buildings', type: 'fill', source: 'bayern-tiles', 'source-layer': 'building', paint: { 'fill-color': '#cccccc', 'fill-opacity': 0.8 } },
      { id: 'roads', type: 'line', source: 'bayern-tiles', 'source-layer': 'transportation', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 3 } },
      { id: 'labels', type: 'symbol', source: 'bayern-tiles', 'source-layer': 'transportation', layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-size': 12 }, paint: { 'text-color': '#333333' } },
      { id: 'extrusions', type: 'fill-extrusion', source: 'bayern-tiles', 'source-layer': 'building', paint: { 'fill-extrusion-color': '#cccccc', 'fill-extrusion-height': ['get', 'height'] } }
    ]
  };
  const { map, layer } = setup(style, roads, { zoom: 8, tileSize: 512 }, { source: 'bayern-tiles', minZoom: 6, maxZoom: 14, strict: false });
  const report = layer.getStyleReport();
  assert.deepEqual(report.skippedLayers, [], JSON.stringify(report));
  assert.deepEqual(report.ignored, [], JSON.stringify(report));
  assert.equal(layer.getLayers().length, style.layers.length);
  layer.destroy();
  map.destroy();
});

test('evaluates zoom and data expressions per feature group with MapLibre zoom levels', async () => {
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': ['interpolate', ['linear'], ['zoom'], 0, '#000000', 4, '#ffffff'] } },
      {
        id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation',
        paint: {
          'line-color': ['match', ['get', 'class'], 'primary', '#ff0000', '#00ff00'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, ['case', ['==', ['get', 'class'], 'primary'], 2, 1], 4, ['*', 2, ['case', ['==', ['get', 'class'], 'primary'], 4, 2]]],
          'line-dasharray': ['literal', [2, 1]]
        }
      }
    ]
  };
  // With a 256px core camera, core zoom 3 is MapLibre zoom 2.
  const { map, layer, context, requested } = setup(style, roads, { zoom: 3 });
  await wait();
  assert.ok(requested.every(url => url.startsWith('/2/')), 'MapLibre styles pick floor(512px zoom) tiles: ' + requested.join(' '));
  const background = context.ops.find(op => op.op === 'fillRect');
  assert.equal(background.fillStyle, 'rgba(128,128,128,1)');
  const strokes = context.ops.filter(op => op.op === 'stroke');
  const primary = strokes.filter(op => op.strokeStyle === '#ff0000');
  const other = strokes.filter(op => op.strokeStyle === '#00ff00');
  assert.ok(primary.length && other.length);
  // Width at MapLibre zoom 2: primary (2 + 8) / 2, residential (1 + 4) / 2.
  // Paths are in tile units, so the recorded width is divided by the scale.
  const scale = 512 / 4096;
  assert.ok(Math.abs(primary[0].lineWidth * scale - 5) < 1e-9, String(primary[0].lineWidth * scale));
  assert.ok(Math.abs(other[0].lineWidth * scale - 2.5) < 1e-9, String(other[0].lineWidth * scale));
  assert.deepEqual(primary[0].dash.map(value => +(value * scale).toFixed(6)), [10, 5], 'dashes scale with the line width');
  // Two residential roads share a group: one merged path per tile.
  assert.equal(other.length, requested.length);
  layer.destroy();
  map.destroy();
});

test('reuses cached group paths across frames and rebuilds only changed layers', async () => {
  const style = [
    { id: 'roads', type: 'line', sourceLayer: 'transportation', paint: { color: '#123456', width: 2 } },
    { id: 'buildings', type: 'fill', sourceLayer: 'building', paint: { color: '#abcdef' } }
  ];
  const { map, layer, context, frame } = setup(style, roads, { zoom: 0 });
  await wait();
  const firstRoad = context.ops.find(op => op.op === 'stroke').path;
  const firstBuilding = context.ops.find(op => op.op === 'fill').path;
  assert.ok(firstRoad instanceof RecordingPath);
  frame();
  map.panBy([3, 2]);
  await wait();
  assert.equal(context.ops.find(op => op.op === 'stroke').path, firstRoad, 'a pan frame reuses the Path2D');
  frame();
  layer.setPaintProperty('roads', 'color', '#654321');
  await wait();
  const stroke = context.ops.find(op => op.op === 'stroke');
  assert.equal(stroke.strokeStyle, '#654321');
  assert.notEqual(stroke.path, firstRoad, 'a paint change rebuilds that layer');
  assert.equal(context.ops.find(op => op.op === 'fill').path, firstBuilding, 'other layers keep their paths');
  frame();
  layer.setLayoutProperty('buildings', 'visibility', 'none');
  await wait();
  assert.ok(!context.ops.some(op => op.op === 'fill'));
  frame();
  layer.setLayoutProperty('buildings', 'visibility', 'visible');
  await wait();
  assert.equal(context.ops.find(op => op.op === 'fill').path, firstBuilding, 'visibility keeps cached paths');
  frame();
  layer.setFilter('roads', ['==', 'class', 'primary']);
  await wait();
  const filtered = context.ops.find(op => op.op === 'stroke').path;
  assert.equal(filtered.ops.filter(op => op[0] === 'M').length, 1, 'setFilter rebuilds with the new filter');
  assert.deepEqual(layer.getFilter('roads'), ['==', 'class', 'primary']);
  assert.equal(layer.getPaintProperty('roads', 'color'), '#654321');
  assert.throws(() => layer.setPaintProperty('missing', 'color', '#fff'), /unknown style layer missing/);
  layer.destroy();
  map.destroy();
});

test('converts legacy filters including $type, in, !in, has and !has', async () => {
  const data = tile({
    mixed: [
      { type: 1, commands: [9, zz(100), zz(100)], props: { kind: 'a', name: 'P' } },
      { type: 2, commands: lineCommands([[0, 0], [4096, 0]]), props: { kind: 'b' } },
      { type: 3, commands: polygonCommands(0, 0, 100, 100), props: { kind: 'c', rank: 5 } }
    ]
  });
  const run = async filter => {
    const { map, layer, context } = setup([{ id: 'dots', type: 'circle', sourceLayer: 'mixed', filter, paint: { color: '#111', radius: 2 } },
      { id: 'lines', type: 'line', sourceLayer: 'mixed', filter, paint: { color: '#222' } },
      { id: 'areas', type: 'fill', sourceLayer: 'mixed', filter, paint: { color: '#333' } }], data, { zoom: 0 });
    await wait();
    const colors = new Set(context.ops.filter(op => op.op === 'fill' || op.op === 'stroke').map(op => op.fillStyle && op.op === 'fill' ? op.fillStyle : op.strokeStyle));
    layer.destroy();
    map.destroy();
    return colors;
  };
  assert.deepEqual([...await run(['==', '$type', 'Point'])], ['#111']);
  assert.deepEqual([...await run(['in', 'kind', 'b', 'c'])].sort(), ['#222', '#333']);
  assert.deepEqual([...await run(['!in', 'kind', 'b', 'c'])], ['#111']);
  assert.deepEqual([...await run(['has', 'rank'])], ['#333']);
  assert.deepEqual([...await run(['all', ['!has', 'name'], ['!=', '$type', 'Polygon']])], ['#222']);
  assert.deepEqual([...await run(['>=', ['get', 'rank'], 5])], ['#333']);
});

test('places symbols like MapLibre: top layer first, anchors, fonts and wrapping', async () => {
  const data = tile({
    place: [{ type: 1, commands: [9, zz(2048), zz(2048)], props: { name: 'Alpha', long: 'Ein sehr langer Ortsname hier' } }]
  });
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } },
    layers: [
      { id: 'lower', type: 'symbol', source: 'base', 'source-layer': 'place', layout: { 'text-field': 'lower {name}', 'text-size': 20, 'text-font': ['Noto Sans Regular'] } },
      { id: 'upper', type: 'symbol', source: 'base', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'], 'text-size': 20, 'text-anchor': 'top', 'text-font': ['Noto Sans Bold Italic', 'Open Sans Regular'], 'text-transform': 'uppercase' } },
      { id: 'wrapped', type: 'symbol', source: 'base', 'source-layer': 'place', layout: { 'text-field': ['get', 'long'], 'text-size': 10, 'text-max-width': 6, 'text-allow-overlap': true, 'text-ignore-placement': true } }
    ]
  };
  const { map, layer, context } = setup(style, data, { zoom: 1, tileSize: 512 });
  await wait();
  const texts = context.ops.filter(op => op.op === 'text');
  const labels = texts.map(op => op.text);
  assert.ok(labels.includes('ALPHA'), JSON.stringify(labels));
  assert.ok(!labels.includes('lower Alpha'), 'the upper layer wins the collision');
  const upper = texts.find(op => op.text === 'ALPHA');
  assert.equal(upper.font, 'italic 700 20px "Noto Sans", "Open Sans", sans-serif');
  assert.equal(upper.textBaseline, 'top', 'text-anchor top puts the text below its anchor');
  const wrapped = texts.filter(op => /langer|Ortsname|sehr|hier/.test(op.text));
  assert.ok(wrapped.length > 1, 'text-max-width wraps long point labels: ' + JSON.stringify(wrapped.map(op => op.text)));
  assert.deepEqual(layer.getStyleReport().skippedLayers, []);
  layer.destroy();
  map.destroy();
});

test('merges same-name line parts so a label fits along the joined street', async () => {
  // A 256px tile shows 4096 units: the 66px label needs about 1060 units,
  // so one 800-unit part is too short and the joined 1600 units fit.
  const data = tile({
    transportation: [
      { type: 2, commands: lineCommands([[1000, 2000], [1800, 2000]]), props: { name: 'Lindenallee' } },
      { type: 2, commands: lineCommands([[1800, 2000], [2600, 2000]]), props: { name: 'Lindenallee' } }
    ]
  });
  const labelsFor = async parts => {
    const style = [{ id: 'labels', type: 'symbol', sourceLayer: 'transportation', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'symbol-placement': 'line' } }];
    const source = parts === 2 ? data : tile({ transportation: [{ type: 2, commands: lineCommands([[1000, 2000], [1800, 2000]]), props: { name: 'Lindenallee' } }] });
    const { map, layer, context } = setup(style, source, { zoom: 2 });
    await wait();
    // Line labels are drawn glyph by glyph: count the spelled-out names.
    const count = context.ops.filter(op => op.op === 'text').map(op => op.text).join('').split('Lindenallee').length - 1;
    layer.destroy();
    map.destroy();
    return count;
  };
  assert.equal(await labelsFor(1), 0, 'a line shorter than its text gets no label');
  assert.ok(await labelsFor(2) > 0, 'joined parts are long enough');
});

test('fromStyle renders the vector source with its GeoJSON sources and reports the rest', async () => {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1, tileSize: 512 });
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sources: {
      base: { type: 'vector', tiles: ['/tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 },
      places: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      relief: { type: 'raster', tiles: ['/relief/{z}/{x}/{y}.png'] }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#f3f1ea' } },
      { id: 'hillshade', type: 'raster', source: 'relief' },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-blur': 2 } },
      { id: 'place-dots', type: 'circle', source: 'places' }
    ]
  }, { fetch: () => new Promise(() => {}), transformRequest: url => url.replace('/tiles/', '/proxy/') });
  const report = layer.getStyleReport();
  assert.equal(report.source, 'base');
  assert.deepEqual(report.skippedLayers, []);
  assert.ok(report.approximated.includes('roads line-blur'));
  assert.deepEqual(layer.getLayers().map(entry => entry.id), ['bg', 'hillshade', 'roads', 'place-dots']);
  assert.equal(layer.getSource('places').type, 'geojson');
  await assert.rejects(() => microMapVector.fromStyle(map, { layers: [] }), /needs a MapLibre style/);
  layer.destroy();
  map.destroy();
});

test('runtime MVT source keeps tile data, layer order, queries and reloads separate', async () => {
  const microMapCompose = require('../lib/microMap.compose.js');
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 0, tileSize: 512 });
  const point = name => tile({ Haltestelle: [{ type: 1, commands: [9, zz(2048), zz(2048)], props: { name } }] });
  const baseData = point('Base');
  const stopData = point('Transit');
  const retryData = point('Retry');
  const requested = [];
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/base/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'base-dots', type: 'circle', source: 'base', 'source-layer': 'Haltestelle', paint: { 'circle-color': '#ff0000', 'circle-radius': 8 } }]
  }, {
    tileBuffer: 0,
    fetch: url => {
      requested.push(url);
      const data = url.includes('/retry/') ? retryData : url.includes('/transit/') ? stopData : baseData;
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(data)) });
    }
  });
  const composed = microMapCompose(map, { vectors: [layer], geojson: true });
  const context = layer.getCanvas().getContext('2d');
  await wait(60);
  const baseRequests = requested.filter(url => url.includes('/base/')).length;
  composed.addSource('transit', { type: 'vector', tiles: ['/transit/{z}/{x}/{y}.pbf'], attribution: 'Transit data' });
  composed.addLayer({ id: 'transit-dots', type: 'circle', source: 'transit', 'source-layer': 'Haltestelle', paint: { 'circle-color': '#0000ff', 'circle-radius': 8 } });
  await wait(70);
  assert.equal(layer.getStyleReport().attributions.transit, 'Transit data');
  assert.equal(composed.areTilesLoaded(), true);
  context.ops.length = 0;
  layer.redraw();
  await wait(30);
  const fills = context.ops.filter(op => op.op === 'fill').map(op => op.fillStyle);
  assert.equal(fills.filter(color => color === '#ff0000').length, fills.filter(color => color === '#0000ff').length,
    'one source must not paint the other source\'s same-named MVT layer');
  assert.ok(fills.includes('#ff0000') && fills.includes('#0000ff'), fills.join(' '));
  const hits = composed.queryRenderedFeatures(map.project([0, 0]), { layers: ['base-dots', 'transit-dots'] });
  assert.deepEqual(hits.map(hit => hit.source).sort(), ['base', 'transit']);
  assert.deepEqual(hits.map(hit => hit.properties.name).sort(), ['Base', 'Transit']);
  composed.getSource('transit').setTiles(['/retry/{z}/{x}/{y}.pbf']);
  await wait(70);
  assert.equal(requested.filter(url => url.includes('/base/')).length, baseRequests, 'changing transit tiles reuses cached base data');
  assert.ok(requested.some(url => url.includes('/retry/')));
  assert.deepEqual(composed.queryRenderedFeatures(map.project([0, 0]), { layers: ['transit-dots'] }).map(hit => hit.properties.name), ['Retry']);
  assert.equal(composed.getStyle().sources.transit.tiles[0], '/retry/{z}/{x}/{y}.pbf');
  assert.throws(() => composed.removeSource('transit'), /remove layers before their source/);
  composed.removeLayer('transit-dots').removeSource('transit');
  await wait(30);
  assert.equal(composed.getSource('transit'), undefined);
  assert.equal(composed.queryRenderedFeatures(map.project([0, 0]), { layers: ['base-dots'] })[0].source, 'base');
  composed.remove();
});

test('runtime MVT TileJSON resolves relative tiles and rejects stale responses after removal', async () => {
  const microMapCompose = require('../lib/microMap.compose.js');
  const map = microMap(new FakeElement(), { tiles: false, center: [0, 0], zoom: 0, tileSize: 512 });
  const requested = [];
  let resolveStale;
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/base/{z}/{x}/{y}.pbf'] } },
    layers: []
  }, {
    tileBuffer: 0,
    fetch: url => {
      requested.push(url);
      if (url === 'https://tiles.example.test/transit.json') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        format: 'pbf', tiles: ['tiles/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 4, attribution: 'Provider'
      }) });
      if (url === 'https://tiles.example.test/stale.json') return new Promise(resolve => { resolveStale = resolve; });
      if (url === 'https://tiles.example.test/missing.json') return Promise.resolve({ ok: false, status: 404 });
      const data = tile({ Haltestelle: [{ type: 1, commands: [9, zz(2048), zz(2048)], props: { name: 'Stop' } }] });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(data)) });
    }
  });
  const composed = microMapCompose(map, { vectors: [layer] });
  const sourceEvents = [];
  composed.on('sourcedata', event => sourceEvents.push(event.type + ':' + event.source));
  composed.on('sourceerror', event => sourceEvents.push(event.type + ':' + event.source));
  layer.addSource('transit', { type: 'vector', url: 'https://tiles.example.test/transit.json' });
  layer.addLayer({ id: 'stops', type: 'circle', source: 'transit', 'source-layer': 'Haltestelle', paint: { 'circle-color': '#123456' } });
  await wait(70);
  assert.ok(requested.some(url => url.startsWith('https://tiles.example.test/tiles/0/')));
  assert.ok(sourceEvents.includes('sourcedata:transit'));
  assert.equal(layer.getStyleReport().attributions.transit, 'Provider');
  assert.equal(layer.queryRenderedFeatures(map.project([0, 0]), { layers: ['stops'] })[0].source, 'transit');
  layer.removeLayer('stops').removeSource('transit');
  layer.addSource('transit', { type: 'vector', url: 'https://tiles.example.test/stale.json' });
  assert.equal(typeof resolveStale, 'function');
  layer.removeSource('transit');
  layer.addSource('transit', { type: 'vector', tiles: ['/fresh/{z}/{x}/{y}.pbf'] });
  layer.addLayer({ id: 'stops', type: 'circle', source: 'transit', 'source-layer': 'Haltestelle' });
  resolveStale({ ok: true, json: () => Promise.resolve({ format: 'pbf', tiles: ['/obsolete/{z}/{x}/{y}.pbf'] }) });
  await wait(70);
  assert.ok(requested.some(url => url.startsWith('/fresh/')));
  assert.ok(!requested.some(url => url.startsWith('/obsolete/')));
  assert.deepEqual(layer.getSource('transit').serialize().tiles, ['/fresh/{z}/{x}/{y}.pbf']);
  layer.addSource('missing', { type: 'vector', url: 'https://tiles.example.test/missing.json' });
  await wait(10);
  assert.ok(sourceEvents.includes('sourceerror:missing'));
  layer.removeSource('missing');
  composed.destroy();
  layer.destroy();
  map.destroy();
});

test('runtime TileJSON retries transient failures but not invalid metadata', async () => {
  const map = microMap(new FakeElement(), { tiles: false, center: [0, 0], zoom: 0, tileSize: 512 });
  let attempts = 0;
  let invalidAttempts = 0;
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/base/{z}/{x}/{y}.pbf'] } },
    layers: []
  }, {
    tileBuffer: 0,
    retryDelay: 10,
    fetch: url => {
      if (url === '/transient.json') {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('temporary network failure'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ format: 'pbf', tiles: ['/stops/{z}/{x}/{y}.pbf'] }) });
      }
      if (url === '/invalid.json') {
        invalidAttempts++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ tiles: ['/raster/{z}/{x}/{y}.png'] }) });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) });
    }
  });
  const events = [];
  layer.on('sourceerror', event => events.push(event.source));
  layer.addSource('transit', { type: 'vector', url: '/transient.json' });
  layer.addLayer({ id: 'stops', type: 'circle', source: 'transit', 'source-layer': 'transportation' });
  await wait(70);
  assert.equal(attempts, 2);
  assert.ok(events.includes('transit'));
  assert.equal(layer.areTilesLoaded(), true);
  layer.addSource('invalid', { type: 'vector', url: '/invalid.json' });
  await wait(50);
  assert.equal(invalidAttempts, 1);
  assert.ok(events.includes('invalid'));
  layer.removeSource('invalid');
  layer.destroy();
  map.destroy();
});

test('reloading a runtime MVT source keeps an unrelated in-flight tile request', async () => {
  const map = microMap(new FakeElement(), { tiles: false, center: [0, 0], zoom: 0, tileSize: 512 });
  let resolveBase;
  let baseSignal;
  const requested = [];
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/base/{z}/{x}/{y}.pbf'] } },
    layers: []
  }, {
    tileBuffer: 0,
    fetch: (url, request) => {
      requested.push(url);
      if (url.startsWith('/base/')) {
        baseSignal = request && request.signal;
        return new Promise(resolve => { resolveBase = resolve; });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) });
    }
  });
  await wait(20);
  assert.equal(typeof resolveBase, 'function');
  layer.addSource('transit', { type: 'vector', tiles: ['/stops/{z}/{x}/{y}.pbf'] });
  await wait(30);
  layer.getSource('transit').setTiles(['/stops-retry/{z}/{x}/{y}.pbf']);
  await wait(30);
  assert.equal(requested.filter(url => url.startsWith('/base/')).length, 1);
  assert.equal(baseSignal && baseSignal.aborted, false);
  resolveBase({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) });
  await wait(40);
  assert.equal(layer.areTilesLoaded(), true);
  layer.destroy();
  map.destroy();
});

test('runtime MVT source only requests tiles while one of its layers is visible', async () => {
  const { map, layer, requested } = setup({
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/base/{z}/{x}/{y}.pbf'] } },
    layers: []
  }, roads, { zoom: 0, tileSize: 512 });
  layer.addSource('stops', { type: 'vector', tiles: ['/stops/{z}/{x}/{y}.pbf'] });
  layer.addLayer({ id: 'stop-dots', type: 'circle', source: 'stops', 'source-layer': 'transportation', layout: { visibility: 'none' } });
  await wait(40);
  assert.equal(requested.filter(url => url.startsWith('/stops/')).length, 0);
  assert.equal(layer.areTilesLoaded(), true);
  layer.setLayoutProperty('stop-dots', 'visibility', 'visible');
  await wait(40);
  assert.ok(requested.some(url => url.startsWith('/stops/')));
  assert.equal(layer.areTilesLoaded(), true);
  layer.destroy();
  map.destroy();
});

test('compiles the expression subset strictly', () => {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1 });
  const make = value => microMapVector(map, { tiles: '/{z}/{x}/{y}', fetch: () => new Promise(() => {}), style: [{ type: 'line', paint: { 'line-color': value } }] });
  for (const value of [
    ['let', 'c', ['get', 'class'], ['match', ['var', 'c'], 'a', '#fff', '#000']],
    ['step', ['zoom'], '#000', 5, '#fff'],
    ['to-color', ['coalesce', ['get', 'color'], '#000']],
    { stops: [[1, '#000'], [10, '#fff']] },
    ['concat', ['upcase', 'a'], ['to-string', ['+', 1, ['*', 2, 3]]]]
  ]) make(value).destroy();
  assert.throws(() => make(['get', ['concat', 'a', 'b']]), /get needs one literal property name/);
  assert.throws(() => make(['interpolate', ['linear'], ['zoom'], 5, 1, 2, 3]), /stops must be ascending/);
  assert.throws(() => make(['var', 'missing']), /unknown variable missing/);
  assert.throws(() => make({ color: '#fff' }), /object values need a literal expression/);
  map.destroy();
});

test('renders GeoJSON sources through the vector pipeline, interleaved and shared', async () => {
  const data = tile({ transportation: [{ type: 2, commands: lineCommands([[0, 2048], [4096, 2048]]), props: { class: 'primary', name: 'Tile Road' } }] });
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] }, stops: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#111111', 'line-width': 3 } },
      { id: 'stop-dots', type: 'circle', source: 'stops', paint: { 'circle-color': ['get', 'color'], 'circle-radius': 6 } },
      { id: 'labels', type: 'symbol', source: 'base', 'source-layer': 'transportation', layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line', 'text-size': 12 } }
    ]
  };
  const { map, layer, context, frame } = setup(style, data, { zoom: 1, tileSize: 512 });
  await wait();
  frame();
  layer.getSource('stops').setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'a', properties: { color: '#ff0000', name: 'Stop A' }, geometry: { type: 'Point', coordinates: [0.5, 0.5] } },
      { type: 'Feature', id: 'b', properties: { color: '#0000ff' }, geometry: { type: 'Point', coordinates: [-60, 20] } }
    ]
  });
  await wait();
  const drawn = context.ops.filter(op => op.op === 'fill' || op.op === 'stroke').map(op => op.op === 'fill' ? op.fillStyle : op.strokeStyle);
  const firstRoad = drawn.indexOf('#111111');
  assert.ok(firstRoad >= 0 && drawn.indexOf('#ff0000') > firstRoad, 'GeoJSON circles draw after the road layer below them: ' + drawn.join(' '));
  assert.ok(drawn.includes('#0000ff'), 'data-driven GeoJSON styling');
  const point = map.project([0.5, 0.5]);
  const hits = layer.queryRenderedFeatures(point, { layers: ['stop-dots'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a');
  assert.equal(hits[0].source, 'stops');
  assert.equal(hits[0].sourceLayer, undefined);
  assert.equal(hits[0].properties.name, 'Stop A');
  assert.deepEqual(hits[0].geometry.coordinates.map(value => +value.toFixed(6)), [0.5, 0.5]);

  // A MapLibre-style layer can be added between existing layers.
  frame();
  layer.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-100, 10], [100, 10]] } } });
  layer.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': '#00aa00', 'line-width': 5 } }, 'stop-dots');
  await wait();
  const order = context.ops.filter(op => op.op === 'stroke' || op.op === 'fill').map(op => op.op === 'fill' ? op.fillStyle : op.strokeStyle);
  assert.ok(order.indexOf('#00aa00') > order.indexOf('#111111') && order.indexOf('#00aa00') < order.indexOf('#ff0000'), order.join(' '));
  assert.throws(() => layer.removeSource('route'), /remove layers before their source/);
  layer.moveLayer('route-line');
  assert.deepEqual(layer.getLayers().map(entry => entry.id), ['roads', 'stop-dots', 'labels', 'route-line']);
  layer.removeLayer('route-line').removeSource('route');
  assert.equal(layer.getSource('route'), undefined);
  assert.throws(() => layer.addLayer({ id: 'x', type: 'line', source: 'missing' }), /unknown source missing/);
  assert.throws(() => layer.addSource('stops', { type: 'geojson', data: null }), /source already exists/);
  layer.destroy();
  map.destroy();
});

test('treats a 404 vector tile as empty, so GeoJSON still draws there', async () => {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1, tileSize: 512 });
  const layer = await microMapVector.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] }, pins: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } } } },
    layers: [{ id: 'pins', type: 'circle', source: 'pins', paint: { 'circle-color': '#abcdef' } }]
  }, { fetch: () => Promise.resolve({ ok: false, status: 404 }) });
  const context = layer.getCanvas().getContext('2d');
  await wait();
  assert.ok(context.ops.some(op => op.op === 'fill' && op.fillStyle === '#abcdef'));
  layer.destroy();
  map.destroy();
});

test('compose.fromStyle gives one MapLibre-shaped facade over the style', async () => {
  const microMapCompose = require('../lib/microMap.compose.js');
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 1, tileSize: 512, zoomAnimation: false });
  const composed = await microMapCompose.fromStyle(map, {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } },
    layers: [{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#111111' } }]
  }, { camera: true, vectorOptions: { fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) }) } });
  const events = [];
  composed.on('style.load', event => events.push(event.type));
  composed.on('styledata', event => events.push(event.type));
  assert.equal(composed.isStyleLoaded(), true);
  assert.equal(composed.getStyle().layers[0].id, 'roads');
  const snapshot = composed.getStyle();
  snapshot.sources.base.tiles[0] = '/changed';
  assert.equal(composed.getStyle().sources.base.tiles[0], '/{z}/{x}/{y}.mvt');
  assert.equal(composed.getSource('base').type, 'vector');
  composed.setPaintProperty('roads', 'line-color', '#222222');
  assert.equal(composed.getPaintProperty('roads', 'line-color'), '#222222');
  assert.equal(composed.getStyle().layers[0].paint['line-color'], '#222222');
  assert.equal(composed.getLayer('roads').type, 'line');
  composed.addSource('pins', { type: 'geojson', data: { type: 'Feature', properties: { name: 'Pin' }, geometry: { type: 'Point', coordinates: [1, 1] } } });
  composed.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: { 'circle-color': '#ff00ff', 'circle-radius': 8 } });
  assert.equal(composed.getSource('pins').type, 'geojson');
  await wait();
  assert.ok(events.includes('style.load'));
  assert.ok(events.includes('styledata'));
  assert.equal(composed.loaded(), true);
  assert.equal(composed.areTilesLoaded(), true);
  const [hit] = composed.queryRenderedFeatures(map.project([1, 1]), { layers: ['pins'] });
  assert.equal(hit.properties.name, 'Pin');
  composed.getSource('base').setTiles(['/retry/{z}/{x}/{y}.mvt']);
  assert.deepEqual(composed.getSource('base').serialize().tiles, ['/retry/{z}/{x}/{y}.mvt']);
  assert.deepEqual(composed.getStyle().sources.base.tiles, ['/retry/{z}/{x}/{y}.mvt']);
  composed.setFilter('roads', ['==', 'class', 'primary']);
  assert.deepEqual(composed.getFilter('roads'), ['==', 'class', 'primary']);
  assert.equal(composed.getLayer('missing'), undefined);
  composed.remove();
});

test('draws raster sources at their style position with parent fallback and bounds', async () => {
  FakeElement.images = [];
  const style = {
    version: 8,
    sources: {
      base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] },
      satellite: { type: 'raster', tiles: ['/sat/{z}/{x}/{y}.webp'], tileSize: 256, maxzoom: 3, bounds: [0, 0, 180, 85] }
    },
    layers: [
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'building', paint: { 'fill-color': '#aa0000' } },
      { id: 'sat', type: 'raster', source: 'satellite', paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 1], 'raster-saturation': -0.5 } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#00aa00' } }
    ]
  };
  const { map, layer, context, frame } = setup(style, roads, { zoom: 1, tileSize: 512 });
  await wait(60);
  const order = context.ops.map(op => op.op === 'fill' ? op.fillStyle : op.op === 'stroke' ? op.strokeStyle : op.op === 'drawImage' ? 'image' : null).filter(Boolean);
  assert.ok(order.indexOf('#aa0000') < order.indexOf('image') && order.indexOf('image') < order.lastIndexOf('#00aa00'), order.join(' '));
  const images = context.ops.filter(op => op.op === 'drawImage');
  // A 512px world at MapLibre zoom 1 is 1024px: 256px raster tiles at z2,
  // and only the north-east quarter lies inside the source bounds.
  assert.ok(images.length > 0 && images.every(op => /\/sat\/2\/[23]\/[01]\.webp$/.test(op.src)), images.map(op => op.src).join(' '));
  assert.ok(Math.abs(images[0].alpha - 0.625) < 1e-9, 'raster-opacity is a zoom expression');
  assert.equal(images[0].filter, 'saturate(0.5)');
  frame();
  FakeElement.hold = true;
  map.setZoom(2);
  await wait(30);
  FakeElement.hold = false;
  const fallback = context.ops.filter(op => op.op === 'drawImage');
  assert.ok(fallback.length && fallback.every(op => op.args.length === 8 && /\/sat\/2\//.test(op.src)), 'pending z3 tiles show their loaded z2 parent quadrant');
  assert.equal(layer.getStyleReport().skippedLayers.length, 0);
  layer.destroy();
  map.destroy();
});

test('a failed raster tile shows its nearest parent with data, loaded on demand', async () => {
  FakeElement.images = [];
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] }, sat: { type: 'raster', tiles: ['/sat/{z}/{x}/{y}.webp'], tileSize: 256, maxzoom: 4 } },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }]
  };
  // Like a source without data at z2 (404s beyond its coverage).
  const transformRequest = url => url.replace(/\/sat\/2\/(\d+)\/(\d+)\.webp$/, '/sat/2/$1/$2-fail.webp');
  const { map, layer, context } = setup(style, roads, { zoom: 1, tileSize: 512 }, { transformRequest });
  for (let i = 0; i < 50 && !layer.areTilesLoaded(); i++) await wait(10);
  assert.ok(FakeElement.images.some(url => /^\/sat\/2\/.*-fail/.test(url)));
  assert.ok(FakeElement.images.some(url => /^\/sat\/1\//.test(url)), 'parents are requested: ' + FakeElement.images.join(' '));
  assert.ok(!FakeElement.images.some(url => /^\/sat\/0\//.test(url)), 'no further than the first parent with data');
  context.ops.length = 0;
  map.setBearing(1);
  await wait(30);
  const draws = context.ops.filter(op => op.op === 'drawImage');
  assert.ok(draws.length && draws.every(op => /\/sat\/1\//.test(op.src) && op.args.length === 8), draws.map(op => op.src).join(' '));
  assert.ok(layer.areTilesLoaded());
  layer.destroy();
  map.destroy();
});

test('adds and removes a WMS raster source through compose in style order', async () => {
  const microMapCompose = require('../lib/microMap.compose.js');
  FakeElement.images = [];
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } },
    layers: [
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'building', paint: { 'fill-color': '#aa0000' } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#00aa00' } }
    ]
  };
  const { map, layer, context, frame } = setup(style, roads, { zoom: 1, tileSize: 512 });
  const composed = microMapCompose(map, { vectors: [layer], geojson: true });
  const template = '/wms?BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
  composed.addSource('contours', { type: 'raster', tiles: [template], tileSize: 256, attribution: 'Contours' });
  assert.equal(composed.getSource('contours').type, 'raster');
  assert.equal(composed.getStyle().sources.contours.tiles[0], template);
  composed.getSource('contours').tiles[0] = '/changed';
  assert.equal(composed.getSource('contours').tiles[0], template, 'source metadata is a snapshot');
  composed.addLayer({ id: 'contours-layer', type: 'raster', source: 'contours', paint: { 'raster-opacity': 0.5 } }, 'roads');
  await wait(60);
  const order = context.ops.map(op => op.op === 'fill' ? op.fillStyle : op.op === 'stroke' ? op.strokeStyle : op.op === 'drawImage' ? 'image' : null).filter(Boolean);
  assert.ok(order.indexOf('#aa0000') < order.indexOf('image') && order.indexOf('image') < order.lastIndexOf('#00aa00'), order.join(' '));
  assert.ok(FakeElement.images.some(url => /^\/wms\?BBOX=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+&WIDTH=256/.test(url)));
  assert.equal(composed.getAttributions().includes('Contours'), true);
  const beforeRetry = FakeElement.images.length;
  composed.getSource('contours').setTiles([template + '&retry=1']);
  await wait(60);
  assert.ok(FakeElement.images.slice(beforeRetry).some(url => url.endsWith('&retry=1')), 'setTiles reloads cached imagery');
  assert.deepEqual(composed.getSource('contours').serialize().tiles, [template + '&retry=1']);
  assert.deepEqual(composed.getStyle().sources.contours.tiles, [template + '&retry=1']);
  assert.throws(() => composed.removeSource('contours'), /remove layers before their source/);
  assert.throws(() => composed.addLayer({ id: 'wrong', type: 'line', source: 'contours' }), /matching raster source/);
  composed.removeLayer('contours-layer').removeSource('contours');
  frame();
  layer.redraw();
  await wait();
  assert.equal(composed.getSource('contours'), undefined);
  assert.equal(composed.getStyle().sources.contours, undefined);
  assert.equal(composed.getAttributions().includes('Contours'), false);
  assert.ok(!context.ops.some(op => op.op === 'drawImage'), 'removed raster tiles do not draw');
  assert.throws(() => composed.addSource('bad', { type: 'raster', tiles: ['/no-template'] }), /XYZ or WMS tile template/);
  composed.remove();
});

test('MapLibre expressions beyond the basics: colours, arrays, text and math', () => {
  const vector = require('../lib/microMap.vector.js');
  const evaluate = (expression, properties = {}, zoom = 10) => vector.evaluateExpression(expression, { properties, zoom });
  assert.equal(evaluate(['rgb', 255, 128, 0]), 'rgba(255,128,0,1)');
  assert.equal(evaluate(['rgba', 0, 0, 0, 0.5]), 'rgba(0,0,0,0.5)');
  assert.deepEqual(evaluate(['to-rgba', '#ff0000']), [255, 0, 0, 1]);
  assert.equal(evaluate(['at', 1, ['literal', ['a', 'b', 'c']]]), 'b');
  assert.equal(evaluate(['index-of', 'b', ['literal', ['a', 'b']]]), 1);
  assert.equal(evaluate(['slice', ['get', 'name'], 0, 3], { name: 'Munich' }), 'Mun');
  assert.equal(evaluate(['format', ['get', 'name'], { 'font-scale': 0.8 }, ' ', {}, ['get', 'ref'], {}], { name: 'A9', ref: 'E45' }), 'A9 E45');
  assert.equal(evaluate(['typeof', ['get', 'n']], { n: 3 }), 'number');
  assert.equal(evaluate(['get', 'b', ['literal', { b: 2 }]]), 2);
  assert.ok(Math.abs(evaluate(['sin', ['/', ['pi'], 2]]) - 1) < 1e-12);
  assert.equal(evaluate(['number-format', 1234.5, { locale: 'en-US', 'max-fraction-digits': 0 }]), '1,235');
  assert.equal(evaluate(['interpolate-hcl', ['linear'], ['zoom'], 0, 0, 20, 10]), 5);
});

test('legacy zoom functions with tokens switch text at their stops', () => {
  const vector = require('../lib/microMap.vector.js');
  const field = { stops: [[2, '{ABBREV}'], [4, '{NAME}']] };
  const properties = { ABBREV: 'Ger.', NAME: 'Germany' };
  const at = zoom => vector.evaluateExpression(field, { property: 'text-field', properties, zoom });
  assert.equal(at(3.9), 'Ger.', 'string outputs step instead of interpolating');
  assert.equal(at(4), 'Germany');
  assert.equal(vector.evaluateExpression('{NAME} ({ABBREV})', { property: 'text-field', properties }), 'Germany (Ger.)');
  assert.equal(vector.evaluateExpression({ stops: [[0, 2], [10, 12]] }, { property: 'line-width', zoom: 5 }), 7, 'numbers still interpolate');
});

test('hillshade lights slopes facing the illumination and leaves flat ground clear', () => {
  const vector = require('../lib/microMap.vector.js');
  const size = 16;
  const terrarium = [256, 1, 1 / 256, 32768];
  // Elevation rising to the east (a west-facing slope) or to the west.
  function dem(rise) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const metres = 32768 + rise(x, y);
      const o = 4 * (y * size + x);
      data[o] = Math.floor(metres / 256);
      data[o + 1] = Math.floor(metres) % 256;
      data[o + 2] = Math.round((metres % 1) * 256);
      data[o + 3] = 255;
    }
    return data;
  }
  // Light from the west.
  const settings = { direction: 270, exaggeration: 0.5, shadow: [0, 0, 0, 1], highlight: [255, 255, 255, 1], accent: [0, 0, 0, 1] };
  const shade = rise => vector.shadeDEM(dem(rise), size, 12, 1400, terrarium, settings);
  const brightness = data => data[4 * (8 * size + 8)] * data[4 * (8 * size + 8) + 3] / 255;
  const westFacing = shade(x => x * 40);
  const eastFacing = shade(x => -x * 40);
  assert.ok(brightness(westFacing) > brightness(eastFacing) + 20, 'light from the west: ' + brightness(westFacing) + ' vs ' + brightness(eastFacing));
  assert.ok(westFacing[4 * (8 * size + 8) + 3] > 0, 'slopes are shaded');
  const flat = shade(() => 500);
  assert.equal(flat[4 * (8 * size + 8) + 3], 0, 'flat ground stays transparent');
});

test('hillshade layers shade raster-dem tiles in style order, flat and tilted', async () => {
  FakeElement.images = [];
  const style = {
    version: 8,
    sources: {
      base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] },
      dem: { type: 'raster-dem', tiles: ['/dem/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 4 }
    },
    layers: [
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'building', paint: { 'fill-color': '#aa0000' } },
      { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.6 } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#00aa00' } }
    ]
  };
  const { map, layer, context } = setup(style, roads, { zoom: 1, tileSize: 512 });
  await wait(80);
  assert.deepEqual(layer.getStyleReport().skippedLayers, []);
  assert.ok(FakeElement.images.some(url => /^\/dem\/2\//.test(url)), 'DEM tiles at the 256px level: ' + FakeElement.images.join(' '));
  const order = context.ops.map(op => op.op === 'fill' ? op.fillStyle : op.op === 'stroke' ? op.strokeStyle : op.op === 'drawImage' ? (op.src ? 'image' : 'shade') : null).filter(Boolean);
  assert.ok(order.includes('shade'), 'shaded canvases are drawn: ' + order.join(' '));
  assert.ok(order.indexOf('#aa0000') < order.indexOf('shade') && order.indexOf('shade') < order.lastIndexOf('#00aa00'), order.join(' '));
  assert.ok(!order.includes('image'), 'the raw elevation image itself is never drawn');
  // Tilted: cells paint the same shading into their own canvases.
  map.setPitch(50);
  // Shading has a per-frame time budget: give the cells a few dozen frames.
  for (let i = 0; i < 200 && !layer.areTilesLoaded(); i++) await wait(20);
  const stats = layer.getRenderStats();
  assert.equal(stats.mode, 'tilted');
  assert.ok(stats.cells > 0 && stats.painted === stats.cells && stats.incomplete === 0, JSON.stringify(stats));
  assert.ok(layer.areTilesLoaded());
  layer.destroy();
  map.destroy();
});

test('color-relief colours elevation by its stops, as MapLibre samples them', () => {
  const vector = require('../lib/microMap.vector.js');
  const terrarium = [256, 1, 1 / 256, 32768];
  const dem = (...metres) => {
    const data = new Uint8ClampedArray(metres.length * 4);
    metres.forEach((value, i) => {
      const encoded = 32768 + value;
      data.set([Math.floor(encoded / 256), Math.floor(encoded) % 256, Math.round((encoded % 1) * 256), 255], 4 * i);
    });
    return data;
  };
  const pixel = (data, i) => Array.from(data.slice(4 * i, 4 * i + 4));
  const relief = (color, ...metres) => vector.reliefDEM(dem(...metres), terrarium, { type: 'color-relief', paint: { 'color-relief-color': color } });
  const ramp = ['interpolate', ['linear'], ['elevation'], 0, '#000000', 1000, '#ff0000', 2000, 'rgba(0, 0, 255, 0)'];
  const out = relief(ramp, -500, 0, 500, 1000, 1500, 3000);
  assert.deepEqual(pixel(out, 0), [0, 0, 0, 255], 'held below the first stop');
  assert.deepEqual(pixel(out, 2), [128, 0, 0, 255], 'linear between stops');
  assert.deepEqual(pixel(out, 3), [255, 0, 0, 255]);
  // Premultiplied blending: fading out keeps the colour, not a grey.
  assert.deepEqual(pixel(out, 4), [255, 0, 0, 128]);
  assert.equal(pixel(out, 5)[3], 0, 'held (transparent) above the last stop');
  // Exponential curves are sampled at their stops and blended linearly.
  const exponential = relief(['interpolate', ['exponential', 2], ['elevation'], 0, '#000000', 1000, '#ffffff'], 500);
  assert.deepEqual(pixel(exponential, 0), [128, 128, 128, 255]);
  const step = relief(['step', ['elevation'], '#0000ff', 0, '#00ff00', 1000, '#ffffff'], -1, 0, 999, 1000);
  assert.deepEqual([0, 1, 2, 3].map(i => pixel(step, i)), [[0, 0, 255, 255], [0, 255, 0, 255], [0, 255, 0, 255], [255, 255, 255, 255]]);
  assert.deepEqual(pixel(relief('#336699', 10), 0), [51, 102, 153, 255], 'a constant colour');
  assert.equal(pixel(vector.reliefDEM(dem(10), terrarium, { type: 'color-relief' }), 0)[3], 0, 'no colour draws nothing');
});

test('color-relief layers colour raster-dem tiles in style order', async () => {
  FakeElement.images = [];
  const style = {
    version: 8,
    sources: {
      base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] },
      dem: { type: 'raster-dem', tiles: ['/dem/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 4 }
    },
    layers: [
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'building', paint: { 'fill-color': '#aa0000' } },
      { id: 'relief', type: 'color-relief', source: 'dem', paint: { 'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, 'green', 3000, 'white'], 'color-relief-opacity': 0.7 } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#00aa00' } }
    ]
  };
  const { map, layer, context } = setup(style, roads, { zoom: 1, tileSize: 512 });
  await wait(80);
  assert.deepEqual(layer.getStyleReport().skippedLayers, []);
  const draws = context.ops.filter(op => op.op === 'drawImage');
  assert.ok(draws.length && draws.every(op => !op.src), 'coloured canvases, never the raw elevation image');
  const order = context.ops.map(op => op.op === 'fill' ? op.fillStyle : op.op === 'stroke' ? op.strokeStyle : op.op === 'drawImage' ? 'relief' : null).filter(Boolean);
  assert.ok(order.indexOf('#aa0000') < order.indexOf('relief') && order.indexOf('relief') < order.lastIndexOf('#00aa00'), order.join(' '));
  assert.ok(draws.every(op => Math.abs(op.alpha - 0.7) < 1e-9), 'color-relief-opacity applies');
  assert.throws(() => layer.addLayer({ id: 'wrong', type: 'color-relief', source: 'base', 'source-layer': 'water' }), /matching raster source/);
  layer.destroy();
  map.destroy();
});

test('raster-dem sources by TileJSON and in addLayer', async () => {
  const style = { version: 8, sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] } }, layers: [] };
  const fetches = [];
  const { map, layer } = setup(style, roads, { zoom: 1, tileSize: 512 }, {
    fetch: url => {
      fetches.push(url);
      if (url === '/terrain.json') return Promise.resolve({ ok: true, json: () => Promise.resolve({ tiles: ['/terrain/{z}/{x}/{y}.webp'], maxzoom: 3, encoding: 'terrarium' }) });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) });
    }
  });
  FakeElement.images = [];
  layer.addSource('terrain', { type: 'raster-dem', url: '/terrain.json' });
  assert.throws(() => layer.addLayer({ id: 'wrong', type: 'raster', source: 'terrain' }), /matching raster source and layer type/);
  layer.addLayer({ id: 'relief', type: 'hillshade', source: 'terrain' });
  await wait(80);
  assert.ok(fetches.includes('/terrain.json'));
  // Without a tileSize, raster-dem tiles are 512px (MapLibre's default).
  assert.ok(FakeElement.images.some(url => /^\/terrain\/1\/\d\/\d\.webp$/.test(url)), FakeElement.images.join(' '));
  layer.destroy();
  map.destroy();
});

test('heatmap layers colour kernel density from GeoJSON loaded by URL', async () => {
  const points = { type: 'FeatureCollection', features: [0, 1, 2, 3, 4].map(i => ({ type: 'Feature', properties: { mag: i + 2 }, geometry: { type: 'Point', coordinates: [10 + i * 0.5, 48] } })) };
  const style = {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}.mvt'] }, quakes: { type: 'geojson', data: '/quakes.geojson' } },
    layers: [
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#00aa00' } },
      { id: 'heat', type: 'heatmap', source: 'quakes', paint: { 'heatmap-weight': ['interpolate', ['linear'], ['get', 'mag'], 0, 0, 6, 1], 'heatmap-radius': 20 } }
    ]
  };
  const fetched = [];
  const { map, layer, context } = setup(style, roads, { zoom: 5, center: [11, 48], tileSize: 512 }, {
    fetch: url => {
      fetched.push(url);
      if (url === '/quakes.geojson') return Promise.resolve({ ok: true, json: () => Promise.resolve(points) });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer(roads)) });
    }
  });
  const events = [];
  layer.on('sourcedata', event => events.push(event.source));
  await wait(80);
  assert.ok(fetched.includes('/quakes.geojson'));
  assert.ok(events.includes('quakes'), 'sourcedata after the document arrives');
  assert.equal(layer.getStyle().sources.quakes.data, '/quakes.geojson', 'getStyle keeps the URL');
  assert.deepEqual(layer.getStyleReport().skippedLayers, []);
  const order = context.ops.map(op => op.op === 'stroke' ? op.strokeStyle : op.op === 'drawImage' && !op.src ? 'heat' : null).filter(Boolean);
  assert.ok(order.includes('heat') && order.indexOf('#00aa00') < order.lastIndexOf('heat'), 'the heatmap is drawn above the roads: ' + order.join(' '));
  const vector = require('../lib/microMap.vector.js');
  assert.deepEqual(vector.evaluateExpression(['to-rgba', 'lime']), [0, 255, 0, 1], 'CSS colour names, as in the default heatmap ramp');
  assert.equal(layer.queryRenderedFeatures({ layers: ['heat'] }).length, 0, 'heatmaps are not hit-tested');
  layer.destroy();
  map.destroy();
});
