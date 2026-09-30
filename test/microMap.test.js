'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.innerHTML = '';
  }

  get lastChild() { return this.children[this.children.length - 1] || null; }

  appendChild(child) {
    if (child.parentNode) {
      const siblings = child.parentNode.children;
      const index = siblings.indexOf(child);
      if (index > -1) siblings.splice(index, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index > -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    (this.listeners[type] || (this.listeners[type] = [])).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(handler);
    if (index > -1) list.splice(index, 1);
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
      deltaY: 0,
      deltaMode: 0,
      key: '',
      preventDefault() {},
      stopPropagation() {},
      ...values
    };
    const onProperty = this['on' + type];
    if (typeof onProperty === 'function') onProperty.call(this, event);
    for (const handler of (this.listeners[type] || []).slice()) handler(event);
    return event;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  focus() { global.document.activeElement = this; }
  setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
  releasePointerCapture(pointerId) { this.releasedPointerId = pointerId; }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const originalGlobals = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']) {
  originalGlobals[name] = global[name];
}

const documentListeners = Object.create(null);
const createdElements = [];
global.document = {
  activeElement: null,
  querySelector() { return null; },
  createElement(tagName) {
    const element = new FakeElement(tagName);
    createdElements.push(element);
    return element;
  },
  addEventListener(type, handler) {
    (documentListeners[type] || (documentListeners[type] = [])).push(handler);
  },
  removeEventListener(type, handler) {
    const list = documentListeners[type] || [];
    const index = list.indexOf(handler);
    if (index > -1) list.splice(index, 1);
  },
  dispatch(type, values = {}) {
    const event = { type, target: null, key: '', preventDefault() {}, stopPropagation() {}, ...values };
    for (const handler of (documentListeners[type] || []).slice()) handler(event);
    return event;
  }
};
global.getComputedStyle = () => ({ position: 'static' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = FakeResizeObserver;

const microMap = require('../lib/microMap.js');

function almostEqual(actual, expected, epsilon = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function nextFrame() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

function preloadImagesSince(index) {
  return createdElements.slice(index).filter(element => element.tagName === 'IMG' && element.fetchPriority === 'low');
}

async function flushPreloadTimers() {
  await nextFrame();
  await nextFrame();
}

function createMap(overrides = {}) {
  const container = new FakeElement();
  const map = microMap(container, {
    center: [12.491, 48.63],
    zoom: 10,
    tiles: '/tiles/{z}/{x}/{y}.png',
    attribution: 'Test tiles',
    ...overrides
  });
  return { container, map };
}

test('renders wrapped XYZ tiles and attribution', async () => {
  const { container, map } = createMap();
  assert.equal(map.loaded(), false);
  await nextFrame();
  assert.equal(map.loaded(), true);

  assert.equal(container.children.length, 2);
  const tileLayer = container.children[0];
  assert.equal(tileLayer.children.length, 1);
  const genPane = tileLayer.children[0];
  assert.ok(genPane.children.length > 0);
  assert.match(genPane.children[0].src, /^\/tiles\/10\/\d+\/\d+\.png$/);
  assert.equal(container.children[1].innerHTML, 'Test tiles');
  map.destroy();
  assert.equal(map.loaded(), false);
});

test('unchanged frames keep the active pane in place while a pan updates visible tiles', async () => {
  const { container, map } = createMap({ zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];
  const pane = tileLayer.lastChild;
  const initialUrls = new Set(pane.children.map(image => image.src));
  const appendChild = tileLayer.appendChild;
  let paneMoves = 0;
  tileLayer.appendChild = function (child) {
    paneMoves++;
    return appendChild.call(this, child);
  };

  map.resize();
  await nextFrame();
  assert.equal(paneMoves, 0, 'an unchanged frame must not reappend the visible pane');
  map.panBy([10000, 0]);
  await nextFrame();
  assert.equal(tileLayer.lastChild, pane);
  assert.ok(pane.children.some(image => !initialUrls.has(image.src)), 'a new tile grid must still be loaded');
  map.destroy();
});

test('project and unproject round-trip longitude and latitude', () => {
  const { map } = createMap();
  const centerPixel = map.project([12.491, 48.63]);
  almostEqual(centerPixel[0], 400);
  almostEqual(centerPixel[1], 300);

  const lonLat = map.unproject(centerPixel);
  almostEqual(lonLat[0], 12.491);
  almostEqual(lonLat[1], 48.63);
  map.destroy();
});

test('bearing and pitch keep camera math, markers and lifecycle events aligned', async () => {
  const { container, map } = createMap({ center: [0, 0], zoom: 8, bearing: 450, pitch: 75 });
  let rotates = 0;
  let pitches = 0;
  let rotateEnds = 0;
  let pitchEnds = 0;
  map.on('rotate', event => { rotates++; assert.equal(event.bearing, 180); });
  map.on('pitch', event => { pitches++; assert.equal(event.pitch, 30); });
  map.on('rotateend', () => rotateEnds++);
  map.on('pitchend', () => pitchEnds++);

  assert.equal(map.getBearing(), 90, 'initial bearing is normalized');
  assert.equal(map.getPitch(), 60, 'initial pitch is capped by maxPitch');
  const point = [125, 175];
  const lonLat = map.unproject(point);
  const roundTrip = map.project(lonLat);
  almostEqual(roundTrip[0], point[0]);
  almostEqual(roundTrip[1], point[1]);

  const marker = map.addMarker([1, 1]);
  map.setBearing(180);
  map.setPitch(30);
  assert.equal(rotates, 1);
  assert.equal(pitches, 1);
  assert.equal(rotateEnds, 1);
  assert.equal(pitchEnds, 1);
  const markerPixel = map.project([1, 1]);
  assert.equal(marker.element.style.left, markerPixel[0] + 'px');
  assert.equal(marker.element.style.top, markerPixel[1] + 'px');

  const before = map.unproject(point);
  map.setZoom(10, point);
  const after = map.unproject(point);
  almostEqual(after[0], before[0]);
  almostEqual(after[1], before[1]);
  await nextFrame();
  assert.match(container.children[0].style.transform, /scaleY\(.*\).*rotate\(-180deg\)/);
  map.destroy();
});

test('bearing follows MapLibre: bearing 90 puts east at the top', () => {
  const { map } = createMap({ center: [0, 0], zoom: 8, bearing: 90 });
  const center = map.project([0, 0]);
  const north = map.project([0, 0.5]);
  const east = map.project([0.5, 0]);
  assert.ok(north[0] < center[0] - 10 && Math.abs(north[1] - center[1]) < 1e-6, 'north points left');
  assert.ok(east[1] < center[1] - 10 && Math.abs(east[0] - center[0]) < 1e-6, 'east points up');
  map.setBearing(-90);
  assert.equal(map.getBearing(), 270);
  assert.ok(map.project([0, 0.5])[0] > center[0] + 10, 'bearing -90 puts north on the right');
  map.destroy();
});

test('pitch compresses screen vertical after bearing rotates the map', () => {
  const { map } = createMap({ center: [0, 0], zoom: 8, bearing: 61, pitch: 60 });
  const center = map.project([0, 0]);
  const east = map.project([0.5, 0]);
  const horizontal = east[0] - center[0];
  const vertical = east[1] - center[1];
  almostEqual(vertical / horizontal, -Math.tan(61 * Math.PI / 180) * 0.5);
  const roundTrip = map.unproject(east);
  almostEqual(roundTrip[0], 0.5);
  almostEqual(roundTrip[1], 0);
  map.destroy();
});

test('panBy moves the center by screen pixels', () => {
  const { map } = createMap({ center: [0, 0], zoom: 10 });
  map.panBy([256, 0]);
  const center = map.getCenter();
  almostEqual(center[0], 0.3515625);
  almostEqual(center[1], 0);
  map.destroy();
});

test('setZoom preserves the coordinate below the chosen anchor', () => {
  const { map } = createMap({ zoom: 8 });
  const anchor = [125, 175];
  const before = map.unproject(anchor);
  map.setZoom(12, anchor);
  const after = map.unproject(anchor);
  almostEqual(after[0], before[0]);
  almostEqual(after[1], before[1]);
  map.destroy();
});

test('fitBounds keeps both corners inside the padded viewport', () => {
  const { map } = createMap();
  map.fitBounds([12, 48, 13, 49], 30);
  const northWest = map.project([12, 49]);
  const southEast = map.project([13, 48]);

  assert.ok(northWest[0] >= 29.9 && northWest[1] >= 29.9);
  assert.ok(southEast[0] <= 770.1 && southEast[1] <= 570.1);
  assert.ok(map.getZoom() > 8 && map.getZoom() < 11);
  map.destroy();
});

test('fitBounds handles a box crossing the antimeridian', () => {
  const { map } = createMap({ center: [180, 0], zoom: 2 });
  map.fitBounds([170, -10, -170, 10], 20);
  const west = map.project([170, 10]);
  const east = map.project([-170, -10]);
  assert.ok(west[0] >= 19.9 && west[0] < 400);
  assert.ok(east[0] <= 780.1 && east[0] > 400);
  assert.ok(map.getCenter()[0] < -179.999 || map.getCenter()[0] > 179.999);
  map.destroy();
});

test('maxBounds keeps a dateline-crossing region centered on the dateline', () => {
  const { map } = createMap({
    center: [180, 0],
    zoom: 5,
    maxBounds: [170, -10, -170, 10]
  });
  const center = map.getCenter();
  assert.ok(Math.abs(center[0]) > 179.9, `expected a dateline center, got ${center[0]}`);
  assert.ok(Math.abs(center[1]) < 1e-7);
  map.destroy();
});

test('setMaxBounds updates coverage at runtime, supports the dateline, and can be cleared', () => {
  const { map } = createMap({ center: [12.6, 48.7], zoom: 14 });
  let moves = 0;
  map.on('move', () => { moves++; });

  assert.equal(map.setMaxBounds([11.9, 47.9, 12.1, 48.1]), map);
  let center = map.getCenter();
  assert.ok(center[0] <= 12.1 + 1e-7 && center[0] >= 11.9 - 1e-7, `expected clamped longitude, got ${center[0]}`);
  assert.ok(center[1] <= 48.1 + 1e-7 && center[1] >= 47.9 - 1e-7, `expected clamped latitude, got ${center[1]}`);
  assert.ok(moves > 0, 'a clamp that moves the camera must emit move');

  map.setCenter([13, 49]);
  center = map.getCenter();
  assert.ok(center[0] <= 12.1 + 1e-7 && center[1] <= 48.1 + 1e-7, 'the new coverage must constrain later camera changes');
  assert.throws(() => map.setMaxBounds([NaN, 47.9, 12.1, 48.1]), /bounds must contain finite/);

  map.setMaxBounds(null).setCenter([13, 49]);
  almostEqual(map.getCenter()[0], 13);
  almostEqual(map.getCenter()[1], 49);
  map.setZoom(5).setMaxBounds([170, -10, -170, 10]);
  assert.ok(Math.abs(map.getCenter()[0]) > 179.9, `expected dateline center, got ${map.getCenter()[0]}`);
  map.destroy();
});

test('getCameraState exposes a copied, exact camera snapshot', () => {
  const { container, map } = createMap({
    center: [12.5, 48.6], zoom: 7.25, bearing: 30, pitch: 20, tileSize: 512
  });
  const state = map.getCameraState();
  almostEqual(state.center[0], 12.5);
  almostEqual(state.center[1], 48.6);
  assert.equal(state.zoom, 7.25);
  assert.equal(state.bearing, 30);
  assert.equal(state.pitch, 20);
  assert.equal(state.width, 800);
  assert.equal(state.height, 600);
  assert.equal(state.tileSize, 512);
  assert.equal(state.worldSize, 512 * Math.pow(2, 7.25));
  state.center[0] = 0;
  almostEqual(map.getCenter()[0], 12.5);

  container.clientWidth = 640;
  container.clientHeight = 360;
  map.resize();
  almostEqual(map.getCameraState().center[0], 12.5);
  almostEqual(map.getCameraState().center[1], 48.6);
  assert.equal(map.getCameraState().width, 640);
  assert.equal(map.getCameraState().height, 360);
  map.destroy();
});

test('a zero-size container renders after resize', async () => {
  const container = new FakeElement();
  container.clientWidth = 0;
  container.clientHeight = 0;
  const map = microMap(container, { tiles: '/{z}/{x}/{y}.png' });
  await nextFrame();
  assert.equal(container.children[0].children.length, 0);

  container.clientWidth = 320;
  container.clientHeight = 240;
  map.resize();
  await nextFrame();
  assert.ok(container.children[0].children.length > 0);
  map.destroy();
});

test('tiles: false creates a camera-only map for overlays and vector tiles', async () => {
  const { container, map } = createMap({ tiles: false, attribution: null, center: [0, 0], zoom: 4 });
  await nextFrame();
  assert.equal(container.children.length, 1, 'the empty raster pane remains an internal layer only');
  assert.equal(container.children[0].children.length, 0, 'no image tiles are requested');
  assert.deepEqual(map.getCenter().map(value => Math.round(value)), [0, 0]);
  const point = map.project([1, 1]);
  assert.deepEqual(map.unproject(point).map(value => +value.toFixed(7)), [1, 1]);
  map.destroy();
});

test('pointer drag, click and keyboard interaction emit events', () => {
  const { container, map } = createMap();
  let clicks = 0;
  let moves = 0;
  let moveEnds = 0;
  map.on('click', event => {
    clicks++;
    assert.equal(event.lonLat.length, 2);
  });
  map.on('move', () => moves++);
  map.on('moveend', () => moveEnds++);

  container.dispatch('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 7, clientX: 100, clientY: 100 });
  assert.equal(clicks, 1);

  container.dispatch('pointerdown', { pointerId: 8, clientX: 100, clientY: 100 });
  container.dispatch('pointermove', { pointerId: 8, clientX: 130, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 8, clientX: 130, clientY: 100 });
  assert.ok(moves > 0);
  assert.ok(moveEnds > 0);

  const before = map.getCenter()[0];
  container.dispatch('keydown', { key: 'ArrowRight' });
  assert.ok(map.getCenter()[0] > before);
  map.destroy();
});

test('once runs a listener once and off can cancel it through the original listener', () => {
  const { container, map } = createMap();
  const events = [];
  const onceListener = event => events.push(event);

  assert.equal(map.once('click', onceListener), map);
  container.dispatch('pointerdown', { pointerId: 17, clientX: 100, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 17, clientX: 100, clientY: 100 });
  container.dispatch('pointerdown', { pointerId: 18, clientX: 120, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 18, clientX: 120, clientY: 100 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'click');
  assert.equal(events[0].target, map);

  let cancelled = 0;
  function cancelledListener() { cancelled++; }
  map.once('click', cancelledListener).off('click', cancelledListener);
  container.dispatch('pointerdown', { pointerId: 19, clientX: 140, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 19, clientX: 140, clientY: 100 });
  assert.equal(cancelled, 0);
  map.destroy();
});


test('wheel zoom keeps the coordinate below the pointer fixed', () => {
  const { container, map } = createMap({ zoom: 8, zoomAnimation: false });
  const point = [180, 140];
  const before = map.unproject(point);
  container.dispatch('wheel', { clientX: point[0], clientY: point[1], deltaY: -100 });
  const after = map.unproject(point);
  assert.ok(map.getZoom() > 8);
  almostEqual(after[0], before[0]);
  almostEqual(after[1], before[1]);
  map.destroy();
});

test('ctrlKey wheel events (trackpad pinch) use the gentler trackpad zoom rate', () => {
  const a = createMap({ zoom: 8, zoomAnimation: false });
  a.container.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -80, ctrlKey: true });
  const zoomWithCtrl = a.map.getZoom();
  a.map.destroy();

  const b = createMap({ zoom: 8, zoomAnimation: false });
  b.container.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -80 });
  const zoomWithoutCtrl = b.map.getZoom();
  b.map.destroy();

  assert.ok(
    zoomWithCtrl > zoomWithoutCtrl,
    `expected the trackpad rate (${zoomWithCtrl}) to zoom further than the mouse rate (${zoomWithoutCtrl}) for the same raw delta`
  );
});

test('animated wheel zoom eases toward the target zoom over time', async () => {
  const { container, map } = createMap({ zoom: 8 });
  container.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -100 });
  const mid = map.getZoom();
  assert.ok(mid >= 8 && mid < 9);
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.ok(map.getZoom() > 8);
  map.destroy();
});

test('rapid wheel notches glide smoothly without pausing between them', async () => {
  const { container, map } = createMap({ zoom: 8 });
  const samples = [];
  for (let i = 0; i < 5; i++) {
    container.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -100 });
    await new Promise(resolve => setTimeout(resolve, 40));
    samples.push(map.getZoom());
  }
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] >= samples[i - 1] - 1e-9, `zoom must not decrease: ${samples[i - 1]} -> ${samples[i]}`);
  }
  assert.ok(samples[samples.length - 1] > 8);
  map.destroy();
});

test('animated double-click zoom lands exactly one level up, shift zooms out', async () => {
  const { container, map } = createMap({ zoom: 8 });
  container.dispatch('dblclick', { clientX: 400, clientY: 300 });
  await new Promise(resolve => setTimeout(resolve, 350));
  almostEqual(map.getZoom(), 9);

  container.dispatch('dblclick', { clientX: 400, clientY: 300, shiftKey: true });
  await new Promise(resolve => setTimeout(resolve, 350));
  almostEqual(map.getZoom(), 8);
  map.destroy();
});

test('setZoom animates when a duration is given', async () => {
  const { map } = createMap({ zoom: 8 });
  map.setZoom(10, null, 200);
  assert.equal(map.getZoom(), 8);
  await new Promise(resolve => setTimeout(resolve, 260));
  almostEqual(map.getZoom(), 10);
  map.destroy();
});

test('zoomAnimation: false zooms instantly', () => {
  const { container, map } = createMap({ zoom: 8, zoomAnimation: false });
  container.dispatch('dblclick', { clientX: 400, clientY: 300 });
  almostEqual(map.getZoom(), 9);
  map.destroy();
});

test('two pointers perform pinch zoom', () => {
  const { container, map } = createMap({ center: [0, 0], zoom: 8, zoomSnap: 0.5 });
  container.dispatch('pointerdown', { pointerId: 1, clientX: 250, clientY: 300 });
  container.dispatch('pointerdown', { pointerId: 2, clientX: 550, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 2, clientX: 600, clientY: 300 });
  assert.equal(map.getZoom(), 8.5, 'pinch zoom honours zoomSnap');
  container.dispatch('pointerup', { pointerId: 1, clientX: 200, clientY: 300 });
  container.dispatch('pointerup', { pointerId: 2, clientX: 600, clientY: 300 });
  map.destroy();
});

test('supports TMS and subdomain placeholders', async () => {
  const { container, map } = createMap({
    center: [0, 0],
    zoom: 2,
    tiles: 'https://{s}.example.test/{z}/{x}/{y}/{-y}.png',
    subdomains: 'ab'
  });
  await nextFrame();
  const src = container.children[0].children[0].children[0].src;
  assert.match(src, /^https:\/\/[ab]\.example\.test\/2\/\d+\/\d+\/\d+\.png$/);
  map.destroy();
});

test('destroy removes generated DOM and restores container state', async () => {
  const container = new FakeElement();
  container.style.cssText = 'height:300px';
  container.setAttribute('aria-label', 'Existing label');
  const map = microMap(container, { tiles: '/{z}/{x}/{y}.png' });
  await nextFrame();
  assert.ok(container.children.length > 0);

  map.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(container.style.cssText, 'height:300px');
  assert.equal(container.getAttribute('aria-label'), 'Existing label');
});


test('generated minified build executes as CommonJS', async () => {
  const minifiedPath = path.resolve(__dirname, '..', 'lib', 'microMap.min.js');
  delete require.cache[minifiedPath];
  const minifiedMicroMap = require(minifiedPath);
  const container = new FakeElement();
  const map = minifiedMicroMap(container, {
    center: [7.1, 50.7],
    zoom: 9,
    tiles: '/{z}/{x}/{y}.png'
  });
  await nextFrame();
  assert.equal(typeof minifiedMicroMap, 'function');
  assert.ok(container.children[0].children.length > 0);
  const center = map.unproject(map.project([7.1, 50.7]));
  almostEqual(center[0], 7.1);
  almostEqual(center[1], 50.7);
  assert.equal(map.getCameraState().worldSize, 256 * Math.pow(2, 9));
  map.setMaxBounds([7, 50, 7.2, 51]).setCenter([8, 52]);
  assert.ok(map.getCenter()[0] <= 7.2 + 1e-7);
  let onceCount = 0;
  map.once('click', () => onceCount++);
  container.dispatch('pointerdown', { pointerId: 27, clientX: 200, clientY: 180 });
  container.dispatch('pointerup', { pointerId: 27, clientX: 200, clientY: 180 });
  container.dispatch('pointerdown', { pointerId: 28, clientX: 200, clientY: 180 });
  container.dispatch('pointerup', { pointerId: 28, clientX: 200, clientY: 180 });
  assert.equal(onceCount, 1);
  map.destroy();
});

test('previous zoom level tiles stay visible until the new level finishes loading', async () => {
  const { container, map } = createMap({ zoom: 5, zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];
  assert.equal(tileLayer.children.length, 1);

  map.setZoom(6);
  await nextFrame();
  assert.equal(tileLayer.children.length, 2, 'old zoom tiles must not be removed immediately');

  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tileLayer.children.length, 2, 'old tiles must remain while the current pane is still loading');

  const currentPane = tileLayer.children[tileLayer.children.length - 1];
  for (const image of currentPane.children) image.dispatch('load');
  await nextFrame();
  assert.equal(tileLayer.children.length, 1, 'stale tiles are pruned once the current pane has settled');
  map.destroy();
});

test('keeps one fallback zoom pane while current tiles are slow or fail', async () => {
  const { container, map } = createMap({ zoom: 5, zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];

  map.setZoom(6);
  await nextFrame();
  assert.equal(tileLayer.children.length, 2);

  const fallbackPane = tileLayer.children[0];
  const oldFallbackUrls = new Set(fallbackPane.children.map(image => image.src));
  map.panBy([10000, 0]);
  await nextFrame();
  assert.ok(
    fallbackPane.children.some(image => !oldFallbackUrls.has(image.src)),
    'the lower-resolution fallback must follow a pan while current tiles are pending'
  );

  // The former 1 s deadline removed the fallback here even though the new
  // tile images had not settled, which left an empty grey map.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(tileLayer.children.length, 2, 'a slow current pane must keep the lower-resolution fallback');

  const currentPane = tileLayer.children[tileLayer.children.length - 1];
  for (const image of currentPane.children) image.dispatch('error');
  await nextFrame();
  assert.equal(tileLayer.children.length, 2, 'a failed current pane must not remove the fallback');
  assert.equal(currentPane.children[0].style.visibility, 'hidden');
  map.destroy();
});

test('offscreen pending tiles no longer hold a zoom fallback open', async () => {
  const { container, map } = createMap({ zoom: 5, zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];
  for (const image of tileLayer.lastChild.children.slice()) image.dispatch('load');

  map.setZoom(6);
  await nextFrame();
  assert.equal(tileLayer.children.length, 2);
  const pending = tileLayer.lastChild.children.slice();
  map.panBy([10000, 0]);
  await nextFrame();
  assert.ok(pending.some(image => !image.parentNode), 'the old viewport must have offscreen requests');
  for (const image of tileLayer.lastChild.children.slice()) image.dispatch('load');
  await nextFrame();
  assert.equal(tileLayer.children.length, 1, 'settled visible tiles should release the fallback');
  map.destroy();
});

test('a failed tile keeps its fallback only while its area is visible', async () => {
  const { container, map } = createMap({ zoom: 5, zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];
  for (const image of tileLayer.lastChild.children.slice()) image.dispatch('load');

  map.setZoom(6);
  await nextFrame();
  for (const image of tileLayer.lastChild.children.slice()) image.dispatch('error');
  assert.equal(tileLayer.children.length, 2, 'failed visible tiles need the fallback');

  map.panBy([10000, 0]);
  await nextFrame();
  for (const image of tileLayer.lastChild.children.slice()) image.dispatch('load');
  await nextFrame();
  assert.equal(tileLayer.children.length, 1, 'failed tiles outside the viewport should release the fallback');
  map.destroy();
});

test('a higher-resolution fallback follows a pan while a lower target zoom is pending', async () => {
  const { container, map } = createMap({ zoom: 6, zoomAnimation: false });
  await nextFrame();
  const tileLayer = container.children[0];

  map.setZoom(5);
  await nextFrame();
  assert.equal(tileLayer.children.length, 2);
  const fallbackPane = tileLayer.children[0];
  const oldFallbackUrls = new Set(fallbackPane.children.map(image => image.src));

  map.panBy([10000, 0]);
  await nextFrame();
  assert.ok(
    fallbackPane.children.some(image => !oldFallbackUrls.has(image.src)),
    'the higher-resolution fallback must cover a panned viewport until lower zoom tiles settle'
  );
  map.destroy();
});

test('setTiles replaces the source and reports tile lifecycle events', async () => {
  const { container, map } = createMap({ zoom: 5, zoomAnimation: false });
  await nextFrame();
  const oldImage = container.children[0].children[0].children[0];
  const changes = [];
  const loads = [];
  const errors = [];
  map.on('tileschange', event => changes.push(event.tiles));
  map.on('tileload', event => loads.push(event));
  map.on('tileerror', event => errors.push(event));

  map.setTiles('/offline/{z}/{x}/{y}.webp', { crossOrigin: 'anonymous' });
  await nextFrame();
  const currentImage = container.children[0].children[0].children[0];
  assert.match(currentImage.src, /^\/offline\/5\/\d+\/\d+\.webp$/);
  assert.equal(currentImage.crossOrigin, 'anonymous');
  assert.deepEqual(changes, ['/offline/{z}/{x}/{y}.webp']);

  oldImage.dispatch('load');
  currentImage.dispatch('load');
  assert.equal(loads.length, 1, 'stale source requests must not emit tileload');
  assert.match(loads[0].url, /^\/offline\/5\/\d+\/\d+\.webp$/);

  const failed = currentImage.parentNode.children[1];
  failed.dispatch('error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].url, /^\/offline\/5\/\d+\/\d+\.webp$/);
  assert.throws(() => map.setTiles(null), /tiles must be a URL template/);
  map.destroy();
});

test('preloads an offscreen ring in the requested direction and reuses it when it becomes visible', async () => {
  const requests = [];
  const createdAt = createdElements.length;
  const { map } = createMap({
    center: [0, 0],
    zoom: 5,
    tileBuffer: 0,
    tiles: (z, x, y) => {
      const url = `/preload/${z}/${x}/${y}.png`;
      requests.push({ z, x, y, url });
      return url;
    },
    preload: {
      around: 1,
      direction: { bearing: 90, distance: 2, width: 0 },
      maxTiles: 4,
      delay: 0
    }
  });
  await flushPreloadTimers();

  const speculative = preloadImagesSince(createdAt).filter(image => image.src);
  assert.equal(speculative.length, 2, 'background work is limited to two in-flight image requests');
  assert.ok(
    requests.findIndex(request => request.url === speculative[0].src) > 0,
    'all visible requests are issued before speculative work starts'
  );
  assert.match(speculative[0].src, /^\/preload\/5\/18\/16\.png$/, '90 degrees preloads east of the viewport');
  assert.match(speculative[1].src, /^\/preload\/5\/13\/13\.png$/, 'around adds an outer tile ring');

  speculative[0].dispatch('load');
  const directionalUrl = speculative[0].src;
  const beforePan = requests.filter(request => request.url === directionalUrl).length;
  map.panBy([512, 0]);
  await nextFrame();
  assert.ok(speculative[0].parentNode, 'a loaded preload is adopted by the visible tile pane');
  assert.equal(
    requests.filter(request => request.url === directionalUrl).length,
    beforePan,
    'adopting a preload does not issue a duplicate foreground request'
  );
  map.destroy();
});

test('preload zoom offsets warm a bounded additional detail level', async () => {
  const createdAt = createdElements.length;
  const { map } = createMap({
    center: [0, 0],
    zoom: 5,
    tileBuffer: 0,
    tiles: '/zoom-preload/{z}/{x}/{y}.png',
    preload: { zoom: 1, maxTiles: 3, delay: 0 }
  });
  await flushPreloadTimers();
  const speculative = preloadImagesSince(createdAt);
  assert.equal(speculative.length, 2);
  assert.ok(speculative.every(image => /\/zoom-preload\/6\//.test(image.src)));
  assert.deepEqual(map.getPreload().zoom, [1]);

  map.preload({ zoom: -1, maxTiles: 2, delay: 0 });
  await flushPreloadTimers();
  const lower = preloadImagesSince(createdAt).filter(image => /\/zoom-preload\/4\//.test(image.src));
  assert.ok(lower.length > 0, 'preload(options) is the short form for replacing the policy');
  assert.deepEqual(map.getPreload().zoom, [-1]);
  map.destroy();
});

test('navigation state drives forward preloads and follows only when explicitly requested', async () => {
  const createdAt = createdElements.length;
  const { map } = createMap({
    center: [0, 0],
    zoom: 16,
    tileBuffer: 0,
    tiles: '/nav/{z}/{x}/{y}.png',
    preload: { maxTiles: 4, delay: 0 }
  });
  let navigationEvent = undefined;
  map.on('navigationchange', event => { navigationEvent = event.navigation; });
  map.setNavigation({ position: [12, 48], heading: 90, speed: 30, lookAhead: 30 });
  assert.ok(Math.abs(map.getCenter()[0]) < 1e-7, 'navigation position is a preload focus, not implicit camera follow');
  assert.deepEqual(map.getNavigation(), {
    position: [12, 48], heading: 90, speed: 30, lookAhead: 30, follow: false
  });
  assert.deepEqual(navigationEvent, map.getNavigation());

  await flushPreloadTimers();
  const speculative = preloadImagesSince(createdAt);
  const navigationTileX = Math.floor((12 + 180) / 360 * Math.pow(2, 16));
  assert.ok(speculative.some(image => {
    const match = image.src.match(/^\/nav\/16\/(\d+)\//);
    return match && +match[1] > navigationTileX;
  }), 'heading, speed and lookAhead select tiles ahead of the reported position');

  map.setNavigation({ position: [13, 48], follow: true });
  almostEqual(map.getCenter()[0], 13);
  assert.equal(map.getNavigation().follow, true);
  map.setNavigation(null);
  assert.equal(map.getNavigation(), null);
  assert.equal(navigationEvent, null);
  map.destroy();
});

test('accepts initial application navigation state without implicitly following it', () => {
  const { map } = createMap({
    center: [0, 0],
    navigation: { position: [12, 48], heading: 45, speed: 8, lookAhead: 12 }
  });
  assert.deepEqual(map.getNavigation(), {
    position: [12, 48], heading: 45, speed: 8, lookAhead: 12, follow: false
  });
  assert.ok(Math.abs(map.getCenter()[0]) < 1e-7);
  map.destroy();
});

test('source changes and destroy cancel delayed preload work', async () => {
  const createdAt = createdElements.length;
  const { map } = createMap({
    center: [0, 0],
    zoom: 5,
    tileBuffer: 0,
    tiles: '/old/{z}/{x}/{y}.png',
    preload: { around: 1, maxTiles: 4, delay: 25 }
  });
  await nextFrame();
  map.setTiles('/new/{z}/{x}/{y}.png');
  await new Promise(resolve => setTimeout(resolve, 50));
  const speculative = preloadImagesSince(createdAt).filter(image => image.src);
  assert.ok(speculative.length > 0);
  assert.ok(speculative.every(image => /^\/new\//.test(image.src)), 'old-source preload timers and cache entries are invalidated');

  const countBeforeDestroy = preloadImagesSince(createdAt).length;
  map.destroy();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(preloadImagesSince(createdAt).length, countBeforeDestroy, 'destroy prevents queued speculative requests');
});

test('maxBounds keeps the center within the padded box', () => {
  const { map } = createMap({
    center: [12, 48],
    zoom: 12,
    maxBounds: [11.9, 47.9, 12.1, 48.1]
  });
  map.panBy([100000, 0]);
  const center = map.getCenter();
  assert.ok(center[0] <= 12.1 + 1e-6);
  map.destroy();
});

test('resize emits dimensions and keeps markers aligned to the resized viewport', () => {
  const { container, map } = createMap({ center: [0, 0], zoom: 10 });
  const marker = map.addMarker([0, 0]);
  let resizeEvent = null;
  map.on('resize', event => { resizeEvent = event; });
  assert.equal(marker.element.style.left, '400px');

  container.clientWidth = 1000;
  map.resize();

  assert.equal(marker.element.style.left, '500px');
  assert.deepEqual(resizeEvent.size, [1000, 600]);
  assert.deepEqual(resizeEvent.oldSize, [800, 600]);
  map.destroy();
});

test('zoomSnap rounds zoom changes to the configured step', () => {
  const { map } = createMap({ zoom: 8, zoomSnap: 0.5 });
  map.setZoom(8.7);
  almostEqual(map.getZoom(), 8.5);
  map.setView([12.6, 48.7], 8.7);
  almostEqual(map.getZoom(), 8.5);
  map.fitBounds([12.48, 48.62, 12.50, 48.64]);
  almostEqual(map.getZoom() * 2, Math.round(map.getZoom() * 2));
  map.destroy();
});

test('dragging: false disables panning but keeps click detection', () => {
  const { container, map } = createMap({ dragging: false });
  const before = map.getCenter();
  container.dispatch('pointerdown', { pointerId: 3, clientX: 100, clientY: 100 });
  container.dispatch('pointermove', { pointerId: 3, clientX: 200, clientY: 100 });
  container.dispatch('pointerup', { pointerId: 3, clientX: 200, clientY: 100 });
  const after = map.getCenter();
  almostEqual(after[0], before[0]);
  almostEqual(after[1], before[1]);
  map.destroy();
});

test('scrollWheelZoom: false ignores wheel input', () => {
  const { container, map } = createMap({ zoom: 8, scrollWheelZoom: false });
  container.dispatch('wheel', { clientX: 100, clientY: 100, deltaY: -100 });
  assert.equal(map.getZoom(), 8);
  map.destroy();
});

test('contextmenu emits an event with the clicked coordinate', () => {
  const { container, map } = createMap();
  let received = null;
  map.on('contextmenu', event => { received = event; });
  container.dispatch('contextmenu', { clientX: 50, clientY: 50 });
  assert.ok(received);
  assert.equal(received.lonLat.length, 2);
  map.destroy();
});

test('openMenu renders items and clicking one calls onClick and closes the menu', () => {
  const { container, map } = createMap();
  let clicked = null;
  const handle = map.openMenu([10, 20], [
    { label: 'Foo', onClick: () => { clicked = 'foo'; } },
    '-',
    { label: 'Bar', disabled: true, onClick: () => { clicked = 'bar'; } }
  ]);

  assert.ok(container.children.includes(handle.element), 'menu element must be attached to the container');
  const buttons = handle.element.children.filter(c => c.tagName === 'BUTTON');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].textContent, 'Foo');
  assert.equal(buttons[1].disabled, true);
  assert.equal(handle.element.getAttribute('aria-label'), 'Map actions');
  assert.equal(document.activeElement, buttons[0], 'the first active menu item receives focus');

  buttons[0].dispatch('click');
  assert.equal(clicked, 'foo');
  assert.equal(handle.element.parentNode, null, 'menu must close after a normal item click');
  assert.equal(document.activeElement, container, 'closing a focused menu returns focus to the map');
  map.destroy();
});

test('keyboard and wheel gestures on an interactive overlay do not control the map', () => {
  const { container, map } = createMap({ zoom: 8, zoomAnimation: false });
  const button = new FakeElement('button');
  map.addMarker([12.491, 48.63], { element: button, interactive: true });
  const center = map.getCenter();

  container.dispatch('keydown', { target: button, key: 'ArrowRight' });
  container.dispatch('wheel', { target: button, clientX: 400, clientY: 300, deltaY: -100 });
  assert.deepEqual(map.getCenter(), center);
  assert.equal(map.getZoom(), 8);
  map.destroy();
});

test('openMenu closes on outside click, Escape, and map move', () => {
  const { container, map } = createMap();

  let handle = map.openMenu([0, 0], [{ label: 'A', onClick: () => {} }]);
  document.dispatch('pointerdown', { target: container });
  assert.equal(handle.element.parentNode, null, 'outside pointerdown must close the menu');

  handle = map.openMenu([0, 0], [{ label: 'A', onClick: () => {} }]);
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(handle.element.parentNode, null, 'Escape must close the menu');

  handle = map.openMenu([0, 0], [{ label: 'A', onClick: () => {} }]);
  map.panBy([50, 0]);
  assert.equal(handle.element.parentNode, null, 'a map move must close the menu');

  map.destroy();
});

test('an item with keepOpen:true keeps the menu open after being clicked', () => {
  const { map } = createMap();
  const handle = map.openMenu([0, 0], [{ label: 'Stay', keepOpen: true, onClick: () => {} }]);
  const button = handle.element.children[0];
  button.dispatch('click');
  assert.equal(handle.element.parentNode, map.getContainer());
  map.destroy();
});

test('options.contextMenu builds and opens a menu automatically on right-click', () => {
  const { container, map } = createMap({
    contextMenu: event => [{ label: 'At ' + event.lonLat[0].toFixed(2), onClick: () => {} }]
  });
  container.dispatch('contextmenu', { clientX: 40, clientY: 30 });
  const menu = container.children.find(c => c.attributes && c.attributes.role === 'menu');
  assert.ok(menu, 'contextMenu builder must open a menu on right-click');
  map.destroy();
});

test('shift+drag draws a box and emits boxselect with bounds and size on release, without panning', () => {
  const { container, map } = createMap({ center: [0, 0], zoom: 10 });
  const before = map.getCenter();
  let received = null;
  map.on('boxselect', event => { received = event; });

  container.dispatch('pointerdown', { pointerId: 9, clientX: 100, clientY: 100, shiftKey: true });
  container.dispatch('pointermove', { pointerId: 9, clientX: 200, clientY: 180, shiftKey: true });
  container.dispatch('pointerup', { pointerId: 9, clientX: 200, clientY: 180, shiftKey: true });

  assert.ok(received, 'boxselect must fire');
  assert.equal(received.bounds.length, 4);
  assert.ok(received.widthMeters > 0);
  assert.ok(received.heightMeters > 0);
  assert.equal(received.areaM2, received.widthMeters * received.heightMeters);
  const after = map.getCenter();
  assert.equal(after[0], before[0], 'a box-select drag must not pan the map');
  assert.equal(after[1], before[1]);
  map.destroy();
});

test('boxZoom: true fits the map to the selected box', () => {
  const { container, map } = createMap({ center: [0, 0], zoom: 2, boxZoom: true });
  container.dispatch('pointerdown', { pointerId: 3, clientX: 100, clientY: 100, shiftKey: true });
  container.dispatch('pointermove', { pointerId: 3, clientX: 700, clientY: 500, shiftKey: true });
  container.dispatch('pointerup', { pointerId: 3, clientX: 700, clientY: 500, shiftKey: true });
  assert.ok(map.getZoom() > 2, 'boxZoom must zoom in to fit the selected area');
  map.destroy();
});

test('a tiny shift+click does not emit boxselect', () => {
  const { container, map } = createMap();
  let fired = false;
  map.on('boxselect', () => { fired = true; });
  container.dispatch('pointerdown', { pointerId: 4, clientX: 100, clientY: 100, shiftKey: true });
  container.dispatch('pointerup', { pointerId: 4, clientX: 101, clientY: 100, shiftKey: true });
  assert.equal(fired, false);
  map.destroy();
});

test('Escape cancels an in-progress box selection', () => {
  const { container, map } = createMap();
  let fired = false;
  map.on('boxselect', () => { fired = true; });
  container.dispatch('pointerdown', { pointerId: 5, clientX: 50, clientY: 50, shiftKey: true });
  container.dispatch('pointermove', { pointerId: 5, clientX: 150, clientY: 150, shiftKey: true });
  container.dispatch('keydown', { key: 'Escape' });
  container.dispatch('pointerup', { pointerId: 5, clientX: 150, clientY: 150, shiftKey: true });
  assert.equal(fired, false, 'a cancelled box must not emit boxselect on the later pointerup');
  map.destroy();
});

test('pointercancel aborts box selection and releases its pointer capture', () => {
  const { container, map } = createMap();
  let fired = false;
  map.on('boxselect', () => { fired = true; });
  container.dispatch('pointerdown', { pointerId: 15, clientX: 50, clientY: 50, shiftKey: true });
  container.dispatch('pointermove', { pointerId: 15, clientX: 150, clientY: 150, shiftKey: true });
  container.dispatch('pointercancel', { pointerId: 15, clientX: 150, clientY: 150 });
  assert.equal(fired, false);
  assert.equal(container.releasedPointerId, 15);
  assert.equal(container.style.cursor, 'grab');
  map.destroy();
});

test('boxSelect: false disables the shift+drag gesture entirely', () => {
  const { container, map } = createMap({ boxSelect: false, center: [0, 0], zoom: 10 });
  const before = map.getCenter();
  let fired = false;
  map.on('boxselect', () => { fired = true; });
  container.dispatch('pointerdown', { pointerId: 6, clientX: 100, clientY: 100, shiftKey: true });
  container.dispatch('pointermove', { pointerId: 6, clientX: 200, clientY: 180, shiftKey: true });
  container.dispatch('pointerup', { pointerId: 6, clientX: 200, clientY: 180, shiftKey: true });
  assert.equal(fired, false);
  const after = map.getCenter();
  assert.notEqual(after[0], before[0], 'with boxSelect disabled, shift+drag should pan like a normal drag');
  map.destroy();
});

test('addMarker positions an element and updates it on move', () => {
  const { map } = createMap({ center: [0, 0], zoom: 10 });
  const marker = map.addMarker([0, 0], { anchor: [6, 6] });
  const expected = map.project([0, 0]);
  assert.equal(marker.element.style.left, (expected[0] - 6) + 'px');
  assert.equal(marker.element.style.top, (expected[1] - 6) + 'px');
  assert.equal(marker.element.style.zIndex, '3', 'markers must remain above the optional vector canvas');

  marker.setLonLat([0.01, 0]);
  const moved = map.project([0.01, 0]);
  assert.equal(marker.element.style.left, (moved[0] - 6) + 'px');

  marker.remove();
  assert.equal(marker.element.parentNode, null);
  map.destroy();
});

test('addRoute draws a camera-aligned SVG overlay and cleans it up', () => {
  const { container, map } = createMap({ center: [12.491, 48.63], zoom: 12, bearing: 25, pitch: 20 });
  const coordinates = [[12.48, 48.625], [12.491, 48.63], [12.505, 48.637]];
  const route = map.addRoute(coordinates, { color: '#123456', width: 7, dashArray: '4 2' });
  const line = route.element.children[1];
  const before = line.getAttribute('d');

  assert.match(before, /^M/);
  assert.equal(line.getAttribute('stroke'), '#123456');
  assert.equal(line.getAttribute('stroke-width'), '7');
  assert.equal(line.getAttribute('stroke-dasharray'), '4 2');
  assert.deepEqual(route.getCoordinates(), coordinates);

  map.setBearing(90).setPitch(35);
  assert.notEqual(line.getAttribute('d'), before, 'route pixels use the shared bearing/pitch camera transform');
  route.setCoordinates([[12.49, 48.63], [12.5, 48.64]]).setStyle({ color: '#ff00aa', outlineWidth: 0 });
  assert.equal(line.getAttribute('stroke'), '#ff00aa');
  assert.deepEqual(route.getCoordinates(), [[12.49, 48.63], [12.5, 48.64]]);

  route.remove();
  assert.equal(route.element.parentNode, null);
  assert.ok(!container.children.includes(route.element));
  assert.throws(() => map.addRoute([[12.49, 48.63]]), /at least two/);
  map.destroy();
  assert.equal(map.addRoute(coordinates), null);
});

test('invalid numeric options are bounded and invalid zoom durations resolve immediately', async () => {
  const { container, map } = createMap({ tileBuffer: Infinity, zoom: 8 });
  await nextFrame();
  const pane = container.children[0].children[0];
  assert.ok(pane.children.length < 500, 'an invalid tile buffer must not generate an unbounded tile grid');
  map.setZoom(9, null, -100);
  assert.equal(map.getZoom(), 9);
  map.setZoom(Infinity);
  assert.equal(map.getZoom(), 9);
  map.destroy();
});

test('destroy releases tile DOM and prevents new overlays or menus from being attached', async () => {
  const { container, map } = createMap();
  await nextFrame();
  const tileLayer = container.children[0];
  map.destroy();
  assert.equal(tileLayer.children.length, 0);
  assert.equal(map.addMarker([0, 0]), null);
  assert.equal(map.addRoute([[0, 0], [0.01, 0.01]]), null);
  assert.equal(map.openMenu([0, 0], [{ label: 'Nope' }]), null);
  assert.equal(container.children.length, 0);
});

test('destroy emits a lifecycle event so optional layers can release their DOM', () => {
  const { map } = createMap();
  let destroyed = 0;
  map.on('destroy', () => destroyed++);
  map.destroy();
  assert.equal(destroyed, 1);
});

test('distribution stays below the sixteen-kilobyte gzip budget', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const minified = fs.readFileSync(path.join(projectRoot, 'lib/microMap.min.js'));
  const gzipped = zlib.gzipSync(minified, { level: 9 });
  assert.ok(gzipped.length < 16384, `gzip size is ${gzipped.length} bytes`);

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies, undefined);
});

test.after(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test('right-drag and Ctrl-drag rotate and tilt; a plain right-click still opens the menu', async () => {
  const { container, map } = createMap({ contextMenu: () => [{ label: 'Here', onClick() {} }] });
  const center = map.getCenter();
  let menus = 0;
  map.on('contextmenu', () => menus++);
  container.dispatch('pointerdown', { pointerId: 3, button: 2, clientX: 400, clientY: 300 });
  // macOS: contextmenu arrives while the button is still down.
  container.dispatch('contextmenu', { clientX: 400, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 3, button: 2, clientX: 450, clientY: 260 });
  container.dispatch('pointerup', { pointerId: 3, button: 2, clientX: 450, clientY: 260 });
  almostEqual(map.getBearing(), 40);
  almostEqual(map.getPitch(), 20);
  assert.deepEqual(map.getCenter(), center, 'rotating does not pan');
  // Windows: contextmenu after the release of a rotation is dropped too.
  container.dispatch('contextmenu', { clientX: 450, clientY: 260 });
  assert.equal(menus, 0);

  container.dispatch('pointerdown', { pointerId: 4, button: 2, clientX: 400, clientY: 300 });
  container.dispatch('contextmenu', { clientX: 400, clientY: 300 });
  container.dispatch('pointerup', { pointerId: 4, button: 2, clientX: 400, clientY: 300 });
  assert.equal(menus, 1, 'a right-click without movement opens the context menu on release');

  container.dispatch('pointerdown', { pointerId: 5, button: 0, ctrlKey: true, clientX: 400, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 5, button: 0, ctrlKey: true, clientX: 375, clientY: 300 });
  container.dispatch('pointerup', { pointerId: 5, button: 0, ctrlKey: true, clientX: 375, clientY: 300 });
  almostEqual(map.getBearing(), 20);
  assert.deepEqual(map.getCenter(), center);

  map.dragRotate.disable();
  assert.equal(map.dragRotate.isEnabled(), false);
  container.dispatch('pointerdown', { pointerId: 6, button: 2, clientX: 400, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 6, button: 2, clientX: 500, clientY: 300 });
  container.dispatch('pointerup', { pointerId: 6, button: 2, clientX: 500, clientY: 300 });
  almostEqual(map.getBearing(), 20);
  map.destroy();
});

test('a small leftover bearing snaps back to north after a rotation', async () => {
  const { container, map } = createMap();
  container.dispatch('pointerdown', { pointerId: 3, button: 2, clientX: 400, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 3, button: 2, clientX: 406, clientY: 300 });
  container.dispatch('pointerup', { pointerId: 3, button: 2, clientX: 406, clientY: 300 });
  almostEqual(map.getBearing(), 4.8);
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(map.getBearing(), 0);
  map.destroy();
});

test('Shift+arrow keys rotate and tilt with a short animation', async () => {
  const { container, map } = createMap();
  const center = map.getCenter();
  container.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  container.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
  await new Promise(resolve => setTimeout(resolve, 380));
  almostEqual(map.getBearing(), 15);
  almostEqual(map.getPitch(), 10);
  assert.deepEqual(map.getCenter(), center, 'Shift+arrows do not pan');
  map.destroy();
});

test('two fingers twist to rotate and move up together to tilt', () => {
  const { container, map } = createMap();
  // Twist: the second finger circles around the first by about 30 degrees.
  container.dispatch('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
  container.dispatch('pointerdown', { pointerId: 2, clientX: 500, clientY: 300 });
  container.dispatch('pointermove', { pointerId: 2, clientX: 473.2, clientY: 400 });
  container.dispatch('pointerup', { pointerId: 2, clientX: 473.2, clientY: 400 });
  container.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 300 });
  const twisted = map.getBearing() > 180 ? map.getBearing() - 360 : map.getBearing();
  assert.ok(twisted < -15 && twisted > -25, 'a clockwise twist rotates past the 10 degree threshold: ' + twisted);

  map.setBearing(0);
  container.dispatch('pointerdown', { pointerId: 3, clientX: 300, clientY: 400 });
  container.dispatch('pointerdown', { pointerId: 4, clientX: 500, clientY: 400 });
  // Touch moves arrive interleaved, a few pixels at a time.
  for (let y = 390; y >= 340; y -= 10) {
    container.dispatch('pointermove', { pointerId: 3, clientX: 300, clientY: y });
    container.dispatch('pointermove', { pointerId: 4, clientX: 500, clientY: y });
  }
  assert.ok(map.getPitch() > 20, 'moving two side-by-side fingers up tilts the map: ' + map.getPitch());
  container.dispatch('pointerup', { pointerId: 3, clientX: 300, clientY: 340 });
  container.dispatch('pointerup', { pointerId: 4, clientX: 500, clientY: 340 });

  map.setPitch(0);
  map.touchPitch.disable();
  map.touchZoomRotate.disableRotation();
  assert.equal(map.touchZoomRotate.isRotationEnabled(), false);
  container.dispatch('pointerdown', { pointerId: 5, clientX: 300, clientY: 400 });
  container.dispatch('pointerdown', { pointerId: 6, clientX: 500, clientY: 400 });
  for (let y = 390; y >= 340; y -= 10) {
    container.dispatch('pointermove', { pointerId: 5, clientX: 300, clientY: y });
    container.dispatch('pointermove', { pointerId: 6, clientX: 500, clientY: y });
  }
  assert.equal(map.getPitch(), 0, 'a disabled touchPitch does not tilt');
  map.destroy();
});
