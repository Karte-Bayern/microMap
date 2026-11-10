'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Deterministic RAF queues show whether unchanged application settings really
// avoid a draw, without depending on elapsed time or private renderer state.
function fixture(kind, strict = true, extraPaint = {}, line = false) {
  let sequence = 0;
  const frames = new Map();
  class Element {
    constructor(tag = 'div') {
      this.style = {}; this.children = []; this.parentNode = null;
      this.clientWidth = this.clientHeight = 128;
      this.operations = [];
      this.context = new Proxy({
        fill: path => this.operations.push(['fill', this.context.fillStyle, path]),
        stroke: path => this.operations.push(['stroke', this.context.strokeStyle, path])
      }, { get: (object, name) => name in object ? object[name] : () => {} });
    }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
    setAttribute() {}
    getContext() { return this.context; }
  }
  const root = {
    document: { createElement: tag => new Element(tag) }, microMap() {},
    fetch() { throw new Error('no network expected'); }, performance: { now: () => 0 },
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); }, setTimeout, clearTimeout,
    Path2D: class { moveTo() {} lineTo() {} closePath() {} arc() {} }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/microMap.' + kind + '.js'), 'utf8'), root);
  const container = new Element();
  const map = {
    getContainer: () => container, on() { return this; }, off() { return this; },
    getZoom: () => 3, getCenter: () => [0, 0], getBounds: () => [-180, -85, 180, 85],
    getCameraState: () => ({ center: [0, 0], zoom: 3, worldSize: 4096, tileSize: 512, width: 128, height: 128 }),
    project: coordinate => [64 + coordinate[0], 64 - coordinate[1]]
  };
  const data = { type: 'Feature', id: 'point', properties: { kind: 'a' }, geometry: line
    ? { type: 'LineString', coordinates: [[-1, 0], [1, 0]] } : { type: 'Point', coordinates: [0, 0] } };
  const expression = ['match', ['get', 'kind'], 'a', '#123456', '#654321'];
  const filter = ['==', 'kind', 'a'];
  const specification = { id: 'dots', type: line ? 'line' : 'circle', source: 'points', minzoom: 0, maxzoom: 20,
    paint: line ? { 'line-color': expression, 'line-width': 4, ...extraPaint } : { 'circle-color': expression, 'circle-radius': 4, ...extraPaint },
    layout: { visibility: 'visible', ...(line ? { 'line-cap': 'round' } : {}) }, filter };
  let layer;
  if (kind === 'vector') layer = root.microMapVector(map, { tiles: false, strict, style: {
    version: 8, sources: { points: { type: 'geojson', data } }, layers: [specification]
  } });
  else {
    layer = root.microMapGeoJSON(map);
    layer.addSource('points', { type: 'geojson', data });
    layer.addLayer(specification);
  }
  function flush() {
    for (let i = 0; i < 30 && frames.size; i++) {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(0);
    }
    assert.equal(frames.size, 0, 'render work settles');
  }
  flush();
  return { layer, flush, frames, filter, root, map, operations: layer.getCanvas().operations,
    copy: value => JSON.parse(JSON.stringify(value)), specification };
}

for (const kind of ['vector', 'geojson']) {
  test(kind + ' skips structurally unchanged style setters without scheduling a draw', () => {
    const view = fixture(kind);
    const { layer, frames, copy, specification } = view;
    try {
      let changes = 0;
      layer.on('stylechange', () => changes++);
      const pixels = view.operations.length;
      assert.ok(pixels > 0, 'a visible frame was rendered before testing no-ops');
      for (let i = 0; i < 3; i++) {
        assert.equal(layer.setPaintProperty('dots', 'circle-color', copy(specification.paint['circle-color'])), layer);
        layer.setPaintProperties('dots', copy(specification.paint));
        layer.setPaintProperty('dots', 'circle-opacity', undefined);
        layer.setPaintProperties('dots', { 'circle-radius': 4, 'circle-stroke-color': undefined });
        layer.setLayoutProperty('dots', 'visibility', 'visible');
        layer.setLayoutProperties('dots', { visibility: 'visible', unused: undefined });
        layer.setFilter('dots', copy(specification.filter));
        if (kind === 'vector') layer.setLayerZoomRange('dots', 0, 20);
      }
      assert.equal(frames.size, 0, 'same scalar and cloned expressions retain the rendered frame');
      view.flush();
      assert.equal(view.operations.length, pixels);
      assert.equal(changes, 0, 'no redundant overlay stylechange events');
      layer.setPaintProperties('dots', { 'circle-color': copy(specification.paint['circle-color']), 'circle-radius': 8 });
      assert.equal(frames.size, 1, 'a mixed patch with one real change schedules rendering');
      view.flush();
      assert.equal(layer.getLayer('dots').paint['circle-radius'], 8);
      layer.setPaintProperty('dots', 'circle-radius', undefined);
      assert.equal(frames.size, 1, 'deleting an existing value remains a change');
      view.flush();
      layer.setPaintProperty('dots', 'circle-radius', undefined);
      assert.equal(frames.size, 0, 'deleting the now absent value is a no-op');
      layer.setLayoutProperty('dots', 'visibility', 'none');
      view.flush();
      layer.setLayoutProperty('dots', 'visibility', 'none');
      assert.equal(frames.size, 0, 'repeated hidden state retains caches');
      layer.setLayoutProperty('dots', 'visibility', 'visible');
      view.flush();
      layer.setFilter('dots', null);
      view.flush();
      layer.setFilter('dots', undefined);
      assert.equal(frames.size, 0, 'repeated filter removal is a no-op');
    } finally { layer.destroy(); }
  });
}

test('vector style no-ops preserve validation and do not recompile ignored properties', () => {
  const strict = fixture('vector');
  const relaxed = fixture('vector', false, { 'future-option': ['literal', { b: 2, a: 1 }] });
  try {
    assert.throws(() => strict.layer.setPaintProperty('missing', 'circle-radius', 4), /unknown style layer/);
    assert.throws(() => strict.layer.setPaintProperties('dots', { 'circle-radius': 8, 'future-option': true }), /not supported/);
    assert.equal(strict.layer.getPaintProperty('dots', 'circle-radius'), 4, 'failed patches remain atomic');
    assert.throws(() => strict.layer.setPaintProperty('dots', 'circle-radius', ['unsupported-expression']), /unsupported/);
    assert.throws(() => strict.layer.setFilter('dots', ['unsupported-filter']), /filter|condition|expression|operator/);
    assert.equal(strict.frames.size, 0, 'invalid values do not schedule a frame');
    const ignored = relaxed.layer.getStyleReport().ignored.length;
    relaxed.layer.setPaintProperty('dots', 'future-option', ['literal', { a: 1, b: 2 }]);
    assert.equal(relaxed.frames.size, 0, 'object key order does not invalidate an expression');
    assert.equal(relaxed.layer.getStyleReport().ignored.length, ignored, 'an unchanged value is not recompiled or reported again');
  } finally { strict.layer.destroy(); relaxed.layer.destroy(); }
});

test('visibility patches retain vector paths when accompanying layout values are unchanged', () => {
  const view = fixture('vector', true, {}, true);
  try {
    const before = view.operations.filter(operation => operation[0] === 'stroke').map(operation => operation[2]);
    assert.ok(before.length > 0);
    view.layer.setLayoutProperties('dots', { visibility: 'none', 'line-cap': 'round' });
    view.flush();
    view.layer.setLayoutProperties('dots', { visibility: 'visible', 'line-cap': 'round' });
    view.flush();
    const after = view.operations.filter(operation => operation[0] === 'stroke').slice(-before.length).map(operation => operation[2]);
    assert.ok(after.every((path, i) => path === before[i]), 'unchanged layout fields do not turn a visibility update into a bucket rebuild');
  } finally { view.layer.destroy(); }
});

test('overlay filter snapshots distinguish mutation and resubmission from a no-op', () => {
  const view = fixture('geojson');
  try {
    view.filter[2] = 'b';
    assert.equal(view.layer.getLayer('dots').filter[2], 'a', 'the initial filter is isolated');
    view.layer.setFilter('dots', view.filter);
    assert.equal(view.frames.size, 1);
    view.flush();
    view.filter[2] = 'a';
    assert.equal(view.layer.getLayer('dots').filter[2], 'b', 'setFilter also stores a snapshot');
    view.layer.setFilter('dots', view.filter);
    assert.equal(view.frames.size, 1);
    view.flush();
    assert.throws(() => view.layer.setLayoutProperty('dots', 'visibility', 'invalid'), /visibility/);
    assert.equal(view.frames.size, 0, 'validation still happens before changing overlay state');
  } finally { view.layer.destroy(); }
});

test('feature-state snapshots distinguish edits from unchanged submissions', () => {
  const view = fixture('vector');
  const target = { source: 'points', id: 'point' };
  const state = { detail: { selected: true } };
  try {
    view.layer.setFeatureState(target, state); view.flush();
    state.detail.selected = false;
    assert.equal(view.layer.getFeatureState(target).detail.selected, true, 'submitted state is isolated from caller mutation');
    view.layer.setFeatureState(target, state);
    assert.equal(view.frames.size, 1, 'a changed nested state schedules a frame');
    view.flush();
    assert.equal(view.layer.getFeatureState(target).detail.selected, false);
    view.layer.setFeatureState(target, { detail: { selected: false } });
    assert.equal(view.frames.size, 0, 'equivalent nested state is a no-op');
    view.layer.removeFeatureState(target, 'missing');
    assert.equal(view.frames.size, 0);
  } finally { view.layer.destroy(); }
});

test('compose avoids unrelated attribution refreshes while preserving visibility credits and styledata', () => {
  const view = fixture('vector');
  let timerID = 0, refreshes = 0, events = 0;
  const timers = new Map();
  view.root.setTimeout = callback => { timers.set(++timerID, callback); return timerID; };
  view.root.clearTimeout = id => timers.delete(id);
  view.root.microMapUI = { refresh() { refreshes++; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/microMap.compose.js'), 'utf8'), view.root);
  const map = view.root.microMapCompose(view.map, { vectors: [view.layer] });
  const flushTimers = () => {
    for (let i = 0; i < 10 && timers.size; i++) {
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
    }
    assert.equal(timers.size, 0);
  };
  try {
    map.on('styledata', () => events++);
    flushTimers();
    const initialEvents = events;
    map.setPaintProperty('dots', 'circle-radius', 4);
    map.setPaintProperties('dots', { 'circle-radius': 8 });
    map.setLayoutProperty('dots', 'visibility', 'none');
    map.setLayoutProperties('dots', { visibility: 'visible' });
    map.setFilter('dots', null);
    assert.equal(refreshes, 0, 'visual setters preserve attribution without a DOM refresh');
    assert.equal(timers.size, 1, 'visual setter styledata events remain batched');
    flushTimers();
    assert.equal(events, initialEvents + 1);
    map.addSource('extra', { type: 'vector', attribution: 'Additional source', tiles: ['/extra/{z}/{x}/{y}.mvt'] });
    map.addLayer({ id: 'extra-dots', type: 'circle', source: 'extra' });
    assert.equal(refreshes, 2);
    assert.ok(map.getAttributions().includes('Additional source'));
    map.setLayoutProperty('extra-dots', 'visibility', 'none');
    assert.equal(refreshes, 3, 'hiding the only visible layer removes its source credit immediately');
    assert.equal(map.getAttributions().includes('Additional source'), false);
    const report = view.layer.getStyleReport;
    let scans = 0;
    view.layer.getStyleReport = () => { scans++; return report(); };
    for (let i = 0; i < 300; i++) {
      map.setLayoutProperty('extra-dots', 'visibility', 'none');
      map.setLayoutProperties('extra-dots', { visibility: 'none' });
    }
    assert.equal(refreshes, 3, 'unchanged visibility needs no attribution DOM refresh');
    assert.equal(scans, 0, 'unchanged visibility also skips complete attribution scans');
    map.setLayoutProperties('extra-dots', { visibility: 'visible' });
    assert.equal(refreshes, 4, 'a visibility patch also restores its source credit immediately');
    map.moveLayer('extra-dots', 'dots');
    map.removeLayer('extra-dots');
    map.removeSource('extra');
    assert.equal(refreshes, 7, 'source/layer insertion, movement and removal still refresh credits');
    flushTimers();
    assert.equal(events, initialEvents + 2, 'structural styledata events also remain batched');
  } finally { map.destroy(); }
});
