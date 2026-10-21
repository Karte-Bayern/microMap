'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const microMap = require('../lib/microMap.js');
const vector = require('../lib/microMap.vector.js');

const savedDocument = Object.getOwnPropertyDescriptor(global, 'document');
function element(tag) {
  const context = new Proxy({
    getTransform: undefined,
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([128, 100, 0, 255], i);
      return { data, width, height };
    },
    createImageData: undefined
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const node = {
    style: {}, children: [], clientWidth: 64, clientHeight: 64, naturalWidth: 4,
    setAttribute() {},
    getContext: kind => kind === '2d' ? context : null,
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
    },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  };
  if (tag === 'img') Object.defineProperty(node, 'src', {
    set(value) { node.url = value; queueMicrotask(() => { if (node.onload) node.onload(); }); }
  });
  return node;
}
global.document = { createElement: element };
test.after(() => {
  if (savedDocument) Object.defineProperty(global, 'document', savedDocument);
  else delete global.document;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: data => resolve({ ok: true, json: async () => data }), reject };
}
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function loaded(layer) {
  const deadline = Date.now() + 2000;
  while (!layer.areTilesLoaded() && Date.now() < deadline) await wait(5);
  assert.equal(layer.areTilesLoaded(), true, JSON.stringify(layer.getRenderStats()));
}
function scene(source, layerType, pitch, fetcher) {
  const request = deferred();
  const container = element('div');
  const camera = microMap.createCamera({ width: 64, height: 64, pitch, bearing: 0 });
  const map = {
    getContainer: () => container,
    on() { return this; }, off() { return this; },
    getZoom: () => 0, getCamera: () => camera,
    getCameraState: () => ({ center: [0, 0], zoom: 0, worldSize: 512, width: 64, height: 64, pitch, bearing: 0 })
  };
  const layer = vector(map, {
    tiles: false, fetch: fetcher || (() => request.promise),
    style: { version: 8, sources: { source }, layers: [{ id: 'layer', type: layerType, source: 'source' }] }
  });
  return { layer, request };
}
const point = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } };

for (const pitch of [0, 55]) {
  test('URL GeoJSON stays pending until its data arrives at pitch ' + pitch, async () => {
    const { layer, request } = scene({ type: 'geojson', data: '/points.geojson' }, 'circle', pitch);
    try {
      await wait(60);
      assert.equal(layer.areTilesLoaded(), false, 'an empty pending source is not loaded');
      request.resolve(point);
      await loaded(layer);
      assert.deepEqual(layer.getSource('source').getData(), point);
    } finally { layer.destroy(); }
  });

  test('DEM TileJSON stays pending through metadata and tile loading at pitch ' + pitch, async () => {
    const { layer, request } = scene({ type: 'raster-dem', url: '/dem.json', encoding: 'terrarium' }, 'hillshade', pitch);
    try {
      await wait(60);
      assert.equal(layer.areTilesLoaded(), false, 'TileJSON must precede the first DEM request');
      assert.equal(layer.getRenderStats().rasterTiles, 0);
      request.resolve({ tiles: ['/dem/{z}/{x}/{y}.png'], maxzoom: 0 });
      await loaded(layer);
      assert.ok(layer.getRenderStats().rasterTiles > 0, 'resolved metadata starts DEM requests');
    } finally { layer.destroy(); }
  });

  test('failed source documents settle without leaving pending cells at pitch ' + pitch, async () => {
    for (const [source, type] of [
      [{ type: 'geojson', data: '/points.geojson' }, 'circle'],
      [{ type: 'raster-dem', url: '/dem.json' }, 'hillshade']
    ]) {
      const { layer, request } = scene(source, type, pitch);
      const errors = [];
      layer.on('sourceerror', event => errors.push(event));
      try {
        await wait(60);
        assert.equal(layer.areTilesLoaded(), false);
        request.reject(new Error('fixture unavailable'));
        await loaded(layer);
        assert.equal(errors.length, 1);
        assert.equal(layer.getRenderStats().incomplete, 0);
      } finally { layer.destroy(); }
    }
  });

  test('synchronous source fetch failures settle at pitch ' + pitch, async () => {
    for (const [source, type] of [
      [{ type: 'geojson', data: '/points.geojson' }, 'circle'],
      [{ type: 'raster-dem', url: '/dem.json' }, 'hillshade']
    ]) {
      const failure = new Error('fixture fetch failed synchronously');
      const { layer } = scene(source, type, pitch, () => { throw failure; });
      const errors = [];
      layer.on('sourceerror', event => errors.push(event.error));
      try {
        await loaded(layer);
        assert.deepEqual(errors, [failure]);
        assert.equal(layer.getRenderStats().incomplete, 0);
      } finally { layer.destroy(); }
    }
  });
}

test('replaced GeoJSON and removed DEM sources do not retain old pending requests', async () => {
  const geo = scene({ type: 'geojson', data: '/old.geojson' }, 'circle', 0);
  const dem = scene({ type: 'raster-dem', url: '/removed.json' }, 'hillshade', 0);
  try {
    geo.layer.getSource('source').setData(point);
    dem.layer.removeLayer('layer').removeSource('source');
    await loaded(geo.layer);
    await loaded(dem.layer);
    geo.request.resolve({ type: 'FeatureCollection', features: [] });
    dem.request.resolve({ tiles: ['/late/{z}/{x}/{y}.png'] });
    await wait();
    assert.deepEqual(geo.layer.getSource('source').getData(), point, 'late response cannot replace newer data');
    assert.equal(dem.layer.getSource('source'), undefined);
    assert.equal(dem.layer.getRenderStats().rasterTiles, 0, 'removed metadata cannot start tiles');
  } finally { geo.layer.destroy(); dem.layer.destroy(); }
});
