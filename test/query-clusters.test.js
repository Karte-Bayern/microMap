'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vector = require('../lib/microMap.vector.js');

const savedDocument = Object.getOwnPropertyDescriptor(global, 'document');
function element() {
  const context = new Proxy({ measureText: () => ({ width: 10 }) }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; }
  });
  return {
    style: {}, children: [], clientWidth: 512, clientHeight: 512,
    setAttribute() {}, getContext: () => context,
    appendChild(child) { child.parentNode = this; this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  };
}
global.document = { createElement: element };
test.after(() => {
  if (savedDocument) Object.defineProperty(global, 'document', savedDocument);
  else delete global.document;
});

const point = (id, coordinates, properties = {}) => ({ type: 'Feature', id, properties, geometry: { type: 'Point', coordinates } });
const collection = features => ({ type: 'FeatureCollection', features });
function scene(data, clustered = true, startZoom = 12) {
  const center = [12.4, 48.1], container = element();
  let zoom = startZoom;
  const map = {
    getContainer: () => container, getZoom: () => zoom,
    on() { return this; }, off() { return this; },
    getCameraState: () => ({ center, zoom, worldSize: 512 * 2 ** zoom, width: 512, height: 512, pitch: 0, bearing: 0 }),
    unproject([x, y]) {
      const world = 512 * 2 ** zoom;
      const cy = (1 - Math.log(Math.tan(Math.PI / 4 + center[1] * Math.PI / 360)) / Math.PI) / 2;
      return [center[0] + (x - 256) * 360 / world, Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy + (y - 256) / world)))) * 180 / Math.PI];
    }
  };
  const layer = vector(map, { tiles: false, maxZoom: 14,
    style: { version: 8, sources: { search: { type: 'geojson', data,
      cluster: clustered, clusterRadius: 40, clusterMaxZoom: 16,
      ...(clustered ? { clusterProperties: { total: ['+', ['get', 'value']] } } : {})
    } }, layers: [
      // OSMmini uses this invisible layer to load source tiles, then draws
      // DOM markers from querySourceFeatures, including cluster bubbles.
      { id: 'search', type: 'circle', source: 'search', paint: { 'circle-radius': 0, 'circle-opacity': 0 } }
    ] }
  });
  return { layer, zoom(value) { zoom = value; layer.redraw(); } };
}
async function settle(layer) {
  const deadline = Date.now() + 2000;
  while (!layer.areTilesLoaded() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(layer.areTilesLoaded(), true, JSON.stringify(layer.getRenderStats()));
}

test('OSMmini transparent source queries return cluster bubbles and working expansion/leaves', async () => {
  const data = collection(Array.from({ length: 320 }, (_, id) => point(id,
    [12.36 + Math.floor(id / 40) * .012 + (id % 40) * .000005, 48.1 + (id % 5) * .000002],
    { __idx: id, value: 1 })));
  const { layer } = scene(data);
  try {
    await settle(layer);
    const clusters = layer.querySourceFeatures('search');
    assert.equal(clusters.length, 8, 'eight marker bubbles replace 320 raw DOM markers');
    assert.ok(clusters.every(feature => feature.properties.cluster && feature.properties.point_count === 40));
    assert.equal(clusters.reduce((sum, feature) => sum + feature.properties.total, 0), 320);
    const cluster = clusters[0], source = layer.getSource('search');
    assert.equal(await source.getClusterExpansionZoom(cluster.properties.cluster_id), 17);
    const leaves = await source.getClusterLeaves(cluster.properties.cluster_id, 50, 0);
    assert.equal(leaves.length, 40);
    assert.deepEqual(leaves.map(feature => feature.properties.__idx).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
    const children = await new Promise((resolve, reject) => source.getClusterChildren(cluster.properties.cluster_id,
      (error, features) => error ? reject(error) : resolve(features)));
    assert.equal(children.length, 40);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['!', ['has', 'point_count']] }), []);
    assert.equal(layer.querySourceFeatures('search', { filter: ['>=', ['get', 'total'], 40] }).length, 8);
    cluster.properties.point_count = -1;
    cluster.geometry.coordinates[0] = 0;
    assert.equal(layer.querySourceFeatures('search')[0].properties.point_count, 40, 'query results cannot mutate cluster state');
    assert.deepEqual(source.getData(), data, 'the original source remains available for editing');
  } finally { layer.destroy(); }
});

test('source and native cluster queries dissolve above basemap maxzoom and refresh after setData', async () => {
  const data = collection([point(1, [12.4, 48.1], { value: 2 }), point(2, [12.40001, 48.1], { value: 3 })]);
  const view = scene(data, true, 16.99), layer = view.layer;
  try {
    layer.setPaintProperties('search', { 'circle-opacity': 1, 'circle-radius': 8 });
    await settle(layer);
    assert.equal(layer.querySourceFeatures('search').length, 1);
    assert.ok(layer.queryRenderedFeatures([256, 256], { radius: 64 }).some(feature => feature.properties.point_count === 2), 'native drawing uses the source cluster level');
    view.zoom(17.01);
    await settle(layer);
    assert.deepEqual(layer.querySourceFeatures('search').map(feature => feature.id), [1, 2], 'the camera zoom is independent of maxzoom 14 basemap tiles');
    const native = layer.queryRenderedFeatures([256, 256], { radius: 64 });
    assert.ok(native.some(feature => feature.id === 1) && native.some(feature => feature.id === 2));
    assert.ok(native.every(feature => !feature.properties.cluster), 'native virtual layers also discard cached lower-zoom clusters');
    view.zoom(12);
    layer.getSource('search').setData(collection([point(9, [12.4, 48.1], { value: 7 })]));
    await settle(layer);
    assert.deepEqual(layer.querySourceFeatures('search').map(feature => feature.id), [9], 'updated source data replaces the previous hierarchy');
  } finally { layer.destroy(); }
});

test('unclustered GeoJSON source queries apply expression and legacy filters without mutating data', () => {
  const data = collection([
    point(1, [12.4, 48.1], { kind: 'stop', selected: true }),
    { type: 'Feature', id: 2, properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: [[12.4, 48.1], [12.41, 48.1]] } },
    { type: 'Feature', id: 3, properties: { kind: 'stop' }, geometry: { type: 'MultiPoint', coordinates: [[12.4, 48.1], [12.41, 48.1]] } }
  ]);
  const { layer } = scene(data, false);
  try {
    assert.deepEqual(layer.querySourceFeatures('search'), data.features);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['==', ['get', 'kind'], 'route'] }).map(feature => feature.id), [2]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['==', '$type', 'Point'] }).map(feature => feature.id), [1, 3]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['==', '$id', 1] }).map(feature => feature.id), [1]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['all', ['has', 'selected'], ['==', ['get', 'selected'], true]] }).map(feature => feature.id), [1]);
    const copy = layer.querySourceFeatures('search'); copy[0].properties.kind = 'changed';
    assert.equal(layer.querySourceFeatures('search')[0].properties.kind, 'stop');
    layer.getSource('search').setData(data.features[1]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['==', ['geometry-type'], 'LineString'] }), [data.features[1]]);
    assert.deepEqual(layer.querySourceFeatures('missing'), []);
  } finally { layer.destroy(); }
});

test('clustered source queries retain lines and multipoints alongside clusters', () => {
  const line = { type: 'Feature', id: 3, properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: [[12.4, 48.1], [12.41, 48.1]] } };
  const multi = { type: 'Feature', id: 4, properties: { kind: 'stops' }, geometry: { type: 'MultiPoint', coordinates: [[12.4, 48.1], [12.41, 48.1]] } };
  const { layer } = scene(collection([point(1, [12.4, 48.1], { value: 1 }), point(2, [12.40001, 48.1], { value: 1 }), line, multi]));
  try {
    const features = layer.querySourceFeatures('search');
    assert.equal(features.length, 3);
    assert.equal(features[0].properties.point_count, 2);
    assert.deepEqual(features.slice(1), [line, multi]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['!', ['has', 'point_count']] }), [line, multi]);
    assert.deepEqual(layer.querySourceFeatures('search', { filter: ['==', ['geometry-type'], 'LineString'] }), [line]);
  } finally { layer.destroy(); }
});
