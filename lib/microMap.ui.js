/*! microMap.ui.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapUI = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  // Markers, popups, tooltips and controls around a microMap: the classes
  // follow MapLibre (new Marker(), setLngLat, addControl), the lower-case
  // factories follow Leaflet (marker([lat, lng]), bindPopup, control.zoom).
  // Everything targets a core map or a microMap.compose facade.

  // Interface text, keyed like MapLibre's locale; override per page or pass
  // `locale` in a control's or popup's options.
  var locale = {
    'Marker.Title': 'Map marker',
    'Popup.Close': 'Close popup',
    'NavigationControl.ZoomIn': 'Zoom in',
    'NavigationControl.ZoomOut': 'Zoom out',
    'NavigationControl.ResetBearing': 'Reset bearing to north',
    'GeolocateControl.FindMyLocation': 'Find my location',
    'GeolocateControl.LocationNotAvailable': 'Location not available',
    'CoordinateControl.Empty': 'Click the map to inspect coordinates',
    'CoordinateControl.Copy': 'Copy coordinates',
    'CoordinateControl.Copied': 'Coordinates copied',
    'CoordinateControl.CopyFailed': 'Could not copy coordinates',
    'AttributionControl.ToggleAttribution': 'Toggle attribution',
    'ScaleControl.Meters': 'm',
    'ScaleControl.Kilometers': 'km',
    'ScaleControl.Feet': 'ft',
    'ScaleControl.Miles': 'mi',
    'ScaleControl.NauticalMiles': 'nm'
  };

  var ANCHORS = {
    center: [-50, -50], top: [-50, 0], bottom: [-50, -100], left: [0, -50], right: [-100, -50],
    'top-left': [0, 0], 'top-right': [-100, 0], 'bottom-left': [0, -100], 'bottom-right': [-100, -100]
  };
  var SVG = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function finite(value, fallback) { value = +value; return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function text(key, options) { return options && options.locale && options.locale[key] || locale[key]; }
  function doc() { return root.document; }
  function isNode(value) { return !!value && typeof value === 'object' && typeof value.nodeType === 'number'; }

  function element(tag, className, parent) {
    var node = doc().createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function svg(tag, attributes, parent) {
    var node = doc().createElementNS(SVG, tag);
    for (var key in attributes) node.setAttribute(key, attributes[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function classes(node, names, add) {
    String(names || '').split(/\s+/).forEach(function (name) {
      if (name) node.classList[add === false ? 'remove' : 'add'](name);
    });
  }

  function pointValue(value) {
    if (value == null) return [0, 0];
    var point = Array.isArray(value) ? [+value[0], +value[1]] : [+value.x, +value.y];
    return [finite(point[0], 0), finite(point[1], 0)];
  }

  // MapLibre order ([lng, lat] or {lng, lat}) and Leaflet order ([lat, lng]).
  function lngLatValue(value) {
    var lng = Array.isArray(value) ? +value[0] : value && +(value.lng != null ? value.lng : value.lon);
    var lat = Array.isArray(value) ? +value[1] : value && +value.lat;
    if (!isFinite(lng) || !isFinite(lat)) throw new Error('microMap.ui: coordinates need a finite longitude and latitude');
    return [lng, clamp(lat, -90, 90)];
  }

  function latLngValue(value) {
    return lngLatValue(Array.isArray(value) ? [value[1], value[0]] : value);
  }

  function lngLatObject(pair) {
    return { lng: pair[0], lat: pair[1], toArray: function () { return [pair[0], pair[1]]; } };
  }

  // ---- Stylesheet ------------------------------------------------------------
  // Injected once per document, before the page's own styles, so applications
  // can restyle every class. Set microMapUI.styles = false to skip it.
  var CSS = [
    '[data-micromap-theme="dark"]{--micromap-ui-surface:#20313c;--micromap-ui-text:#e9f2f4;--micromap-ui-border:#526973;--micromap-ui-accent:#83b9ff;--micromap-ui-hover:#344b56;--micromap-ui-backdrop:rgba(32,49,60,.9)}',
    '.micromap-marker{position:absolute;left:0;top:0;z-index:3;will-change:transform}',
    '.micromap-marker-pin{cursor:pointer;line-height:0}',
    '.micromap-marker-draggable{cursor:grab;touch-action:none}',
    '.micromap-marker-dragging{cursor:grabbing}',
    '.micromap-marker:focus-visible{outline:2px solid var(--micromap-ui-accent,#1769e0);outline-offset:2px}',
    '.micromap-div-icon{background:var(--micromap-ui-surface,#fff);border:1px solid var(--micromap-ui-border,#666);box-sizing:border-box}',
    '.micromap-popup{position:absolute;left:0;top:0;z-index:4;display:flex;pointer-events:none;will-change:transform}',
    '.micromap-popup-content{position:relative;pointer-events:auto;background:var(--micromap-ui-surface,#fff);color:var(--micromap-ui-text,#222);border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.28);padding:10px 12px;font:13px/1.4 system-ui,sans-serif;overflow-wrap:anywhere}',
    '.micromap-popup-has-close .micromap-popup-content{padding-right:28px}',
    '.micromap-popup-close{position:absolute;top:0;right:0;border:0;border-radius:0 6px 0 0;background:transparent;color:inherit;cursor:pointer;font:18px/1 sans-serif;padding:4px 8px}',
    '.micromap-popup-close:hover{background:var(--micromap-ui-hover,rgba(0,0,0,.06))}',
    '.micromap-popup-tip{flex:none;width:0;height:0;border:8px solid transparent}',
    '.micromap-popup-anchor-top,.micromap-popup-anchor-top-left,.micromap-popup-anchor-top-right{flex-direction:column}',
    '.micromap-popup-anchor-bottom,.micromap-popup-anchor-bottom-left,.micromap-popup-anchor-bottom-right{flex-direction:column-reverse}',
    '.micromap-popup-anchor-left{flex-direction:row}',
    '.micromap-popup-anchor-right{flex-direction:row-reverse}',
    '.micromap-popup-anchor-top .micromap-popup-tip,.micromap-popup-anchor-bottom .micromap-popup-tip,.micromap-popup-anchor-left .micromap-popup-tip,.micromap-popup-anchor-right .micromap-popup-tip{align-self:center}',
    '.micromap-popup-anchor-top-left .micromap-popup-tip,.micromap-popup-anchor-bottom-left .micromap-popup-tip{align-self:flex-start}',
    '.micromap-popup-anchor-top-right .micromap-popup-tip,.micromap-popup-anchor-bottom-right .micromap-popup-tip{align-self:flex-end}',
    '.micromap-popup-anchor-top .micromap-popup-tip,.micromap-popup-anchor-top-left .micromap-popup-tip,.micromap-popup-anchor-top-right .micromap-popup-tip{border-top:none;border-bottom-color:var(--micromap-ui-surface,#fff)}',
    '.micromap-popup-anchor-bottom .micromap-popup-tip,.micromap-popup-anchor-bottom-left .micromap-popup-tip,.micromap-popup-anchor-bottom-right .micromap-popup-tip{border-bottom:none;border-top-color:var(--micromap-ui-surface,#fff)}',
    '.micromap-popup-anchor-left .micromap-popup-tip{border-left:none;border-right-color:var(--micromap-ui-surface,#fff)}',
    '.micromap-popup-anchor-right .micromap-popup-tip{border-right:none;border-left-color:var(--micromap-ui-surface,#fff)}',
    '.micromap-popup-anchor-center .micromap-popup-tip{display:none}',
    '.micromap-tooltip .micromap-popup-content{pointer-events:none;padding:4px 8px;font-size:12px;white-space:nowrap}',
    '.micromap-tooltip .micromap-popup-tip{border-width:6px}',
    '.micromap-ctrl-corner{position:absolute;z-index:5;display:flex;flex-direction:column;gap:10px;padding:10px;pointer-events:none}',
    '.micromap-ctrl-top-left{top:0;left:0;align-items:flex-start}',
    '.micromap-ctrl-top-right{top:0;right:0;align-items:flex-end}',
    '.micromap-ctrl-bottom-left{bottom:0;left:0;align-items:flex-start}',
    '.micromap-ctrl-bottom-right{bottom:0;right:0;align-items:flex-end}',
    '.micromap-ctrl-corner>*{pointer-events:auto}',
    '.micromap-ctrl-group{background:var(--micromap-ui-surface,#fff);border-radius:4px;box-shadow:0 0 0 2px rgba(0,0,0,.1);overflow:hidden}',
    '.micromap-ctrl-group button{display:block;width:29px;height:29px;padding:0;border:0;background:transparent;color:var(--micromap-ui-text,#333);font:bold 18px/29px system-ui,sans-serif;cursor:pointer}',
    '.micromap-ctrl-group button+button{border-top:1px solid var(--micromap-ui-border,#ddd)}',
    '.micromap-ctrl-group button:hover:not(:disabled){background:var(--micromap-ui-hover,rgba(0,0,0,.05))}',
    '.micromap-ctrl-group button:disabled{opacity:.35;cursor:default}',
    '.micromap-ctrl-group button:focus-visible{outline:2px solid var(--micromap-ui-accent,#1769e0);outline-offset:-2px}',
    '.micromap-ctrl-group svg{display:block;margin:auto}',
    '.micromap-ctrl-geolocate-waiting svg{animation:micromap-pulse 1s infinite alternate}',
    '.micromap-ctrl-geolocate-active{color:var(--micromap-ui-accent,#1769e0)!important}',
    '.micromap-ctrl-geolocate-background{color:#6f8fb8!important}',
    '.micromap-ctrl-geolocate-error{color:#c62828!important}',
    '.micromap-ctrl-scale{box-sizing:border-box;border:2px solid var(--micromap-ui-text,#333);border-top:none;background:var(--micromap-ui-backdrop,rgba(255,255,255,.75));color:var(--micromap-ui-text,#333);font:10px/1.5 system-ui,sans-serif;padding:0 5px;white-space:nowrap}',
    '.micromap-ctrl-attrib{max-width:calc(100% - 20px);background:var(--micromap-ui-backdrop,rgba(255,255,255,.82));color:var(--micromap-ui-text,#333);font:11px/1.45 system-ui,sans-serif;padding:0 6px;border-radius:4px}',
    '.micromap-ctrl-attrib summary{cursor:pointer;list-style:none;font-weight:bold;padding:1px 0}',
    '.micromap-ctrl-attrib summary::-webkit-details-marker{display:none}',
    '.micromap-ctrl-attrib-full summary{display:none}',
    '.micromap-ctrl-attrib a{color:inherit}',
    '.micromap-user-location-dot{width:16px;height:16px;box-sizing:border-box;border-radius:50%;background:var(--micromap-ui-accent,#1769e0);border:2px solid var(--micromap-ui-surface,#fff);box-shadow:0 0 3px rgba(0,0,0,.35)}',
    '.micromap-user-location-accuracy{position:absolute;left:0;top:0;z-index:2;box-sizing:border-box;border-radius:50%;background:rgba(23,105,224,.15);border:1px solid rgba(23,105,224,.45);pointer-events:none}',
    '@keyframes micromap-pulse{to{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.micromap-ctrl-geolocate-waiting svg{animation:none}}'
  ].join('');

  var styledDocuments = typeof WeakSet === 'function' ? new WeakSet() : null;

  function injectStyles(document) {
    if (api.styles === false || !document || !styledDocuments || styledDocuments.has(document)) return;
    var head = document.head || document.documentElement || document.body;
    if (!head) return;
    var style = document.createElement('style');
    style.setAttribute('data-micromap-ui', '');
    style.textContent = CSS;
    head.insertBefore(style, head.firstChild || null);
    styledDocuments.add(document);
  }

  // ---- Attribution HTML ------------------------------------------------------
  // Attributions can come from remote TileJSON, so they pass an allowlist:
  // a few inline elements, http(s)/mailto links, class and title. Any other
  // tag is dropped (its text stays), comments vanish, stray "<" is escaped.
  var ALLOWED_TAGS = { a: 1, abbr: 1, b: 1, br: 1, em: 1, i: 1, small: 1, span: 1, strong: 1, sup: 1 };

  function escapeAttribute(value) {
    return String(value).replace(/&(?!(amp|quot|lt|gt|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/\x22/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitizeHTML(html) {
    var output = '';
    var tokens = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>|[^<]+|</g;
    var match;
    html = String(html == null ? '' : html);
    while ((match = tokens.exec(html))) {
      var token = match[0];
      if (token.charAt(0) !== '<') output += token.replace(/>/g, '&gt;');
      else if (token === '<') output += '&lt;';
      else if (match[2] && own(ALLOWED_TAGS, match[2].toLowerCase())) {
        var name = match[2].toLowerCase();
        if (match[1]) output += name === 'br' ? '' : '</' + name + '>';
        else output += '<' + name + safeAttributes(name, match[3]) + '>';
      }
    }
    return output;
  }

  function safeAttributes(name, source) {
    var result = '';
    // \x22 \x27 \x60 instead of quote characters: build.mjs does not parse regex literals.
    var pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:\x22([^\x22]*)\x22|\x27([^\x27]*)\x27|([^\s\x22\x27=<>\x60]+)))?/g;
    var match;
    while ((match = pattern.exec(source))) {
      var key = match[1].toLowerCase();
      var value = match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] != null ? match[4] : '';
      if (key === 'class' || key === 'title') result += ' ' + key + '="' + escapeAttribute(value) + '"';
      else if (name === 'a' && key === 'href' && /^(https?:\/\/|mailto:)[^\s\x22\x27<>\\]*$/i.test(value)) result += ' href="' + escapeAttribute(value) + '"';
      else if (name === 'a' && key === 'target' && value === '_blank') result += ' target="_blank"';
    }
    return name === 'a' ? result + ' rel="noopener noreferrer"' : result;
  }

  // ---- Map state -------------------------------------------------------------
  var states = typeof WeakMap === 'function' ? new WeakMap() : null;

  function coreOf(target) {
    var core = target && typeof target.getMap === 'function' ? target.getMap() : target;
    if (!core || typeof core.getContainer !== 'function' || typeof core.project !== 'function' ||
        typeof core.unproject !== 'function' || typeof core.on !== 'function') {
      throw new Error('microMap.ui: pass a microMap or microMap.compose map');
    }
    return core;
  }

  // One listener set per map repositions every marker and popup after a
  // camera change and tears everything down with the map.
  function stateOf(core) {
    var state = states.get(core);
    if (state) return state;
    state = { core: core, items: [], corners: Object.create(null), controls: [], popup: null };
    state.update = function () {
      var items = state.items.slice();
      for (var i = 0; i < items.length; i++) items[i]._update();
    };
    state.destroy = function () {
      state.items.slice().forEach(function (item) { item.remove(); });
      state.controls.slice().forEach(function (record) { removeControl(record.owner, record.control); });
      for (var position in state.corners) {
        var corner = state.corners[position];
        if (corner.parentNode) corner.parentNode.removeChild(corner);
      }
      core.off('move', state.update).off('resize', state.update).off('destroy', state.destroy);
      states.delete(core);
    };
    core.on('move', state.update).on('resize', state.update).on('destroy', state.destroy);
    states.set(core, state);
    var container = core.getContainer();
    injectStyles(container.ownerDocument || doc());
    return state;
  }

  function track(item, core) {
    var state = stateOf(core);
    if (state.items.indexOf(item) < 0) state.items.push(item);
    return state;
  }

  function untrack(item, core) {
    var state = core && states.get(core);
    if (!state) return;
    var index = state.items.indexOf(item);
    if (index > -1) state.items.splice(index, 1);
  }

  function localPoint(core, event) {
    var rect = core.getContainer().getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function transform(node, value) {
    // CSSOM may normalize whitespace; compare the requested value and the
    // browser's last serialization while still honoring external style edits.
    if (node._microMapTransform !== value || node.style.transform !== node._microMapAppliedTransform) {
      node.style.transform = value;
      node._microMapTransform = value;
      node._microMapAppliedTransform = node.style.transform;
    }
  }

  function place(node, point, anchor, offset, extra) {
    var shift = ANCHORS[anchor] || ANCHORS.center;
    transform(node, 'translate(' + Math.round(point[0] + offset[0]) + 'px,' + Math.round(point[1] + offset[1]) + 'px) translate(' +
      shift[0] + '%,' + shift[1] + '%)' + (extra || ''));
  }

  // Walks the tree instead of querySelectorAll, so popups work in any DOM.
  function firstFocusable(node) {
    var children = node.children || node.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var tag = String(child.tagName || '').toLowerCase();
      if (!child.disabled && (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' ||
          (tag === 'a' && child.getAttribute && child.getAttribute('href') != null) || (child.getAttribute && child.getAttribute('tabindex') === '0'))) return child;
      var nested = firstFocusable(child);
      if (nested) return nested;
    }
    return null;
  }

  // ---- Events ----------------------------------------------------------------
  function Evented() {}

  Evented.prototype.on = function (type, handler) {
    if (typeof handler === 'function') {
      var listeners = this._listeners || (this._listeners = Object.create(null));
      (listeners[type] || (listeners[type] = [])).push(handler);
    }
    return this;
  };

  Evented.prototype.off = function (type, handler) {
    var list = this._listeners && this._listeners[type];
    if (!list) return this;
    if (!handler) delete this._listeners[type];
    for (var i = list.length - 1; handler && i >= 0; i--) if (list[i] === handler || list[i]._original === handler) list.splice(i, 1);
    return this;
  };

  Evented.prototype.once = function (type, handler) {
    var self = this;
    function single(event) {
      self.off(type, single);
      handler.call(self, event);
    }
    single._original = handler;
    return this.on(type, single);
  };

  Evented.prototype.fire = function (type, data) {
    var list = this._listeners && this._listeners[type];
    if (!list || !list.length) return this;
    var event = { type: type, target: this };
    for (var key in data) event[key] = data[key];
    list = list.slice();
    for (var i = 0; i < list.length; i++) list[i].call(this, event);
    return this;
  };

  Evented.prototype.listens = function (type) {
    return !!(this._listeners && this._listeners[type] && this._listeners[type].length);
  };

  function inherit(Child, Parent) {
    Child.prototype = Object.create(Parent.prototype);
    Child.prototype.constructor = Child;
  }

  // ---- Icons (Leaflet) -------------------------------------------------------
  function Icon(options) {
    if (!(this instanceof Icon)) return new Icon(options);
    this.options = options || {};
  }

  Icon.prototype.createIcon = function () {
    var options = this.options;
    var image = element('img', 'micromap-marker-icon ' + (options.className || ''));
    var retina = options.iconRetinaUrl && finite(root.devicePixelRatio, 1) > 1;
    image.src = retina ? options.iconRetinaUrl : options.iconUrl;
    image.alt = options.alt || '';
    image.draggable = false;
    var size = pointValue(options.iconSize);
    if (size[0]) image.style.width = size[0] + 'px';
    if (size[1]) image.style.height = size[1] + 'px';
    return image;
  };

  // Leaflet anchors icons in pixels; the default is the icon's centre.
  Icon.prototype.anchor = function () {
    if (this.options.iconAnchor != null) return pointValue(this.options.iconAnchor);
    var size = pointValue(this.options.iconSize);
    return [size[0] / 2, size[1] / 2];
  };

  function DivIcon(options) {
    if (!(this instanceof DivIcon)) return new DivIcon(options);
    options = options || {};
    Icon.call(this, {
      html: options.html, className: options.className == null ? 'micromap-div-icon' : options.className,
      iconSize: options.iconSize === undefined ? [12, 12] : options.iconSize, iconAnchor: options.iconAnchor,
      popupAnchor: options.popupAnchor, tooltipAnchor: options.tooltipAnchor
    });
  }
  inherit(DivIcon, Icon);

  DivIcon.prototype.createIcon = function () {
    var options = this.options;
    var node = element('div', options.className);
    // html is trusted application markup, as in Leaflet; nodes are appended.
    if (isNode(options.html)) node.appendChild(options.html);
    else if (options.html != null) node.innerHTML = String(options.html);
    var size = pointValue(options.iconSize);
    if (size[0]) node.style.width = size[0] + 'px';
    if (size[1]) node.style.height = size[1] + 'px';
    return node;
  };

  // A MapLibre-like default pin, anchored at its tip.
  function defaultPin(color, scale) {
    scale = clamp(finite(scale, 1), 0.2, 4);
    var wrapper = element('div', 'micromap-marker-pin');
    var image = svg('svg', { width: 27 * scale, height: 41 * scale, viewBox: '0 0 27 41', 'aria-hidden': 'true', focusable: 'false' }, wrapper);
    svg('path', { d: 'M13.5 0C6.04 0 0 6.04 0 13.5 0 23.6 13.5 41 13.5 41S27 23.6 27 13.5C27 6.04 20.96 0 13.5 0z', fill: color || '#3fb1ce' }, image);
    svg('circle', { cx: 13.5, cy: 13.5, r: 5.5, fill: '#fff' }, image);
    return wrapper;
  }

  // ---- Marker ----------------------------------------------------------------
  function Marker(options) {
    if (!(this instanceof Marker)) return new Marker(options);
    if (isNode(options)) options = { element: options };
    options = options || {};
    this.options = options;
    this._offset = pointValue(options.offset);
    this._draggable = !!options.draggable;
    this._rotation = finite(options.rotation, 0);
    this._rotationAlignment = options.rotationAlignment === 'map' ? 'map' : 'viewport';
    this._lngLat = null;
    this._core = null;
    this._owner = null;
    this._popup = null;
    this._tooltip = null;
    this._iconAnchor = null;
    var node = options.element;
    this._generated = !node;
    if (!node && options.icon) {
      node = options.icon.createIcon();
      this._iconAnchor = options.icon.anchor();
      if (options.icon.options.popupAnchor != null) this._popupAnchor = pointValue(options.icon.options.popupAnchor);
    }
    this._pin = !node;
    if (!node) {
      var scale = clamp(finite(options.scale, 1), 0.2, 4);
      node = defaultPin(options.color, scale);
      // The pin tip is the anchor; popups open above its head.
      this._popupAnchor = { top: [0, 0], 'top-left': [0, 0], 'top-right': [0, 0], bottom: [0, -38 * scale], 'bottom-left': [9 * scale, -29 * scale],
        'bottom-right': [-9 * scale, -29 * scale], left: [13 * scale, -26 * scale], right: [-13 * scale, -26 * scale], center: [0, -26 * scale] };
    }
    this._anchor = own(ANCHORS, options.anchor) ? options.anchor : this._pin ? 'bottom' : 'center';
    classes(node, 'micromap-marker ' + (options.className || ''));
    if (options.title) node.title = options.title;
    if (options.opacity != null) node.style.opacity = clamp(finite(options.opacity, 1), 0, 1);
    this._element = node;
    this._keyboard = options.keyboard;
    var events = ['click', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerenter', 'pointerleave', 'focus', 'blur'];
    for (var i = 0; i < events.length; i++) node.addEventListener(events[i], this);
    this._interactive();
  }
  inherit(Marker, Evented);

  // Keyboard reachability for markers that do something: open a popup,
  // show a tooltip, move by arrow keys or fire a click.
  Marker.prototype._interactive = function () {
    var node = this._element;
    var tag = String(node.tagName || '').toLowerCase();
    var active = this._draggable || this._popup || this._tooltip || this._keyboard === true;
    if (active && tag !== 'button' && tag !== 'a' && node.getAttribute('tabindex') == null) node.setAttribute('tabindex', '0');
    if (active && tag !== 'button' && tag !== 'a' && node.getAttribute('role') == null) node.setAttribute('role', 'button');
    // Only generated pins and icons get a default name; an application's own
    // element keeps its text for assistive technology.
    if (this._generated && node.getAttribute('aria-label') == null && !node.title) node.setAttribute('aria-label', text('Marker.Title', this.options));
    classes(node, 'micromap-marker-draggable', this._draggable);
  };

  Marker.prototype.handleEvent = function (event) {
    var type = event.type;
    if (type === 'click') {
      if (this._dragged) {
        this._dragged = false;
        return;
      }
      this.fire('click', { originalEvent: event });
      if (this._popup) this.togglePopup();
    } else if (type === 'keydown') this._onKey(event);
    else if (type === 'pointerdown') this._dragStart(event);
    else if (type === 'pointermove') this._dragMove(event);
    else if (type === 'pointerup' || type === 'pointercancel') this._dragEnd(event);
    else if (this._tooltip && !this._tooltip._permanent) {
      if (type === 'pointerenter' || type === 'focus') this.openTooltip();
      else if (type === 'pointerleave' || type === 'blur') this.closeTooltip();
    }
  };

  Marker.prototype._onKey = function (event) {
    var key = event.key;
    if (key === 'Enter' || key === ' ') {
      var tag = String(this._element.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'a' || (!this._popup && !this.listens('click'))) return;
      event.preventDefault();
      this.fire('click', { originalEvent: event });
      if (this._popup) this.togglePopup();
      return;
    }
    var steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!this._draggable || !this._core || !this._lngLat || !own(steps, key)) return;
    event.preventDefault();
    event.stopPropagation();
    var distance = event.shiftKey ? 25 : 5;
    var point = this._core.project(this._lngLat);
    this.fire('dragstart', { originalEvent: event });
    this._moveTo(this._core.unproject([point[0] + steps[key][0] * distance, point[1] + steps[key][1] * distance]), event);
    this.fire('dragend', { originalEvent: event });
  };

  Marker.prototype._dragStart = function (event) {
    if (!this._draggable || !this._core || !this._lngLat || (event.pointerType === 'mouse' && event.button)) return;
    event.stopPropagation();
    var start = localPoint(this._core, event);
    var point = this._core.project(this._lngLat);
    this._drag = { id: event.pointerId, start: start, grab: [start[0] - point[0], start[1] - point[1]], moved: false };
    if (this._element.setPointerCapture) this._element.setPointerCapture(event.pointerId);
  };

  Marker.prototype._dragMove = function (event) {
    var drag = this._drag;
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    var current = localPoint(this._core, event);
    if (!drag.moved) {
      // A few pixels of tolerance keep a tap a click.
      if (Math.abs(current[0] - drag.start[0]) < 3 && Math.abs(current[1] - drag.start[1]) < 3) return;
      drag.moved = true;
      classes(this._element, 'micromap-marker-dragging');
      this.fire('dragstart', { originalEvent: event });
    }
    this._moveTo(this._core.unproject([current[0] - drag.grab[0], current[1] - drag.grab[1]]), event);
  };

  Marker.prototype._dragEnd = function (event) {
    var drag = this._drag;
    if (!drag || drag.id !== event.pointerId) return;
    this._drag = null;
    if (this._element.releasePointerCapture) this._element.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    classes(this._element, 'micromap-marker-dragging', false);
    this._dragged = true;
    this.fire('dragend', { originalEvent: event });
  };

  Marker.prototype._moveTo = function (lngLat, event) {
    this.setLngLat(lngLat);
    this.fire('drag', { originalEvent: event });
  };

  Marker.prototype.setLngLat = function (value) {
    this._lngLat = lngLatValue(value);
    if (this._popup && this._popup.isOpen()) this._popup.setLngLat(this._lngLat);
    if (this._tooltip && this._tooltip.isOpen()) this._tooltip.setLngLat(this._lngLat);
    this._update();
    return this;
  };

  Marker.prototype.getLngLat = function () { return this._lngLat ? lngLatObject(this._lngLat) : undefined; };
  Marker.prototype.setLatLng = function (value) { return this.setLngLat(latLngValue(value)); };
  Marker.prototype.getLatLng = function () { return this._lngLat ? { lat: this._lngLat[1], lng: this._lngLat[0] } : undefined; };
  Marker.prototype.getElement = function () { return this._element; };

  Marker.prototype.addTo = function (target) {
    if (!this._lngLat) throw new Error('microMap.ui: set the marker position before adding it');
    this.remove();
    var core = coreOf(target);
    core.getContainer().appendChild(this._element);
    this._core = core;
    this._owner = target;
    track(this, core);
    this._update();
    if (this._tooltip && this._tooltip._permanent) this.openTooltip();
    this.fire('add');
    return this;
  };

  Marker.prototype.remove = function () {
    if (!this._core) return this;
    if (this._popup && this._popup.isOpen()) this._popup.remove();
    if (this._tooltip && this._tooltip.isOpen()) this._tooltip.remove();
    if (this._element.parentNode) this._element.parentNode.removeChild(this._element);
    untrack(this, this._core);
    this._core = this._owner = null;
    this._drag = null;
    this.fire('remove');
    return this;
  };

  Marker.prototype._update = function () {
    if (!this._core || !this._lngLat) return;
    var point = this._core.project(this._lngLat);
    var rotation = this._rotation + (this._rotationAlignment === 'map' && this._core.getBearing ? this._core.getBearing() : 0);
    var turn = rotation ? ' rotate(' + rotation + 'deg)' : '';
    if (this._iconAnchor) {
      transform(this._element, 'translate(' + Math.round(point[0] - this._iconAnchor[0] + this._offset[0]) + 'px,' +
        Math.round(point[1] - this._iconAnchor[1] + this._offset[1]) + 'px)' + turn);
    } else place(this._element, point, this._anchor, this._offset, turn);
  };

  Marker.prototype.setDraggable = function (value) {
    this._draggable = !!value;
    if (!this._draggable) this._drag = null;
    this._interactive();
    return this;
  };
  Marker.prototype.isDraggable = function () { return this._draggable; };
  Marker.prototype.setOffset = function (value) { this._offset = pointValue(value); this._update(); return this; };
  Marker.prototype.getOffset = function () { return this._offset.slice(); };
  Marker.prototype.setRotation = function (value) { this._rotation = finite(value, 0); this._update(); return this; };
  Marker.prototype.getRotation = function () { return this._rotation; };
  Marker.prototype.setRotationAlignment = function (value) { this._rotationAlignment = value === 'map' ? 'map' : 'viewport'; this._update(); return this; };
  Marker.prototype.setOpacity = function (value) { this._element.style.opacity = clamp(finite(value, 1), 0, 1); return this; };

  // Popups at a marker open above its visual anchor (Leaflet: popupAnchor).
  Marker.prototype._popupOffset = function () {
    if (this._popupAnchor) return this._popupAnchor;
    return [0, 0];
  };

  Marker.prototype.setPopup = function (popup) {
    if (this._popup === popup) return this;
    if (this._popup) {
      if (this._popup.isOpen()) this._popup.remove();
      this._popup._source = null;
    }
    this._popup = popup || null;
    if (popup) {
      popup._source = this;
      if (!popup._offsetSet) popup._setOffsets(this._popupOffset());
    }
    this._interactive();
    return this;
  };

  Marker.prototype.getPopup = function () { return this._popup; };

  Marker.prototype.togglePopup = function () {
    var popup = this._popup;
    if (!popup || !this._core) return this;
    if (popup.isOpen()) popup.remove();
    else if (popup._leaflet) popup.setLngLat(this._lngLat).openOn(this._owner);
    else popup.setLngLat(this._lngLat).addTo(this._owner);
    return this;
  };

  // Leaflet popup shorthands.
  Marker.prototype.bindPopup = function (content, options) {
    var popup = content instanceof Popup ? content : leafletPopup(options).setContent(content);
    return this.setPopup(popup);
  };
  Marker.prototype.unbindPopup = function () { return this.setPopup(null); };
  Marker.prototype.openPopup = function () { if (this._popup && !this._popup.isOpen()) this.togglePopup(); return this; };
  Marker.prototype.closePopup = function () { if (this._popup && this._popup.isOpen()) this._popup.remove(); return this; };
  Marker.prototype.isPopupOpen = function () { return !!(this._popup && this._popup.isOpen()); };
  Marker.prototype.setPopupContent = function (content) { if (this._popup) this._popup.setContent(content); return this; };

  // Leaflet tooltips: on hover and focus, or permanently.
  Marker.prototype.bindTooltip = function (content, options) {
    this.unbindTooltip();
    var tooltip = content instanceof Tooltip ? content : new Tooltip(options).setContent(content);
    tooltip._source = this;
    if (!tooltip._offsetSet) tooltip._setOffsets(this._popupOffset());
    this._tooltip = tooltip;
    this._element.setAttribute('aria-describedby', tooltip._id);
    this._interactive();
    if (tooltip._permanent && this._core) this.openTooltip();
    return this;
  };
  Marker.prototype.unbindTooltip = function () {
    if (!this._tooltip) return this;
    if (this._tooltip.isOpen()) this._tooltip.remove();
    this._element.removeAttribute('aria-describedby');
    this._tooltip = null;
    return this;
  };
  Marker.prototype.openTooltip = function () {
    if (this._tooltip && this._core && !this._tooltip.isOpen()) this._tooltip.setLngLat(this._lngLat).addTo(this._owner);
    return this;
  };
  Marker.prototype.closeTooltip = function () { if (this._tooltip && this._tooltip.isOpen()) this._tooltip.remove(); return this; };
  Marker.prototype.toggleTooltip = function () { return this._tooltip && this._tooltip.isOpen() ? this.closeTooltip() : this.openTooltip(); };
  Marker.prototype.getTooltip = function () { return this._tooltip; };
  Marker.prototype.isTooltipOpen = function () { return !!(this._tooltip && this._tooltip.isOpen()); };
  Marker.prototype.setIcon = function (icon) {
    var old = this._element;
    var node = icon.createIcon();
    var events = ['click', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerenter', 'pointerleave', 'focus', 'blur'];
    for (var i = 0; i < events.length; i++) {
      old.removeEventListener(events[i], this);
      node.addEventListener(events[i], this);
    }
    classes(node, 'micromap-marker ' + (this.options.className || ''));
    if (old.getAttribute('aria-describedby')) node.setAttribute('aria-describedby', old.getAttribute('aria-describedby'));
    this._element = node;
    this._iconAnchor = icon.anchor();
    this._popupAnchor = icon.options.popupAnchor != null ? pointValue(icon.options.popupAnchor) : null;
    this._pin = false;
    if (old.parentNode) old.parentNode.replaceChild(node, old);
    this._interactive();
    this._update();
    return this;
  };

  // ---- Popup -----------------------------------------------------------------
  function offsetsFor(value) {
    var result = {};
    var anchor;
    if (value == null) value = 0;
    if (typeof value === 'number') {
      var corner = Math.round(Math.sqrt(0.5 * value * value));
      result = {
        center: [0, 0], top: [0, value], 'top-left': [corner, corner], 'top-right': [-corner, corner], bottom: [0, -value],
        'bottom-left': [corner, -corner], 'bottom-right': [-corner, -corner], left: [value, 0], right: [-value, 0]
      };
    } else if (Array.isArray(value) || (value.x != null && value.y != null)) {
      for (anchor in ANCHORS) result[anchor] = pointValue(value);
    } else {
      for (anchor in ANCHORS) result[anchor] = pointValue(value[anchor]);
    }
    return result;
  }

  function Popup(options) {
    if (!(this instanceof Popup)) return new Popup(options);
    options = options || {};
    this.options = options;
    this._closeButton = options.closeButton !== false;
    this._closeOnClick = options.closeOnClick !== false;
    this._closeOnMove = !!options.closeOnMove;
    this._closeOnEscape = options.closeOnEscapeKey !== false;
    this._focus = options.focusAfterOpen !== false;
    this._autoPan = !!options.autoPan;
    this._autoClose = !!options.autoClose;
    this._anchorOption = own(ANCHORS, options.anchor) ? options.anchor : null;
    this._offsetSet = options.offset != null;
    this._offsets = offsetsFor(options.offset);
    this._maxWidth = typeof options.maxWidth === 'number' ? options.maxWidth + 'px' : options.maxWidth || '240px';
    this._className = options.className || '';
    this._content = null;
    this._lngLat = null;
    this._core = null;
    this._owner = null;
    this._element = null;
    this._id = 'micromap-popup-' + ++uid;
    this._onMapClick = this._onMapClick.bind(this);
    this._onMapMove = this._onMapMove.bind(this);
  }
  inherit(Popup, Evented);

  Popup.prototype.setLngLat = function (value) {
    this._lngLat = lngLatValue(value);
    this._update();
    return this;
  };
  Popup.prototype.getLngLat = function () { return this._lngLat ? lngLatObject(this._lngLat) : undefined; };
  Popup.prototype.setLatLng = function (value) { return this.setLngLat(latLngValue(value)); };
  Popup.prototype.getLatLng = function () { return this._lngLat ? { lat: this._lngLat[1], lng: this._lngLat[0] } : undefined; };

  Popup.prototype.setText = function (value) {
    this._contentFunction = null;
    return this._setContent(doc().createTextNode(String(value == null ? '' : value)));
  };

  // Like MapLibre's setHTML, the markup is trusted: escape untrusted values
  // first, or use setText()/setDOMContent().
  Popup.prototype.setHTML = function (html) {
    this._contentFunction = null;
    return this._setContent(htmlHolder(html));
  };

  function htmlHolder(html) {
    var holder = element('div', 'micromap-popup-html');
    holder.innerHTML = String(html == null ? '' : html);
    return holder;
  }

  Popup.prototype.setDOMContent = function (node) {
    this._contentFunction = null;
    return this._setContent(node);
  };

  // Leaflet: a string is HTML, a function receives the source marker.
  Popup.prototype.setContent = function (content) {
    if (typeof content === 'function') {
      this._contentFunction = content;
      return this;
    }
    this._contentFunction = null;
    return isNode(content) ? this.setDOMContent(content) : this.setHTML(content);
  };

  Popup.prototype._setContent = function (node) {
    this._content = node;
    if (this._body) {
      while (this._body.lastChild && this._body.lastChild !== this._closeElement) this._body.removeChild(this._body.lastChild);
      this._body.appendChild(node);
      this._update();
    }
    return this;
  };

  Popup.prototype._setOffsets = function (value) { this._offsets = offsetsFor(value); };
  Popup.prototype.setOffset = function (value) { this._offsetSet = true; this._setOffsets(value); this._update(); return this; };
  Popup.prototype.setMaxWidth = function (value) {
    this._maxWidth = typeof value === 'number' ? value + 'px' : value;
    if (this._element) this._element.style.maxWidth = this._maxWidth;
    this._update();
    return this;
  };
  Popup.prototype.getMaxWidth = function () { return this._maxWidth; };
  Popup.prototype.getElement = function () { return this._element; };
  Popup.prototype.isOpen = function () { return !!this._core; };
  Popup.prototype.addClassName = function (name) { this._className += ' ' + name; if (this._element) classes(this._element, name); return this; };
  Popup.prototype.removeClassName = function (name) {
    this._className = this._className.split(/\s+/).filter(function (entry) { return entry !== name; }).join(' ');
    if (this._element) classes(this._element, name, false);
    return this;
  };
  Popup.prototype.toggleClassName = function (name) {
    var has = this._element ? this._element.classList.contains(name) : (' ' + this._className + ' ').indexOf(' ' + name + ' ') > -1;
    return has ? (this.removeClassName(name), false) : (this.addClassName(name), true);
  };

  Popup.prototype._build = function () {
    var self = this;
    var container = element('div', 'micromap-popup ' + this._className);
    container.id = this._id;
    container.setAttribute('role', this instanceof Tooltip ? 'tooltip' : 'dialog');
    container.style.maxWidth = this._maxWidth;
    element('div', 'micromap-popup-tip', container);
    var body = element('div', 'micromap-popup-content', container);
    if (this._closeButton) {
      classes(container, 'micromap-popup-has-close');
      var close = element('button', 'micromap-popup-close', body);
      close.type = 'button';
      close.setAttribute('aria-label', text('Popup.Close', this.options));
      close.textContent = '\u00d7';
      close.addEventListener('click', function () { self.remove(); });
      this._closeElement = close;
    }
    container.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && self._closeOnEscape) {
        event.stopPropagation();
        self.remove();
      }
    });
    if (this._content) body.appendChild(this._content);
    this._body = body;
    this._element = container;
  };

  Popup.prototype.addTo = function (target) {
    if (!this._lngLat) throw new Error('microMap.ui: set the popup position before adding it');
    this.remove();
    var core = coreOf(target);
    var state = track(this, core);
    if (this._autoClose && state.popup && state.popup !== this) state.popup.remove();
    if (this._autoClose) state.popup = this;
    if (this._contentFunction) {
      var produced = this._contentFunction(this._source);
      if (isNode(produced)) this._setContent(produced);
      else this._setContent(htmlHolder(produced));
    }
    if (!this._element) this._build();
    core.getContainer().appendChild(this._element);
    this._core = core;
    this._owner = target;
    // Registered while a click is dispatched, this listener only sees the
    // next click: a popup opened from a click handler stays open.
    if (this._closeOnClick) core.on('click', this._onMapClick);
    if (this._closeOnMove) core.on('move', this._onMapMove);
    this._update();
    if (this._autoPan) this._pan();
    if (this._focus) {
      var focusable = firstFocusable(this._element);
      if (focusable && focusable.focus) focusable.focus({ preventScroll: true });
    }
    this.fire('open');
    return this;
  };

  // Leaflet: openOn closes the map's previous auto-closing popup.
  Popup.prototype.openOn = function (target) {
    this._autoClose = true;
    return this.addTo(target);
  };

  Popup.prototype.remove = function () {
    var core = this._core;
    if (!core) return this;
    var focused = this._element && root.document && this._element.contains && this._element.contains(root.document.activeElement);
    core.off('click', this._onMapClick).off('move', this._onMapMove);
    if (this._element && this._element.parentNode) this._element.parentNode.removeChild(this._element);
    var state = states.get(core);
    if (state && state.popup === this) state.popup = null;
    untrack(this, core);
    this._core = this._owner = null;
    // Return keyboard focus to the marker that opened the popup.
    if (focused && this._source && this._source._element && this._source._element.focus) this._source._element.focus();
    this.fire('close');
    return this;
  };
  Popup.prototype.close = Popup.prototype.remove;

  Popup.prototype._onMapClick = function () { this.remove(); };
  Popup.prototype._onMapMove = function () { if (!this._panning) this.remove(); };

  Popup.prototype._update = function () {
    if (!this._core || !this._lngLat || !this._element) return;
    var point = this._core.project(this._lngLat);
    var anchor = this._anchorOption || this._autoAnchor(point);
    if (anchor !== this._applied) {
      if (this._applied) classes(this._element, 'micromap-popup-anchor-' + this._applied, false);
      classes(this._element, 'micromap-popup-anchor-' + anchor);
      this._applied = anchor;
    }
    place(this._element, point, anchor, this._offsets[anchor] || [0, 0]);
  };

  // MapLibre's automatic anchor: keep the popup inside the map.
  Popup.prototype._autoAnchor = function (point) {
    var container = this._core.getContainer();
    var width = this._element.offsetWidth || 0;
    var height = this._element.offsetHeight || 0;
    var bottom = this._offsets.bottom || [0, 0];
    var parts = point[1] + bottom[1] < height ? ['top'] : point[1] > container.clientHeight - height ? ['bottom'] : [];
    if (point[0] < width / 2) parts.push('left');
    else if (point[0] > container.clientWidth - width / 2) parts.push('right');
    return parts.length ? parts.join('-') : 'bottom';
  };

  // Leaflet's autoPan: move the map until the popup is fully visible.
  Popup.prototype._pan = function () {
    var core = this._core;
    if (!core.panBy || !this._element.getBoundingClientRect) return;
    var box = this._element.getBoundingClientRect();
    var frame = core.getContainer().getBoundingClientRect();
    var padding = 8;
    var dx = box.left < frame.left + padding ? box.left - frame.left - padding : box.right > frame.right - padding ? box.right - frame.right + padding : 0;
    var dy = box.top < frame.top + padding ? box.top - frame.top - padding : box.bottom > frame.bottom - padding ? box.bottom - frame.bottom + padding : 0;
    if (!dx && !dy) return;
    this._panning = true;
    core.panBy([dx, dy]);
    this._panning = false;
  };

  function leafletPopup(options) {
    options = options || {};
    var settings = { autoPan: options.autoPan !== false, autoClose: options.autoClose !== false };
    for (var key in options) if (key !== 'autoPan' && key !== 'autoClose') settings[key] = options[key];
    if (settings.maxWidth == null) settings.maxWidth = 300;
    var popup = new Popup(settings);
    popup._leaflet = true;
    return popup;
  }

  // ---- Tooltip (Leaflet) -----------------------------------------------------
  var DIRECTIONS = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', center: 'center' };

  function Tooltip(options) {
    if (!(this instanceof Tooltip)) return new Tooltip(options);
    options = options || {};
    var direction = own(DIRECTIONS, options.direction) ? options.direction : 'auto';
    Popup.call(this, {
      closeButton: false, closeOnClick: false, closeOnEscapeKey: false, focusAfterOpen: false,
      anchor: DIRECTIONS[direction], offset: options.offset, maxWidth: 'none', locale: options.locale,
      className: 'micromap-tooltip ' + (options.className || '')
    });
    this._direction = direction;
    this._permanent = !!options.permanent;
    this._opacity = options.opacity == null ? 0.9 : clamp(finite(options.opacity, 0.9), 0, 1);
  }
  inherit(Tooltip, Popup);

  Tooltip.prototype.addTo = function (target) {
    Popup.prototype.addTo.call(this, target);
    this._element.style.opacity = this._opacity;
    return this;
  };

  // Leaflet's 'auto': to the right of the source, or left near the edge.
  Tooltip.prototype._autoAnchor = function (point) {
    return point[0] > this._core.getContainer().clientWidth / 2 ? 'right' : 'left';
  };

  // ---- Layer groups (Leaflet) ------------------------------------------------
  function LayerGroup(layers) {
    if (!(this instanceof LayerGroup)) return new LayerGroup(layers);
    this._layers = [];
    this._owner = null;
    (layers || []).forEach(this.addLayer, this);
  }
  inherit(LayerGroup, Evented);

  LayerGroup.prototype.addLayer = function (layer) {
    if (this._layers.indexOf(layer) < 0) this._layers.push(layer);
    if (this._owner) layer.addTo(this._owner);
    return this;
  };
  LayerGroup.prototype.removeLayer = function (layer) {
    var index = this._layers.indexOf(layer);
    if (index > -1) this._layers.splice(index, 1);
    if (this._owner && layer.remove) layer.remove();
    return this;
  };
  LayerGroup.prototype.hasLayer = function (layer) { return this._layers.indexOf(layer) > -1; };
  LayerGroup.prototype.clearLayers = function () { this._layers.slice().forEach(this.removeLayer, this); return this; };
  LayerGroup.prototype.eachLayer = function (callback, context) { this._layers.slice().forEach(callback, context); return this; };
  LayerGroup.prototype.getLayers = function () { return this._layers.slice(); };
  LayerGroup.prototype.addTo = function (target) {
    this._owner = target;
    this._layers.forEach(function (layer) { layer.addTo(target); });
    return this;
  };
  LayerGroup.prototype.remove = function () {
    this._layers.forEach(function (layer) { if (layer.remove) layer.remove(); });
    this._owner = null;
    return this;
  };
  // [west, south, east, north] of the markers in the group.
  LayerGroup.prototype.getBounds = function () {
    var box = null;
    this._layers.forEach(function (layer) {
      var position = layer.getLngLat && layer.getLngLat();
      if (!position) return;
      if (!box) box = [position.lng, position.lat, position.lng, position.lat];
      else box = [Math.min(box[0], position.lng), Math.min(box[1], position.lat), Math.max(box[2], position.lng), Math.max(box[3], position.lat)];
    });
    return box;
  };

  // ---- Controls --------------------------------------------------------------
  function positionName(value) {
    value = String(value || '').replace(/^(top|bottom)-?(left|right)$/, '$1-$2');
    return /^(top|bottom)-(left|right)$/.test(value) ? value : null;
  }

  // A control is MapLibre's IControl (onAdd(map) returns its element,
  // onRemove(map)); Leaflet's addTo/remove/setPosition work as well.
  function Control(options) {
    if (!(this instanceof Control)) return new Control(options);
    this.options = options || {};
    if (typeof this.options.onAdd === 'function') this.onAdd = this.options.onAdd;
    if (typeof this.options.onRemove === 'function') this.onRemove = this.options.onRemove;
  }
  inherit(Control, Evented);

  Control.prototype.onAdd = function () { throw new Error('microMap.ui: a control needs onAdd(map)'); };
  Control.prototype.onRemove = function () {};
  Control.prototype.getDefaultPosition = function () { return positionName(this.options.position) || 'top-right'; };
  Control.prototype.addTo = function (target) { addControl(target, this); return this; };
  Control.prototype.remove = function () { if (this._owner) removeControl(this._owner, this); return this; };
  Control.prototype.getContainer = function () { return this._container; };
  Control.prototype.getPosition = function () { return this._position || this.getDefaultPosition(); };
  Control.prototype.setPosition = function (position) {
    var owner = this._owner;
    if (owner) removeControl(owner, this);
    this.options.position = position;
    if (owner) addControl(owner, this, position);
    return this;
  };

  function addControl(target, control, position) {
    if (!control || typeof control.onAdd !== 'function') throw new Error('microMap.ui: a control needs onAdd(map)');
    var core = coreOf(target);
    var state = stateOf(core);
    if (state.controls.some(function (record) { return record.control === control; })) return target;
    var where = positionName(position) || (typeof control.getDefaultPosition === 'function' && positionName(control.getDefaultPosition())) || 'top-right';
    var node = control.onAdd(target);
    if (!isNode(node)) throw new Error('microMap.ui: onAdd(map) must return an element');
    var corner = state.corners[where];
    if (!corner) {
      corner = state.corners[where] = element('div', 'micromap-ctrl-corner micromap-ctrl-' + where, core.getContainer());
    }
    // Like MapLibre: new bottom controls stack above the existing ones.
    if (where.indexOf('bottom') === 0) corner.insertBefore(node, corner.firstChild || null);
    else corner.appendChild(node);
    state.controls.push({ control: control, node: node, owner: target });
    control._owner = target;
    control._container = node;
    control._position = where;
    return target;
  }

  function removeControl(target, control) {
    var state = states.get(coreOf(target));
    if (!state) return target;
    for (var i = 0; i < state.controls.length; i++) {
      var record = state.controls[i];
      if (record.control !== control) continue;
      state.controls.splice(i, 1);
      if (record.node.parentNode) record.node.parentNode.removeChild(record.node);
      if (typeof control.onRemove === 'function') control.onRemove(target);
      control._owner = control._container = null;
      break;
    }
    return target;
  }

  function hasControl(target, control) {
    var state = states.get(coreOf(target));
    return !!state && state.controls.some(function (record) { return record.control === control; });
  }

  function button(parent, className, label, content, action) {
    var node = element('button', className, parent);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    if (content) node.textContent = content;
    node.addEventListener('click', action);
    return node;
  }

  // Zoom buttons and a compass that shows the bearing and resets north.
  function NavigationControl(options) {
    if (!(this instanceof NavigationControl)) return new NavigationControl(options);
    Control.call(this, options);
  }
  inherit(NavigationControl, Control);

  NavigationControl.prototype.onAdd = function (target) {
    var options = this.options;
    var core = coreOf(target);
    var group = element('div', 'micromap-ctrl micromap-ctrl-group');
    var delta = finite(options.zoomDelta, 1);
    var self = this;
    function zoomBy(amount) {
      var container = core.getContainer();
      core.setZoom(core.getZoom() + amount, [container.clientWidth / 2, container.clientHeight / 2], 250);
    }
    if (options.showZoom !== false) {
      this._zoomIn = button(group, 'micromap-ctrl-zoom-in', options.zoomInTitle || text('NavigationControl.ZoomIn', options), options.zoomInText || '+', function () { zoomBy(delta); });
      this._zoomOut = button(group, 'micromap-ctrl-zoom-out', options.zoomOutTitle || text('NavigationControl.ZoomOut', options), options.zoomOutText || '\u2212', function () { zoomBy(-delta); });
    }
    if (options.showCompass !== false) {
      this._compass = button(group, 'micromap-ctrl-compass', text('NavigationControl.ResetBearing', options), '', function () {
        var reset = { bearing: 0, duration: 300 };
        if (options.visualizePitch) reset.pitch = 0;
        if (typeof target.easeTo === 'function' && target.camera !== null) {
          try {
            target.easeTo(reset);
            return;
          } catch (error) { /* no camera add-on: set directly */ }
        }
        if (core.setBearing) core.setBearing(0);
        if (options.visualizePitch && core.setPitch) core.setPitch(0);
      });
      var needle = svg('svg', { width: 22, height: 22, viewBox: '0 0 22 22', 'aria-hidden': 'true', focusable: 'false' }, this._compass);
      svg('path', { d: 'M11 2l4 9h-8z', fill: '#e1473d' }, needle);
      svg('path', { d: 'M11 20l-4-9h8z', fill: '#8c96a0' }, needle);
      this._needle = needle;
    }
    this._core = core;
    this._sync = function () {
      var state = core.getCameraState ? core.getCameraState() : { zoom: core.getZoom(), minZoom: 0, maxZoom: 30, bearing: core.getBearing ? core.getBearing() : 0, pitch: 0 };
      if (self._zoomIn) self._zoomIn.disabled = state.zoom >= state.maxZoom - 1e-9;
      if (self._zoomOut) self._zoomOut.disabled = state.zoom <= state.minZoom + 1e-9;
      if (self._needle) {
        self._needle.style.transform = 'rotate(' + -state.bearing + 'deg)' + (options.visualizePitch ? ' scale(1,' + Math.cos(state.pitch * Math.PI / 180).toFixed(3) + ')' : '');
      }
    };
    core.on('move', this._sync);
    this._sync();
    return group;
  };

  NavigationControl.prototype.onRemove = function () {
    if (this._core) this._core.off('move', this._sync);
    this._core = null;
  };

  // Scale bars for the width of maxWidth pixels at the map centre.
  function ScaleControl(options) {
    if (!(this instanceof ScaleControl)) return new ScaleControl(options);
    Control.call(this, options);
    options = this.options;
    this._maxWidth = clamp(finite(options.maxWidth, 100), 20, 1000);
    this._units = options.unit ? [options.unit] : options.units || ['metric'];
  }
  inherit(ScaleControl, Control);

  function roundNumber(value) {
    var power = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var digit = value / power;
    return power * (digit >= 10 ? 10 : digit >= 5 ? 5 : digit >= 3 ? 3 : digit >= 2 ? 2 : 1);
  }

  ScaleControl.prototype.onAdd = function (target) {
    var core = coreOf(target);
    var group = element('div', 'micromap-ctrl micromap-ctrl-scale-group');
    var self = this;
    this._bars = this._units.map(function () { return element('div', 'micromap-ctrl-scale', group); });
    this._core = core;
    this._sync = function () {
      var y = core.getContainer().clientHeight / 2;
      var meters = core.distanceTo(core.unproject([0, y]), core.unproject([self._maxWidth, y]));
      self._units.forEach(function (unit, index) {
        var amount = meters;
        var label = text('ScaleControl.Meters', self.options);
        if (unit === 'imperial') {
          amount = meters * 3.2808;
          label = text('ScaleControl.Feet', self.options);
          if (amount > 5280) { amount /= 5280; label = text('ScaleControl.Miles', self.options); }
        } else if (unit === 'nautical') {
          amount = meters / 1852;
          label = text('ScaleControl.NauticalMiles', self.options);
        } else if (amount >= 1000) {
          amount /= 1000;
          label = text('ScaleControl.Kilometers', self.options);
        }
        var bar = self._bars[index];
        if (!(amount > 0) || !isFinite(amount)) return;
        var nice = roundNumber(amount);
        bar.style.width = Math.round(self._maxWidth * nice / amount) + 'px';
        bar.textContent = +nice.toPrecision(6) + '\u00a0' + label;
      });
    };
    core.on('move', this._sync).on('resize', this._sync);
    this._sync();
    return group;
  };

  ScaleControl.prototype.onRemove = function () {
    if (this._core) this._core.off('move', this._sync).off('resize', this._sync);
    this._core = null;
  };

  ScaleControl.prototype.setUnit = function (unit) {
    this._units = [unit];
    if (this._owner) this.setPosition(this.getPosition());
    return this;
  };

  // A small, accessible click readout with a one-tap clipboard action.
  function CoordinateControl(options) {
    if (!(this instanceof CoordinateControl)) return new CoordinateControl(options);
    Control.call(this, options);
    this._coordinates = null;
  }
  inherit(CoordinateControl, Control);

  CoordinateControl.prototype.getDefaultPosition = function () { return positionName(this.options.position) || 'bottom-left'; };
  CoordinateControl.prototype.onAdd = function (target) {
    var core = coreOf(target);
    var self = this;
    var group = element('div', 'micromap-ctrl micromap-ctrl-coordinate');
    group.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:var(--micromap-ui-surface,rgba(255,255,255,.94));color:var(--micromap-ui-text,#222);border-radius:4px;font:12px/1.4 sans-serif;box-shadow:0 1px 5px #0003';
    group.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    this._core = core;
    this._output = element('output', '', group);
    this._output.setAttribute('aria-live', 'polite');
    this._output.textContent = text('CoordinateControl.Empty', this.options);
    this._button = button(group, '', text('CoordinateControl.Copy', this.options), this.options.buttonText || 'Copy', function () { self.copy(); });
    this._button.disabled = true;
    this._click = function (event) {
      if (!event || !event.lonLat) return;
      var digits = Math.round(clamp(finite(self.options.precision, 5), 0, 8));
      self._coordinates = [event.lonLat[0], event.lonLat[1]];
      self._output.textContent = self._coordinates[0].toFixed(digits) + ', ' + self._coordinates[1].toFixed(digits);
      self._button.disabled = false;
    };
    core.on('click', this._click);
    return group;
  };
  CoordinateControl.prototype.copy = function () {
    var self = this;
    if (!this._coordinates) return Promise.resolve(false);
    var digits = Math.round(clamp(finite(this.options.precision, 5), 0, 8));
    var value = this._coordinates[0].toFixed(digits) + ', ' + this._coordinates[1].toFixed(digits);
    var clipboard = root.navigator && root.navigator.clipboard;
    var copied = clipboard && clipboard.writeText ? clipboard.writeText(value) : Promise.reject(new Error('Clipboard API unavailable'));
    return Promise.resolve(copied).then(function () {
      if (!self._output) return false;
      self._output.setAttribute('aria-label', text('CoordinateControl.Copied', self.options));
      return true;
    }, function () {
      if (!self._output) return false;
      var input = element('textarea');
      input.value = value;
      input.setAttribute('readonly', '');
      input.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc().body.appendChild(input);
      input.select();
      var success = false;
      try { success = !!doc().execCommand('copy'); } catch (error) {}
      if (input.parentNode) input.parentNode.removeChild(input);
      self._output.setAttribute('aria-label', text(success ? 'CoordinateControl.Copied' : 'CoordinateControl.CopyFailed', self.options));
      return success;
    });
  };
  CoordinateControl.prototype.onRemove = function () {
    if (this._core && this._click) this._core.off('click', this._click);
    this._core = this._output = this._button = this._click = null;
    this._coordinates = null;
  };

  // Source credits: the style's sources (via the compose facade), custom
  // strings and Leaflet's addAttribution(); compact on small maps.
  function AttributionControl(options) {
    if (!(this instanceof AttributionControl)) return new AttributionControl(options);
    Control.call(this, options);
    options = this.options;
    this._custom = [].concat(options.customAttribution || []).filter(function (value) { return typeof value === 'string' && value; });
    this._extra = [];
    this._prefix = typeof options.prefix === 'string' ? options.prefix : '';
  }
  inherit(AttributionControl, Control);

  AttributionControl.prototype.getDefaultPosition = function () { return positionName(this.options.position) || 'bottom-right'; };

  AttributionControl.prototype.onAdd = function (target) {
    var core = coreOf(target);
    var self = this;
    var details = element('details', 'micromap-ctrl micromap-ctrl-attrib');
    var summary = element('summary', '', details);
    summary.textContent = '\u24d8';
    summary.setAttribute('aria-label', text('AttributionControl.ToggleAttribution', this.options));
    this._inner = element('div', 'micromap-ctrl-attrib-inner', details);
    this._node = details;
    this._core = core;
    this._target = target;
    this._sync = function () {
      var compact = self.options.compact != null ? !!self.options.compact : core.getContainer().clientWidth < 640;
      if (compact !== self._compact) {
        self._compact = compact;
        classes(details, 'micromap-ctrl-attrib-full', !compact);
        if (compact) details.removeAttribute('open');
        else details.setAttribute('open', '');
      }
    };
    core.on('resize', this._sync);
    this._vectors = (target.vectors || []).filter(function (layer) { return layer && typeof layer.on === 'function'; });
    this._refresh = function () { self._render(); };
    this._vectors.forEach(function (layer) { layer.on('stylechange', self._refresh).on('tileschange', self._refresh); });
    this._sync();
    this._render();
    return details;
  };

  AttributionControl.prototype._render = function () {
    if (!this._inner) return;
    var parts = [];
    function add(value) { if (typeof value === 'string' && value && parts.indexOf(value) < 0) parts.push(value); }
    this._custom.forEach(add);
    if (this._target && typeof this._target.getAttributions === 'function') this._target.getAttributions().forEach(add);
    this._extra.forEach(add);
    var html = (this._prefix ? this._prefix + (parts.length ? ' | ' : '') : '') + parts.join(' | ');
    this._inner.innerHTML = sanitizeHTML(html);
    this._node.style.display = html ? '' : 'none';
  };

  AttributionControl.prototype.onRemove = function () {
    var self = this;
    if (this._core) this._core.off('resize', this._sync);
    (this._vectors || []).forEach(function (layer) { if (layer.off) layer.off('stylechange', self._refresh).off('tileschange', self._refresh); });
    this._core = this._target = this._inner = null;
  };

  AttributionControl.prototype.addAttribution = function (value) {
    if (typeof value === 'string' && value && this._extra.indexOf(value) < 0) this._extra.push(value);
    this._render();
    return this;
  };
  AttributionControl.prototype.removeAttribution = function (value) {
    this._extra = this._extra.filter(function (entry) { return entry !== value; });
    this._render();
    return this;
  };
  AttributionControl.prototype.setPrefix = function (value) {
    this._prefix = typeof value === 'string' ? value : '';
    this._render();
    return this;
  };

  // Find (and optionally follow) the user's location. It only asks the
  // browser after a click and stores nothing; the dot and accuracy circle
  // disappear with the control.
  function GeolocateControl(options) {
    if (!(this instanceof GeolocateControl)) return new GeolocateControl(options);
    Control.call(this, options);
    options = this.options;
    this._positionOptions = options.positionOptions || { enableHighAccuracy: false, maximumAge: 0, timeout: 6000 };
    this._fit = options.fitBoundsOptions || { maxZoom: 15 };
    this._watch = null;
    this._background = false;
  }
  inherit(GeolocateControl, Control);

  GeolocateControl.prototype.onAdd = function (target) {
    var core = coreOf(target);
    var self = this;
    var group = element('div', 'micromap-ctrl micromap-ctrl-group');
    var geolocation = root.navigator && root.navigator.geolocation;
    this._button = button(group, 'micromap-ctrl-geolocate', text('GeolocateControl.FindMyLocation', this.options), '', function () { self.trigger(); });
    var icon = svg('svg', { width: 20, height: 20, viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false' }, this._button);
    svg('circle', { cx: 10, cy: 10, r: 4, fill: 'currentColor' }, icon);
    svg('path', { d: 'M10 1v3M10 16v3M1 10h3M16 10h3', stroke: 'currentColor', 'stroke-width': 2, fill: 'none' }, icon);
    svg('circle', { cx: 10, cy: 10, r: 6.5, stroke: 'currentColor', 'stroke-width': 1.5, fill: 'none' }, icon);
    if (!geolocation) {
      this._button.disabled = true;
      this._button.title = text('GeolocateControl.LocationNotAvailable', this.options);
    }
    this._geolocation = geolocation;
    this._core = core;
    this._target = target;
    // A user pan while following switches to the background state.
    this._onMove = function (event) {
      if (self._watch != null && event && event.originalEvent && !self._background) {
        self._background = true;
        self._state('background');
      }
    };
    core.on('move', this._onMove);
    return group;
  };

  GeolocateControl.prototype._state = function (name) {
    var node = this._button;
    if (!node) return;
    ['waiting', 'active', 'background', 'error'].forEach(function (state) { classes(node, 'micromap-ctrl-geolocate-' + state, state === name); });
    if (this.options.trackUserLocation) node.setAttribute('aria-pressed', this._watch != null ? 'true' : 'false');
  };

  GeolocateControl.prototype.trigger = function () {
    var self = this;
    var geolocation = this._geolocation;
    if (!geolocation || !this._core) return false;
    if (this.options.trackUserLocation) {
      if (this._watch != null && !this._background) {
        this._stop();
        return true;
      }
      if (this._watch != null) {
        // Back from the background: follow the last position again.
        this._background = false;
        this._state('active');
        if (this._last) this._show(this._last, true);
        return true;
      }
      this._state('waiting');
      this._watch = geolocation.watchPosition(function (position) { self._success(position); }, function (error) { self._error(error); }, this._positionOptions);
      this.fire('trackuserlocationstart');
      return true;
    }
    this._state('waiting');
    geolocation.getCurrentPosition(function (position) { self._success(position); }, function (error) { self._error(error); }, this._positionOptions);
    return true;
  };

  GeolocateControl.prototype._stop = function () {
    if (this._watch != null && this._geolocation) this._geolocation.clearWatch(this._watch);
    var tracking = this._watch != null;
    this._watch = null;
    this._background = false;
    this._state(null);
    this._clearDot();
    if (tracking) this.fire('trackuserlocationend');
  };

  GeolocateControl.prototype._success = function (position) {
    if (!this._core || !position || !position.coords) return;
    var coords = position.coords;
    if (!isFinite(+coords.longitude) || !isFinite(+coords.latitude)) return;
    this._last = { lngLat: [+coords.longitude, +coords.latitude], accuracy: Math.max(0, finite(coords.accuracy, 0)) };
    if (!this._background) this._state('active');
    this._show(this._last, !this._background);
    this.fire('geolocate', { coords: coords, timestamp: position.timestamp });
  };

  GeolocateControl.prototype._error = function (error) {
    if (!this._core) return;
    this._state('error');
    // A refused permission ends tracking, as in MapLibre.
    if (error && error.code === 1) {
      if (this._watch != null && this._geolocation) this._geolocation.clearWatch(this._watch);
      this._watch = null;
      this._button.disabled = true;
    }
    this.fire('error', { code: error && error.code, message: error && error.message });
  };

  GeolocateControl.prototype._show = function (last, move) {
    var core = this._core;
    var target = this._target;
    if (this.options.showUserLocation !== false) {
      if (!this._dot) this._dot = new Marker({ element: element('div', 'micromap-user-location-dot'), className: 'micromap-user-location' });
      this._dot.setLngLat(last.lngLat);
      if (!this._dot._core) this._dot.addTo(target);
      if (this.options.showAccuracyCircle !== false) {
        if (!this._circle) this._circle = new AccuracyCircle();
        this._circle.set(last.lngLat, last.accuracy);
        if (!this._circle._core) this._circle.addTo(target);
      }
    }
    if (!move) return;
    // Fit the accuracy circle, like MapLibre, up to fitBoundsOptions.maxZoom.
    var maxZoom = finite(this._fit.maxZoom, 15);
    var latitude = last.lngLat[1];
    var dLat = last.accuracy / 111320;
    var dLng = last.accuracy / (111320 * Math.max(0.01, Math.cos(latitude * Math.PI / 180)));
    var bounds = [last.lngLat[0] - dLng, latitude - dLat, last.lngLat[0] + dLng, latitude + dLat];
    if (typeof target.cameraForBounds === 'function' && typeof target.easeTo === 'function') {
      try {
        var camera = target.cameraForBounds(bounds, { maxZoom: maxZoom, padding: this._fit.padding || 0 });
        target.easeTo({ center: camera.center, zoom: camera.zoom, duration: finite(this._fit.duration, 500) });
        return;
      } catch (error) { /* no camera add-on */ }
    }
    var state = core.getCameraState ? core.getCameraState() : { maxZoom: maxZoom };
    core.setView(last.lngLat, Math.min(maxZoom, state.maxZoom));
  };

  GeolocateControl.prototype._clearDot = function () {
    if (this._dot) this._dot.remove();
    if (this._circle) this._circle.remove();
  };

  GeolocateControl.prototype.onRemove = function () {
    this._stop();
    if (this._core) this._core.off('move', this._onMove);
    this._core = this._target = null;
  };

  // The accuracy circle is a positioned element sized in metres.
  function AccuracyCircle() {
    this._element = element('div', 'micromap-user-location-accuracy');
    this._element.setAttribute('aria-hidden', 'true');
    this._core = null;
  }

  AccuracyCircle.prototype.set = function (lngLat, meters) {
    this._lngLat = lngLat;
    this._meters = meters;
    this._update();
  };

  AccuracyCircle.prototype.addTo = function (target) {
    var core = coreOf(target);
    core.getContainer().appendChild(this._element);
    this._core = core;
    track(this, core);
    this._update();
    return this;
  };

  AccuracyCircle.prototype.remove = function () {
    if (!this._core) return this;
    if (this._element.parentNode) this._element.parentNode.removeChild(this._element);
    untrack(this, this._core);
    this._core = null;
    return this;
  };

  AccuracyCircle.prototype._update = function () {
    if (!this._core || !this._lngLat) return;
    var state = this._core.getCameraState ? this._core.getCameraState() : null;
    var worldSize = state ? state.worldSize : 256 * Math.pow(2, this._core.getZoom());
    var metersPerPixel = 40075016.686 * Math.cos(this._lngLat[1] * Math.PI / 180) / worldSize;
    var diameter = Math.max(0, Math.round(2 * this._meters / metersPerPixel));
    this._element.style.width = this._element.style.height = diameter + 'px';
    this._element.style.display = diameter < 6 ? 'none' : '';
    place(this._element, this._core.project(this._lngLat), 'center', [0, 0]);
  };

  // ---- Public API -------------------------------------------------------------
  var api = {
    Marker: Marker,
    Popup: Popup,
    Tooltip: Tooltip,
    Icon: Icon,
    DivIcon: DivIcon,
    LayerGroup: LayerGroup,
    Control: Control,
    NavigationControl: NavigationControl,
    ScaleControl: ScaleControl,
    CoordinateControl: CoordinateControl,
    AttributionControl: AttributionControl,
    GeolocateControl: GeolocateControl,
    addControl: addControl,
    removeControl: removeControl,
    hasControl: hasControl,
    // Re-renders the map's attribution controls, e.g. after a style change.
    refresh: function (target) {
      var state = states.get(coreOf(target));
      if (state) state.controls.forEach(function (record) { if (record.control._render) record.control._render(); });
      return api;
    },
    sanitizeHTML: sanitizeHTML,
    locale: locale,
    styles: true,
    // Leaflet factories take [lat, lng].
    marker: function (latLng, options) {
      var settings = { keyboard: true };
      for (var key in options) settings[key] = options[key];
      var marker = new Marker(settings);
      return latLng == null ? marker : marker.setLatLng(latLng);
    },
    popup: function (options) { return leafletPopup(options); },
    tooltip: function (options) { return new Tooltip(options); },
    icon: function (options) { return new Icon(options); },
    divIcon: function (options) { return new DivIcon(options); },
    layerGroup: function (layers) { return new LayerGroup(layers); },
    control: function (options) { return new Control(options); }
  };
  api.featureGroup = api.layerGroup;
  api.control.zoom = function (options) {
    options = options || {};
    return new NavigationControl({
      showCompass: false, position: options.position || 'topleft', zoomDelta: options.zoomDelta,
      zoomInText: options.zoomInText, zoomOutText: options.zoomOutText, zoomInTitle: options.zoomInTitle, zoomOutTitle: options.zoomOutTitle
    });
  };
  api.control.scale = function (options) {
    options = options || {};
    var units = [];
    if (options.metric !== false) units.push('metric');
    if (options.imperial !== false) units.push('imperial');
    return new ScaleControl({ position: options.position || 'bottomleft', maxWidth: options.maxWidth, units: units.length ? units : ['metric'] });
  };
  api.control.coordinates = function (options) { return new CoordinateControl(options); };
  api.control.attribution = function (options) {
    options = options || {};
    return new AttributionControl({ position: options.position || 'bottomright', prefix: options.prefix, compact: options.compact });
  };
  api.control.locate = function (options) {
    options = options || {};
    var settings = { position: 'topleft' };
    for (var key in options) settings[key] = options[key];
    return new GeolocateControl(settings);
  };

  if (typeof microMap === 'function' && !microMap.ui) microMap.ui = api;
  return api;
});
