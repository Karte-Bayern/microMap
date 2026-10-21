'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A deterministic clock charges seven milliseconds per ground paint. This
// catches work that crosses frame boundaries without depending on host load.
function scene({ bands = false } = {}) {
  let time = 0, sequence = 0, writes = 0;
  const frames = new Map(), canvases = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = []; this.parentNode = null;
      this.clientWidth = 128; this.clientHeight = 128;
      this.attributes = {};
      this.style = new Proxy({ cssText: '' }, { set(object, key, value) { if (key === 'cssText' || key === 'clipPath') writes++; object[key] = value; return true; } });
      if (tag === 'canvas') {
        this.width = 300; this.height = 150;
        this.paints = [];
        canvases.push(this);
        const target = this;
        this.context = new Proxy({
          canvas: this, globalAlpha: 1,
          fill() { time += 7; target.paints.push(['fill', this.fillStyle]); },
          fillRect() { time += 7; target.paints.push(['background', this.fillStyle]); },
          setTransform(...values) { target.transform = values; },
          save() {}, restore() {},
          getImageData() { throw new Error('the empty heatmap needs no readback'); }
        }, { get(object, key) { return key in object ? object[key] : () => {}; } });
      }
    }
    appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.push(node); return node; }
    insertBefore(node, before) { if (!before) return this.appendChild(node); if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.splice(this.children.indexOf(before), 0, node); return node; }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; return node; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getContext(kind) { return kind === '2d' ? this.context : null; }
  }
  const root = {
    performance: { now: () => time },
    document: { createElement: tag => new Element(tag) },
    microMap() {}, fetch() { throw new Error('no network expected'); },
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout, clearTimeout, devicePixelRatio: 1
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/microMap.vector.js'), 'utf8'), root);
  const container = new Element();
  const state = { center: [0, 0], zoom: 0, worldSize: 512, bearing: 0, pitch: 60 };
  const handlers = new Map();
  const camera = {
    get width() { return container.clientWidth; }, get height() { return container.clientHeight; },
    horizonRow: -1e9, distance: 256,
    cover: () => [{ z: 0, x: 0, y: 0 }],
    groundBox: () => ({ x0: -256, y0: -256, x1: 256, y1: 256 }),
    cssTransform: () => 'matrix3d(' + state.bearing + ')',
    project: (x, y) => [x + container.clientWidth / 2, y + container.clientHeight / 2, 1]
  };
  const map = {
    getContainer: () => container, getZoom: () => state.zoom,
    getCameraState: () => ({ ...state }), getCamera: () => camera,
    on(name, callback) { handlers.set(name, callback); return this; },
    off(name) { handlers.delete(name); return this; }
  };
  const data = () => ({ type: 'FeatureCollection', features: ['#110000', '#220000', '#330000', '#440000', '#550000'].map((color, i) => ({
    type: 'Feature', id: i, properties: { color }, geometry: { type: 'Point', coordinates: [i, 0] }
  })) });
  const layers = [{ id: 'ground', type: 'circle', source: 'points', paint: { 'circle-color': ['get', 'color'] } }];
  if (bands) layers.push({ id: 'heat', type: 'heatmap', source: 'empty' },
    { id: 'top', type: 'circle', source: 'points', paint: { 'circle-color': '#ffffff' } });
  const layer = root.microMapVector(map, { tiles: false, style: { version: 8,
    sources: { points: { type: 'geojson', data: data() }, empty: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } }, layers } });
  function frame() {
    const queued = [...frames.values()]; frames.clear();
    const before = time;
    for (const callback of queued) callback(time);
    return time - before;
  }
  function settle() { for (let i = 0; i < 40 && !layer.areTilesLoaded(); i++) frame(); assert.ok(layer.areTilesLoaded(), JSON.stringify(layer.getRenderStats())); }
  function liveCells() { return container.children.filter(node => node.tagName === 'DIV').flatMap(host => host.children.flatMap(pane => pane.children)); }
  function staging() { return canvases.filter(node => !node.parentNode && node.width > 0 && node.transform && node.transform[4] !== 0 && node !== layer.getCanvas()); }
  return { root, layer, container, state, handlers, canvases, frame, settle, liveCells, staging, data, writes: () => writes };
}

test('tilted ground yields between groups and publishes only a complete cell', () => {
  const view = scene();
  try {
    assert.equal(view.frame(), 14, 'only two seven-ms groups run in a twelve-ms frame');
    assert.equal(view.layer.areTilesLoaded(), false);
    assert.equal(view.liveCells().length, 1);
    assert.deepEqual(view.liveCells()[0].paints, [], 'partial paints remain unpublished');
    assert.equal(view.staging().length, 1, 'only one cell job owns a staging texture');
    assert.equal(view.frame(), 14);
    assert.deepEqual(view.liveCells()[0].paints, []);
    view.settle();
    assert.deepEqual(view.liveCells()[0].paints.map(paint => paint[1]), ['#110000', '#220000', '#330000', '#440000', '#550000']);
    assert.equal(view.staging().length, 0);
    const published = view.liveCells()[0];
    view.layer.setPaintProperty('ground', 'circle-color', '#00ff00');
    view.settle();
    assert.notEqual(view.liveCells()[0], published);
    assert.equal(published.width, 0, 'replaced pixel buffers are released');
    assert.deepEqual(view.liveCells()[0].paints, [['fill', '#00ff00']]);
  } finally { view.layer.destroy(); }
});

test('a resized or invalidated ground job discards staging instead of mixing frames', () => {
  const view = scene();
  try {
    view.frame();
    const stale = view.staging()[0], pixels = stale.width;
    view.container.clientWidth++;
    view.layer.redraw();
    view.frame();
    assert.equal(stale.width, 0, 'a one-pixel resize cancels the old transform');
    assert.equal(view.staging()[0].width, pixels, 'the texture pixel bucket did not change');
    const resized = view.staging()[0];
    view.layer.setPaintProperty('ground', 'circle-radius', 8);
    view.frame();
    assert.equal(resized.width, 0, 'a new paint signature cancels the old job');
    const oldData = view.staging()[0];
    const data = view.data(); data.features[0].properties.color = '#abcdef';
    view.layer.getSource('points').setData(data);
    view.frame();
    assert.equal(oldData.width, 0, 'new data cancels the old bucket');
    view.settle();
    assert.equal(view.liveCells()[0].paints[0][1], '#abcdef');
    view.layer.setPaintProperty('ground', 'circle-radius', 9);
    view.frame();
    const pending = view.staging()[0];
    view.layer.destroy();
    assert.equal(pending.width, 0, 'destroy releases the unfinished texture');
  } finally { view.layer.destroy(); }
});

test('ground bands retain their order and identical redraws avoid style writes', () => {
  const view = scene({ bands: true });
  try {
    view.frame();
    assert.equal(view.staging().length, 2, 'the single cell job owns one texture per ground band');
    assert.ok(view.liveCells().every(cell => cell.paints.length === 0));
    view.settle();
    const cells = view.liveCells();
    assert.equal(cells.length, 2);
    assert.equal(cells[0].paints.length, 5);
    assert.deepEqual(cells[1].paints, [['fill', '#ffffff']]);
    const writes = view.writes();
    for (let i = 0; i < 3; i++) { view.layer.redraw(); view.frame(); }
    assert.equal(view.writes(), writes, 'stable camera and bands do not rewrite CSS');
    view.state.bearing = 30; view.layer.redraw(); view.frame();
    assert.ok(view.writes() > writes, 'camera transforms still update');
    view.layer.setLayoutProperty('heat', 'visibility', 'none');
    view.settle();
    assert.equal(view.liveCells().length, 1, 'removing the heat boundary releases the extra band');
    assert.equal(view.staging().length, 0);
  } finally { view.layer.destroy(); }
});


test('resolution, DPR and zoom changes invalidate an unfinished cell', () => {
  const view = scene();
  try {
    view.frame();
    const initial = view.staging()[0];
    view.root.devicePixelRatio = 2;
    view.layer.redraw(); view.frame();
    assert.equal(initial.width, 0);
    assert.equal(view.staging()[0].width, 1056, 'the replacement uses the new texture resolution');
    const highDpr = view.staging()[0];
    view.root.devicePixelRatio = 1.999;
    view.layer.redraw(); view.frame();
    assert.equal(highDpr.width, 0, 'DPR invalidates even within the same 32-pixel texture bucket');
    assert.equal(view.staging()[0].width, 1056);
    const beforeZoom = view.staging()[0];
    view.state.zoom = .01;
    view.layer.redraw(); view.frame();
    assert.equal(beforeZoom.width, 0, 'zoom-dependent instructions cannot share unfinished jobs');
    view.settle();
  } finally { view.layer.destroy(); }
});

test('band changes and returning to flat view release unfinished textures', () => {
  const view = scene({ bands: true });
  try {
    view.frame();
    const previous = view.staging().slice();
    view.layer.setLayoutProperty('heat', 'visibility', 'none');
    view.frame();
    assert.ok(previous.every(canvas => canvas.width === 0), 'changing band membership drops the whole unpublished job');
    const pending = view.staging()[0];
    assert.ok(pending);
    view.state.pitch = 0;
    view.layer.redraw(); view.frame();
    assert.equal(pending.width, 0, 'flattening drops unpublished ground work');
    assert.equal(view.liveCells().length, 0);
    assert.equal(view.staging().length, 0);
    assert.equal(view.layer.getRenderStats().mode, 'flat');
  } finally { view.layer.destroy(); }
});

test('live overlay source updates preserve cached ground and unfinished ground work', () => {
  const view = scene();
  try {
    view.frame();
    const pending = view.staging()[0];
    view.layer.addSource('live', { type: 'geojson', data: view.data() });
    view.frame();
    assert.equal(view.staging()[0], pending, 'an unrelated source cannot restart the ground job');
    view.settle();
    view.layer.addLayer({ id: 'live-labels', type: 'symbol', source: 'live', layout: { 'text-field': '' } });
    view.layer.addLayer({ id: 'live-query', type: 'circle', source: 'live', paint: { 'circle-opacity': 0 } });
    view.layer.addLayer({ id: 'live-hidden', type: 'circle', source: 'live', layout: { visibility: 'none' }, paint: { 'circle-color': ['get', 'color'] } });
    view.settle();
    const ground = view.liveCells()[0];
    for (let i = 0; i < 10; i++) {
      const data = view.data(); data.features[0].properties.color = '#abcdef';
      view.layer.getSource('live').setData(data);
      view.frame(); view.settle();
      assert.equal(view.liveCells()[0], ground, 'symbol-only, transparent query and hidden sources keep the basemap texture');
    }
    view.layer.setLayoutProperty('live-hidden', 'visibility', 'visible');
    view.settle();
    assert.notEqual(view.liveCells()[0], ground, 'showing ground geometry invalidates the texture');
    assert.ok(view.liveCells()[0].paints.some(paint => paint[1] === '#abcdef'), 'the latest hidden-source update appears');
  } finally { view.layer.destroy(); }
});

test('heatmap-only source data does not repaint either ground band', () => {
  const view = scene({ bands: true });
  try {
    view.settle();
    const ground = view.liveCells().slice();
    for (let i = 0; i < 5; i++) {
      view.layer.getSource('empty').setData({ type: 'FeatureCollection', features: [] });
      view.frame(); view.settle();
      assert.deepEqual(view.liveCells(), ground, 'density invalidation is separate from ground textures');
    }
  } finally { view.layer.destroy(); }
});

test('cluster-level changes refresh ground even across a tiny overzoom step', () => {
  const view = scene();
  try {
    view.state.zoom = 16.99; view.state.worldSize = 512 * 2 ** view.state.zoom;
    view.layer.addSource('clustered', { type: 'geojson', cluster: true, clusterMaxZoom: 16, data: {
      type: 'FeatureCollection', features: [0, 1, 2].map(id => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Point', coordinates: [id * 1e-10, 0] } }))
    } });
    view.layer.addLayer({ id: 'clusters', source: 'clustered', type: 'circle', paint: {
      'circle-color': ['case', ['has', 'point_count'], '#ff0000', '#0000ff']
    } });
    view.settle();
    const before = view.liveCells()[0];
    assert.ok(before.paints.some(paint => paint[1] === '#ff0000'), 'cluster geometry appears below the source maximum');
    view.state.zoom = 17.01; view.state.worldSize = 512 * 2 ** view.state.zoom;
    view.layer.redraw(); view.settle();
    assert.notEqual(view.liveCells()[0], before, 'crossing a cluster level invalidates the cell without a 0.2 zoom drift');
    assert.ok(view.liveCells()[0].paints.some(paint => paint[1] === '#0000ff'), 'unclustered points replace the cluster');
    assert.ok(!view.liveCells()[0].paints.some(paint => paint[1] === '#ff0000'));
  } finally { view.layer.destroy(); }
});

test('feature-dependent opacity continues to invalidate visible ground correctly', () => {
  const view = scene();
  const data = opacity => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { opacity }, geometry: { type: 'Point', coordinates: [0, 0] } }] });
  try {
    view.layer.addSource('conditional', { type: 'geojson', data: data(0) });
    view.layer.addLayer({ id: 'conditional', type: 'circle', source: 'conditional', paint: { 'circle-opacity': ['get', 'opacity'], 'circle-color': '#abcdef' } });
    view.settle();
    const before = view.liveCells()[0];
    assert.ok(!before.paints.some(paint => paint[1] === '#abcdef'));
    view.layer.getSource('conditional').setData(data(1));
    view.settle();
    assert.notEqual(view.liveCells()[0], before);
    assert.ok(view.liveCells()[0].paints.some(paint => paint[1] === '#abcdef'), 'a data update can reveal previously transparent ground');
  } finally { view.layer.destroy(); }
});
