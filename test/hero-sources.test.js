const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const code = html.slice(html.indexOf('      // ---- Live hero map'), html.indexOf('    }());', html.indexOf('      // ---- Live hero map')));
function harness() {
  const nodes = { '#hero-map': {}, '#map-note': {}, '#hero-source': {} };
  const buttons = ['raster', 'karte-bayern', 'openfreemap'].map(source => ({ dataset: { source }, setAttribute(name, value) { this[name] = value; } }));
  const requests = [], layers = [], bases = [], views = [];
  const map = (_, options) => { const base = { options, destroy() { this.destroyed = true; }, on() {} }; bases.push(base); return base; };
  function compose(base, options) { const view = { base, options, addControl() {}, flyTo() {}, on(event, fn) { this[event] = fn; }, remove() { this.removed = true; base.destroy(); } }; views.push(view); return view; }
  compose.fromStyle = (base, style) => new Promise(resolve => { requests.push({ finish: () => resolve(compose(base, { style })) }); });
  function vector(base, options) { layers.push(options); return {}; }
  function profile() { return { background: '#fff' }; }
  profile.validateTileJSON = () => ({ valid: true });
  function widget() { for (const name of ['setLngLat','setPopup','setDOMContent','addTo']) this[name] = () => this; }
  const ctx = { microMap: map, microMapCompose: compose, microMapVector: vector, microMapKarteBayernBlueStyle: profile, AbortController, Promise,
    $: key => nodes[key], document: { querySelectorAll: () => buttons, createElement: () => ({ append() {} }) },
    window: { microMapVector: vector, microMapUI: { NavigationControl: widget, ScaleControl: widget, Marker: widget, Popup: widget } },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve: data => resolve({ ok: true, json: () => Promise.resolve(data) }), reject })) };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { ctx, nodes, requests, layers, bases, views, buttons };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('hero uses Karte.Bayern TileJSON, style and tile size; errors name selected provider', async () => {
  const h = harness(); h.ctx.select('karte-bayern'); await flush();
  assert.equal(h.requests[0].url, 'https://karte.bayern/tilejson.json');
  h.requests[0].resolve({ tiles: ['https://karte.bayern/tiles/{z}/{x}/{y}.mvt'], minzoom: 5, maxzoom: 14 }); await flush();
  assert.equal(h.bases.at(-1).options.tileSize, 256);
  assert.equal(h.layers[0].maxZoom, 14);
  assert.equal(h.layers[0].tiles, 'https://karte.bayern/tiles/{z}/{x}/{y}.mvt');
  assert.match(h.nodes['#map-note'].textContent, /^Karte.Bayern vector/);
  h.views.at(-1).tileerror(); assert.match(h.nodes['#map-note'].textContent, /^Karte.Bayern tiles could not/);
});
test('hero aborts obsolete source fetches and disposes late OpenFreeMap views', async () => {
  const h = harness(); h.ctx.select('openfreemap'); await flush();
  assert.equal(h.requests[0].url, 'https://tiles.openfreemap.org/styles/liberty');
  assert.equal(h.bases.at(-1).options.tileSize, 512);
  h.requests[0].resolve({ layers: [] }); await flush();
  h.ctx.select('raster'); assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[1].finish(); await flush();
  assert.equal(h.views.at(-1).removed, true);
  assert.match(h.nodes['#map-note'].textContent, /^OpenStreetMap raster/);
});
test('hero keeps provider failures visible without switching sources', async () => {
  const h = harness(); h.ctx.select('karte-bayern'); await flush();
  h.requests[0].reject(new Error('CORS')); await flush();
  assert.deepEqual(h.buttons.map(button => button['aria-pressed']), ['false', 'true', 'false']);
  assert.match(h.nodes['#map-note'].textContent, /Karte.Bayern could not be loaded/);
});

test('source buttons switch directly and expose exactly one active source', async () => {
  const h = harness();
  for (const button of h.buttons) {
    button.onclick(); await flush();
    assert.equal(button['aria-pressed'], 'true');
    assert.equal(h.buttons.filter(item => item['aria-pressed'] === 'true').length, 1);
  }
});
