'use strict';

// CPU benchmark for the Canvas vector renderer with real MBTiles data.
//
//   node bench/render-bench.cjs path/to/tiles.mbtiles [lon lat] [--frames=N]
//
// It needs Node >= 22.5 (node:sqlite) and never touches the network. The
// Canvas context only counts calls, so the numbers are the JavaScript side of
// a frame (style evaluation, simplification, path building, label layout);
// real rasterisation must be measured in a browser (bench/browser.html).

const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.slice(2).split('=');
  return [key, value == null ? true : value];
}));
const positional = args.filter(arg => !arg.startsWith('--'));
if (!positional[0]) {
  console.error('usage: node bench/render-bench.cjs tiles.mbtiles [lon lat] [--frames=N] [--path2d=0]');
  process.exit(2);
}
const mbtiles = path.resolve(positional[0]);
const lon = positional[1] == null ? 11.575 : +positional[1];
const lat = positional[2] == null ? 48.137 : +positional[2];
const frames = Math.max(1, +(flags.frames || 30));

class CountingContext {
  constructor() { this.calls = 0; this.segments = 0; this.fills = 0; this.strokes = 0; this.texts = 0; }
  setTransform() { this.calls++; }
  clearRect() { this.calls++; }
  fillRect() { this.fills++; }
  setLineDash() { this.calls++; }
  save() { this.calls++; }
  restore() { this.calls++; }
  beginPath() { this.calls++; }
  rect() { this.calls++; }
  clip() { this.calls++; }
  moveTo() { this.segments++; }
  lineTo() { this.segments++; }
  closePath() { this.calls++; }
  arc() { this.segments++; }
  fill() { this.fills++; }
  stroke() { this.strokes++; }
  translate() { this.calls++; }
  rotate() { this.calls++; }
  scale() { this.calls++; }
  drawImage() { this.calls++; }
  // Approximates a real font: width and height scale with the px size.
  measureText(text) {
    const size = +(/([\d.]+)px/.exec(this.font || '') || [0, 10])[1];
    return { width: String(text).length * size * 0.55, actualBoundingBoxAscent: size * 0.75, actualBoundingBoxDescent: size * 0.2 };
  }
  fillText() { this.texts++; }
  strokeText() { this.texts++; }
}

class CountingPath2D {
  constructor() { this.segments = 0; }
  moveTo() { this.segments++; }
  lineTo() { this.segments++; }
  closePath() {}
  arc() { this.segments++; }
  rect() { this.segments++; }
}

class FakeElement {
  constructor(tagName = 'div', size = [1024, 768]) {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.clientWidth = size[0];
    this.clientHeight = size[1];
    if (this.tagName === 'CANVAS') this.context = new CountingContext();
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

let frameQueue = [];
global.document = {
  querySelector() { return null; },
  createElement(tagName) { return new FakeElement(tagName); },
  addEventListener() {},
  removeEventListener() {}
};
global.getComputedStyle = () => ({ position: 'relative' });
global.requestAnimationFrame = callback => { frameQueue.push(callback); return frameQueue.length; };
global.cancelAnimationFrame = () => {};
global.devicePixelRatio = 1;
if (flags.path2d !== '0') global.Path2D = CountingPath2D;

const microMap = require('../lib/microMap.js');
const microMapVector = require('../lib/microMap.vector.js');
const karteBayernBlueStyle = require('../styles/karte-bayern-blue.js');

const db = new DatabaseSync(mbtiles, { readOnly: true });
const tileQuery = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
const maxZoomRow = db.prepare("SELECT value FROM metadata WHERE name = 'maxzoom'").get();
const minZoomRow = db.prepare("SELECT value FROM metadata WHERE name = 'minzoom'").get();
const sourceMaxZoom = maxZoomRow ? +maxZoomRow.value : 14;
const sourceMinZoom = minZoomRow ? +minZoomRow.value : 0;

function tileBytes(z, x, y) {
  const row = tileQuery.get(z, x, (1 << z) - 1 - y);
  if (!row) return null;
  const data = Buffer.from(row.tile_data);
  return data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data) : data;
}

async function flush() {
  // Resolve the fetch promise chains before the next animation frame.
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

async function runFrame() {
  const queued = frameQueue;
  frameQueue = [];
  const start = performance.now();
  for (const callback of queued) callback(start);
  return performance.now() - start;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function scenario(name, zoom, style) {
  const container = new FakeElement('div');
  const map = microMap(container, { tiles: false, center: [lon, lat], zoom, zoomAnimation: false, maxZoom: 20 });
  let decodeMs = 0;
  let tiles = 0;
  const layer = microMapVector(map, {
    tiles: '{z}/{x}/{y}',
    minZoom: sourceMinZoom,
    maxZoom: sourceMaxZoom,
    maxFeatures: 100000,
    maxConcurrent: 64,
    style,
    fetch(url) {
      const [z, x, y] = url.split('/').map(Number);
      const data = tileBytes(z, x, y);
      if (!data) return Promise.resolve({ ok: false, status: 404 });
      tiles++;
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
    }
  });
  layer.on('tileload', () => {});
  // First frame requests the visible tiles; resolve them all before timing.
  await runFrame();
  await flush();
  const t0 = performance.now();
  await flush();
  decodeMs = performance.now() - t0;
  const first = await runFrame();
  const context = layer.getCanvas().getContext('2d');
  const panTimes = [];
  for (let i = 0; i < frames; i++) {
    map.panBy([i % 2 ? -3 : 3, 2]);
    await flush();
    panTimes.push(await runFrame());
  }
  const counts = { segments: context.segments, fills: context.fills, strokes: context.strokes, texts: context.texts };
  const zoomTimes = [];
  for (let i = 0; i < frames; i++) {
    map.setZoom(zoom + (i % 2 ? -0.02 : 0.02));
    await flush();
    zoomTimes.push(await runFrame());
  }
  layer.destroy();
  map.destroy();
  return { name, zoom, tiles, first, pan: median(panTimes), zoomFrame: median(zoomTimes), counts, decodeMs };
}

function decodeBench(z) {
  const n = 1 << z;
  const x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  const data = tileBytes(z, x, y);
  if (!data) return null;
  const runs = [];
  let features = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const decoded = microMapVector.decodeMVT(data, { maxFeatures: 100000 });
    runs.push(performance.now() - start);
    features = decoded.layers.reduce((sum, layerValue) => sum + layerValue.features.length, 0);
  }
  return { z, x, y, bytes: data.length, features, ms: median(runs) };
}

(async () => {
  console.log('MicroMap vector CPU bench — ' + path.basename(mbtiles) + ' @ ' + lon + ',' + lat +
    (global.Path2D ? '' : ' (no Path2D)'));
  for (const z of [9, 12, 14]) {
    const result = decodeBench(z);
    if (result) console.log('decode z' + z + ' ' + result.x + '/' + result.y + ': ' + (result.bytes / 1024).toFixed(0) + ' KiB, ' +
      result.features + ' features, ' + result.ms.toFixed(1) + ' ms');
  }
  // --style=file.json renders a MapLibre style (for example KBMapCore.buildStyle()).
  const profile = flags.style ? JSON.parse(require('node:fs').readFileSync(flags.style, 'utf8')) : karteBayernBlueStyle();
  const name = flags.style ? path.basename(flags.style) : 'blue';
  for (const zoom of [9.4, 11.6, 13.4, 15.3, 16.6]) {
    const result = await scenario(name, zoom, profile);
    console.log(result.name + ' z' + zoom + ': tiles=' + result.tiles + ' first=' + result.first.toFixed(1) + 'ms pan=' +
      result.pan.toFixed(2) + 'ms zoom=' + result.zoomFrame.toFixed(2) + 'ms segments/frame=' +
      Math.round(result.counts.segments / (frames + 1)) + ' fills=' + Math.round(result.counts.fills / (frames + 1)) +
      ' strokes=' + Math.round(result.counts.strokes / (frames + 1)) + ' texts=' + Math.round(result.counts.texts / (frames + 1)));
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
