'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const microMap = require('../lib/microMap.js');

function scene(pitch, paint = {}) {
  let sequence = 0;
  const frames = new Map(), canvases = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.style = {}; this.clientWidth = this.clientHeight = 128;
      this.width = 300; this.height = 150; this.paints = [];
      if (tag === 'canvas') canvases.push(this);
      const target = this;
      this.context = new Proxy({
        globalAlpha: 1,
        clearRect() { target.paints.length = 0; },
        fill() { target.paints.push({ kind: 'fill', color: this.fillStyle, alpha: this.globalAlpha }); },
        stroke() { target.paints.push({ kind: 'stroke', color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth }); }
      }, { get: (object, key) => key in object ? object[key] : () => {} });
    }
    appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); }
    insertBefore(child, before) { if (!before) return this.appendChild(child); if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    setAttribute() {}
    getContext(kind) { return kind === '2d' ? this.context : null; }
  }
  const root = { microMap, performance: { now: () => 0 }, document: { createElement: tag => new Element(tag) },
    fetch() { throw new Error('no network expected'); }, setTimeout, clearTimeout, devicePixelRatio: 1,
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/microMap.vector.js'), 'utf8'), root);
  const container = new Element();
  const state = { center: [0, 0], zoom: 3, worldSize: 4096, width: 128, height: 128, pitch, bearing: 0 };
  const map = { getContainer: () => container, getZoom: () => state.zoom,
    getCameraState: () => state, getCamera: () => microMap.createCamera({ width: 128, height: 128, pitch, bearing: 0 }),
    unproject: () => [0, 0], on() { return this; }, off() { return this; }
  };
  const data = (color = '#2465ba', width = 3, opacity = .45) => ({ type: 'Feature', id: 1,
    properties: { color, width, opacity }, geometry: { type: 'Point', coordinates: [0, 0] } });
  const layer = root.microMapVector(map, { tiles: false, style: { version: 8,
    sources: { rings: { type: 'geojson', data: data() } }, layers: [
      { id: 'rings', type: 'circle', source: 'rings', paint: { 'circle-radius': 12, 'circle-opacity': 0,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['get', 'width'],
        'circle-stroke-opacity': ['get', 'opacity'], ...paint } }
    ] }
  });
  function settle() {
    for (let i = 0; i < 100 && frames.size; i++) {
      const queued = [...frames.values()]; frames.clear();
      for (const callback of queued) callback(0);
    }
    assert.equal(frames.size, 0); assert.ok(layer.areTilesLoaded());
  }
  function strokes() {
    return canvases.filter(canvas => {
      for (let node = canvas; node; node = node.parentNode) if (node === container) return true;
      return false;
    }).flatMap(canvas => canvas.paints.filter(paint => paint.kind === 'stroke' && paint.alpha > 0));
  }
  settle();
  return { layer, settle, strokes, data };
}

for (const pitch of [0, 55]) {
  test('circle border remains visible and queryable with transparent fill at pitch ' + pitch, () => {
    const view = scene(pitch);
    try {
      assert.ok(view.strokes().length > 0, 'the circle border is painted');
      assert.ok(view.strokes().every(stroke => stroke.color === '#2465ba' && stroke.alpha === .45));
      assert.ok(view.layer.queryRenderedFeatures([64, 64]).some(feature => feature.id === 1), 'point query includes the visible border');
      assert.ok(view.layer.queryRenderedFeatures([[60, 60], [68, 68]]).some(feature => feature.id === 1), 'box query includes the visible border');
      view.layer.setPaintProperty('rings', 'circle-stroke-opacity', 0); view.settle();
      assert.equal(view.strokes().length, 0, 'zero fill and border opacity paints nothing');
      assert.equal(view.layer.queryRenderedFeatures([64, 64]).length, 0);
      assert.equal(view.layer.queryRenderedFeatures([[60, 60], [68, 68]]).length, 0);
    } finally { view.layer.destroy(); }
  });

  test('circle border source updates refresh transparent-fill geometry at pitch ' + pitch, () => {
    const view = scene(pitch);
    try {
      view.layer.getSource('rings').setData(view.data('#df6531')); view.settle();
      assert.ok(view.strokes().length > 0);
      assert.ok(view.strokes().every(stroke => stroke.color === '#df6531'), 'new source colours replace cached borders');
      view.layer.getSource('rings').setData(view.data('#df6531', 0)); view.settle();
      assert.equal(view.strokes().length, 0);
      view.layer.getSource('rings').setData(view.data('#a738cc', 4)); view.settle();
      assert.ok(view.strokes().some(stroke => stroke.color === '#a738cc'), 'feature-dependent width can reveal a border again');
    } finally { view.layer.destroy(); }
  });
}
