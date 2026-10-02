/*! microMap.maplibre.js v0.2.0 | MIT */
// A MapLibre GL JS shaped entry point: `new Map({ container, style, … })`
// loads a complete style (vector, GeoJSON and raster sources, sprites) and
// returns a map with MapLibre's methods, events, markers, popups and
// controls. It composes the core, vector, camera, compose and UI modules.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./microMap.js'), require('./microMap.vector.js'), require('./microMap.compose.js'),
      require('./microMap.camera.js'), require('./microMap.ui.js'));
  } else {
    root.microMapGL = factory(root, root.microMap, root.microMapVector, root.microMapCompose, root.microMapCamera, root.microMapUI);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, vectorMap, compose, cameraMap, ui) {
  'use strict';

  var VERSION = '0.2.0';
  var DEFAULT_STYLE = { version: 8, sources: {}, layers: [] };
  // Events this facade owns; everything else goes to the composed map.
  var OWN_EVENTS = { load: 1, 'style.load': 1, styledata: 1, sourcedata: 1, data: 1, dataloading: 1, sourcedataloading: 1,
    styledataloading: 1, idle: 1, error: 1, remove: 1, render: 1 };
  var protocols = Object.create(null);
  var warned = Object.create(null);

  function warnOnce(message) {
    if (warned[message]) return;
    warned[message] = true;
    if (root.console && typeof root.console.warn === 'function') root.console.warn('microMap: ' + message);
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = clone(value[key]);
    return result;
  }

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  // ---- LngLat and LngLatBounds ------------------------------------------
  function LngLat(lng, lat) {
    if (!(this instanceof LngLat)) return new LngLat(lng, lat);
    if (!isFinite(+lng) || !isFinite(+lat)) throw new Error('microMap: invalid LngLat (' + lng + ', ' + lat + ')');
    this.lng = +lng;
    this.lat = +lat;
    if (this.lat > 90 || this.lat < -90) throw new Error('microMap: latitude must be between -90 and 90');
  }
  LngLat.prototype.wrap = function () { return new LngLat(((this.lng + 180) % 360 + 360) % 360 - 180, this.lat); };
  LngLat.prototype.toArray = function () { return [this.lng, this.lat]; };
  LngLat.prototype.toString = function () { return 'LngLat(' + this.lng + ', ' + this.lat + ')'; };
  LngLat.prototype.distanceTo = function (other) {
    other = LngLat.convert(other);
    var rad = Math.PI / 180;
    var a = Math.sin((other.lat - this.lat) * rad / 2);
    var b = Math.sin((other.lng - this.lng) * rad / 2);
    var h = a * a + Math.cos(this.lat * rad) * Math.cos(other.lat * rad) * b * b;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  LngLat.convert = function (input) {
    if (input instanceof LngLat) return input;
    if (Array.isArray(input) && input.length >= 2) return new LngLat(input[0], input[1]);
    if (input && typeof input === 'object' && ('lng' in input || 'lon' in input) && 'lat' in input) return new LngLat(input.lng != null ? input.lng : input.lon, input.lat);
    throw new Error('microMap: `LngLatLike` argument must be [lng, lat], { lng, lat } or { lon, lat }');
  };

  function LngLatBounds(sw, ne) {
    if (!(this instanceof LngLatBounds)) return new LngLatBounds(sw, ne);
    if (!sw) return;
    if (ne) this.setSouthWest(sw).setNorthEast(ne);
    else if (Array.isArray(sw) && sw.length === 4) this.setSouthWest([sw[0], sw[1]]).setNorthEast([sw[2], sw[3]]);
    else if (Array.isArray(sw) && sw.length === 2) this.setSouthWest(sw[0]).setNorthEast(sw[1]);
  }
  LngLatBounds.prototype.setSouthWest = function (value) { this._sw = LngLat.convert(value); return this; };
  LngLatBounds.prototype.setNorthEast = function (value) { this._ne = LngLat.convert(value); return this; };
  LngLatBounds.prototype.extend = function (value) {
    var sw;
    var ne;
    if (value instanceof LngLatBounds) { sw = value._sw; ne = value._ne; }
    else if (Array.isArray(value) && (value.length === 4 || Array.isArray(value[0]))) return this.extend(LngLatBounds.convert(value));
    else sw = ne = LngLat.convert(value);
    if (!sw) return this;
    if (!this._sw) {
      this._sw = new LngLat(sw.lng, sw.lat);
      this._ne = new LngLat(ne.lng, ne.lat);
    } else {
      this._sw = new LngLat(Math.min(sw.lng, this._sw.lng), Math.min(sw.lat, this._sw.lat));
      this._ne = new LngLat(Math.max(ne.lng, this._ne.lng), Math.max(ne.lat, this._ne.lat));
    }
    return this;
  };
  LngLatBounds.prototype.getCenter = function () { return new LngLat((this._sw.lng + this._ne.lng) / 2, (this._sw.lat + this._ne.lat) / 2); };
  LngLatBounds.prototype.getSouthWest = function () { return this._sw; };
  LngLatBounds.prototype.getNorthEast = function () { return this._ne; };
  LngLatBounds.prototype.getNorthWest = function () { return new LngLat(this._sw.lng, this._ne.lat); };
  LngLatBounds.prototype.getSouthEast = function () { return new LngLat(this._ne.lng, this._sw.lat); };
  LngLatBounds.prototype.getWest = function () { return this._sw.lng; };
  LngLatBounds.prototype.getSouth = function () { return this._sw.lat; };
  LngLatBounds.prototype.getEast = function () { return this._ne.lng; };
  LngLatBounds.prototype.getNorth = function () { return this._ne.lat; };
  LngLatBounds.prototype.toArray = function () { return [this._sw.toArray(), this._ne.toArray()]; };
  LngLatBounds.prototype.isEmpty = function () { return !(this._sw && this._ne); };
  LngLatBounds.prototype.contains = function (value) {
    var point = LngLat.convert(value);
    var inLng = this._sw.lng <= this._ne.lng ? point.lng >= this._sw.lng && point.lng <= this._ne.lng : point.lng >= this._sw.lng || point.lng <= this._ne.lng;
    return inLng && point.lat >= this._sw.lat && point.lat <= this._ne.lat;
  };
  LngLatBounds.prototype.toString = function () { return 'LngLatBounds(' + this._sw + ', ' + this._ne + ')'; };
  LngLatBounds.convert = function (input) {
    if (input instanceof LngLatBounds) return input;
    if (!input) return input;
    return new LngLatBounds(input);
  };

  function boundsArray(value) {
    var bounds = LngLatBounds.convert(value);
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  }

  // ---- Requests ------------------------------------------------------------
  // addProtocol(scheme, loader) as in MapLibre: loader({ url, type }, abort)
  // resolves to { data }. Requests with that scheme go to the loader.
  function protocolFetch(baseFetch) {
    return function (url, init) {
      var match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(url));
      var loader = match && protocols[match[1].toLowerCase()];
      if (!loader) return baseFetch(url, init);
      var controller = root.AbortController ? new root.AbortController() : null;
      if (init && init.signal && controller) init.signal.addEventListener('abort', function () { controller.abort(); });
      function respond(type) {
        return Promise.resolve(loader({ url: url, type: type, headers: init && init.headers }, controller)).then(function (result) {
          return result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: function () {
          return respond('arrayBuffer').then(function (data) {
            if (data == null) return new ArrayBuffer(0);
            if (data instanceof ArrayBuffer) return data;
            if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            return data;
          });
        },
        json: function () {
          return respond('json').then(function (data) { return typeof data === 'string' ? JSON.parse(data) : data; });
        }
      });
    };
  }

  function fetchJSON(fetcher, request) {
    var init = {};
    if (request.headers) init.headers = request.headers;
    if (request.credentials) init.credentials = request.credentials;
    return Promise.resolve(fetcher(request.url, init)).then(function (response) {
      if (!response || response.ok === false) throw new Error('microMap: request failed' + (response && response.status ? ' (' + response.status + ')' : '') + ': ' + request.url);
      return response.json();
    });
  }

  function absoluteURL(url) {
    try {
      if (typeof root.URL === 'function' && root.location && root.location.href) return new root.URL(url, root.location.href).href;
    } catch (error) {}
    return url;
  }

  // Relative URLs inside a style resolve against the style's own URL.
  function resolveStyleURLs(style, base) {
    if (!base || typeof root.URL !== 'function') return style;
    function resolve(url) {
      if (typeof url !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
      try { return new root.URL(url, base).href.replace(/%7B/g, '{').replace(/%7D/g, '}'); } catch (error) { return url; }
    }
    for (var id in style.sources) {
      var source = style.sources[id];
      if (!source) continue;
      if (source.url) source.url = resolve(source.url);
      if (Array.isArray(source.tiles)) source.tiles = source.tiles.map(resolve);
      if (typeof source.data === 'string') source.data = resolve(source.data);
    }
    if (typeof style.sprite === 'string') style.sprite = resolve(style.sprite);
    else if (Array.isArray(style.sprite)) style.sprite.forEach(function (entry) { if (entry) entry.url = resolve(entry.url); });
    if (typeof style.glyphs === 'string') style.glyphs = resolve(style.glyphs);
    return style;
  }

  // A sky specification's constant colours (expressions fall back).
  function skyOf(sky) {
    if (!sky || typeof sky !== 'object') return {};
    function constant(value) { return typeof value === 'string' ? value : undefined; }
    return {
      skyColor: constant(sky['sky-color']),
      horizonColor: constant(sky['horizon-color']),
      fogColor: constant(sky['fog-color']),
      fogBlend: typeof sky['fog-ground-blend'] === 'number' ? sky['fog-ground-blend'] : undefined
    };
  }

  // ---- Map ---------------------------------------------------------------
  function MapLibreMap(options) {
    if (!(this instanceof MapLibreMap)) return new MapLibreMap(options);
    options = options || {};
    if (typeof microMap !== 'function' || typeof vectorMap !== 'function' || typeof compose !== 'function') {
      throw new Error('microMap.Map: load microMap.js, microMap.vector.js and microMap.compose.js first');
    }
    var self = this;
    var container = options.container;
    if (typeof container === 'string') container = root.document.getElementById(container) || root.document.querySelector(container);
    if (!container) throw new Error('microMap.Map: container not found');
    var interactive = options.interactive !== false;
    function enabled(name) { return interactive && options[name] !== false; }
    var center = options.center != null ? LngLat.convert(options.center).toArray() : null;

    var core = microMap(container, {
      tiles: false,
      // MapLibre zoom levels are defined for 512px tiles.
      tileSize: 512,
      center: center || [0, 0],
      zoom: finite(options.zoom, 0),
      bearing: finite(options.bearing, 0),
      pitch: finite(options.pitch, 0),
      minZoom: finite(options.minZoom, 0),
      maxZoom: finite(options.maxZoom, 22),
      maxPitch: finite(options.maxPitch, 60),
      maxBounds: options.maxBounds ? boundsArray(options.maxBounds) : null,
      dragging: enabled('dragPan'),
      scrollWheelZoom: enabled('scrollZoom'),
      doubleClickZoom: enabled('doubleClickZoom'),
      touchZoom: enabled('touchZoomRotate'),
      keyboard: enabled('keyboard'),
      boxSelect: enabled('boxZoom'),
      boxZoom: enabled('boxZoom'),
      dragRotate: enabled('dragRotate'),
      touchPitch: enabled('touchPitch'),
      pitchWithRotate: options.pitchWithRotate !== false,
      bearingSnap: options.bearingSnap,
      ariaLabel: options.ariaLabel
    });
    var baseFetch = options.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    var fetcher = protocolFetch(baseFetch || function () { return Promise.reject(new Error('microMap.Map: fetch is not available')); });
    var vector = vectorMap(core, {
      tiles: false,
      style: clone(DEFAULT_STYLE),
      strict: false,
      fetch: fetcher,
      worker: options.workerUrl || (options.worker === false ? false : undefined),
      transformRequest: options.transformRequest,
      maxDpr: options.pixelRatio != null ? options.pixelRatio : options.maxDpr,
      webgl: options.webgl
    });
    var view = compose(core, { vectors: [vector], camera: cameraMap ? true : false });
    var listeners = Object.create(null);
    var wrapped = [];
    var styleLoaded = false;
    var loaded = false;
    var removed = false;
    var styleRequest = 0;
    var firstStyle = true;
    var idleTimer = 0;
    var idleSent = false;
    var renderFrame = 0;
    var attributionControl = null;

    function emit(type, extra) {
      var list = listeners[type];
      if (!list || !list.length) return;
      var event = { type: type, target: self };
      if (extra) for (var key in extra) event[key] = extra[key];
      list.slice().forEach(function (handler) { handler.call(self, event); });
    }

    function transform(url, kind) {
      var result = typeof options.transformRequest === 'function' ? options.transformRequest(url, kind) : null;
      if (result == null) return { url: url };
      if (typeof result === 'string') return { url: result };
      return { url: result.url || url, headers: result.headers, credentials: result.credentials };
    }

    // 'idle': no camera movement, every visible tile loaded and painted.
    function activity() {
      idleSent = false;
      if (idleTimer) root.clearTimeout(idleTimer);
      idleTimer = root.setTimeout(checkIdle, 80);
      if (!renderFrame && listeners.render && listeners.render.length) {
        renderFrame = (root.requestAnimationFrame || root.setTimeout).call(root, function () {
          renderFrame = 0;
          emit('render');
        });
      }
    }

    function checkIdle() {
      idleTimer = 0;
      if (removed || idleSent || !styleLoaded || !loaded) return;
      if (!vector.areTilesLoaded()) {
        idleTimer = root.setTimeout(checkIdle, 120);
        return;
      }
      idleSent = true;
      emit('idle');
    }

    function finishLoad() {
      if (loaded || removed || !styleLoaded) return;
      core.whenIdle().then(function () {
        if (loaded || removed) return;
        loaded = true;
        emit('load');
        activity();
      }, function () {});
    }

    function applyStyle(style, token, settings) {
      if (!style || style.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
        throw new Error('microMap.Map: style must be a MapLibre style (version 8)');
      }
      var baseID = null;
      for (var id in style.sources) {
        if (style.sources[id] && style.sources[id].type === 'vector') { baseID = id; break; }
      }
      var base = baseID ? style.sources[baseID] : null;
      var tileJSON = base && !Array.isArray(base.tiles) && typeof base.url === 'string' ? fetchJSON(fetcher, transform(base.url, 'Source')) : Promise.resolve(null);
      return tileJSON.then(function (metadata) {
        if (token !== styleRequest || removed) return;
        var template = base && Array.isArray(base.tiles) ? base.tiles[0] : null;
        var minZoom = base && base.minzoom;
        var maxZoom = base && base.maxzoom;
        if (metadata) {
          var tiles = metadata.tiles && metadata.tiles[0];
          if (typeof tiles !== 'string') throw new Error('microMap.Map: TileJSON of source ' + baseID + ' has no tiles');
          template = new root.URL(tiles, absoluteURL(base.url)).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
          if (minZoom == null) minZoom = metadata.minzoom;
          if (maxZoom == null) maxZoom = metadata.maxzoom;
          if (!base.attribution && metadata.attribution) base.attribution = metadata.attribution;
        }
        vector.setStyle(style, { source: baseID || undefined, strict: false });
        vector.setTiles(template || false, { tileJSON: metadata, minZoom: minZoom == null ? 0 : minZoom, maxZoom: maxZoom == null ? 22 : maxZoom });
        if (firstStyle && !settings.keepCamera) {
          var camera = {};
          if (!center && Array.isArray(style.center)) camera.center = style.center;
          if (options.zoom == null && typeof style.zoom === 'number') camera.zoom = style.zoom;
          if (options.bearing == null && typeof style.bearing === 'number') camera.bearing = style.bearing;
          if (options.pitch == null && typeof style.pitch === 'number') camera.pitch = style.pitch;
          if (camera.center || camera.zoom != null) core.setView(camera.center || core.getCenter(), camera.zoom);
          if (camera.bearing != null) core.setBearing(camera.bearing);
          if (camera.pitch != null) core.setPitch(camera.pitch);
        }
        firstStyle = false;
        core.setSky(style.sky ? skyOf(style.sky) : {});
        if (style.terrain) warnOnce('terrain is not supported yet; the style is drawn on a flat map');
        if (style.projection && style.projection.type && style.projection.type !== 'mercator') warnOnce('only the mercator projection is supported');
        styleLoaded = true;
        if (attributionControl && attributionControl._render) attributionControl._render();
        emit('styledata', { dataType: 'style' });
        emit('data', { dataType: 'style' });
        emit('style.load');
        finishLoad();
        activity();
      });
    }

    function setStyle(style, settings) {
      if (removed) return self;
      settings = settings || {};
      var token = ++styleRequest;
      styleLoaded = false;
      emit('styledataloading', { dataType: 'style' });
      var request = typeof style === 'string' ? transform(absoluteURL(style), 'Style') : null;
      var document = request ? fetchJSON(fetcher, request).then(function (json) { return resolveStyleURLs(json, request.url); })
        : Promise.resolve(clone(style || DEFAULT_STYLE));
      document.then(function (json) {
        if (token !== styleRequest || removed) return;
        if (typeof settings.transformStyle === 'function') json = settings.transformStyle(styleLoaded ? vector.getStyle() : undefined, json);
        return applyStyle(json, token, settings);
      }).catch(function (error) {
        if (token !== styleRequest || removed) return;
        emit('error', { error: error });
        if (!(listeners.error && listeners.error.length) && root.console && root.console.error) root.console.error(error);
      });
      return self;
    }

    function on(type, layerID, handler) {
      if (typeof layerID === 'function') { handler = layerID; layerID = undefined; }
      if (typeof handler !== 'function') return self;
      if (OWN_EVENTS[type] && layerID === undefined) {
        (listeners[type] || (listeners[type] = [])).push(handler);
        return self;
      }
      // Composed events carry this map as their target, like MapLibre.
      var proxy = function (event) {
        if (event && (event.target === view || event.target === core)) event.target = self;
        return handler.call(self, event);
      };
      wrapped.push({ type: type, layer: layerID, handler: handler, proxy: proxy });
      if (layerID === undefined) view.on(type, proxy);
      else view.on(type, layerID, proxy);
      return self;
    }

    function off(type, layerID, handler) {
      if (typeof layerID === 'function') { handler = layerID; layerID = undefined; }
      if (OWN_EVENTS[type] && layerID === undefined) {
        var list = listeners[type];
        if (list) {
          var index = list.indexOf(handler);
          if (index < 0) for (index = 0; index < list.length; index++) if (list[index]._original === handler) break;
          if (index > -1 && index < list.length) list.splice(index, 1);
        }
        return self;
      }
      for (var i = wrapped.length - 1; i >= 0; i--) {
        var entry = wrapped[i];
        if (entry.type !== type || entry.layer !== layerID || (handler && entry.handler !== handler && entry.handler._original !== handler)) continue;
        if (layerID === undefined) view.off(type, entry.proxy);
        else view.off(type, layerID, entry.proxy);
        wrapped.splice(i, 1);
      }
      return self;
    }

    function once(type, layerID, handler) {
      if (typeof layerID === 'function') { handler = layerID; layerID = undefined; }
      if (typeof handler !== 'function') {
        // MapLibre: once(type) without a handler returns a Promise.
        return new Promise(function (resolve) { once(type, layerID, resolve); });
      }
      function single(event) {
        off(type, layerID, single);
        handler.call(self, event);
      }
      single._original = handler;
      return on(type, layerID, single);
    }

    // Every composed method, returning this map where it returned the
    // composed one (so calls chain as in MapLibre).
    Object.keys(view).forEach(function (key) {
      if (typeof view[key] !== 'function' || key in MapLibreMap.prototype) return;
      self[key] = function () {
        var result = view[key].apply(view, arguments);
        return result === view ? self : result;
      };
    });
    ['dragPan', 'scrollZoom', 'doubleClickZoom', 'keyboard', 'boxZoom', 'dragRotate', 'touchPitch', 'touchZoomRotate'].forEach(function (name) {
      if (view[name]) self[name] = view[name];
    });
    this.vectors = view.vectors;
    this._core = core;
    this._vector = vector;
    this._view = view;
    this.on = on;
    this.off = off;
    this.once = once;
    this.setStyle = setStyle;
    this.getStyle = function () { return vector.getStyle(); };
    this.isStyleLoaded = function () { return styleLoaded; };
    this.loaded = function () { return loaded && !removed && vector.areTilesLoaded(); };
    this.areTilesLoaded = function () { return vector.areTilesLoaded(); };
    this.isSourceLoaded = function () { return vector.areTilesLoaded(); };
    this.getContainer = function () { return container; };
    this.getCanvasContainer = function () { return container; };
    this.triggerRepaint = function () { vector.redraw(); return self; };
    this.redraw = this.triggerRepaint;
    this.getSky = function () { return core.getSky(); };
    this.setSky = function (sky) { core.setSky(sky ? skyOf(sky) : false); return self; };
    this.setTerrain = function (terrain) { if (terrain) warnOnce('terrain is not supported yet'); return self; };
    this.getTerrain = function () { return null; };
    this.setProjection = function (projection) {
      if (projection && projection.type && projection.type !== 'mercator') warnOnce('only the mercator projection is supported');
      return self;
    };
    this.getProjection = function () { return { type: 'mercator' }; };
    this.setLight = function () { return self; };
    this.getPixelRatio = function () { return Math.min(finite(root.devicePixelRatio, 1), 2); };
    this.getMaxBounds = function () { return options.maxBounds ? LngLatBounds.convert(options.maxBounds) : null; };
    this.setMaxBounds = function (bounds) {
      options.maxBounds = bounds || null;
      core.setMaxBounds(bounds ? boundsArray(bounds) : null);
      return self;
    };
    this.getBounds = function () {
      var box = core.getBounds();
      return new LngLatBounds([box[0], box[1]], [box[2], box[3]]);
    };
    this.getCenter = function () { var value = core.getCenter(); return new LngLat(value[0], value[1]); };
    this.project = function (lngLat) {
      var point = core.project(LngLat.convert(lngLat).toArray());
      return { x: point[0], y: point[1] };
    };
    this.unproject = function (point) {
      var value = core.unproject(Array.isArray(point) ? point : [point.x, point.y]);
      return new LngLat(value[0], value[1]);
    };
    this.fitBounds = function (bounds, fit) {
      view.fitBounds(boundsArray(bounds), fit);
      return self;
    };
    this.cameraForBounds = function (bounds, fit) { return view.cameraForBounds(boundsArray(bounds), fit); };
    this.isMoving = function () { return moving; };
    this.isZooming = function () { return zooming; };
    this.isRotating = function () { return rotating; };
    this.addControl = function (control, position) {
      if (!ui) throw new Error('microMap.Map: load microMap.ui.js for controls');
      ui.addControl(self, control, position);
      return self;
    };
    this.removeControl = function (control) { if (ui) ui.removeControl(self, control); return self; };
    this.hasControl = function (control) { return !!ui && ui.hasControl(self, control); };
    function ease(target, settings) {
      var next = {};
      var key;
      for (key in settings || {}) next[key] = settings[key];
      for (key in target) next[key] = target[key];
      if (next.duration == null) next.duration = 300;
      if (view.camera) view.camera.easeTo(next);
      else {
        if (next.zoom != null) core.setZoom(next.zoom);
        if (next.bearing != null) core.setBearing(next.bearing);
        if (next.pitch != null) core.setPitch(next.pitch);
      }
      return self;
    }
    this.zoomTo = function (zoom, settings) { return ease({ zoom: zoom }, settings); };
    this.zoomIn = function (settings) { return ease({ zoom: core.getZoom() + 1 }, settings); };
    this.zoomOut = function (settings) { return ease({ zoom: core.getZoom() - 1 }, settings); };
    this.rotateTo = function (bearing, settings) { return ease({ bearing: bearing }, settings); };
    this.resetNorth = function (settings) { return ease({ bearing: 0 }, settings); };
    this.resetNorthPitch = function (settings) { return ease({ bearing: 0, pitch: 0 }, settings); };
    this.snapToNorth = function (settings) {
      var bearing = core.getBearing();
      if (Math.abs(bearing > 180 ? bearing - 360 : bearing) < finite(options.bearingSnap, 7)) return ease({ bearing: 0 }, settings);
      return self;
    };
    this.stop = function () { if (view.camera) view.camera.cancelCamera(); return self; };
    this.getMinZoom = function () { return core.getMinZoom(); };
    this.getMaxZoom = function () { return core.getMaxZoom(); };
    this.setMinZoom = function (zoom) { core.setMinZoom(zoom == null ? 0 : zoom); return self; };
    this.setMaxZoom = function (zoom) { core.setMaxZoom(zoom == null ? 22 : zoom); return self; };
    var minPitch = finite(options.minPitch, 0);
    this.getMinPitch = function () { return minPitch; };
    this.setMinPitch = function (pitch) {
      minPitch = Math.max(0, finite(pitch, 0));
      if (core.getPitch() < minPitch) core.setPitch(minPitch);
      return self;
    };
    this.getMaxPitch = function () { return core.getMaxPitch(); };
    this.setMaxPitch = function (pitch) { core.setMaxPitch(pitch == null ? 60 : pitch); return self; };
    this.querySourceFeatures = function (sourceId, settings) { return vector.querySourceFeatures(sourceId, settings); };
    this.setLayerZoomRange = function (id, minzoom, maxzoom) { vector.setLayerZoomRange(id, minzoom, maxzoom); return self; };
    this.getLayersOrder = function () { return vector.getLayers().map(function (layer) { return layer.id; }); };
    this.getMap = function () { return core; };
    this.remove = function () {
      if (removed) return;
      removed = true;
      if (idleTimer) root.clearTimeout(idleTimer);
      emit('remove');
      view.remove();
      listeners = Object.create(null);
    };

    var moving = false;
    var zooming = false;
    var rotating = false;
    core.on('move', function () { moving = true; activity(); });
    core.on('moveend', function () { moving = false; activity(); });
    core.on('zoom', function () { zooming = true; });
    core.on('zoomend', function () { zooming = false; });
    core.on('rotate', function () { rotating = true; });
    core.on('rotateend', function () { rotating = false; });
    vector.on('tileload', function (event) {
      activity();
      emit('sourcedata', { dataType: 'source', sourceId: event.source, sourceDataType: 'content', tile: { z: event.z, x: event.x, y: event.y } });
      emit('data', { dataType: 'source', sourceId: event.source });
    });
    vector.on('sourcedata', function (event) {
      emit('sourcedata', { dataType: 'source', sourceId: event.source, sourceDataType: 'metadata', isSourceLoaded: true });
    });
    ['tileerror', 'sourceerror', 'error'].forEach(function (type) {
      vector.on(type, function (event) { emit('error', { error: event.error || new Error('microMap: ' + type), sourceId: event.source }); });
    });
    vector.on('spriteload', activity);

    if (ui && options.attributionControl !== false) {
      attributionControl = new ui.AttributionControl(options.attributionControl && typeof options.attributionControl === 'object' ? options.attributionControl : {});
      self.addControl(attributionControl, 'bottom-right');
    }
    if (options.bounds) {
      core.once('load', function () { self.fitBounds(options.bounds, options.fitBoundsOptions); });
    }
    if (options.hash && view.camera && typeof view.camera.linkHash === 'function') {
      view.camera.linkHash(typeof options.hash === 'string' ? { prefix: options.hash } : {});
    }
    setStyle(options.style == null ? DEFAULT_STYLE : options.style, {});
  }

  // A control that toggles fullscreen for the map container.
  function FullscreenControl(options) {
    if (!(this instanceof FullscreenControl)) return new FullscreenControl(options);
    this.options = options || {};
  }
  FullscreenControl.prototype.onAdd = function (map) {
    var container = this.options.container || map.getContainer();
    var group = root.document.createElement('div');
    group.className = 'micromap-ctrl micromap-ctrl-group';
    var button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'micromap-ctrl-fullscreen';
    button.setAttribute('aria-label', 'Enter fullscreen');
    button.textContent = '⛶';
    button.addEventListener('click', function () {
      var doc = root.document;
      if (doc.fullscreenElement) doc.exitFullscreen();
      else if (container.requestFullscreen) container.requestFullscreen();
    });
    this._onChange = function () {
      var active = root.document.fullscreenElement === container;
      button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
      map.resize();
    };
    root.document.addEventListener('fullscreenchange', this._onChange);
    group.appendChild(button);
    return group;
  };
  FullscreenControl.prototype.onRemove = function () {
    root.document.removeEventListener('fullscreenchange', this._onChange);
  };
  FullscreenControl.prototype.getDefaultPosition = function () { return 'top-right'; };

  var api = {
    Map: MapLibreMap,
    LngLat: LngLat,
    LngLatBounds: LngLatBounds,
    FullscreenControl: FullscreenControl,
    version: VERSION,
    getVersion: function () { return VERSION; },
    addProtocol: function (scheme, loader) {
      if (typeof scheme !== 'string' || typeof loader !== 'function') throw new Error('microMap: addProtocol(scheme, loader)');
      protocols[scheme.toLowerCase()] = loader;
    },
    removeProtocol: function (scheme) { delete protocols[String(scheme).toLowerCase()]; },
    // MapLibre's worker, RTL and parallel-request settings have no effect.
    setWorkerUrl: function () {},
    getWorkerUrl: function () { return ''; },
    setWorkerCount: function () {},
    getWorkerCount: function () { return 1; },
    setMaxParallelImageRequests: function () {},
    getMaxParallelImageRequests: function () { return 16; },
    setRTLTextPlugin: function () { return Promise.resolve(); },
    getRTLTextPluginStatus: function () { return 'unavailable'; },
    prewarm: function () {},
    clearPrewarmedResources: function () {}
  };
  if (ui) {
    ['Marker', 'Popup', 'NavigationControl', 'ScaleControl', 'GeolocateControl', 'AttributionControl'].forEach(function (name) {
      if (ui[name]) api[name] = ui[name];
    });
  }
  if (typeof microMap === 'function') {
    microMap.Map = MapLibreMap;
    microMap.LngLat = LngLat;
    microMap.LngLatBounds = LngLatBounds;
    microMap.addProtocol = api.addProtocol;
    microMap.removeProtocol = api.removeProtocol;
    if (!microMap.maplibre) microMap.maplibre = api;
  }
  return api;
});
