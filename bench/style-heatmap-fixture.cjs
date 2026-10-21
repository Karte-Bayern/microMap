'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const microMap = require('../lib/microMap.js');
const { performance } = require('node:perf_hooks');

// Models sprite footprints and additive density, not browser rasterisation.
// Readback and colour conversion run through the public vector renderer.
module.exports = function fixture({ width = 1024, height = 768, pitch = 0, verify = false,
  source = require.resolve('../lib/microMap.vector.js'), paint = {} } = {}) {
  let sequence = 0;
  const frames = new Map(), reads = [], writes = [], sprites = [];
  let composited;
  class Element {
    constructor(tag = 'div') {
      this.style = {}; this.children = []; this.attributes = {};
      this.clientWidth = width; this.clientHeight = height;
      this.width = 300; this.height = 150;
      const canvas = this;
      let pixels;
      function surface() {
        const size = canvas.width * canvas.height * 4;
        if (!pixels || pixels.length !== size) pixels = new Uint8ClampedArray(size);
        return pixels;
      }
      this.context = new Proxy({
        clearRect() { if (pixels) pixels.fill(0); },
        createRadialGradient() { sprites.push(canvas); return { addColorStop() {} }; },
        drawImage(image, ...args) {
          if (args.length !== 2) { composited = image; return; }
          const [left, top] = args, data = surface();
          const x0 = Math.max(0, Math.floor(left)), y0 = Math.max(0, Math.floor(top));
          const x1 = Math.min(canvas.width, Math.ceil(left + image.width));
          const y1 = Math.min(canvas.height, Math.ceil(top + image.height));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const at = 4 * (y * canvas.width + x);
            data[at] = data[at + 1] = data[at + 2] = 255;
            data[at + 3] = Math.min(255, data[at + 3] + 1 + (x * 13 + y * 7) % 255);
          }
        },
        getImageData(x, y, w, h) {
          const input = surface(), data = new Uint8ClampedArray(w * h * 4);
          reads.push({ x, y, width: w, height: h, canvas, input: verify ? input.slice() : null });
          for (let row = 0; row < h; row++) {
            const start = 4 * ((y + row) * canvas.width + x);
            data.set(input.subarray(start, start + w * 4), row * w * 4);
          }
          return { data, width: w, height: h };
        },
        putImageData(image, x, y) {
          const target = surface();
          for (let row = 0; row < image.height; row++) {
            const from = row * image.width * 4;
            target.set(image.data.subarray(from, from + image.width * 4), 4 * ((y + row) * canvas.width + x));
          }
          writes.push({ x, y, width: image.width, height: image.height });
        }
      }, { get: (object, key) => key in object ? object[key] : () => {} });
      this.pixels = () => surface();
    }
    appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); }
    insertBefore(child, before) { if (!before) return this.appendChild(child); if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getContext(kind) { return kind === '2d' ? this.context : null; }
  }
  const root = { microMap, performance, document: { createElement: tag => new Element(tag) },
    fetch() { throw new Error('no network expected'); }, setTimeout, clearTimeout,
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), root);
  const state = { center: [0, 0], zoom: 3, worldSize: 4096, width, height, pitch, bearing: 0 };
  const container = new Element();
  const map = { getContainer: () => container, getZoom: () => state.zoom,
    getCameraState: () => state, getCamera: () => microMap.createCamera({ width, height, pitch: state.pitch, bearing: state.bearing }),
    on() { return this; }, off() { return this; } };
  const layer = root.microMapVector(map, { tiles: false, worker: false, style: {
    version: 8, sources: { points: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [{ id: 'heat', type: 'heatmap', source: 'points', paint: {
      'heatmap-radius': 20, 'heatmap-weight': ['get', 'weight'],
      'heatmap-color': ['step', ['heatmap-density'], 'rgba(0,0,0,0)', .001, '#ff0000'], ...paint
    } }]
  } });
  function flush() {
    for (let i = 0; i < 100 && frames.size; i++) {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(0);
    }
    if (frames.size) throw new Error('heatmap did not settle');
  }
  flush();
  return { layer, reads, writes, sprites, state, flush,
    output: () => composited,
    setPoints(points) {
      layer.getSource('points').setData({ type: 'FeatureCollection', features: points.map(([x, y, weight = 1], id) => ({
        type: 'Feature', id, properties: { weight }, geometry: { type: 'Point', coordinates: [
          (x - width / 2) * 360 / state.worldSize,
          Math.atan(Math.sinh(-2 * Math.PI * (y - height / 2) / state.worldSize)) * 180 / Math.PI
        ] }
      })) });
      flush();
    },
    destroy: () => layer.destroy()
  };
};
