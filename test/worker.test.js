'use strict';

// Worker decoding: protocol round trip with real structured cloning and
// transfer, main-thread fallback when a worker fails, and the shared
// worker's lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.clientWidth = 256;
    this.clientHeight = 256;
    if (this.tagName === 'CANVAS') this.context = new Proxy({ measureText: text => ({ width: String(text).length * 6 }) }, {
      get: (target, key) => key in target ? target[key] : () => {},
      set: (target, key, value) => { target[key] = value; return true; }
    });
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

class FakeWorker {
  constructor(url, options) {
    if (FakeWorker.blocked) throw new Error('blocked by CSP');
    this.url = url;
    this.options = options;
    this.listeners = Object.create(null);
    this.posted = 0;
    this.terminated = false;
    FakeWorker.created.push(this);
  }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  dispatch(type, event) { for (const handler of this.listeners[type] || []) handler(event); }
  postMessage(data) {
    this.posted++;
    const request = structuredClone(data);
    setTimeout(() => {
      if (FakeWorker.crash) {
        this.dispatch('error', {});
        return;
      }
      const reply = microMapVector.workerMessage(request);
      this.dispatch('message', { data: structuredClone(reply.message, { transfer: reply.transfer }) });
    }, 1);
  }
  terminate() { this.terminated = true; }
}
FakeWorker.created = [];

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio', 'Worker']) saved[name] = global[name];
global.document = { querySelector() { return null; }, createElement: tagName => new FakeElement(tagName), addEventListener() {}, removeEventListener() {} };
global.getComputedStyle = () => ({ position: 'relative' });
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.devicePixelRatio = 1;
global.Worker = FakeWorker;

const microMap = require('../lib/microMap.js');
const microMapVector = require('../lib/microMap.vector.js');

test.after(() => { for (const name in saved) global[name] = saved[name]; });

function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function varint(value) {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(value ? next + 128 : next); } while (value);
  return Uint8Array.from(bytes);
}
const field = (number, wire, value) => concat([varint(number * 8 + wire), value]);
const bytesField = (number, value) => field(number, 2, concat([varint(value.length), value]));
const stringField = (number, value) => bytesField(number, Uint8Array.from(Buffer.from(value, 'utf8')));
const packedField = (number, values) => bytesField(number, concat(values.map(varint)));

// A road across the tile and a square, with an id and a property each.
const data = concat([bytesField(3, concat([
  stringField(1, 'shapes'),
  bytesField(2, concat([field(1, 0, varint(7)), packedField(2, [0, 0]), field(3, 0, varint(2)), packedField(4, [9, 0, 4096, 10, 8192, 0])])),
  bytesField(2, concat([field(1, 0, varint(8)), packedField(2, [0, 1]), field(3, 0, varint(3)), packedField(4, [9, 2048, 2048, 26, 2048, 0, 0, 2048, 2047, 0, 15])])),
  stringField(3, 'kind'),
  bytesField(4, stringField(1, 'road')),
  bytesField(4, stringField(1, 'area')),
  field(5, 0, varint(4096)),
  field(15, 0, varint(2))
]))]);
const arrayBuffer = () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const wait = (milliseconds = 40) => new Promise(resolve => setTimeout(resolve, milliseconds));
const style = [
  { id: 'areas', type: 'fill', sourceLayer: 'shapes', paint: { color: '#abc' } },
  { id: 'roads', type: 'line', sourceLayer: 'shapes', paint: { color: '#123', width: 4 } }
];

function setup(workerOption) {
  const container = new FakeElement();
  const map = microMap(container, { tiles: false, center: [0, 0], zoom: 0, zoomAnimation: false });
  const loads = [];
  const layer = microMapVector(map, {
    tiles: '/{z}/{x}/{y}.mvt', tileBuffer: 0, style, worker: workerOption,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(arrayBuffer()) })
  });
  layer.on('tileload', event => loads.push(event));
  return { map, layer, loads };
}

test('decodes tiles in a shared worker with transferred typed arrays', async () => {
  FakeWorker.created = [];
  const first = setup('/static/microMap.vector.min.js');
  const second = setup('/static/microMap.vector.min.js');
  await wait();
  assert.equal(FakeWorker.created.length, 1, 'layers share one worker per script URL');
  const worker = FakeWorker.created[0];
  assert.equal(worker.url, '/static/microMap.vector.min.js');
  assert.equal(worker.options.name, 'micromap-vector-decoder');
  assert.ok(worker.posted >= 2);
  assert.ok(first.loads.length && second.loads.length);
  // Worker-decoded features keep the public shape and render/query alike.
  const roads = first.layer.queryRenderedFeatures([128, 128], { layers: ['roads'], radius: 8 });
  assert.equal(roads.length, 1);
  assert.equal(roads[0].id, 7);
  assert.equal(roads[0].properties.kind, 'road');
  const areas = first.layer.queryRenderedFeatures([96, 96], { layers: ['areas'] });
  assert.equal(areas[0].properties.kind, 'area');
  assert.equal(areas[0].geometry.type, 'Polygon');
  first.layer.destroy();
  assert.equal(worker.terminated, false, 'the worker stays while another layer uses it');
  second.layer.destroy();
  assert.equal(worker.terminated, true);
  first.map.destroy();
  second.map.destroy();
});

test('the worker message reproduces decodeMVT exactly', () => {
  const reply = microMapVector.workerMessage({ id: 3, buffer: arrayBuffer(), limits: {} });
  assert.equal(reply.message.id, 3);
  assert.ok(reply.transfer.length >= 5 && reply.transfer.every(buffer => buffer instanceof ArrayBuffer));
  const [layer] = reply.message.layers;
  const direct = microMapVector.decodeMVT(data).layers[0];
  assert.deepEqual(Array.from(layer.coords), Array.from(direct.coords));
  assert.deepEqual(layer.ids, [7, 8]);
  assert.deepEqual(Array.from(layer.types), [2, 3]);
  const failure = microMapVector.workerMessage({ id: 4, buffer: new Uint8Array([0x1a, 0x05]).buffer });
  assert.equal(failure.message.id, 4);
  assert.match(failure.message.error, /invalid protobuf length|truncated/);
});

test('falls back to main-thread decoding when the worker fails or is blocked', async () => {
  FakeWorker.created = [];
  FakeWorker.crash = true;
  const crashed = setup('/crash/microMap.vector.js');
  await wait();
  FakeWorker.crash = false;
  assert.equal(FakeWorker.created.length, 1);
  assert.equal(FakeWorker.created[0].terminated, true, 'a failing worker is stopped');
  assert.ok(crashed.loads.length, 'pending jobs are decoded on the main thread');
  crashed.layer.destroy();
  crashed.map.destroy();

  FakeWorker.blocked = true;
  const blocked = setup('/blocked/microMap.vector.js');
  await wait();
  FakeWorker.blocked = false;
  assert.ok(blocked.loads.length, 'a worker blocked at construction falls back too');
  blocked.layer.destroy();
  blocked.map.destroy();

  FakeWorker.created = [];
  const inline = setup(false);
  await wait();
  assert.equal(FakeWorker.created.length, 0, 'worker: false decodes inline');
  assert.ok(inline.loads.length);
  inline.layer.destroy();
  inline.map.destroy();
});
