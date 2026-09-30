/*! microMap.compose.js v0.1.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./microMap.js'), require('./microMap.geojson.js'), require('./microMap.camera.js'));
  } else root.microMapCompose = factory(root, root.microMap, root.microMapGeoJSON, root.microMapCamera);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, geoJSONMap, cameraMap) {
  'use strict';

  function unsupported(name) {
    throw new Error('microMap.compose: ' + name + ' is not supported by the selected add-ons');
  }

  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;

  // Mouse events MapLibre fires from the pointer, independently of the
  // core's camera events. Layer-scoped variants query rendered features.
  var POINTER_TYPES = { mousemove: 1, mousedown: 1, mouseup: 1, mouseover: 1, mouseout: 1, dblclick: 1, touchstart: 1, touchend: 1 };
  var HOVER_TYPES = { mousemove: 1, mouseenter: 1, mouseleave: 1, mouseover: 1, mouseout: 1 };

  // MapLibre shapes on MicroMap values: [x, y] with .x/.y, [lng, lat] with .lng/.lat.
  function pointValue(point) {
    var value = [point[0], point[1]];
    value.x = point[0];
    value.y = point[1];
    return value;
  }

  function lngLatValue(lonLat) {
    var value = [lonLat[0], lonLat[1]];
    value.lng = lonLat[0];
    value.lat = lonLat[1];
    return value;
  }

  // Accepts [lng, lat], { lng, lat }, { lon, lat } and [x, y], { x, y }.
  function lngLatArray(value) {
    if (Array.isArray(value)) return [+value[0], +value[1]];
    if (value && typeof value === 'object') return [+(value.lng != null ? value.lng : value.lon), +value.lat];
    return value;
  }

  function pointArray(value) {
    if (Array.isArray(value)) return [+value[0], +value[1]];
    if (value && typeof value === 'object') return [+value.x, +value.y];
    return value;
  }

  // MapLibre's LngLatBounds methods on MicroMap's [west, south, east, north].
  function boundsValue(bounds) {
    var value = bounds.slice();
    value.getWest = function () { return bounds[0]; };
    value.getSouth = function () { return bounds[1]; };
    value.getEast = function () { return bounds[2]; };
    value.getNorth = function () { return bounds[3]; };
    value.getSouthWest = function () { return lngLatValue([bounds[0], bounds[1]]); };
    value.getNorthEast = function () { return lngLatValue([bounds[2], bounds[3]]); };
    value.getNorthWest = function () { return lngLatValue([bounds[0], bounds[3]]); };
    value.getSouthEast = function () { return lngLatValue([bounds[2], bounds[1]]); };
    value.getCenter = function () { return lngLatValue([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]); };
    value.contains = function (point) {
      var p = lngLatArray(point);
      return p[0] >= bounds[0] && p[0] <= bounds[2] && p[1] >= bounds[1] && p[1] <= bounds[3];
    };
    value.toArray = function () { return [[bounds[0], bounds[1]], [bounds[2], bounds[3]]]; };
    return value;
  }

  function decorate(event) {
    if (event && Array.isArray(event.point) && event.point.x === undefined) {
      event.point.x = event.point[0];
      event.point.y = event.point[1];
    }
    if (event && event.lngLat === undefined && Array.isArray(event.lonLat)) event.lngLat = lngLatValue(event.lonLat);
    return event;
  }

  function canvasZIndex(module, fallback) {
    var canvas = module && typeof module.getCanvas === 'function' ? module.getCanvas() : null;
    var value = canvas && canvas.style ? parseInt(canvas.style.zIndex, 10) : NaN;
    return isFinite(value) ? value : fallback;
  }

  function compose(map, options) {
    if (typeof microMap !== 'function' || !map || typeof map.getContainer !== 'function') {
      throw new Error('microMap.compose: pass a microMap instance');
    }
    options = options || {};
    var overlays = options.overlays || null;
    var ownOverlays = false;
    var vectors = options.vectors || options.vector || [];
    var camera = options.camera === false ? null : options.camera || null;
    var ownCamera = false;
    var destroyed = false;
    var removed = false;
    var subscriptions = [];
    var styleLoadTimer = 0;
    var styleDataTimer = 0;

    if (!Array.isArray(vectors)) vectors = [vectors];
    vectors = vectors.filter(function (layer) { return !!layer; });
    if (options.geojson && !overlays) {
      var factory = typeof options.geojson === 'function' ? options.geojson : geoJSONMap;
      if (typeof factory !== 'function') throw new Error('microMap.compose: load microMap.geojson.js for GeoJSON sources');
      overlays = factory(map, options.geojson === true ? {} : options.geojson);
      ownOverlays = true;
    }
    if (camera === true) {
      if (typeof cameraMap !== 'function') throw new Error('microMap.compose: load microMap.camera.js for camera helpers');
      camera = cameraMap(map, options.cameraOptions);
      ownCamera = true;
    }

    function orderedQueryModules() {
      var modules = [];
      if (overlays && typeof overlays.queryRenderedFeatures === 'function') modules.push(overlays);
      for (var i = 0; i < vectors.length; i++) if (typeof vectors[i].queryRenderedFeatures === 'function') modules.push(vectors[i]);
      return modules.sort(function (a, b) { return canvasZIndex(b, 1) - canvasZIndex(a, 1); });
    }

    function queryRenderedFeatures(point, queryOptions) {
      if (destroyed) return [];
      var result = [];
      var modules = orderedQueryModules();
      for (var i = 0; i < modules.length; i++) result = result.concat(modules[i].queryRenderedFeatures(point, queryOptions));
      return result;
    }

    var VECTOR_EVENTS = { styleimagemissing: true, spriteload: true, tileload: true, tileerror: true, sourcedata: true, sourceerror: true };
    var STYLE_EVENTS = { 'style.load': true, styledata: true };

    function emitStyle(type) {
      if (destroyed) return;
      var event = { type: type, target: api };
      subscriptions.slice().forEach(function (entry) {
        if (entry.local && entry.type === type) entry.handler(event);
      });
    }

    function scheduleStyleData() {
      if (destroyed || styleDataTimer) return;
      styleDataTimer = root.setTimeout(function () {
        styleDataTimer = 0;
        emitStyle('styledata');
      }, 0);
    }

    function imageAPI(method, query) {
      return function () {
        var owner = vectors[0];
        if (!has(owner, method)) {
          if (query) return method === 'listImages' ? [] : false;
          unsupported(method + '; images need microMap.vector.js');
        }
        var result = owner[method].apply(owner, arguments);
        return query ? result : api;
      };
    }

    function stateOwner(feature, method) {
      var owner = (feature && vectorOwning('source', feature.source)) || vectors[0];
      if (!has(owner, method)) unsupported(method + '; feature state needs microMap.vector.js');
      return owner;
    }

    function has(module, method) {
      return !!module && typeof module[method] === 'function';
    }

    // Layer and source calls go to the surface that owns the id: a vector
    // layer (MapLibre style, vector or GeoJSON sources) or the GeoJSON
    // overlay. New GeoJSON sources prefer an existing overlay.
    function vectorOwning(kind, id) {
      for (var i = 0; i < vectors.length; i++) {
        var vector = vectors[i];
        if (kind === 'layer' && has(vector, 'getLayer') && vector.getLayer(id) !== undefined) return vector;
        if (kind === 'source' && has(vector, 'getSource') && (vector.getSource(id) != null ||
          (has(vector, 'getStyleReport') && vector.getStyleReport() && vector.getStyleReport().source === id))) return vector;
      }
      return null;
    }

    function ownerOf(method, args) {
      var id = args[0];
      if (method === 'addLayer') {
        var source = id && id.source;
        if (overlays && has(overlays, 'getSource') && overlays.getSource(source) != null) return overlays;
        return vectorOwning('source', source) || (has(overlays, method) ? overlays : vectors[0]);
      }
      if (method === 'addSource') {
        // Raster layers must share the vector canvas to keep their position
        // among fills, roads and labels. The GeoJSON overlay owns its own
        // independently ordered sources by default.
        if (args[1] && (args[1].type === 'raster' || args[1].type === 'vector')) return vectors[0];
        return has(overlays, method) ? overlays : vectors[0];
      }
      if (method === 'getSource' || method === 'removeSource') {
        if (overlays && has(overlays, 'getSource') && overlays.getSource(id) != null) return overlays;
        return vectorOwning('source', id) || overlays;
      }
      return vectorOwning('layer', id) || overlays;
    }

    function layerAPI(method) {
      var query = method === 'getSource' || method === 'getLayer' || method === 'getPaintProperty' || method === 'getLayoutProperty' || method === 'getFilter';
      return function () {
        if (destroyed) return query ? undefined : api;
        if (method === 'addSource' && (vectorOwning('source', arguments[0]) ||
          (overlays && has(overlays, 'getSource') && overlays.getSource(arguments[0]) != null))) {
          throw new Error('microMap.compose: source already exists: ' + arguments[0]);
        }
        var owner = ownerOf(method, arguments);
        if (!has(owner, method)) {
          if (query) return undefined;
          unsupported(method);
        }
        var result = owner[method].apply(owner, arguments);
        // Style changes can change which sources need credit.
        if (!query && root.microMapUI && typeof root.microMapUI.refresh === 'function') root.microMapUI.refresh(api);
        else if (!query && microMap && microMap.ui && typeof microMap.ui.refresh === 'function') microMap.ui.refresh(api);
        if (!query) scheduleStyleData();
        return query ? (result == null ? undefined : result) : api;
      };
    }

    // ---- Pointer and layer events ------------------------------------------
    // Layer events work for vector layers (MapLibre styles, GeoJSON sources)
    // and overlay layers: the pointer position is queried against the
    // rendered features. Hover state is evaluated at most once per frame.
    var container = map.getContainer();
    var pointerListening = false;
    var coreListening = false;
    var hoverFrame = 0;
    var pendingHover = null;
    var hovered = Object.create(null);
    var cursorApplied = '';

    function managed(type, layerID) {
      return subscriptions.filter(function (entry) { return entry.managed && entry.type === type && (layerID === undefined || entry.layer === layerID); });
    }

    function localPoint(event) {
      var rect = container.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    function mapEvent(type, point, originalEvent, features) {
      var lonLat = map.unproject(point);
      var event = { type: type, target: api, map: map, point: pointValue(point), lngLat: lngLatValue(lonLat), lonLat: lonLat, originalEvent: originalEvent };
      if (features) event.features = features;
      return event;
    }

    function fire(entries, event) {
      for (var i = 0; i < entries.length; i++) entries[i].handler(event);
    }

    // Fires layer-scoped handlers of one type with that layer's features.
    function fireLayers(type, point, originalEvent) {
      var entries = managed(type).filter(function (entry) { return entry.layer != null; });
      if (!entries.length) return;
      var ids = entries.map(function (entry) { return entry.layer; });
      var byLayer = groupByLayer(queryRenderedFeatures(point, { layers: ids }));
      for (var i = 0; i < entries.length; i++) {
        var features = byLayer[entries[i].layer];
        if (features) entries[i].handler(mapEvent(type, point, originalEvent, features));
      }
      mirrorCursor();
    }

    function groupByLayer(features) {
      var byLayer = Object.create(null);
      for (var i = 0; i < features.length; i++) {
        var id = features[i].layer && features[i].layer.id;
        if (id != null) (byLayer[id] || (byLayer[id] = [])).push(features[i]);
      }
      return byLayer;
    }

    function onMapPointer(event) {
      var isMap = event.target === container;
      var type = event.type;
      if (type === 'pointerleave') {
        fire(managed('mouseout', null), mapEvent('mouseout', localPoint(event), event));
        scheduleHover(null);
        return;
      }
      if (!isMap) {
        // The pointer is over a marker, popup or control, not the map.
        if (type === 'pointermove') scheduleHover(null);
        return;
      }
      var point = localPoint(event);
      if (type === 'pointermove') {
        fire(managed('mousemove', null), mapEvent('mousemove', point, event));
        scheduleHover({ point: point, event: event });
      } else if (type === 'pointerdown' || type === 'pointerup') {
        var mouse = type === 'pointerdown' ? 'mousedown' : 'mouseup';
        if (event.pointerType === 'touch') fire(managed(type === 'pointerdown' ? 'touchstart' : 'touchend', null), mapEvent(type === 'pointerdown' ? 'touchstart' : 'touchend', point, event));
        fire(managed(mouse, null), mapEvent(mouse, point, event));
        fireLayers(mouse, point, event);
        // The core resets the cursor to 'grab' when a drag or click ends.
        mirrorCursor();
      } else if (type === 'pointerenter') {
        fire(managed('mouseover', null), mapEvent('mouseover', point, event));
      } else if (type === 'dblclick') {
        fire(managed('dblclick', null), mapEvent('dblclick', point, event));
        fireLayers('dblclick', point, event);
      }
    }

    function onCoreEvent(event) {
      decorate(event);
      if (event && event.point) fireLayers(event.type, event.point, event.originalEvent);
    }

    function scheduleHover(value) {
      if (!subscriptions.some(function (entry) { return entry.managed && entry.layer != null && HOVER_TYPES[entry.type]; })) return;
      pendingHover = value;
      if (!hoverFrame) hoverFrame = requestFrame.call(root, processHover);
    }

    function processHover() {
      hoverFrame = 0;
      var pending = pendingHover;
      pendingHover = null;
      if (destroyed) return;
      var ids = [];
      subscriptions.forEach(function (entry) {
        if (entry.managed && entry.layer != null && HOVER_TYPES[entry.type] && ids.indexOf(entry.layer) < 0) ids.push(entry.layer);
      });
      // A pressed primary button is a map drag: keep the hover state.
      if (pending && pending.event.buttons & 1) return;
      var byLayer = pending && ids.length ? groupByLayer(queryRenderedFeatures(pending.point, { layers: ids })) : {};
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var features = byLayer[id];
        var point = pending ? pending.point : [0, 0];
        var original = pending ? pending.event : null;
        if (features && !hovered[id]) {
          hovered[id] = true;
          fire(managed('mouseenter', id), mapEvent('mouseenter', point, original, features));
          fire(managed('mouseover', id), mapEvent('mouseover', point, original, features));
        }
        if (features) fire(managed('mousemove', id), mapEvent('mousemove', point, original, features));
        else if (hovered[id]) {
          hovered[id] = false;
          fire(managed('mouseleave', id), mapEvent('mouseleave', point, original));
          fire(managed('mouseout', id), mapEvent('mouseout', point, original));
        }
      }
      mirrorCursor();
    }

    // MapLibre code sets map.getCanvas().style.cursor. MicroMap canvases
    // ignore the pointer, so the requested cursor is applied to the container.
    function mirrorCursor() {
      var canvas = getCanvas();
      if (!canvas || canvas === container || !canvas.style) return;
      var wanted = canvas.style.cursor || '';
      var current = container.style.cursor;
      if (wanted) {
        if (current !== wanted && current !== 'grabbing' && current !== 'crosshair') container.style.cursor = wanted;
        cursorApplied = wanted;
      } else if (cursorApplied) {
        if (current === cursorApplied) container.style.cursor = 'grab';
        cursorApplied = '';
      }
    }

    function listen(type) {
      if ((POINTER_TYPES[type] || HOVER_TYPES[type]) && !pointerListening && typeof container.addEventListener === 'function') {
        pointerListening = true;
        ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'pointerenter', 'dblclick'].forEach(function (name) { container.addEventListener(name, onMapPointer); });
      }
      if ((type === 'click' || type === 'contextmenu') && !coreListening) {
        coreListening = true;
        map.on('click', onCoreEvent).on('contextmenu', onCoreEvent);
      }
    }

    function unlisten() {
      if (pointerListening) ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'pointerenter', 'dblclick'].forEach(function (name) { container.removeEventListener(name, onMapPointer); });
      if (coreListening) map.off('click', onCoreEvent).off('contextmenu', onCoreEvent);
      if (hoverFrame) cancelFrame.call(root, hoverFrame);
      pointerListening = coreListening = false;
      hoverFrame = 0;
    }

    function on(type, layerID, handler) {
      if (typeof layerID === 'function') {
        handler = layerID;
        layerID = null;
      }
      if (destroyed || typeof handler !== 'function') return api;
      var entry = { type: type, layer: layerID == null ? null : layerID, handler: handler };
      if (layerID != null && type === 'click' && overlays && has(overlays, 'getLayer') && overlays.getLayer(layerID) !== undefined && !vectorOwning('layer', layerID)) {
        // Overlay layers keep the GeoJSON add-on's own click events.
        overlays.on(type, layerID, handler);
        entry.overlay = true;
      } else if (layerID == null && STYLE_EVENTS[type]) {
        entry.local = true;
      } else if (layerID != null || POINTER_TYPES[type]) {
        entry.managed = true;
        listen(type);
      } else if (VECTOR_EVENTS[type]) {
        // Image and sprite events come from the vector renderers.
        entry.vector = true;
        entry.handler = function (event) { var copy = {}; for (var k in event) copy[k] = event[k]; copy.target = api; handler(copy); };
        entry.handler.original = handler;
        for (var v = 0; v < vectors.length; v++) if (has(vectors[v], 'on')) vectors[v].on(type, entry.handler);
      } else {
        // Core camera and click events, with MapLibre's lngLat/point shapes.
        entry.handler = function (event) { handler(decorate(event)); };
        entry.handler.original = handler;
        map.on(type, entry.handler);
      }
      subscriptions.push(entry);
      return api;
    }

    function off(type, layerID, handler) {
      if (typeof layerID === 'function') {
        handler = layerID;
        layerID = null;
      }
      if (layerID == null) layerID = null;
      subscriptions = subscriptions.filter(function (entry) {
        var matches = entry.type === type && entry.layer === layerID && (!handler || wraps(entry.handler, handler));
        if (matches) {
          if (entry.overlay) overlays.off(type, layerID, entry.handler);
          else if (entry.vector) for (var v = 0; v < vectors.length; v++) { if (has(vectors[v], 'off')) vectors[v].off(type, entry.handler); }
          else if (!entry.managed && !entry.local) map.off(type, entry.handler);
          else if (layerID != null && !managed(type, layerID).some(function (other) { return other !== entry; })) delete hovered[layerID];
        }
        return !matches;
      });
      return api;
    }

    // Handlers may be wrapped twice (once() and the MapLibre event shape).
    function wraps(candidate, handler) {
      for (; candidate; candidate = candidate.original) if (candidate === handler) return true;
      return false;
    }

    function once(type, layerID, handler) {
      if (typeof layerID === 'function') {
        handler = layerID;
        layerID = null;
      }
      if (typeof handler !== 'function') return api;
      function single(event) { off(type, layerID, single); handler(event); }
      single.original = handler;
      return on(type, layerID, single);
    }

    function getCanvas() {
      for (var i = 0; i < vectors.length; i++) if (has(vectors[i], 'getCanvas')) return vectors[i].getCanvas();
      return has(overlays, 'getCanvas') ? overlays.getCanvas() : container;
    }

    function uiModule(name) {
      var ui = root.microMapUI || (microMap && microMap.ui);
      if (!ui || typeof ui[name] !== 'function') unsupported(name + '; load microMap.ui.js');
      return ui;
    }

    // Attribution HTML of the sources that visible layers use (as MapLibre),
    // from the vectors' style sources and TileJSON.
    function getAttributions() {
      var result = [];
      function add(value) { if (typeof value === 'string' && value && result.indexOf(value) < 0) result.push(value); }
      vectors.forEach(function (layer) {
        var report = has(layer, 'getStyleReport') ? layer.getStyleReport() : null;
        var credits = report && report.attributions || {};
        var used = Object.create(null);
        var layers = has(layer, 'getLayers') ? layer.getLayers() : [];
        layers.forEach(function (entry) {
          if (!entry.layout || entry.layout.visibility !== 'none') used[entry.source || (report && report.source)] = true;
        });
        for (var id in credits) if (used[id] || !layers.length) add(credits[id]);
        var tileJSON = has(layer, 'getTileJSON') ? layer.getTileJSON() : null;
        if (tileJSON) add(tileJSON.attribution);
      });
      return result;
    }

    function coreAPI(method, cancel) {
      return function () {
        if (destroyed) return api;
        if (cancel && camera) camera.cancelCamera();
        var result = map[method].apply(map, arguments);
        return method === 'addMarker' || method === 'addRoute' ? result : api;
      };
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (styleLoadTimer) root.clearTimeout(styleLoadTimer);
      if (styleDataTimer) root.clearTimeout(styleDataTimer);
      styleLoadTimer = styleDataTimer = 0;
      map.off('destroy', destroy);
      subscriptions.slice().forEach(function (entry) { off(entry.type, entry.layer, entry.handler); });
      unlisten();
      if (ownCamera && camera && typeof camera.destroy === 'function') camera.destroy();
      if (ownOverlays && overlays && typeof overlays.destroy === 'function') overlays.destroy();
    }

    // Explicit whole-map teardown for applications that own the map surface.
    // destroy() alone deliberately leaves externally supplied surfaces alive.
    function remove() {
      if (removed) return;
      removed = true;
      destroy();
      if (camera && typeof camera.destroy === 'function') camera.destroy();
      if (overlays && typeof overlays.destroy === 'function') overlays.destroy();
      vectors.forEach(function (layer) { if (typeof layer.destroy === 'function') layer.destroy(); });
      map.destroy();
    }

    var api = {
      isMicroMapCompose: true,
      map: map,
      overlays: overlays,
      vectors: vectors.slice(),
      camera: camera,
      getMap: function () { return map; },
      loaded: function () { return !destroyed && (typeof map.loaded !== 'function' || map.loaded()); },
      isStyleLoaded: function () { return !destroyed; },
      areTilesLoaded: function () {
        if (destroyed) return false;
        for (var i = 0; i < vectors.length; i++) {
          if (has(vectors[i], 'areTilesLoaded') && !vectors[i].areTilesLoaded()) return false;
        }
        return true;
      },
      getStyle: function () {
        if (destroyed) return undefined;
        var snapshot = vectors.length && has(vectors[0], 'getStyle') ? vectors[0].getStyle() : null;
        var overlayStyle = has(overlays, 'getStyle') ? overlays.getStyle() : null;
        if (!snapshot) return overlayStyle || undefined;
        if (overlayStyle) {
          for (var id in overlayStyle.sources) snapshot.sources[id] = overlayStyle.sources[id];
          snapshot.layers = snapshot.layers.concat(overlayStyle.layers);
        }
        return snapshot;
      },
      getContainer: function () { return map.getContainer(); },
      getCenter: function () { return lngLatValue(map.getCenter()); },
      getZoom: function () { return map.getZoom(); },
      getBearing: function () { return map.getBearing(); },
      getPitch: function () { return map.getPitch(); },
      getBounds: function () { return boundsValue(map.getBounds()); },
      project: function (lngLat) { return pointValue(map.project(lngLatArray(lngLat))); },
      unproject: function (point) { return lngLatValue(map.unproject(pointArray(point))); },
      setView: function (center, zoom) { return coreAPI('setView', true)(lngLatArray(center), zoom); },
      setCenter: function (center) { return coreAPI('setCenter', true)(lngLatArray(center)); },
      setZoom: coreAPI('setZoom', true),
      fitBounds: function (bounds, padding) {
        if (destroyed) return api;
        if (camera && typeof camera.fitBounds === 'function') camera.fitBounds(bounds, padding);
        else {
          if (padding && typeof padding === 'object' && !Array.isArray(padding)) unsupported('fitBounds options; load microMap.camera.js');
          map.fitBounds(bounds, padding);
        }
        return api;
      },
      cameraForBounds: function (bounds, options) {
        if (!camera || !camera.cameraForBounds) unsupported('cameraForBounds; load microMap.camera.js');
        return camera.cameraForBounds(bounds, options);
      },
      panBy: coreAPI('panBy', true),
      setBearing: coreAPI('setBearing', true),
      setPitch: coreAPI('setPitch', true),
      resize: coreAPI('resize'),
      setTiles: coreAPI('setTiles'),
      setMaxBounds: coreAPI('setMaxBounds'),
      addMarker: coreAPI('addMarker'),
      addRoute: coreAPI('addRoute'),
      getCameraState: function () { return map.getCameraState ? map.getCameraState() : null; },
      addSource: layerAPI('addSource'),
      getSource: layerAPI('getSource'),
      removeSource: layerAPI('removeSource'),
      addLayer: layerAPI('addLayer'),
      getLayer: layerAPI('getLayer'),
      removeLayer: layerAPI('removeLayer'),
      setPaintProperty: layerAPI('setPaintProperty'),
      setLayoutProperty: layerAPI('setLayoutProperty'),
      setPaintProperties: layerAPI('setPaintProperties'),
      setLayoutProperties: layerAPI('setLayoutProperties'),
      setFilter: layerAPI('setFilter'),
      getFilter: layerAPI('getFilter'),
      getPaintProperty: layerAPI('getPaintProperty'),
      getLayoutProperty: layerAPI('getLayoutProperty'),
      moveLayer: layerAPI('moveLayer'),
      getOverlayBounds: function (sourceID) {
        if (!overlays || typeof overlays.getBounds !== 'function') return null;
        return overlays.getBounds(sourceID);
      },
      queryRenderedFeatures: queryRenderedFeatures,
      whenIdle: function () { return map.whenIdle ? map.whenIdle().then(function () { return api; }) : Promise.resolve(api); },
      // Feature state goes to the vector renderer that owns the source.
      setFeatureState: function (feature, state) { stateOwner(feature, 'setFeatureState').setFeatureState(feature, state); return api; },
      getFeatureState: function (feature) { return stateOwner(feature, 'getFeatureState').getFeatureState(feature); },
      removeFeatureState: function (feature, key) { stateOwner(feature, 'removeFeatureState').removeFeatureState(feature, key); return api; },
      addImage: imageAPI('addImage'),
      updateImage: imageAPI('updateImage'),
      removeImage: imageAPI('removeImage'),
      hasImage: imageAPI('hasImage', true),
      listImages: imageAPI('listImages', true),
      // MapLibre's loadImage(url): a Promise of { data } with the image.
      loadImage: function (url) {
        return new Promise(function (resolve, reject) {
          var image = root.document.createElement('img');
          image.crossOrigin = 'anonymous';
          image.onload = function () { resolve({ data: image }); };
          image.onerror = function () { reject(new Error('microMap.compose: could not load image ' + url)); };
          image.src = url;
        });
      },
      getCanvas: getCanvas,
      getCanvasContainer: function () { return container; },
      getAttributions: getAttributions,
      addControl: function (control, position) { if (!destroyed) uiModule('addControl').addControl(api, control, position); return api; },
      removeControl: function (control) { if (!destroyed) uiModule('removeControl').removeControl(api, control); return api; },
      hasControl: function (control) { return !destroyed && uiModule('hasControl').hasControl(api, control); },
      on: on,
      once: once,
      off: off,
      redraw: function () {
        if (destroyed) return api;
        if (overlays && typeof overlays.redraw === 'function') overlays.redraw();
        for (var i = 0; i < vectors.length; i++) if (typeof vectors[i].redraw === 'function') vectors[i].redraw();
        return api;
      },
      jumpTo: camera ? function (next) { if (!destroyed) camera.jumpTo(next); return api; } : function () { unsupported('jumpTo; load microMap.camera.js'); },
      easeTo: camera ? function (next) { if (!destroyed) camera.easeTo(next); return api; } : function () { unsupported('easeTo; load microMap.camera.js'); },
      flyTo: camera ? function (next) { if (!destroyed) camera.flyTo(next); return api; } : function () { unsupported('flyTo; load microMap.camera.js'); },
      isEasing: function () { return !!(camera && camera.isEasing && camera.isEasing()); },
      panTo: camera ? function (center, next) { if (!destroyed) camera.panTo(center, next); return api; } : function () { unsupported('panTo; load microMap.camera.js'); },
      cancelCamera: camera ? function () { camera.cancelCamera(); return api; } : function () { unsupported('camera helpers; load microMap.camera.js'); },
      destroy: destroy,
      remove: remove
    };
    // The core's MapLibre-shaped gesture switches (map.dragRotate.disable()…).
    ['dragPan', 'scrollZoom', 'doubleClickZoom', 'keyboard', 'boxZoom', 'dragRotate', 'touchPitch', 'touchZoomRotate'].forEach(function (name) {
      if (map[name]) api[name] = map[name];
    });
    map.on('destroy', destroy);
    // A deferred style event gives callers of async map factories time to
    // attach the same listeners they attach after constructing MapLibre.
    styleLoadTimer = root.setTimeout(function () {
      styleLoadTimer = 0;
      emitStyle('style.load');
      scheduleStyleData();
    }, 0);
    return api;
  }

  // MapLibre style in, MapLibre-shaped map out: one vector layer renders the
  // style (vector and GeoJSON sources), composed with the optional add-ons.
  compose.fromStyle = function (map, style, options) {
    options = options || {};
    var vectorMap = options.vector || root.microMapVector || (microMap && microMap.vector);
    if (typeof vectorMap !== 'function' || typeof vectorMap.fromStyle !== 'function') {
      return Promise.reject(new Error('microMap.compose: load microMap.vector.js for MapLibre styles'));
    }
    return vectorMap.fromStyle(map, style, options.vectorOptions || {}).then(function (layer) {
      try {
        return compose(map, { vectors: [layer], camera: options.camera, cameraOptions: options.cameraOptions, geojson: options.geojson });
      } catch (error) {
        layer.destroy();
        throw error;
      }
    });
  };

  if (typeof microMap === 'function' && !microMap.compose) microMap.compose = compose;
  return compose;
});
