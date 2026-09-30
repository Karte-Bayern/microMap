'use strict';

// microMap.ui (markers, popups, tooltips, controls), compose layer events and
// the camera's flyTo, on a small DOM with real event bubbling, so "dragging a
// marker does not pan the map" is actually exercised.
const test = require('node:test');
const assert = require('node:assert/strict');

class ClassList {
  constructor() { this.names = []; }
  add(name) { if (!this.names.includes(name)) this.names.push(name); }
  remove(name) { this.names = this.names.filter(entry => entry !== name); }
  contains(name) { return this.names.includes(name); }
  toggle(name, force) { const on = force == null ? !this.contains(name) : force; if (on) this.add(name); else this.remove(name); return on; }
  set(value) { this.names = String(value).split(/\s+/).filter(Boolean); }
  toString() { return this.names.join(' '); }
}

class FakeEvent {
  constructor(type, init) {
    Object.assign(this, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: 0, clientY: 0, key: '' }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

class Node {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: '' };
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.classList = new ClassList();
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set(value); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }
  removeChild(child) { const index = this.children.indexOf(child); if (index > -1) this.children.splice(index, 1); child.parentNode = null; return child; }
  replaceChild(next, old) { const index = this.children.indexOf(old); this.children[index] = next; next.parentNode = this; old.parentNode = null; return old; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener(type, listener) { (this.listeners[type] || (this.listeners[type] = [])).push(listener); }
  removeEventListener(type, listener) { const list = this.listeners[type] || []; const index = list.indexOf(listener); if (index > -1) list.splice(index, 1); }
  dispatch(type, init) {
    const event = new FakeEvent(type, init);
    event.target = this;
    for (let node = this; node && !event.stopped; node = node.parentNode) {
      for (const listener of (node.listeners[type] || []).slice()) {
        if (typeof listener === 'function') listener.call(node, event);
        else listener.handleEvent(event);
      }
    }
    return event;
  }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() {
    return new Proxy({}, { get: (target, key) => key in target ? target[key] : () => ({ width: 10 }), set: (target, key, value) => { target[key] = value; return true; } });
  }
}

const documentNode = {
  activeElement: null,
  createElement(tag) { return new Node(tag, documentNode); },
  createElementNS(namespace, tag) { return new Node(tag, documentNode); },
  createTextNode(value) { return { nodeType: 3, textContent: String(value), parentNode: null }; },
  addEventListener() {},
  removeEventListener() {}
};
documentNode.head = new Node('head', documentNode);

const saved = {};
for (const name of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio', 'matchMedia', 'navigator']) saved[name] = Object.getOwnPropertyDescriptor(global, name);
global.document = documentNode;
global.getComputedStyle = () => ({ position: 'relative' });
global.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 4);
global.cancelAnimationFrame = clearTimeout;
global.devicePixelRatio = 1;

const microMap = require('../lib/microMap.js');
const microMapCamera = require('../lib/microMap.camera.js');
const microMapCompose = require('../lib/microMap.compose.js');
const ui = require('../lib/microMap.ui.js');

test.after(() => {
  for (const name in saved) {
    if (saved[name]) Object.defineProperty(global, name, saved[name]);
    else delete global[name];
  }
});

const wait = (milliseconds = 30) => new Promise(resolve => setTimeout(resolve, milliseconds));

function createMap(options = {}) {
  const container = new Node('div', documentNode);
  container.clientWidth = 400;
  container.clientHeight = 300;
  const map = microMap(container, { tiles: false, center: [11, 48], zoom: 10, zoomAnimation: false, ...options });
  return { container, map };
}

function translate(element) {
  const match = /translate\((-?\d+)px,(-?\d+)px\)/.exec(element.style.transform);
  return match ? [+match[1], +match[2]] : null;
}

function click(container, x, y) {
  container.dispatch('pointerdown', { pointerId: 9, clientX: x, clientY: y });
  container.dispatch('pointerup', { pointerId: 9, clientX: x, clientY: y });
}

test('MapLibre-style markers anchor, offset, follow the camera and report LngLat', () => {
  const { container, map } = createMap();
  const pin = new ui.Marker({ color: '#dc2626' }).setLngLat([11, 48]).addTo(map);
  const element = pin.getElement();
  assert.equal(element.parentNode, container);
  assert.ok(element.classList.contains('micromap-marker'));
  assert.match(element.style.transform, /translate\(200px,150px\) translate\(-50%,-100%\)/, 'the default pin is anchored at its tip');
  assert.equal(element.getAttribute('aria-label'), 'Map marker');
  assert.deepEqual(pin.getLngLat().toArray(), [11, 48]);

  const custom = new Node('button', documentNode);
  custom.textContent = '3';
  const stop = new ui.Marker({ element: custom, offset: [4, -6] }).setLngLat({ lng: 11, lat: 48 }).addTo(map);
  assert.match(custom.style.transform, /translate\(204px,144px\) translate\(-50%,-50%\)/, 'custom elements default to the centre');
  assert.equal(custom.getAttribute('aria-label'), null, 'an application element keeps its own accessible text');

  map.panBy([20, 10]);
  assert.deepEqual(translate(element), [180, 140], 'markers follow the camera');
  const rotated = new ui.Marker({ rotation: 10, rotationAlignment: 'map' }).setLngLat([11, 48]).addTo(map);
  map.setBearing(30);
  assert.match(rotated.getElement().style.transform, /rotate\(40deg\)/);
  stop.remove();
  assert.equal(custom.parentNode, null);
  map.destroy();
  assert.equal(element.parentNode, null, 'markers leave with the map');
});

test('Leaflet factories take [lat, lng]', () => {
  const { map } = createMap();
  const marker = ui.marker([48.1, 11.5]).addTo(map);
  assert.deepEqual(marker.getLngLat().toArray(), [11.5, 48.1]);
  assert.deepEqual(marker.getLatLng(), { lat: 48.1, lng: 11.5 });
  assert.equal(marker.getElement().getAttribute('tabindex'), '0', 'Leaflet markers are keyboard reachable');
  assert.throws(() => new ui.Marker().setLngLat([NaN, 1]), /finite longitude and latitude/);
  map.destroy();
});

test('dragging a marker moves only the marker and fires drag events', () => {
  const { container, map } = createMap();
  const marker = new ui.Marker({ draggable: true }).setLngLat([11, 48]).addTo(map);
  const element = marker.getElement();
  const events = [];
  marker.on('dragstart', () => events.push('dragstart')).on('drag', () => events.push('drag')).on('dragend', event => events.push('dragend:' + (event.target === marker)));
  const before = map.getCenter();
  element.dispatch('pointerdown', { pointerId: 3, clientX: 200, clientY: 150 });
  element.dispatch('pointermove', { pointerId: 3, clientX: 201, clientY: 150 });
  assert.deepEqual(events, [], 'a tiny move stays a click');
  element.dispatch('pointermove', { pointerId: 3, clientX: 230, clientY: 170 });
  element.dispatch('pointerup', { pointerId: 3, clientX: 230, clientY: 170 });
  assert.deepEqual(events, ['dragstart', 'drag', 'dragend:true']);
  assert.deepEqual(map.getCenter(), before, 'the map did not pan');
  const moved = map.project(marker.getLngLat().toArray());
  assert.ok(Math.abs(moved[0] - 230) < 1e-6 && Math.abs(moved[1] - 170) < 1e-6);
  let clicks = 0;
  marker.on('click', () => clicks++);
  element.dispatch('click');
  assert.equal(clicks, 0, 'the click after a drag is swallowed');
  element.dispatch('click');
  assert.equal(clicks, 1);
  // Keyboard: arrow keys move draggable markers by 5px.
  element.dispatch('keydown', { key: 'ArrowLeft' });
  assert.ok(Math.abs(map.project(marker.getLngLat().toArray())[0] - 225) < 1e-6);
  assert.equal(events[events.length - 1], 'dragend:true');
  assert.ok(container.contains(element));
  map.destroy();
});

test('popups: content, close button, Escape, map click and automatic anchor', () => {
  const { container, map } = createMap();
  const opened = [];
  const popup = new ui.Popup({ offset: 10, maxWidth: '200px' }).setLngLat([11, 48]).setHTML('<b>Bäckerei</b>');
  popup.on('open', () => opened.push('open')).on('close', () => opened.push('close'));
  popup.addTo(map);
  const element = popup.getElement();
  assert.equal(element.parentNode, container);
  assert.ok(element.classList.contains('micromap-popup-anchor-bottom'));
  assert.match(element.style.transform, /translate\(200px,140px\) translate\(-50%,-100%\)/, 'offset 10 lifts a bottom-anchored popup');
  assert.equal(element.style.maxWidth, '200px');
  const body = element.children[1];
  const close = body.children[0];
  assert.equal(close.getAttribute('aria-label'), 'Close popup');
  assert.equal(body.children[1].innerHTML, '<b>Bäckerei</b>');
  assert.equal(documentNode.activeElement, close, 'focus moves into the popup');
  close.dispatch('click');
  assert.equal(popup.isOpen(), false);
  popup.addTo(map);
  element.dispatch('keydown', { key: 'Escape' });
  assert.equal(popup.isOpen(), false);
  popup.setText('Plain').addTo(map);
  assert.equal(element.children[1].children[1].textContent, 'Plain');
  click(container, 50, 50);
  assert.equal(popup.isOpen(), false, 'a map click closes the popup');
  assert.deepEqual(opened, ['open', 'close', 'open', 'close', 'open', 'close']);

  // A popup opened from a map click handler survives that click.
  const second = new ui.Popup().setText('From click');
  map.on('click', event => second.setLngLat(event.lonLat).addTo(map));
  click(container, 100, 100);
  assert.equal(second.isOpen(), true);

  // Near the top edge the popup opens below the point.
  const edge = new ui.Popup({ closeButton: false });
  edge._build();
  edge.getElement().offsetWidth = 120;
  edge.getElement().offsetHeight = 80;
  edge.setLngLat(map.unproject([300, 20])).addTo(map);
  assert.ok(edge.getElement().classList.contains('micromap-popup-anchor-top'));
  map.destroy();
});

test('marker popups toggle, follow the pin and use Leaflet autoClose', () => {
  const { container, map } = createMap();
  const popup = new ui.Popup().setText('Stop 1');
  const marker = new ui.Marker().setLngLat([11, 48]).setPopup(popup).addTo(map);
  assert.equal(marker.getElement().getAttribute('role'), 'button');
  marker.getElement().dispatch('click');
  assert.equal(popup.isOpen(), true);
  assert.match(popup.getElement().style.transform, /translate\(200px,112px\)/, 'the popup opens above the pin head');
  marker.getElement().dispatch('keydown', { key: 'Enter' });
  assert.equal(popup.isOpen(), false, 'Enter toggles the popup');

  const first = ui.marker([48, 11]).bindPopup('First').addTo(map).openPopup();
  const secondMarker = ui.marker([48.01, 11.01]).bindPopup(source => 'Second at ' + source.getLatLng().lat.toFixed(2)).addTo(map);
  secondMarker.openPopup();
  assert.equal(first.isPopupOpen(), false, 'Leaflet popups close the previous one');
  assert.equal(secondMarker.getPopup().getElement().children[1].children[1].innerHTML, 'Second at 48.01');
  secondMarker.closePopup();
  assert.equal(secondMarker.isPopupOpen(), false);
  assert.ok(container.children.length > 0);
  map.destroy();
});

test('tooltips show on hover and focus, or permanently', () => {
  const { map } = createMap();
  const hover = ui.marker([48, 11]).bindTooltip('Hover me', { direction: 'top' }).addTo(map);
  const element = hover.getElement();
  assert.equal(hover.isTooltipOpen(), false);
  element.dispatch('pointerenter');
  assert.equal(hover.isTooltipOpen(), true);
  const tooltip = hover.getTooltip().getElement();
  assert.equal(tooltip.getAttribute('role'), 'tooltip');
  assert.equal(element.getAttribute('aria-describedby'), tooltip.id);
  assert.ok(tooltip.classList.contains('micromap-popup-anchor-bottom'), 'direction top opens above the point');
  element.dispatch('pointerleave');
  assert.equal(hover.isTooltipOpen(), false);
  element.dispatch('focus');
  assert.equal(hover.isTooltipOpen(), true);
  const permanent = ui.marker([48, 11.01]).bindTooltip('Always', { permanent: true }).addTo(map);
  assert.equal(permanent.isTooltipOpen(), true);
  map.destroy();
});

test('Leaflet icons anchor in pixels; layer groups manage markers', () => {
  const { map } = createMap();
  const icon = ui.icon({ iconUrl: '/pin.png', iconSize: [20, 30], iconAnchor: [10, 30], popupAnchor: [0, -28] });
  const marker = ui.marker([48, 11], { icon }).addTo(map);
  const image = marker.getElement();
  assert.equal(image.tagName, 'IMG');
  assert.equal(image.src, '/pin.png');
  assert.deepEqual(translate(image), [190, 120]);
  const div = ui.marker([48, 11], { icon: ui.divIcon({ html: '<span>7</span>', className: 'stop' }) }).addTo(map);
  assert.equal(div.getElement().innerHTML, '<span>7</span>');
  assert.deepEqual(translate(div.getElement()), [194, 144], 'divIcon defaults to 12x12 around its centre');
  const group = ui.layerGroup([ui.marker([48.2, 11.1]), ui.marker([47.9, 10.9])]).addTo(map);
  assert.equal(group.getLayers().length, 2);
  assert.deepEqual(group.getBounds(), [10.9, 47.9, 11.1, 48.2]);
  group.clearLayers();
  assert.equal(group.getLayers().length, 0);
  map.destroy();
});

test('controls: positions, navigation, scale and removal', () => {
  const { container, map } = createMap({ maxZoom: 11 });
  const navigation = new ui.NavigationControl();
  ui.addControl(map, navigation);
  const corner = container.children.find(node => node.classList.contains('micromap-ctrl-top-right'));
  assert.ok(corner && corner.contains(navigation.getContainer()), 'MapLibre controls default to top-right');
  const [zoomIn, zoomOut, compass] = navigation.getContainer().children;
  assert.equal(zoomIn.getAttribute('aria-label'), 'Zoom in');
  zoomIn.dispatch('click');
  assert.equal(map.getZoom(), 11);
  assert.equal(zoomIn.disabled, true, 'zoom in is disabled at maxZoom');
  assert.equal(zoomOut.disabled, false);
  map.setBearing(45);
  assert.match(compass.children[0].style.transform, /rotate\(-45deg\)/);
  compass.dispatch('click');
  assert.equal(map.getBearing(), 0, 'the compass resets north');

  const scale = new ui.ScaleControl({ maxWidth: 100, unit: 'metric' });
  const leafletScale = ui.control.scale();
  ui.addControl(map, scale, 'bottom-left');
  leafletScale.addTo(map);
  const [bar] = scale.getContainer().children;
  assert.match(bar.textContent, /^\d+(\.\d+)? (m|km)$/);
  assert.ok(parseInt(bar.style.width, 10) <= 100 && parseInt(bar.style.width, 10) >= 40);
  assert.equal(leafletScale.getContainer().children.length, 2, 'Leaflet shows metric and imperial');
  assert.match(leafletScale.getContainer().children[1].textContent, / (ft|mi)$/);
  const bottomLeft = container.children.find(node => node.classList.contains('micromap-ctrl-bottom-left'));
  assert.equal(bottomLeft.children[0], leafletScale.getContainer(), 'new bottom controls stack above older ones');

  let removed = 0;
  const custom = new ui.Control({ onAdd: () => new Node('div', documentNode), onRemove: () => removed++, position: 'topleft' });
  custom.addTo(map);
  assert.equal(ui.hasControl(map, custom), true);
  custom.remove();
  assert.equal(removed, 1);
  assert.equal(ui.hasControl(map, custom), false);
  assert.throws(() => ui.addControl(map, {}), /needs onAdd/);
  map.destroy();
  assert.ok(!container.children.some(node => node.classList.contains('micromap-ctrl-corner')), 'corners leave with the map');
});

test('attribution is sanitized, compact on small maps and extensible', () => {
  const { map } = createMap();
  const attribution = new ui.AttributionControl({
    customAttribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" onclick="steal()">OSM</a> <script>bad()</script><img src=x onerror=bad()> <a href="javascript:alert(1)">x</a> &copy; 2026'
  });
  ui.addControl(map, attribution);
  const inner = attribution.getContainer().children[1];
  assert.equal(inner.innerHTML, '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OSM</a> bad() <a rel="noopener noreferrer">x</a> &copy; 2026');
  assert.ok(!attribution.getContainer().classList.contains('micromap-ctrl-attrib-full'), 'a 400px map uses the compact form');
  attribution.addAttribution('Luftbild <strong>LDBV</strong>');
  assert.match(inner.innerHTML, /\| Luftbild <strong>LDBV<\/strong>$/);
  assert.equal(ui.sanitizeHTML('<a href=\'https://a.b/?x=1&y=2\' title="t">l</a>'), '<a href="https://a.b/?x=1&amp;y=2" title="t" rel="noopener noreferrer">l</a>');
  assert.equal(ui.sanitizeHTML('a < b > c <!-- x -->'), 'a &lt; b &gt; c ');
  map.destroy();
});

test('geolocation only on request, with events, dot and permission errors', async () => {
  const { container, map } = createMap();
  const requests = [];
  let deny = false;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      geolocation: {
        getCurrentPosition(success, failure, options) {
          requests.push(options);
          setTimeout(() => deny ? failure({ code: 1, message: 'denied' }) : success({ coords: { longitude: 12, latitude: 48.5, accuracy: 30 }, timestamp: 1 }), 1);
        },
        watchPosition(success) { requests.push('watch'); setTimeout(() => success({ coords: { longitude: 12.1, latitude: 48.6, accuracy: 20 }, timestamp: 2 }), 1); return 7; },
        clearWatch(id) { requests.push('clear:' + id); }
      }
    }
  });
  const locate = new ui.GeolocateControl();
  const found = [];
  locate.on('geolocate', event => found.push(event.coords.longitude)).on('error', event => found.push('error:' + event.code));
  ui.addControl(map, locate);
  assert.equal(requests.length, 0, 'nothing is requested before a click');
  const [buttonNode] = locate.getContainer().children;
  buttonNode.dispatch('click');
  await wait(10);
  assert.deepEqual(found, [12]);
  assert.ok(Math.abs(map.getCenter()[0] - 12) < 1e-9, 'the map moves to the position');
  assert.ok(container.children.some(node => node.classList.contains('micromap-user-location-dot')));
  assert.ok(buttonNode.classList.contains('micromap-ctrl-geolocate-active'));
  deny = true;
  buttonNode.dispatch('click');
  await wait(10);
  assert.equal(found[1], 'error:1');
  assert.equal(buttonNode.disabled, true, 'a refused permission disables the control');

  const tracking = new ui.GeolocateControl({ trackUserLocation: true });
  const states = [];
  tracking.on('trackuserlocationstart', () => states.push('start')).on('trackuserlocationend', () => states.push('end'));
  ui.addControl(map, tracking, 'top-left');
  const trackButton = tracking.getContainer().children[0];
  trackButton.dispatch('click');
  await wait(10);
  assert.equal(trackButton.getAttribute('aria-pressed'), 'true');
  trackButton.dispatch('click');
  assert.deepEqual(states, ['start', 'end']);
  assert.ok(requests.includes('clear:7'));
  map.destroy();

  Object.defineProperty(global, 'navigator', { configurable: true, value: {} });
  const second = createMap();
  const unavailable = new ui.GeolocateControl();
  ui.addControl(second.map, unavailable);
  assert.equal(unavailable.getContainer().children[0].disabled, true);
  second.map.destroy();
});

test('compose: layer events, MapLibre event shapes, cursor and controls', async () => {
  const { container, map } = createMap();
  const canvas = new Node('canvas', documentNode);
  // A stand-in vector layer: features inside a 40px box around the centre.
  const vector = {
    getCanvas: () => canvas,
    getLayer: id => id === 'roads' ? { id } : undefined,
    queryRenderedFeatures(point, options) {
      const inside = Math.abs(point[0] - 200) < 20 && Math.abs(point[1] - 150) < 20;
      return inside && (!options || !options.layers || options.layers.includes('roads')) ? [{ layer: { id: 'roads' }, properties: { name: 'B 11' } }] : [];
    },
    getStyleReport: () => ({ source: 'base', attributions: { base: '<a href="https://www.openstreetmap.org/copyright">OSM</a>', aerial: 'Luftbild LDBV' } }),
    getTileJSON: () => null,
    layers: [{ id: 'roads', source: 'base' }, { id: 'aerial', source: 'aerial', layout: { visibility: 'none' } }],
    getLayers() { return this.layers.map(layer => JSON.parse(JSON.stringify(layer))); },
    setLayoutProperty(id, name, value) { this.layers.find(layer => layer.id === id).layout[name] = value; }
  };
  const originalGetLayer = vector.getLayer;
  vector.getLayer = id => id === 'aerial' ? { id } : originalGetLayer(id);
  const composed = microMapCompose(map, { vectors: [vector], camera: true });
  const log = [];
  composed.on('click', 'roads', event => log.push('click:' + event.features[0].properties.name + ':' + event.lngLat.lng.toFixed(3) + ':' + event.point.x));
  composed.on('mouseenter', 'roads', () => { log.push('enter'); composed.getCanvas().style.cursor = 'pointer'; });
  composed.on('mouseleave', 'roads', () => { log.push('leave'); composed.getCanvas().style.cursor = ''; });
  composed.on('mousemove', event => { if (!log.includes('mapmove')) log.push('mapmove' + (event.lngLat && typeof event.lngLat.lat === 'number' ? '' : ':bad')); });
  composed.on('click', event => { if (event.lngLat && event.point.y === 150) log.push('mapclick'); });

  container.dispatch('pointermove', { clientX: 205, clientY: 150 });
  await wait(20);
  assert.deepEqual(log.slice(0, 2), ['mapmove', 'enter']);
  assert.equal(container.style.cursor, 'pointer', 'getCanvas().style.cursor reaches the container');
  click(container, 205, 150);
  assert.ok(log.includes('click:B 11:' + map.unproject([205, 150])[0].toFixed(3) + ':205'));
  assert.ok(log.includes('mapclick'));
  container.dispatch('pointermove', { clientX: 20, clientY: 20 });
  await wait(20);
  assert.equal(log[log.length - 1], 'leave');
  assert.equal(container.style.cursor, 'grab');
  click(container, 20, 20);
  assert.equal(log.filter(entry => entry.startsWith('click:')).length, 1, 'no layer click away from the layer');

  // Controls through the facade, with the style's attributions.
  const attribution = new ui.AttributionControl({ compact: false });
  composed.addControl(attribution);
  assert.equal(composed.hasControl(attribution), true);
  assert.match(attribution.getContainer().children[1].innerHTML, /openstreetmap\.org\/copyright/);
  assert.doesNotMatch(attribution.getContainer().children[1].innerHTML, /LDBV/, 'hidden layers do not credit their source');
  composed.setLayoutProperty('aerial', 'visibility', 'visible');
  assert.match(attribution.getContainer().children[1].innerHTML, /\| Luftbild LDBV$/, 'showing a layer credits its source at once');
  composed.addControl(new ui.NavigationControl(), 'top-left');
  composed.removeControl(attribution);
  assert.equal(composed.hasControl(attribution), false);

  // Removing the handler stops the layer events.
  composed.off('mouseenter', 'roads');
  container.dispatch('pointermove', { clientX: 205, clientY: 150 });
  await wait(20);
  assert.equal(log.filter(entry => entry === 'enter').length, 1);
  composed.remove();
});

test('flyTo zooms out along the way, lands exactly and ends once', async () => {
  const { map } = createMap({ zoom: 10, maxZoom: 18 });
  const camera = microMapCamera(map);
  let ends = 0;
  let lowest = Infinity;
  map.on('moveend', () => ends++);
  map.on('move', () => { lowest = Math.min(lowest, map.getZoom()); });
  camera.flyTo({ center: [13, 50], zoom: 10, duration: 120, essential: true });
  assert.equal(camera.isEasing(), true);
  await wait(250);
  assert.equal(camera.isEasing(), false);
  assert.deepEqual(map.getCenter().map(value => +value.toFixed(9)), [13, 50]);
  assert.equal(map.getZoom(), 10);
  assert.ok(lowest < 9, 'the flight zooms out between distant places (lowest ' + lowest + ')');
  assert.equal(ends, 1, 'one moveend per animation');

  // easeTo used to end the movement after every frame.
  ends = 0;
  camera.easeTo({ center: [13.1, 50], zoom: 11, bearing: 20, duration: 60 });
  await wait(150);
  assert.equal(ends, 1);
  assert.equal(map.getBearing(), 20);

  // Reduced motion turns a non-essential flight into a jump.
  global.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  ends = 0;
  camera.flyTo({ center: [11, 48], zoom: 9 });
  assert.equal(camera.isEasing(), false);
  assert.deepEqual(map.getCenter().map(value => +value.toFixed(9)), [11, 48]);
  assert.equal(ends, 1);
  camera.flyTo({ center: [12, 48], zoom: 9, essential: true, duration: 40 });
  assert.equal(camera.isEasing(), true, 'essential flights still animate');
  delete global.matchMedia;
  await wait(100);
  camera.flyTo({ center: [11, 48], zoom: 12, animate: false });
  assert.equal(map.getZoom(), 12);
  camera.flyTo({ center: [14, 50], zoom: 12, maxDuration: 1 });
  assert.equal(camera.isEasing(), false, 'maxDuration turns an overly long flight into a jump');
  assert.equal(map.getZoom(), 12);

  // A user gesture cancels a flight.
  camera.flyTo({ center: [11, 48], zoom: 8, duration: 500, essential: true });
  await wait(20);
  map.getContainer().dispatch('pointerdown', { pointerId: 4, clientX: 100, clientY: 100 });
  map.getContainer().dispatch('pointermove', { pointerId: 4, clientX: 140, clientY: 100 });
  assert.equal(camera.isEasing(), false);
  map.getContainer().dispatch('pointerup', { pointerId: 4, clientX: 140, clientY: 100 });
  map.destroy();
});

test('ui distribution has its own package entry and size budget', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const root = path.resolve(__dirname, '..');
  const minified = fs.readFileSync(path.join(root, 'lib/microMap.ui.min.js'));
  assert.ok(zlib.gzipSync(minified, { level: 9 }).length < 16384);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./ui'], './lib/microMap.ui.js');
  assert.ok(packageJson.files.includes('lib'));
  const vm = require('node:vm');
  const sandbox = { microMap: function () {} };
  vm.runInNewContext(minified.toString('utf8'), sandbox);
  assert.equal(typeof sandbox.microMapUI.Marker, 'function', 'the minified bundle runs');
});

test('marker and tooltip positioning avoids unchanged DOM transform writes', () => {
  const { map } = createMap();
  const marker = new ui.Marker().setLngLat([11, 48]).addTo(map);
  const tooltip = new ui.Tooltip().setLngLat([11, 48]).setText('Route').addTo(map);
  for (const item of [marker, tooltip]) {
    const style = item.getElement().style;
    let value = style.transform, writes = 0;
    Object.defineProperty(style, 'transform', { configurable: true, get: () => value, set: next => { value = next.replace(/,/g, ', '); writes++; } });
    item.setLngLat([11, 48]); item.setLngLat([11, 48]);
    assert.equal(writes, 0);
    item.setLngLat([12, 48]); assert.ok(writes > 0);
    const afterMove = writes; item.setLngLat([12, 48]); assert.equal(writes, afterMove);
    style.transform = 'none'; item.setLngLat([12, 48]); assert.notEqual(style.transform, 'none');
  }
  map.destroy();
});
