'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeCanvas {
  constructor() {
    this.style = {};
    this.parentNode = null;
    this.width = 0;
    this.height = 0;
    this.listeners = Object.create(null);
    this.gl = {
      COLOR_BUFFER_BIT: 16384,
      viewport: (...values) => { this.viewport = values; },
      clearColor: (...values) => { this.clearColor = values; },
      clear: value => { this.clear = value; }
    };
  }
  getContext(kind) { return kind === 'webgl2' ? this.gl : null; }
  setAttribute() {}
  addEventListener(type, handler) { this.listeners[type] = handler; }
  removeEventListener(type) { delete this.listeners[type]; }
}

function fakeMap(container) {
  const handlers = Object.create(null);
  return {
    getContainer: () => container,
    on(type, handler) { (handlers[type] || (handlers[type] = [])).push(handler); return this; },
    off(type, handler) {
      if (!handlers[type]) return this;
      handlers[type] = handlers[type].filter(value => value !== handler);
      return this;
    },
    emit(type) { (handlers[type] || []).slice().forEach(handler => handler()); }
  };
}

test('WebGL surface tracks the map lifecycle and restores after a lost context', async () => {
  const previous = { document: global.document, devicePixelRatio: global.devicePixelRatio };
  const canvases = [];
  global.document = { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; } };
  global.devicePixelRatio = 2;
  const webgl = require('../lib/microMap.webgl.js');
  const container = {
    clientWidth: 320,
    clientHeight: 180,
    appendChild(child) { child.parentNode = this; },
    removeChild(child) { child.parentNode = null; }
  };
  const map = fakeMap(container);
  const frames = [];
  const layer = webgl(map, { render: state => frames.push(state) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const canvas = canvases[0];
  assert.equal(webgl.isSupported(), true);
  assert.equal(layer.getRenderer(), 'webgl2');
  assert.equal(frames[0].width, 320);
  assert.equal(frames[0].height, 180);
  assert.equal(frames[0].pixelWidth, 640);
  assert.equal(frames[0].pixelHeight, 360);
  assert.equal(canvas.width, 640);
  assert.deepEqual(canvas.viewport, [0, 0, 640, 360]);
  canvas.listeners.webglcontextlost({ preventDefault() {} });
  assert.equal(layer.isContextLost(), true);
  canvas.listeners.webglcontextrestored();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(layer.isContextLost(), false);
  layer.destroy();
  assert.equal(canvas.parentNode, null);
  if (previous.document === undefined) delete global.document;
  else global.document = previous.document;
  if (previous.devicePixelRatio === undefined) delete global.devicePixelRatio;
  else global.devicePixelRatio = previous.devicePixelRatio;
});

test('WebGL surface caps DPR for compact devices and avoids redundant viewport work', async () => {
  const previous = { document: global.document, devicePixelRatio: global.devicePixelRatio };
  const canvases = [];
  global.document = { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; } };
  global.devicePixelRatio = 3;
  const container = {
    clientWidth: 320,
    clientHeight: 180,
    appendChild(child) { child.parentNode = this; },
    removeChild(child) { child.parentNode = null; }
  };
  const map = fakeMap(container);
  const layer = require('../lib/microMap.webgl.js')(map, { maxDpr: 2 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const canvas = canvases[0];
  assert.equal(canvas.width, 640);
  assert.deepEqual(canvas.viewport, [0, 0, 640, 360]);
  const firstViewport = canvas.viewport;
  map.emit('move');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(canvas.viewport, firstViewport, 'unchanged dimensions reuse the existing viewport');
  layer.destroy();
  if (previous.document === undefined) delete global.document;
  else global.document = previous.document;
  if (previous.devicePixelRatio === undefined) delete global.devicePixelRatio;
  else global.devicePixelRatio = previous.devicePixelRatio;
});
