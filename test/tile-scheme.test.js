'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function scene() {
  let sequence = 0;
  const frames = new Map(), imageURLs = [], requests = [], metadata = new Map();
  class Element {
    constructor(tag = 'div') {
      this.style = {}; this.children = []; this.clientWidth = this.clientHeight = 128;
      this.naturalWidth = this.naturalHeight = 4;
      this.context = new Proxy({
        getImageData(x, y, width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; }
      }, { get: (object, key) => key in object ? object[key] : () => {} });
      if (tag === 'img') Object.defineProperty(this, 'src', {
        get: () => this.url,
        set: value => { this.url = value; if (value) { imageURLs.push(value); queueMicrotask(() => { if (this.onload) this.onload(); }); } }
      });
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    setAttribute() {}
    getContext(kind) { return kind === '2d' ? this.context : null; }
  }
  const fetch = url => {
    requests.push(url);
    return Promise.resolve(metadata.has(url) ? { ok: true, json: async () => metadata.get(url) } :
      { ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  };
  const root = { microMap() {}, fetch, URL, document: { createElement: tag => new Element(tag) }, setTimeout, clearTimeout,
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  for (const name of ['vector', 'raster']) vm.runInNewContext(fs.readFileSync(require.resolve('../lib/microMap.' + name + '.js'), 'utf8'), root);
  const container = new Element();
  const worldY = lat => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
  const map = { getContainer: () => container, getZoom: () => 2,
    getCameraState: () => ({ center: [12, 50], zoom: 2, worldSize: 2048, tileSize: 512, width: 128, height: 128, pitch: 0, bearing: 0 }),
    project: coordinate => [64 + (coordinate[0] - 12) * 2048 / 360, 64 + (worldY(coordinate[1]) - worldY(50)) * 2048],
    on() { return this; }, off() { return this; }
  };
  async function settle(layer) {
    for (let i = 0; i < 100; i++) {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(0);
      await new Promise(setImmediate);
      if (!frames.size && (!layer.areTilesLoaded || layer.areTilesLoaded())) return;
    }
    throw new Error('tile fixture did not settle');
  }
  return { root, map, fetch, metadata, requests, imageURLs, settle };
}

const template = prefix => 'https://tiles.test/' + prefix + '/{z}/{x}/{y}.mvt?inverse={-y}';
function checkTiles(events, urls, prefix, tms) {
  assert.ok(events.length > 0, 'source loaded tiles');
  for (const tile of events) {
    const inverse = 2 ** tile.z - tile.y - 1;
    const expected = `https://tiles.test/${prefix}/${tile.z}/${tile.x}/${tms ? inverse : tile.y}.mvt?inverse=${inverse}`;
    assert.ok(urls.includes(expected), 'URL matches the scheme while emitted coordinates remain XYZ: ' + expected);
  }
}

test('primary vector TileJSON supports TMS, explicit XYZ override and scheme changes', async () => {
  for (const scheme of [undefined, 'xyz']) {
    const view = scene(), url = 'https://tiles.test/vector.json';
    view.metadata.set(url, { tiles: [template('base')], scheme: 'tms', format: 'mvt', minzoom: 2, maxzoom: 2 });
    const layer = await view.root.microMapVector.fromTileJSON(view.map, url, { worker: false, tileBuffer: 0, scheme });
    const events = []; layer.on('tileload', event => events.push(event));
    try {
      await view.settle(layer);
      checkTiles(events, view.requests, 'base', scheme !== 'xyz');
      events.length = 0;
      layer.setTiles(template('replacement'), { scheme: 'tms' });
      await view.settle(layer);
      checkTiles(events, view.requests, 'replacement', true);
      events.length = 0;
      layer.setTiles(template('reset'));
      await view.settle(layer);
      checkTiles(events, view.requests, 'reset', false);
    } finally { layer.destroy(); }
  }
});

test('inline and runtime vector sources retain independent tile schemes', async () => {
  const view = scene();
  view.metadata.set('https://tiles.test/extra.json', { tiles: ['./extra/{z}/{x}/{y}.mvt?inverse={-y}'], scheme: 'tms', format: 'mvt' });
  const layer = await view.root.microMapVector.fromStyle(view.map, { version: 8, sources: {
    base: { type: 'vector', tiles: [template('base')], scheme: 'tms' },
    extra: { type: 'vector', url: 'https://tiles.test/extra.json' }
  }, layers: ['base', 'extra'].map(source => ({ id: source, source, 'source-layer': 'points', type: 'circle' })) }, { worker: false, tileBuffer: 0 });
  const events = []; layer.on('tileload', event => events.push(event));
  try {
    await view.settle(layer);
    for (const source of ['base', 'extra']) checkTiles(events.filter(event => event.source === source), view.requests, source, true);
    events.length = 0;
    layer.getSource('base').setTiles([template('base-reload')]);
    layer.getSource('extra').setTiles([template('extra-reload')]);
    await view.settle(layer);
    for (const source of ['base', 'extra']) checkTiles(events.filter(event => event.source === source), view.requests, source + '-reload', true);
    layer.addSource('xyz', { type: 'vector', url: 'https://tiles.test/extra.json', scheme: 'xyz' });
    layer.addLayer({ id: 'xyz', type: 'circle', source: 'xyz', 'source-layer': 'points' });
    events.length = 0;
    await view.settle(layer);
    checkTiles(events.filter(event => event.source === 'xyz'), view.requests, 'extra', false);
  } finally { layer.destroy(); }
});

test('vector callbacks receive TMS coordinates and unknown TileJSON schemes default to XYZ', async () => {
  const view = scene();
  const layer = view.root.microMapVector(view.map, { worker: false, scheme: 'tms', tileBuffer: 0,
    tiles: (z, x, y) => `https://tiles.test/callback/${z}/${x}/${y}.mvt?inverse=${y}` });
  const events = []; layer.on('tileload', event => events.push(event));
  try {
    await view.settle(layer);
    checkTiles(events, view.requests, 'callback', true);
  } finally { layer.destroy(); }
  const url = 'https://tiles.test/unknown.json';
  view.metadata.set(url, { tiles: [template('fallback')], scheme: 'unknown', format: 'mvt' });
  const fallback = await view.root.microMapVector.fromTileJSON(view.map, url, { worker: false, tileBuffer: 0 });
  events.length = 0; fallback.on('tileload', event => events.push(event));
  try {
    await view.settle(fallback);
    checkTiles(events, view.requests, 'fallback', false);
  } finally { fallback.destroy(); }
});

test('direct style changes apply the primary source scheme and source setters retain it', async () => {
  const view = scene(), url = 'https://tiles.test/base.json';
  view.metadata.set(url, { tiles: [template('metadata-base')], scheme: 'tms', format: 'mvt' });
  const style = scheme => ({ version: 8, sources: { base: { type: 'vector', tiles: [template('metadata-base')], scheme } },
    layers: [{ id: 'base', type: 'circle', source: 'base', 'source-layer': 'points' }] });
  const initial = style(); initial.sources.base = { type: 'vector', url };
  const layer = await view.root.microMapVector.fromStyle(view.map, initial, { worker: false, tileBuffer: 0 });
  const events = []; layer.on('tileload', event => events.push(event));
  try {
    await view.settle(layer);
    checkTiles(events, view.requests, 'metadata-base', true);
    events.length = 0;
    layer.getSource('base').setTiles([template('metadata-base')]);
    await view.settle(layer);
    checkTiles(events, view.requests, 'metadata-base', true);
    assert.equal(layer.getSource('base').serialize().scheme, 'tms', 'replacement tiles retain the resolved metadata scheme');
    for (const scheme of ['xyz', 'tms']) {
      events.length = 0;
      layer.setStyle(style(scheme));
      await view.settle(layer);
      checkTiles(events, view.requests, 'metadata-base', scheme === 'tms');
    }
  } finally { layer.destroy(); }
});

for (const type of ['raster', 'raster-dem']) {
  test(type + ' reads TMS from TileJSON without double-inverting {-y}', async () => {
    for (const scheme of [undefined, 'xyz']) {
      const view = scene(), url = 'https://tiles.test/raster.json';
      view.metadata.set(url, { tiles: [template('image')], scheme: 'tms', minzoom: 2, maxzoom: 2 });
      const layer = await view.root.microMapVector.fromStyle(view.map, { version: 8,
        sources: { image: { type, url, scheme } }, layers: [{ id: 'image', source: 'image', type: type === 'raster' ? 'raster' : 'hillshade' }]
      }, { worker: false });
      const events = []; layer.on('tileload', event => events.push(event));
      try {
        await view.settle(layer);
        checkTiles(events, view.imageURLs, 'image', scheme !== 'xyz');
        events.length = 0;
        layer.getSource('image').setTiles([template('image-reload')]);
        await view.settle(layer);
        checkTiles(events, view.imageURLs, 'image-reload', scheme !== 'xyz');
      } finally { layer.destroy(); }
    }
  });
}

test('explicit {-y} templates work without scheme in vector and raster sources', async () => {
  const view = scene();
  const inverse = 'https://tiles.test/inverse/{z}/{x}/{-y}.mvt';
  view.metadata.set('https://tiles.test/inverse.json', { tiles: [inverse], scheme: 'tms', format: 'mvt' });
  const layer = await view.root.microMapVector.fromStyle(view.map, { version: 8, sources: {
    base: { type: 'vector', tiles: [inverse] }, image: { type: 'raster', tiles: [inverse] },
    metadata: { type: 'vector', url: 'https://tiles.test/inverse.json' }
  }, layers: [{ id: 'base', source: 'base', type: 'circle', 'source-layer': 'points' }, { id: 'image', source: 'image', type: 'raster' },
    { id: 'metadata', source: 'metadata', type: 'circle', 'source-layer': 'points' }] }, { worker: false });
  const events = []; layer.on('tileload', event => events.push(event));
  try {
    await view.settle(layer);
    for (const tile of events) assert.ok((tile.raster ? view.imageURLs : view.requests).includes(
      `https://tiles.test/inverse/${tile.z}/${tile.x}/${2 ** tile.z - tile.y - 1}.mvt`));
    assert.ok(events.length > 0);
    assert.ok(events.some(event => event.source === 'metadata'), 'TileJSON also accepts an explicit inverted-Y placeholder');
  } finally { layer.destroy(); }
});

test('standalone raster sources expose TMS and preserve XYZ cache coordinates', async () => {
  for (const callback of [false, true]) {
    const view = scene();
    const layer = view.root.microMapRaster(view.map);
    layer.addSource('tms', { type: 'raster', scheme: 'tms', tileSize: 512,
      tiles: callback ? (z, x, y) => `https://tiles.test/tms/${z}/${x}/${y}.mvt?inverse=${y}` : template('tms') });
    layer.addLayer({ id: 'tms', source: 'tms', type: 'raster' });
    const events = []; layer.on('tileload', event => events.push(event));
    try {
      await view.settle(layer);
      assert.equal(layer.getSource('tms').scheme, 'tms');
      checkTiles(events, view.imageURLs, 'tms', true);
    } finally { layer.destroy(); }
  }
});
