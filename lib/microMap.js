/* microMap.js v0.1.0 - a tiny dependency-free XYZ raster map | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.microMap = factory(root);
}(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var MAX_LAT = 85.0511287798;
  var DEG = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function log2(value) {
    return Math.log(value) / Math.LN2;
  }

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  // Raster preloading is deliberately opt-in.  Its options describe work
  // *outside* the normal viewport/buffer request set, so it can be capped
  // independently without making ordinary rendering less responsive.
  function preloadConfig(value) {
    if (value == null || value === false) return null;
    var defaults = value === true;
    if (defaults) value = {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('microMap: preload must be false, true, or an options object');
    }
    var zooms = value.zoom == null || value.zoom === false ? (defaults ? [1] : []) : (Array.isArray(value.zoom) ? value.zoom : [value.zoom]);
    var offsets = [];
    var i;
    var offset;
    for (i = 0; i < zooms.length && offsets.length < 4; i++) {
      offset = clamp(Math.round(finite(zooms[i], 0)), -4, 4);
      if (offset && offsets.indexOf(offset) < 0) offsets.push(offset);
    }
    var direction = null;
    if (value.direction != null && value.direction !== false) {
      if (typeof value.direction !== 'object' || !isFinite(+value.direction.bearing)) {
        throw new Error('microMap: preload.direction requires a finite bearing');
      }
      direction = {
        bearing: ((+value.direction.bearing % 360) + 360) % 360,
        distance: clamp(finite(value.direction.distance, 2), 0, 16),
        width: clamp(Math.floor(finite(value.direction.width, 1)), 0, 4)
      };
    }
    return {
      around: clamp(Math.floor(finite(value.around, defaults ? 1 : 0)), 0, 8),
      zoom: offsets,
      direction: direction,
      maxTiles: clamp(Math.floor(finite(value.maxTiles, 48)), 0, 256),
      delay: clamp(Math.floor(finite(value.delay, 120)), 0, 5000)
    };
  }

  function toWorld(lonLat) {
    var lon = +lonLat[0];
    var lat = +lonLat[1];
    if (!isFinite(lon) || !isFinite(lat)) {
      throw new Error('microMap: coordinates must contain finite longitude and latitude values');
    }
    lat = clamp(lat, -MAX_LAT, MAX_LAT);
    var sin = Math.sin(lat * DEG);
    return [
      (lon + 180) / 360,
      0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
    ];
  }

  function toLonLat(world) {
    var x = ((world[0] % 1) + 1) % 1;
    var y = Math.PI * (1 - 2 * world[1]);
    return [x * 360 - 180, Math.atan(Math.sinh(y)) / DEG];
  }

  function boundsValues(bounds) {
    var box;
    if (bounds && bounds.length === 2 && bounds[0] && bounds[1]) {
      box = [+bounds[0][0], +bounds[0][1], +bounds[1][0], +bounds[1][1]];
    } else if (bounds && bounds.length === 4) {
      box = [+bounds[0], +bounds[1], +bounds[2], +bounds[3]];
    } else {
      throw new Error('microMap: bounds must be [west, south, east, north] or two coordinate pairs');
    }
    for (var i = 0; i < 4; i++) {
      if (!isFinite(box[i])) throw new Error('microMap: bounds must contain finite coordinates');
    }
    return box;
  }

  function boundsWorld(bounds) {
    var box = boundsValues(bounds);
    var nw = toWorld([box[0], box[3]]);
    var se = toWorld([box[2], box[1]]);
    if (box[2] < box[0]) se[0] += 1;
    return { x0: nw[0], y0: nw[1], x1: se[0], y1: se[1] };
  }

  function clampAxis(value, half, lo, hi) {
    return hi - lo > 2 * half ? clamp(value, lo + half, hi - half) : (lo + hi) / 2;
  }

  var EARTH_RADIUS = 6371008.8;

  function distance(a, b) {
    var lat1 = +a[1] * DEG;
    var lat2 = +b[1] * DEG;
    var dLat = (+b[1] - a[1]) * DEG;
    var dLon = (+b[0] - a[0]) * DEG;
    var sinLat = Math.sin(dLat / 2);
    var sinLon = Math.sin(dLon / 2);
    var h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Search application-owned records without making the raster core own a
  // source registry or a remote geocoder. Return the original matching items.
  function search(data, query, options) {
    options = options || {};
    var items = Array.isArray(data) ? data : data && data.features;
    if (!Array.isArray(items)) throw new Error('microMap.search: expected an array or GeoJSON FeatureCollection');
    var keys = options.keys || ['name', 'title', 'label', 'description'];
    if (!Array.isArray(keys)) throw new Error('microMap.search: keys must be an array');
    var limit = options.limit == null ? 20 : +options.limit;
    if (!isFinite(limit) || limit < 0 || Math.floor(limit) !== limit) throw new Error('microMap.search: limit must be a non-negative integer');
    var needle = String(query == null ? '' : query).trim().toLocaleLowerCase();
    if (!needle || !limit) return [];
    var matches = [];
    for (var i = 0; i < items.length && matches.length < limit; i++) {
      var item = items[i];
      var record = item && (item.properties || item);
      if (!record) continue;
      for (var j = 0; j < keys.length; j++) {
        var value = record[keys[j]];
        if (value != null && String(value).toLocaleLowerCase().indexOf(needle) !== -1) {
          matches.push(item);
          break;
        }
      }
    }
    return matches;
  }

  function microMap(element, options) {
    options = options || {};
    if (typeof element === 'string') element = root.document.querySelector(element);
    if (!element) throw new Error('microMap: container not found');
    if (options.tiles !== false && (!options.tiles || (typeof options.tiles !== 'string' && typeof options.tiles !== 'function'))) {
      throw new Error('microMap: options.tiles must be a URL template or function (or false for overlays only)');
    }

    var tileSize = clamp(finite(options.tileSize == null ? 256 : options.tileSize, 256), 16, 1024);
    var minZoom = clamp(Math.ceil(finite(options.minZoom == null ? 0 : options.minZoom, 0)), 0, 30);
    var maxZoom = clamp(Math.floor(finite(options.maxZoom == null ? 19 : options.maxZoom, 19)), minZoom, 30);
    var zoom = clamp(finite(options.zoom == null ? 0 : options.zoom, 0), minZoom, maxZoom);
    var center = toWorld(options.center || [0, 0]);
    var centerX = center[0];
    var centerY = center[1];
    // Bearing follows MapLibre: the compass direction at the top of the
    // screen, so bearing 90 puts east up and turns the map plane by -90°.
    // The camera deliberately stays affine: a bearing rotates the map plane
    // and pitch compresses the screen's vertical axis. That keeps raster tiles,
    // Canvas overlays, markers and hit testing in one shared coordinate
    // system without claiming terrain or perspective support.
    var bearing = ((finite(options.bearing, 0) % 360) + 360) % 360;
    var maxPitch = clamp(finite(options.maxPitch == null ? 60 : options.maxPitch, 60), 0, 60);
    var pitch = clamp(finite(options.pitch, 0), 0, maxPitch);
    var cameraCosine = Math.cos(-bearing * DEG);
    var cameraSine = Math.sin(-bearing * DEG);
    var cameraPitchScale = Math.cos(pitch * DEG);
    var cameraInversePitchScale = 1 / cameraPitchScale;
    var source = options.tiles || null;
    var subdomains = typeof options.subdomains === 'string' && options.subdomains ? options.subdomains : 'abc';
    var crossOrigin = options.crossOrigin;
    var referrerPolicy = options.referrerPolicy;
    var sourceVersion = 0;
    var tileBuffer = clamp(Math.ceil(finite(options.tileBuffer == null ? 1 : options.tileBuffer, 1)), 0, 8);
    var preloadOptions = preloadConfig(options.preload);
    var preloadCache = Object.create(null);
    var preloadQueue = [];
    var preloadQueued = Object.create(null);
    var preloadTimer = 0;
    var preloadActive = 0;
    var preloadEpoch = 0;
    var preloadUse = 0;
    var navigation = null;
    var dragging = options.dragging !== false;
    var touchZoomEnabled = options.touchZoom !== false;
    var scrollWheelZoom = options.scrollWheelZoom !== false;
    var doubleClickZoom = options.doubleClickZoom !== false;
    var keyboardEnabled = options.keyboard !== false;
    var inertia = options.inertia !== false;
    // Rotation and pitch gestures, named like MapLibre's handlers.
    var dragRotate = options.dragRotate !== false;
    var pitchWithRotate = options.pitchWithRotate !== false;
    var touchRotate = options.touchRotate !== false;
    var touchPitch = options.touchPitch !== false;
    var bearingSnap = Math.max(0, finite(options.bearingSnap == null ? 7 : options.bearingSnap, 7));
    var rotateDrag = null;
    var suppressMenuUntil = 0;
    var cameraAnimFrame = 0;
    var cameraTarget = null;
    var zoomAnimation = options.zoomAnimation !== false;
    var contextMenuBuilder = options.contextMenu || null;
    var boxSelect = options.boxSelect !== false;
    var boxSelectKey = options.boxSelectKey || 'shiftKey';
    var boxZoomOption = !!options.boxZoom;
    var zoomSnap = Math.max(0, finite(options.zoomSnap == null ? 0 : options.zoomSnap, 0));
    var maxBounds = options.maxBounds ? boundsWorld(options.maxBounds) : null;
    var tiles = Object.create(null);
    var listeners = Object.create(null);
    var pointers = Object.create(null);
    var markers = [];
    var routes = [];
    var menuEl = null;
    var boxEl = null;
    var boxFrom = null;
    var boxId = null;
    var pointerCount = 0;
    var pinch = null;
    var lastPointer = null;
    var clickStart = null;
    var velocityX = 0;
    var velocityY = 0;
    var lastMoveTime = 0;
    var inertiaFrame = 0;
    var zoomAnimFrame = 0;
    var zoomAnimFrom = 0;
    var zoomAnimTo = 0;
    var zoomAnimStart = 0;
    var zoomAnimDuration = 0;
    var zoomAnimPoint = null;
    var zoomAnimEvent = null;
    var zoomFollowFrame = 0;
    var zoomFollowTarget = null;
    var zoomFollowTime = 0;
    var width = 0;
    var height = 0;
    var frame = 0;
    var endTimer = 0;
    var pendingMove = false;
    var pendingZoom = false;
    var pendingRotate = false;
    var pendingPitch = false;
    var destroyed = false;
    var loaded = false;
    var events = [];
    var oldStyle = element.style.cssText;
    var oldTabindex = element.getAttribute('tabindex');
    var oldRole = element.getAttribute('role');
    var oldLabel = element.getAttribute('aria-label');
    var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
    var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;

    if (!root.getComputedStyle || root.getComputedStyle(element).position === 'static') {
      element.style.position = 'relative';
    }
    element.style.overflow = 'hidden';
    element.style.touchAction = 'none';
    element.style.userSelect = 'none';
    element.style.webkitUserSelect = 'none';
    element.style.webkitTapHighlightColor = 'transparent';
    element.style.overscrollBehavior = 'contain';
    element.style.cursor = 'grab';
    if (oldTabindex == null) element.tabIndex = 0;
    if (oldRole == null) element.setAttribute('role', 'region');
    if (oldLabel == null) element.setAttribute('aria-label', options.ariaLabel || 'Interactive map');

    var tileLayer = root.document.createElement('div');
    tileLayer.setAttribute('aria-hidden', 'true');
    tileLayer.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform';
    element.appendChild(tileLayer);
    var panes = Object.create(null);
    var tilePending = Object.create(null);
    var tileErrors = Object.create(null);
    var idleWaiters = [];
    var lastTileZoom = null;
    var zoomPruneTimer = 0;

    var attribution = null;
    if (options.attribution) {
      attribution = root.document.createElement('div');
      attribution.style.cssText = 'position:absolute;right:0;bottom:0;z-index:2;padding:2px 5px;background:rgba(255,255,255,.82);font:11px/1.4 sans-serif';
      attribution.innerHTML = options.attribution;
      attribution.onpointerdown = function (event) { event.stopPropagation(); };
      element.appendChild(attribution);
    }

    function addEvent(type, handler, eventOptions) {
      element.addEventListener(type, handler, eventOptions);
      events.push([type, handler, eventOptions]);
    }

    function worldSize(atZoom) {
      return tileSize * Math.pow(2, atZoom == null ? zoom : atZoom);
    }

    function cameraScale() {
      return cameraPitchScale;
    }

    function cameraPoint(x, y) {
      var dx = x - width / 2;
      var dy = y - height / 2;
      return [width / 2 + dx * cameraCosine - dy * cameraSine,
        height / 2 + (dx * cameraSine + dy * cameraCosine) * cameraScale()];
    }

    function rawPoint(x, y) {
      var dx = x - width / 2;
      var dy = (y - height / 2) * cameraInversePitchScale;
      return [width / 2 + dx * cameraCosine + dy * cameraSine,
        height / 2 - dx * cameraSine + dy * cameraCosine];
    }

    function rawDelta(dx, dy) {
      dy *= cameraInversePitchScale;
      return [dx * cameraCosine + dy * cameraSine, -dx * cameraSine + dy * cameraCosine];
    }

    function rawView() {
      var a = rawPoint(0, 0);
      var b = rawPoint(width, 0);
      var c = rawPoint(width, height);
      var d = rawPoint(0, height);
      return {
        x0: Math.min(a[0], b[0], c[0], d[0]),
        y0: Math.min(a[1], b[1], c[1], d[1]),
        x1: Math.max(a[0], b[0], c[0], d[0]),
        y1: Math.max(a[1], b[1], c[1], d[1])
      };
    }

    function cameraTransform() {
      return 'translate(' + width / 2 + 'px,' + height / 2 + 'px) scaleY(' + cameraScale() + ') rotate(' + -bearing +
        'deg) translate(' + -width / 2 + 'px,' + -height / 2 + 'px)';
    }

    function limitCenter() {
      var view = rawView();
      var size = worldSize();
      var half = Math.max(Math.abs(view.y0 - height / 2), Math.abs(view.y1 - height / 2)) / size;
      centerY = half < 0.5 ? clamp(centerY, half, 1 - half) : 0.5;
      if (maxBounds) {
        var halfX = Math.max(Math.abs(view.x0 - width / 2), Math.abs(view.x1 - width / 2)) / size;
        centerX += Math.round((maxBounds.x0 + maxBounds.x1) / 2 - centerX);
        centerX = clampAxis(centerX, halfX, maxBounds.x0, maxBounds.x1);
        centerY = clampAxis(centerY, half, maxBounds.y0, maxBounds.y1);
      }
    }

    function snapZoom(value) {
      return zoomSnap ? Math.round(value / zoomSnap) * zoomSnap : value;
    }

    function localPoint(event) {
      var rect = element.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    function project(lonLat) {
      var world = toWorld(lonLat);
      var dx = world[0] - centerX;
      dx -= Math.round(dx);
      var size = worldSize();
      return cameraPoint(width / 2 + dx * size, height / 2 + (world[1] - centerY) * size);
    }

    function unproject(point) {
      var size = worldSize();
      point = rawPoint(+point[0], +point[1]);
      return toLonLat([
        centerX + (point[0] - width / 2) / size,
        centerY + (point[1] - height / 2) / size
      ]);
    }

    function getCenter() {
      return toLonLat([centerX, centerY]);
    }

    // Keep camera consumers out of the renderer's private coordinate state.
    // The returned center and object are fresh values, so overlay code cannot
    // mutate the active camera without an explicit map method call.
    function getCameraState() {
      return {
        center: getCenter(),
        zoom: zoom,
        minZoom: minZoom,
        maxZoom: maxZoom,
        zoomSnap: zoomSnap,
        bearing: bearing,
        pitch: pitch,
        width: width,
        height: height,
        tileSize: tileSize,
        worldSize: worldSize()
      };
    }

    function emit(type, extra) {
      var list = listeners[type];
      if (!list || !list.length) return;
      var event = {
        type: type,
        target: api,
        center: getCenter(),
        zoom: zoom,
        bearing: bearing,
        pitch: pitch
      };
      var key;
      if (extra) for (key in extra) event[key] = extra[key];
      list = list.slice();
      for (var i = 0; i < list.length; i++) list[i](event);
    }

    function finish() {
      if (endTimer) root.clearTimeout(endTimer);
      endTimer = 0;
      if (pendingMove) emit('moveend');
      if (pendingZoom) emit('zoomend');
      if (pendingRotate) emit('rotateend');
      if (pendingPitch) emit('pitchend');
      pendingMove = pendingZoom = pendingRotate = pendingPitch = false;
      checkIdle();
    }

    function checkIdle() {
      if (!idleWaiters.length || destroyed || frame || pendingMove) return;
      var current = clamp(Math.round(zoom), minZoom, maxZoom);
      var visible = tiles[current] || {};
      for (var key in visible) if (visible[key]._microMapPending) return;
      var waiters = idleWaiters.splice(0);
      for (var i = 0; i < waiters.length; i++) waiters[i].resolve(api);
    }

    function whenIdle() {
      return new Promise(function (resolve, reject) {
        if (destroyed) { reject(new Error('microMap: map has been destroyed')); return; }
        idleWaiters.push({ resolve: resolve, reject: reject });
        schedule();
        checkIdle();
      });
    }

    function changed(oldZoom, originalEvent, immediateEnd, rotated, tilted) {
      schedule();
      pendingMove = true;
      emit('move', originalEvent ? { originalEvent: originalEvent } : null);
      if (oldZoom !== zoom) {
        pendingZoom = true;
        emit('zoom', originalEvent ? { originalEvent: originalEvent } : null);
      }
      if (rotated) {
        pendingRotate = true;
        emit('rotate', originalEvent ? { originalEvent: originalEvent } : null);
      }
      if (tilted) {
        pendingPitch = true;
        emit('pitch', originalEvent ? { originalEvent: originalEvent } : null);
      }
      if (endTimer) root.clearTimeout(endTimer);
      if (immediateEnd) finish();
      else endTimer = root.setTimeout(finish, 180);
    }

    function tileUrl(z, x, y, count) {
      if (typeof source === 'function') return source(z, x, y);
      var domain = subdomains.charAt(((x + y) % subdomains.length + subdomains.length) % subdomains.length);
      return source
        .replace(/\{z\}/g, z)
        .replace(/\{x\}/g, x)
        .replace(/\{y\}/g, y)
        .replace(/\{-y\}/g, count - y - 1)
        .replace(/\{s\}/g, domain);
    }

    function preloadKey(z, x, y) {
      return z + '/' + x + '/' + y;
    }

    function clearPreloads() {
      if (preloadTimer) root.clearTimeout(preloadTimer);
      preloadTimer = 0;
      preloadEpoch++;
      preloadQueue = [];
      preloadQueued = Object.create(null);
      for (var key in preloadCache) {
        var entry = preloadCache[key];
        entry.cancelled = true;
        entry.image.onload = entry.image.onerror = null;
        entry.image.src = '';
      }
      preloadCache = Object.create(null);
      preloadActive = 0;
    }

    function trimPreloadCache() {
      var limit = preloadOptions ? preloadOptions.maxTiles : 0;
      var count = 0;
      var key;
      for (key in preloadCache) count++;
      while (count > limit) {
        var oldest = null;
        for (key in preloadCache) {
          var entry = preloadCache[key];
          if (!oldest || (!entry.pending && oldest.pending) ||
              (entry.pending === oldest.pending && entry.used < oldest.used)) oldest = entry;
        }
        if (!oldest) return;
        delete preloadCache[oldest.key];
        oldest.cancelled = true;
        oldest.image.onload = oldest.image.onerror = null;
        oldest.image.src = '';
        if (oldest.pending) preloadActive = Math.max(0, preloadActive - 1);
        count--;
      }
    }

    function makePreloadRoom() {
      var limit = preloadOptions ? preloadOptions.maxTiles : 0;
      var count = 0;
      var oldest = null;
      for (var key in preloadCache) {
        var entry = preloadCache[key];
        count++;
        if (!entry.pending && (!oldest || entry.used < oldest.used)) oldest = entry;
      }
      if (count < limit) return true;
      if (!oldest) return false;
      delete preloadCache[oldest.key];
      oldest.cancelled = true;
      oldest.image.onload = oldest.image.onerror = null;
      oldest.image.src = '';
      return true;
    }

    function takePreload(z, x, y) {
      var key = preloadKey(z, x, y);
      var entry = preloadCache[key];
      if (!entry || entry.pending || entry.version !== sourceVersion) return null;
      delete preloadCache[key];
      entry.image.onload = entry.image.onerror = null;
      return entry;
    }

    function preloadRange(z, buffer, focus) {
      var count = Math.pow(2, z);
      var scale = Math.pow(2, zoom - z);
      var pixelX = focus[0] * tileSize * count;
      var pixelY = focus[1] * tileSize * count;
      var view = rawView();
      return {
        minX: Math.floor((pixelX + (view.x0 - width / 2) / scale) / tileSize) - buffer,
        maxX: Math.floor((pixelX + (view.x1 - width / 2) / scale) / tileSize) + buffer,
        minY: Math.max(0, Math.floor((pixelY + (view.y0 - height / 2) / scale) / tileSize) - buffer),
        maxY: Math.min(count - 1, Math.floor((pixelY + (view.y1 - height / 2) / scale) / tileSize) + buffer)
      };
    }

    function queuePreload(z, x, y) {
      if (!preloadOptions || !source || preloadQueue.length >= preloadOptions.maxTiles || y < 0 || y >= Math.pow(2, z)) return;
      var key = preloadKey(z, x, y);
      if (preloadCache[key] || preloadQueued[key] || (tiles[z] && tiles[z][x + '/' + y])) return;
      preloadQueued[key] = true;
      preloadQueue.push({ key: key, z: z, x: x, y: y });
    }

    function queuePreloadRange(z, outer, inner) {
      for (var y = outer.minY; y <= outer.maxY; y++) {
        for (var x = outer.minX; x <= outer.maxX; x++) {
          if (!inner || x < inner.minX || x > inner.maxX || y < inner.minY || y > inner.maxY) queuePreload(z, x, y);
        }
      }
    }

    function preloadDirection(z, focus) {
      var direction = preloadOptions.direction;
      var nav = navigation;
      var distance = direction ? direction.distance : 0;
      var width = direction ? direction.width : 1;
      var bearing = direction ? direction.bearing : null;
      if (nav && nav.heading != null) {
        bearing = nav.heading;
        var latitude = (nav.position || getCenter())[1] * DEG;
        var metersPerTile = 2 * Math.PI * EARTH_RADIUS * Math.max(0.01, Math.cos(latitude)) / Math.pow(2, z);
        distance = Math.max(distance, clamp(nav.speed * nav.lookAhead / metersPerTile, 0, 16));
      }
      if (bearing == null || !distance) return;
      var radians = bearing * DEG;
      var forwardX = Math.sin(radians);
      var forwardY = -Math.cos(radians);
      var sideX = -forwardY;
      var sideY = forwardX;
      var count = Math.pow(2, z);
      var originX = focus[0] * count;
      var originY = focus[1] * count;
      for (var step = 1; step <= Math.ceil(distance); step++) {
        for (var side = -width; side <= width; side++) {
          queuePreload(z, Math.round(originX + forwardX * step + sideX * side),
            Math.round(originY + forwardY * step + sideY * side));
        }
      }
    }

    function drainPreloads() {
      while (preloadActive < 2 && preloadQueue.length && !destroyed && source && preloadOptions) {
        var entry = preloadQueue.shift();
        delete preloadQueued[entry.key];
        if (preloadCache[entry.key] || (tiles[entry.z] && tiles[entry.z][entry.x + '/' + entry.y])) continue;
        if (!makePreloadRoom()) return;
        var image = root.document.createElement('img');
        var version = sourceVersion;
        var epoch = preloadEpoch;
        var count = Math.pow(2, entry.z);
        var wrappedX = ((entry.x % count) + count) % count;
        entry.image = image;
        entry.version = version;
        entry.pending = true;
        entry.used = ++preloadUse;
        preloadCache[entry.key] = entry;
        preloadActive++;
        image.alt = '';
        image.decoding = 'async';
        image.fetchPriority = 'low';
        if (crossOrigin != null) image.crossOrigin = crossOrigin;
        if (referrerPolicy) image.referrerPolicy = referrerPolicy;

        (function (current, currentImage, currentVersion, currentEpoch, currentX) {
          var settled = false;
          function settle(failed) {
            if (settled) return;
            settled = true;
            currentImage.onload = currentImage.onerror = null;
            if (currentEpoch !== preloadEpoch || currentVersion !== sourceVersion || destroyed || current.cancelled) return;
            preloadActive = Math.max(0, preloadActive - 1);
            current.pending = false;
            if (failed) {
              delete preloadCache[current.key];
              emit('tilepreloaderror', { z: current.z, x: currentX, y: current.y, url: current.url });
            } else {
              current.used = ++preloadUse;
              emit('tilepreload', { z: current.z, x: currentX, y: current.y, url: current.url });
              trimPreloadCache();
            }
            drainPreloads();
          }
          currentImage.onload = function () { settle(false); };
          currentImage.onerror = function () { settle(true); };
          try {
            current.url = tileUrl(current.z, currentX, current.y, count);
            currentImage.src = current.url;
          } catch (error) {
            settle(true);
          }
        }(entry, image, version, epoch, wrappedX));
      }
    }

    function planPreloads() {
      preloadTimer = 0;
      if (destroyed || !source || !preloadOptions || !preloadOptions.maxTiles || !width || !height) return;
      preloadQueue = [];
      preloadQueued = Object.create(null);
      var focus = navigation && navigation.world ? navigation.world : [centerX, centerY];
      var current = clamp(Math.round(zoom), minZoom, maxZoom);
      var inner = preloadRange(current, tileBuffer, focus);
      preloadDirection(current, focus);
      if (preloadOptions.around) queuePreloadRange(current, preloadRange(current, tileBuffer + preloadOptions.around, focus), inner);
      for (var i = 0; i < preloadOptions.zoom.length; i++) {
        var target = clamp(current + preloadOptions.zoom[i], minZoom, maxZoom);
        if (target !== current) {
          preloadDirection(target, focus);
          queuePreloadRange(target, preloadRange(target, tileBuffer + preloadOptions.around, focus));
        }
      }
      drainPreloads();
    }

    function schedulePreloads() {
      if (preloadTimer) root.clearTimeout(preloadTimer);
      preloadTimer = 0;
      if (!destroyed && source && preloadOptions && preloadOptions.maxTiles) {
        preloadTimer = root.setTimeout(planPreloads, preloadOptions.delay);
      }
    }

    function paneFor(z) {
      var p = panes[z];
      if (!p) {
        p = root.document.createElement('div');
        p.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform';
        tileLayer.appendChild(p);
        panes[z] = p;
      }
      return p;
    }

    function paneTransform(z) {
      var countZ = Math.pow(2, z);
      var scaleZ = Math.pow(2, zoom - z);
      var pixelX = centerX * tileSize * countZ;
      var pixelY = centerY * tileSize * countZ;
      return 'translate(' + (width / 2 - pixelX * scaleZ) + 'px,' +
        (height / 2 - pixelY * scaleZ) + 'px) scale(' + scaleZ + ')';
    }

    function scheduleOldZoomPrune(delay) {
      if (zoomPruneTimer) root.clearTimeout(zoomPruneTimer);
      zoomPruneTimer = root.setTimeout(pruneOldZooms, delay);
    }

    // Keep one nearby pane below the current zoom until every requested tile
    // settles successfully. A lower-resolution map is much preferable to a
    // grey hole when a slow connection or a failing tile leaves gaps.
    function pruneOldZooms() {
      zoomPruneTimer = 0;
      var current = clamp(Math.round(zoom), minZoom, maxZoom);
      var fallback = null;
      var z;
      if (tilePending[current] || tileErrors[current]) {
        for (z in panes) {
          if (+z < current && (fallback == null || +z > fallback)) fallback = +z;
        }
        if (fallback == null) {
          for (z in panes) {
            if (+z > current && (fallback == null || +z < fallback)) fallback = +z;
          }
        }
      }
      for (z in panes) {
        if (+z !== current && +z !== fallback) {
          tileLayer.removeChild(panes[z]);
          delete panes[z];
          delete tiles[z];
          delete tilePending[z];
          delete tileErrors[z];
        }
      }
    }

    function addTile(z, x, y, count, key) {
      var wrappedX = ((x % count) + count) % count;
      var preloaded = takePreload(z, x, y);
      var image = preloaded ? preloaded.image : root.document.createElement('img');
      var settled = false;
      image._microMapPending = !preloaded;
      tilePending[z] = (tilePending[z] || 0) + 1;

      image.alt = '';
      image.draggable = false;
      image.width = image.height = tileSize;
      image.decoding = 'async';
      image.style.cssText = 'position:absolute;max-width:none;pointer-events:none;user-select:none;left:' +
        (x * tileSize) + 'px;top:' + (y * tileSize) + 'px;width:' + tileSize + 'px;height:' + tileSize + 'px';
      var version = sourceVersion;
      var url = preloaded ? preloaded.url : tileUrl(z, wrappedX, y, count);

      function settle(failed) {
        if (settled) return;
        settled = true;
        image._microMapPending = false;
        image.onload = image.onerror = null;
        if (version !== sourceVersion) return;
        if (tilePending[z]) tilePending[z]--;
        if (failed) {
          image._microMapFailed = true;
          tileErrors[z] = (tileErrors[z] || 0) + 1;
        }
        if (!tilePending[z] && +z === clamp(Math.round(zoom), minZoom, maxZoom)) {
          pruneOldZooms();
        }
        emit(failed ? 'tileerror' : 'tileload', { z: z, x: wrappedX, y: y, url: url });
        checkIdle();
      }

      if (crossOrigin != null) image.crossOrigin = crossOrigin;
      if (referrerPolicy) image.referrerPolicy = referrerPolicy;
      image.onload = function () { settle(false); };
      image.onerror = function () { image.style.visibility = 'hidden'; settle(true); };
      if (!preloaded) image.src = url;
      paneFor(z).appendChild(image);
      (tiles[z] || (tiles[z] = Object.create(null)))[key] = image;
      if (preloaded) settle(false);
    }

    function drawPane(tileZoom, buffer, view) {
      var count = Math.pow(2, tileZoom);
      var scale = Math.pow(2, zoom - tileZoom);
      var pixelX = centerX * tileSize * count;
      var pixelY = centerY * tileSize * count;
      var minX = Math.floor((pixelX + (view.x0 - width / 2) / scale) / tileSize) - buffer;
      var maxX = Math.floor((pixelX + (view.x1 - width / 2) / scale) / tileSize) + buffer;
      var minY = Math.max(0, Math.floor((pixelY + (view.y0 - height / 2) / scale) / tileSize) - buffer);
      var maxY = Math.min(count - 1, Math.floor((pixelY + (view.y1 - height / 2) / scale) / tileSize) + buffer);
      var pane = paneFor(tileZoom);
      var range = pane._microMapRange;
      if (range && range[0] === minX && range[1] === maxX && range[2] === minY && range[3] === maxY) return pane;
      pane._microMapRange = [minX, maxX, minY, maxY];
      var wanted = Object.create(null);
      var x;
      var y;
      var key;
      var zoomTiles = tiles[tileZoom] || (tiles[tileZoom] = Object.create(null));
      for (y = minY; y <= maxY; y++) {
        for (x = minX; x <= maxX; x++) {
          key = x + '/' + y;
          wanted[key] = true;
          if (!zoomTiles[key]) addTile(tileZoom, x, y, count, key);
        }
      }

      for (key in zoomTiles) {
        if (!wanted[key]) {
          var image = zoomTiles[key];
          if (image._microMapPending) {
            image._microMapPending = false;
            if (tilePending[tileZoom]) tilePending[tileZoom]--;
            image.onload = image.onerror = null;
            image.removeAttribute('src');
          }
          if (image._microMapFailed && tileErrors[tileZoom]) tileErrors[tileZoom]--;
          pane.removeChild(image);
          delete zoomTiles[key];
        }
      }

      if (tileZoom === clamp(Math.round(zoom), minZoom, maxZoom) &&
          !tilePending[tileZoom] && !tileErrors[tileZoom]) pruneOldZooms();

      return pane;
    }

    function draw() {
      frame = 0;
      if (destroyed) return;
      width = element.clientWidth;
      height = element.clientHeight;
      if (!width || !height) { checkIdle(); return; }
      limitCenter();
      tileLayer.style.transform = cameraTransform();

      if (source) {
        var view = rawView();
        var tileZoom = clamp(Math.round(zoom), minZoom, maxZoom);
        var current = drawPane(tileZoom, tileBuffer, view);
        // Update whichever retained fallback is nearest the new viewport. A
        // zoom-in normally uses a lower-resolution pane; a zoom-out uses the
        // previous higher-resolution pane. Either is more useful than a stale
        // snapshot or an empty grey region after a pan.
        if (tilePending[tileZoom] || tileErrors[tileZoom]) {
          var fallbackZoom = null;
          var candidateZoom;
          for (var paneZoom in panes) {
            candidateZoom = +paneZoom;
            if (candidateZoom < tileZoom && (fallbackZoom == null || candidateZoom > fallbackZoom)) fallbackZoom = candidateZoom;
          }
          if (fallbackZoom == null) {
            for (paneZoom in panes) {
              candidateZoom = +paneZoom;
              if (candidateZoom > tileZoom && (fallbackZoom == null || candidateZoom < fallbackZoom)) fallbackZoom = candidateZoom;
            }
          }
          if (fallbackZoom != null) drawPane(fallbackZoom, 0, view);
        }
        if (tileLayer.lastChild !== current) tileLayer.appendChild(current);
        for (var z in panes) panes[z].style.transform = paneTransform(+z);
        // The visible pane has been laid out first.  Speculative requests are
        // delayed and marked low priority so they never replace this path.
        schedulePreloads();

        if (tileZoom !== lastTileZoom) {
          lastTileZoom = tileZoom;
          scheduleOldZoomPrune(250);
        }
      }

      if (!loaded) {
        loaded = true;
        emit('load');
      }
      checkIdle();
    }

    function schedule() {
      if (!frame && !destroyed) frame = requestFrame.call(root, draw);
    }

    function moveCenter(dx, dy, originalEvent, immediateEnd) {
      if (!isFinite(dx) || !isFinite(dy) || (!dx && !dy)) return;
      var size = worldSize();
      var raw = rawDelta(dx, dy);
      centerX += raw[0] / size;
      centerY += raw[1] / size;
      limitCenter();
      changed(zoom, originalEvent, immediateEnd);
    }

    function applyZoom(nextZoomRaw, point) {
      point = point || [width / 2, height / 2];
      var anchor = unproject(point);
      var world = toWorld(anchor);
      var raw = rawPoint(point[0], point[1]);
      zoom = nextZoomRaw;
      var newSize = worldSize();
      centerX = world[0] - (raw[0] - width / 2) / newSize;
      centerY = world[1] - (raw[1] - height / 2) / newSize;
      limitCenter();
    }

    function zoomAt(nextZoom, point, originalEvent, immediateEnd) {
      stopZoomAnim();
      nextZoom = +nextZoom;
      if (!isFinite(nextZoom)) return;
      nextZoom = clamp(snapZoom(nextZoom), minZoom, maxZoom);
      if (nextZoom === zoom) return;
      var oldZoom = zoom;
      applyZoom(nextZoom, point);
      changed(oldZoom, originalEvent, immediateEnd);
    }

    function stopZoomAnim() {
      if (zoomAnimFrame) cancelFrame.call(root, zoomAnimFrame);
      zoomAnimFrame = 0;
      if (zoomFollowFrame) cancelFrame.call(root, zoomFollowFrame);
      zoomFollowFrame = 0;
      zoomFollowTarget = null;
    }

    function stepZoomAnim() {
      var t = zoomAnimDuration ? clamp((Date.now() - zoomAnimStart) / zoomAnimDuration, 0, 1) : 1;
      var eased = 1 - Math.pow(1 - t, 3);
      var oldZoom = zoom;
      applyZoom(zoomAnimFrom + (zoomAnimTo - zoomAnimFrom) * eased, zoomAnimPoint);
      changed(oldZoom, zoomAnimEvent, t >= 1);
      zoomAnimFrame = t < 1 ? requestFrame.call(root, stepZoomAnim) : 0;
    }

    function animateZoomTo(targetZoom, point, duration, originalEvent) {
      targetZoom = +targetZoom;
      if (!isFinite(targetZoom)) return;
      targetZoom = clamp(snapZoom(targetZoom), minZoom, maxZoom);
      if (targetZoom === zoom && !zoomAnimFrame) return;
      if (!zoomAnimation) {
        zoomAt(targetZoom, point, originalEvent, true);
        return;
      }
      if (zoomFollowFrame) { cancelFrame.call(root, zoomFollowFrame); zoomFollowFrame = 0; zoomFollowTarget = null; }
      zoomAnimFrom = zoom;
      zoomAnimTo = targetZoom;
      zoomAnimPoint = point || zoomAnimPoint || [width / 2, height / 2];
      zoomAnimEvent = originalEvent || null;
      zoomAnimStart = Date.now();
      zoomAnimDuration = Math.max(0, finite(duration, 0));
      if (!zoomAnimFrame) zoomAnimFrame = requestFrame.call(root, stepZoomAnim);
    }

    // Continuous exponential chase (no fixed arrival time) instead of a fresh
    // eased animation per wheel notch: restarting a duration-based ease on
    // every notch decelerates to a near-stop right before the next notch
    // arrives, which feels like snapping to a grid of stops. This keeps
    // gliding smoothly toward whatever target the wheel last set.
    function stepZoomFollow() {
      if (destroyed || zoomFollowTarget == null) {
        zoomFollowFrame = 0;
        return;
      }
      var now = Date.now();
      var dt = zoomFollowTime ? Math.min(0.1, (now - zoomFollowTime) / 1000) : 0;
      zoomFollowTime = now;
      var oldZoom = zoom;
      var diff = zoomFollowTarget - zoom;
      if (dt && Math.abs(diff) > 0.0005) {
        applyZoom(zoom + diff * (1 - Math.pow(0.0018, dt)), zoomAnimPoint);
        changed(oldZoom, zoomAnimEvent, false);
        zoomFollowFrame = requestFrame.call(root, stepZoomFollow);
      } else if (dt) {
        applyZoom(zoomFollowTarget, zoomAnimPoint);
        changed(oldZoom, zoomAnimEvent, true);
        zoomFollowFrame = 0;
        zoomFollowTarget = null;
      } else {
        zoomFollowFrame = requestFrame.call(root, stepZoomFollow);
      }
    }

    function followZoomTo(targetZoom, point, originalEvent) {
      targetZoom = +targetZoom;
      if (!isFinite(targetZoom)) return;
      targetZoom = clamp(snapZoom(targetZoom), minZoom, maxZoom);
      if (!zoomAnimation) {
        zoomAt(targetZoom, point, originalEvent, true);
        return;
      }
      if (zoomAnimFrame) { cancelFrame.call(root, zoomAnimFrame); zoomAnimFrame = 0; }
      zoomFollowTarget = targetZoom;
      zoomAnimPoint = point || zoomAnimPoint || [width / 2, height / 2];
      zoomAnimEvent = originalEvent || null;
      if (!zoomFollowFrame) {
        zoomFollowTime = 0;
        zoomFollowFrame = requestFrame.call(root, stepZoomFollow);
      }
    }

    function pointerPair() {
      var ids = Object.keys(pointers);
      return ids.length > 1 ? [pointers[ids[0]], pointers[ids[1]]] : null;
    }

    function beginPinch() {
      var pair = pointerPair();
      if (!pair) return;
      var mid = [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
      var dx = pair[0][0] - pair[1][0];
      var dy = pair[0][1] - pair[1][1];
      pinch = {
        zoom: zoom,
        distance: Math.sqrt(dx * dx + dy * dy) || 1,
        world: toWorld(unproject(mid)),
        start: [pair[0].slice(), pair[1].slice()],
        angle: Math.atan2(dy, dx),
        bearing: bearing,
        pitch: pitch,
        mode: null,
        rotating: false
      };
    }

    function signedBearing(value) {
      return value > 180 ? value - 360 : value;
    }

    function stopCameraAnim() {
      if (cameraAnimFrame) cancelFrame.call(root, cameraAnimFrame);
      cameraAnimFrame = 0;
      cameraTarget = null;
    }

    // A short eased bearing/pitch animation for keys and bearing snapping;
    // the bearing takes the shorter way round.
    function animateCamera(nextBearing, nextPitch, duration) {
      stopCameraAnim();
      var fromBearing = bearing;
      var turn = signedBearing(((nextBearing - bearing) % 360 + 360) % 360);
      var fromPitch = pitch;
      var toPitch = clamp(nextPitch, 0, maxPitch);
      var started = Date.now();
      cameraTarget = [nextBearing, toPitch];
      function step() {
        if (destroyed) return;
        var t = Math.min(1, (Date.now() - started) / Math.max(1, duration));
        var eased = t * (2 - t);
        setOrientation(fromBearing + turn * eased, fromPitch + (toPitch - fromPitch) * eased, t < 1);
        cameraAnimFrame = t < 1 ? requestFrame.call(root, step) : 0;
        if (t >= 1) cameraTarget = null;
      }
      cameraAnimFrame = requestFrame.call(root, step);
    }

    function snapBearing() {
      var signed = signedBearing(bearing);
      if (signed && Math.abs(signed) < bearingSnap) animateCamera(0, pitch, 200);
    }

    function stopInertia() {
      if (inertiaFrame) cancelFrame.call(root, inertiaFrame);
      inertiaFrame = 0;
    }

    function runInertia(speedX, speedY) {
      var lastTime = null;
      function step(now) {
        if (destroyed) return;
        if (lastTime == null) {
          lastTime = now;
          inertiaFrame = requestFrame.call(root, step);
          return;
        }
        var dt = (now - lastTime) / 1000;
        lastTime = now;
        var friction = Math.pow(0.02, dt);
        speedX *= friction;
        speedY *= friction;
        if (Math.abs(speedX) < 4 && Math.abs(speedY) < 4) {
          inertiaFrame = 0;
          finish();
          return;
        }
        moveCenter(speedX * dt, speedY * dt);
        inertiaFrame = requestFrame.call(root, step);
      }
      inertiaFrame = requestFrame.call(root, step);
    }

    function updateBoxRect(a, b) {
      boxEl.style.left = Math.min(a[0], b[0]) + 'px';
      boxEl.style.top = Math.min(a[1], b[1]) + 'px';
      boxEl.style.width = Math.abs(a[0] - b[0]) + 'px';
      boxEl.style.height = Math.abs(a[1] - b[1]) + 'px';
    }

    function cancelBoxSelect() {
      if (!boxEl) return api;
      var id = boxId;
      if (boxEl.parentNode === element) element.removeChild(boxEl);
      boxEl = boxFrom = boxId = null;
      if (id != null && element.releasePointerCapture) element.releasePointerCapture(id);
      if (!pointerCount) element.style.cursor = 'grab';
      return api;
    }

    // A box selection is drawn while `boxSelectKey` is held during a drag;
    // it never pans the map. On release it emits 'boxselect' with the pixel
    // and geographic bounds plus an approximate size, useful either to
    // fitBounds() into it (opt in with `boxZoom: true`) or to measure it.
    function finishBoxSelect(point, originalEvent) {
      var from = boxFrom;
      cancelBoxSelect();
      var p1 = [Math.min(from[0], point[0]), Math.min(from[1], point[1])];
      var p2 = [Math.max(from[0], point[0]), Math.max(from[1], point[1])];
      if (p2[0] - p1[0] < 4 || p2[1] - p1[1] < 4) return;
      var nw = unproject(p1);
      var se = unproject(p2);
      var bounds = [nw[0], se[1], se[0], nw[1]];
      var widthMeters = distance([nw[0], (nw[1] + se[1]) / 2], [se[0], (nw[1] + se[1]) / 2]);
      var heightMeters = distance([(nw[0] + se[0]) / 2, nw[1]], [(nw[0] + se[0]) / 2, se[1]]);
      emit('boxselect', {
        point1: p1,
        point2: p2,
        lonLat1: nw,
        lonLat2: se,
        bounds: bounds,
        widthMeters: widthMeters,
        heightMeters: heightMeters,
        areaM2: widthMeters * heightMeters,
        originalEvent: originalEvent
      });
      if (boxZoomOption) fitBounds(bounds);
    }

    function onPointerDown(event) {
      // Right-drag or Ctrl-drag rotates (horizontal) and tilts (vertical).
      if (dragRotate && !pointerCount && !rotateDrag && !boxEl && (event.button === 2 || (event.button === 0 && event.ctrlKey)) &&
        (!event.target || event.target === element)) {
        event.preventDefault();
        stopInertia();
        stopZoomAnim();
        stopCameraAnim();
        rotateDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, bearing: bearing, pitch: pitch, moved: false, menu: null };
        if (element.setPointerCapture) element.setPointerCapture(event.pointerId);
        element.style.cursor = 'grabbing';
        return;
      }
      if (event.button != null && event.button !== 0) return;
      if (event.target && event.target !== element) return;
      event.preventDefault();
      stopInertia();
      stopZoomAnim();
      stopCameraAnim();
      if (boxEl) return;
      var point = localPoint(event);

      if (boxSelect && !pointerCount && event[boxSelectKey]) {
        boxId = event.pointerId;
        boxFrom = point;
        if (element.setPointerCapture) element.setPointerCapture(event.pointerId);
        boxEl = root.document.createElement('div');
        boxEl.className = 'micromap-box';
        boxEl.style.cssText = 'position:absolute;z-index:3;border:2px dashed #3388ff;' +
          'background:rgba(51,136,255,.15);pointer-events:none';
        element.appendChild(boxEl);
        element.style.cursor = 'crosshair';
        updateBoxRect(point, point);
        return;
      }

      if (!pointers[event.pointerId]) pointerCount++;
      pointers[event.pointerId] = point;
      if (element.setPointerCapture) element.setPointerCapture(event.pointerId);
      element.style.cursor = 'grabbing';
      if (pointerCount === 1) {
        lastPointer = point;
        velocityX = velocityY = 0;
        lastMoveTime = 0;
        clickStart = { id: event.pointerId, x: point[0], y: point[1], moved: false };
      } else {
        clickStart = null;
        beginPinch();
      }
    }

    function onPointerMove(event) {
      if (rotateDrag && event.pointerId === rotateDrag.id) {
        event.preventDefault();
        var turnX = event.clientX - rotateDrag.x;
        var turnY = event.clientY - rotateDrag.y;
        if (!rotateDrag.moved && Math.abs(turnX) + Math.abs(turnY) < 3) return;
        rotateDrag.moved = true;
        setOrientation(rotateDrag.bearing + turnX * 0.8,
          pitchWithRotate ? rotateDrag.pitch - turnY * 0.5 : pitch, true, event);
        return;
      }
      if (boxEl && event.pointerId === boxId) {
        event.preventDefault();
        updateBoxRect(boxFrom, localPoint(event));
        return;
      }
      if (!pointers[event.pointerId]) return;
      event.preventDefault();
      var point = localPoint(event);
      pointers[event.pointerId] = point;

      if (pointerCount > 1) {
        if (!touchZoomEnabled) return;
        var pair = pointerPair();
        if (!pair || !pinch) return;
        var mid = [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
        var dx = pair[0][0] - pair[1][0];
        var dy = pair[0][1] - pair[1][1];
        var distance = Math.sqrt(dx * dx + dy * dy) || 1;
        var moveA = [pair[0][0] - pinch.start[0][0], pair[0][1] - pinch.start[0][1]];
        var moveB = [pair[1][0] - pinch.start[1][0], pair[1][1] - pinch.start[1][1]];
        if (!pinch.mode) {
          // Two side-by-side fingers moving up or down together tilt the
          // map (MapLibre's touchPitch); anything else zooms and rotates.
          var startDX = pinch.start[0][0] - pinch.start[1][0];
          var startDY = pinch.start[0][1] - pinch.start[1][1];
          if (touchPitch && Math.abs(moveA[1]) > 6 && Math.abs(moveB[1]) > 6 && moveA[1] * moveB[1] > 0 &&
            Math.abs(moveA[0]) < Math.abs(moveA[1]) && Math.abs(moveB[0]) < Math.abs(moveB[1]) && Math.abs(startDY) < Math.abs(startDX) * 0.7) {
            pinch.mode = 'pitch';
          } else if (Math.abs(distance - pinch.distance) > 4 || Math.abs(moveA[0]) + Math.abs(moveA[1]) + Math.abs(moveB[0]) + Math.abs(moveB[1]) > 12) {
            pinch.mode = 'zoom';
          } else return;
        }
        if (pinch.mode === 'pitch') {
          setPitch(pinch.pitch - (moveA[1] + moveB[1]) / 2 * 0.5, true);
          return;
        }
        var oldZoom = zoom;
        var rotated = false;
        if (touchRotate) {
          var turn = Math.atan2(dy, dx) - pinch.angle;
          turn = Math.atan2(Math.sin(turn), Math.cos(turn));
          // Like MapLibre, a twist only starts rotating past a threshold so
          // that a plain pinch never turns the map by accident.
          if (!pinch.rotating && Math.abs(turn) > 10 * DEG) {
            pinch.rotating = true;
            pinch.angle += turn > 0 ? 10 * DEG : -10 * DEG;
            turn = Math.atan2(Math.sin(Math.atan2(dy, dx) - pinch.angle), Math.cos(Math.atan2(dy, dx) - pinch.angle));
          }
          if (pinch.rotating) {
            var nextBearing = (((pinch.bearing - turn / DEG) % 360) + 360) % 360;
            rotated = nextBearing !== bearing;
            if (rotated) {
              bearing = nextBearing;
              cameraCosine = Math.cos(-bearing * DEG);
              cameraSine = Math.sin(-bearing * DEG);
            }
          }
        }
        zoom = clamp(snapZoom(pinch.zoom + log2(distance / pinch.distance)), minZoom, maxZoom);
        var size = worldSize();
        var raw = rawPoint(mid[0], mid[1]);
        centerX = pinch.world[0] - (raw[0] - width / 2) / size;
        centerY = pinch.world[1] - (raw[1] - height / 2) / size;
        limitCenter();
        changed(oldZoom, event, false, rotated, false);
      } else if (lastPointer) {
        var moveX = point[0] - lastPointer[0];
        var moveY = point[1] - lastPointer[1];
        if (clickStart && (Math.abs(point[0] - clickStart.x) > 4 || Math.abs(point[1] - clickStart.y) > 4)) {
          clickStart.moved = true;
        }
        lastPointer = point;
        var now = Date.now();
        if (lastMoveTime && now > lastMoveTime) {
          var dt = (now - lastMoveTime) / 1000;
          velocityX = velocityX * 0.7 + (-moveX / dt) * 0.3;
          velocityY = velocityY * 0.7 + (-moveY / dt) * 0.3;
        }
        lastMoveTime = now;
        if (dragging) moveCenter(-moveX, -moveY, event);
      }
    }

    function onPointerEnd(event) {
      if (rotateDrag && event.pointerId === rotateDrag.id) {
        var drag = rotateDrag;
        rotateDrag = null;
        if (element.releasePointerCapture) element.releasePointerCapture(event.pointerId);
        element.style.cursor = 'grab';
        if (drag.moved) {
          // Windows and Linux send contextmenu after the button is released.
          suppressMenuUntil = Date.now() + 400;
          snapBearing();
          finish();
        } else if (drag.menu) contextMenuAt(drag.menu.point, drag.menu.event);
        return;
      }
      if (boxEl && event.pointerId === boxId) {
        if (event.type === 'pointercancel') cancelBoxSelect();
        else finishBoxSelect(localPoint(event), event);
        return;
      }
      if (!pointers[event.pointerId]) return;
      var point = localPoint(event);
      var isClick = event.type === 'pointerup' && pointerCount === 1 && clickStart &&
        clickStart.id === event.pointerId && !clickStart.moved;
      var wasDragging = pointerCount === 1 && clickStart && clickStart.moved;
      delete pointers[event.pointerId];
      pointerCount--;

      if (isClick) {
        emit('click', { point: point, lonLat: unproject(point), originalEvent: event });
      }

      if (pointerCount > 1) beginPinch();
      else if (pointerCount === 1) {
        var ids = Object.keys(pointers);
        lastPointer = pointers[ids[0]];
        pinch = null;
        clickStart = null;
      } else {
        var twisted = pinch && pinch.rotating;
        lastPointer = pinch = clickStart = null;
        element.style.cursor = 'grab';
        if (twisted) snapBearing();
        if (dragging && inertia && wasDragging && (Math.abs(velocityX) > 60 || Math.abs(velocityY) > 60)) {
          runInertia(velocityX, velocityY);
        } else {
          finish();
        }
      }
    }

    function onWheel(event) {
      if (!scrollWheelZoom) return;
      if (event.target && event.target !== element) return;
      event.preventDefault();
      var raw = event.deltaY;
      if (event.deltaMode === 1) raw *= 16;
      else if (event.deltaMode === 2) raw *= height;

      // A trackpad pinch gesture is reported as a wheel event with ctrlKey
      // set (Safari, Chrome and Firefox all do this on macOS/precision
      // touchpads); plain two-finger trackpad scrolling reports small,
      // non-quantized deltas, while a physical mouse wheel reports larger,
      // fixed-size notches. Trackpad input needs a gentler per-unit rate to
      // feel proportionate instead of overshooting on every tick.
      var isTrackpad = event.ctrlKey || Math.abs(raw) < 50;
      var delta = isTrackpad ? clamp(-raw * 0.01, -1.5, 1.5) : clamp(-raw * 0.004, -1, 1);

      var base = zoomFollowFrame ? zoomFollowTarget : zoom;
      followZoomTo(base + delta, localPoint(event), event);
    }

    function onDoubleClick(event) {
      if (!doubleClickZoom) return;
      if (event.target && event.target !== element) return;
      event.preventDefault();
      animateZoomTo(zoom + (event.shiftKey ? -1 : 1), localPoint(event), 300, event);
    }

    function onContextMenu(event) {
      if (event.target && event.target !== element) return;
      event.preventDefault();
      // macOS fires contextmenu when the button goes down: wait until the
      // press ends without a rotation. After a rotation, drop it.
      if (rotateDrag) {
        if (!rotateDrag.moved) rotateDrag.menu = { point: localPoint(event), event: event };
        return;
      }
      if (Date.now() < suppressMenuUntil) return;
      contextMenuAt(localPoint(event), event);
    }

    function contextMenuAt(point, event) {
      var lonLat = unproject(point);
      emit('contextmenu', { point: point, lonLat: lonLat, originalEvent: event });
      if (contextMenuBuilder) {
        var items = contextMenuBuilder({ point: point, lonLat: lonLat, originalEvent: event });
        if (items && items.length) openMenu(point, items);
      }
    }

    function onKeyDown(event) {
      if (event.target && event.target !== element) return;
      if (boxEl && event.key === 'Escape') {
        cancelBoxSelect();
        event.preventDefault();
        return;
      }
      if (!keyboardEnabled) return;
      var key = event.key;
      var handled = true;
      // Shift+arrows rotate and tilt like MapLibre.
      if (event.shiftKey && /^Arrow/.test(key)) {
        // Repeated keys build on the running animation's target.
        var base = cameraTarget || [bearing, pitch];
        if (key === 'ArrowLeft' || key === 'ArrowRight') animateCamera(base[0] + (key === 'ArrowLeft' ? -15 : 15), base[1], 300);
        else animateCamera(base[0], base[1] + (key === 'ArrowUp' ? 10 : -10), 300);
        event.preventDefault();
        return;
      }
      if (key === 'ArrowLeft') moveCenter(-80, 0, event, true);
      else if (key === 'ArrowRight') moveCenter(80, 0, event, true);
      else if (key === 'ArrowUp') moveCenter(0, -80, event, true);
      else if (key === 'ArrowDown') moveCenter(0, 80, event, true);
      else if (key === '+' || key === '=') animateZoomTo(zoom + 1, null, 250, event);
      else if (key === '-' || key === '_') animateZoomTo(zoom - 1, null, 250, event);
      else handled = false;
      if (handled) event.preventDefault();
    }

    // `animating` marks a frame of a camera animation: the movement then ends
    // with its final frame (or 180 ms later) instead of after every frame.
    function setView(lonLat, nextZoom, animating) {
      if (destroyed) return api;
      var world = toWorld(lonLat);
      stopInertia();
      stopZoomAnim();
      var oldZoom = zoom;
      centerX = world[0];
      centerY = world[1];
      if (nextZoom != null && isFinite(+nextZoom)) zoom = clamp(animating ? +nextZoom : snapZoom(+nextZoom), minZoom, maxZoom);
      limitCenter();
      changed(oldZoom, null, !animating);
      return api;
    }

    function setOrientation(nextBearing, nextPitch, animating, originalEvent) {
      if (destroyed) return api;
      if (!isFinite(+nextBearing)) throw new Error('microMap: bearing must be finite');
      if (!isFinite(+nextPitch)) throw new Error('microMap: pitch must be finite');
      nextBearing = ((+nextBearing % 360) + 360) % 360;
      nextPitch = clamp(+nextPitch, 0, maxPitch);
      var rotated = nextBearing !== bearing;
      var tilted = nextPitch !== pitch;
      if (!rotated && !tilted) return api;
      bearing = nextBearing;
      pitch = nextPitch;
      if (rotated) {
        cameraCosine = Math.cos(-bearing * DEG);
        cameraSine = Math.sin(-bearing * DEG);
      }
      if (tilted) {
        cameraPitchScale = Math.cos(pitch * DEG);
        cameraInversePitchScale = 1 / cameraPitchScale;
      }
      limitCenter();
      changed(zoom, originalEvent || null, !animating, rotated, tilted);
      return api;
    }

    function setBearing(nextBearing, animating) {
      return setOrientation(nextBearing, pitch, animating);
    }

    function setPitch(nextPitch, animating) {
      return setOrientation(bearing, nextPitch, animating);
    }

    function fitBounds(bounds, padding) {
      if (destroyed) return api;
      var box = boundsValues(bounds);
      var west = box[0];
      var south = box[1];
      var east = box[2];
      var north = box[3];
      var padX = padding && padding.length ? +padding[0] : +padding || 0;
      var padY = padding && padding.length ? +padding[1] : +padding || 0;
      var nw = toWorld([west, north]);
      var se = toWorld([east, south]);
      if (east < west) se[0] += 1;
      var dx = Math.abs(se[0] - nw[0]);
      var dy = Math.abs(se[1] - nw[1]);
      var availableWidth = Math.max(1, width - 2 * padX);
      var availableHeight = Math.max(1, height - 2 * padY);
      var radians = bearing * DEG;
      var cosine = Math.abs(Math.cos(radians));
      var sine = Math.abs(Math.sin(radians));
      var verticalScale = cameraScale();
      var nextZoom = Math.min(
        dx || dy ? log2(availableWidth / (tileSize * (cosine * dx + sine * dy))) : maxZoom,
        dx || dy ? log2(availableHeight / (tileSize * verticalScale * (sine * dx + cosine * dy))) : maxZoom,
        maxZoom
      );
      var oldZoom = zoom;
      centerX = (nw[0] + se[0]) / 2;
      centerY = (nw[1] + se[1]) / 2;
      zoom = clamp(snapZoom(nextZoom), minZoom, maxZoom);
      limitCenter();
      changed(oldZoom, null, true);
      return api;
    }

    // TileJSON coverage and an application's permitted operating area can
    // change after construction. Reuse the same bearing-, pitch- and
    // antimeridian-aware clamp as the initial maxBounds option.
    function setMaxBounds(bounds) {
      if (destroyed) return api;
      var oldX = centerX;
      var oldY = centerY;
      maxBounds = bounds == null ? null : boundsWorld(bounds);
      limitCenter();
      if (centerX !== oldX || centerY !== oldY) changed(zoom, null, true);
      return api;
    }

    // `preload()` schedules the current policy; with an argument it is a
    // compact convenience form of `setPreload()`.  Zoom values are relative
    // offsets (for example, `zoom: 1` warms the next detail level).
    function setPreload(nextOptions) {
      if (destroyed) return api;
      preloadOptions = preloadConfig(nextOptions);
      clearPreloads();
      schedulePreloads();
      return api;
    }

    function preload(nextOptions) {
      if (arguments.length) return setPreload(nextOptions);
      schedulePreloads();
      return api;
    }

    // Return a copy so an application cannot mutate the active scheduler
    // policy without going through setPreload().
    function getPreload() {
      if (!preloadOptions) return null;
      return {
        around: preloadOptions.around,
        zoom: preloadOptions.zoom.slice(),
        direction: preloadOptions.direction && {
          bearing: preloadOptions.direction.bearing,
          distance: preloadOptions.direction.distance,
          width: preloadOptions.direction.width
        },
        maxTiles: preloadOptions.maxTiles,
        delay: preloadOptions.delay
      };
    }

    function getNavigation() {
      if (!navigation) return null;
      return {
        position: navigation.position && navigation.position.slice(),
        heading: navigation.heading,
        speed: navigation.speed,
        lookAhead: navigation.lookAhead,
        follow: navigation.follow
      };
    }

    // This deliberately stores application-provided navigation state only;
    // it never starts geolocation.  A position guides preloads even while the
    // user looks elsewhere.  `follow: true` is the explicit opt-in to move
    // the camera to that position.
    function setNavigation(next) {
      if (destroyed) return api;
      if (next == null) {
        navigation = null;
        clearPreloads();
        schedulePreloads();
        emit('navigationchange', { navigation: null });
        return api;
      }
      if (typeof next !== 'object' || Array.isArray(next)) {
        throw new Error('microMap: navigation must be an options object or null');
      }
      var previous = navigation || {};
      var owns = Object.prototype.hasOwnProperty;
      var state = {};
      if (owns.call(next, 'position')) {
        if (next.position == null) {
          state.position = state.world = null;
        } else {
          state.position = [+next.position[0], clamp(+next.position[1], -MAX_LAT, MAX_LAT)];
          state.world = toWorld(state.position);
        }
      } else {
        state.position = previous.position && previous.position.slice();
        state.world = previous.world && previous.world.slice();
      }
      if (owns.call(next, 'heading')) {
        if (next.heading == null) state.heading = null;
        else {
          if (!isFinite(+next.heading)) throw new Error('microMap: navigation.heading must be finite');
          state.heading = ((+next.heading % 360) + 360) % 360;
        }
      } else state.heading = previous.heading == null ? null : previous.heading;
      if (owns.call(next, 'speed')) {
        if (!isFinite(+next.speed)) throw new Error('microMap: navigation.speed must be finite');
        state.speed = clamp(+next.speed, 0, 1000);
      } else state.speed = finite(previous.speed, 0);
      if (owns.call(next, 'lookAhead')) {
        if (!isFinite(+next.lookAhead)) throw new Error('microMap: navigation.lookAhead must be finite');
        state.lookAhead = clamp(+next.lookAhead, 0, 120);
      } else state.lookAhead = finite(previous.lookAhead, 15);
      state.follow = owns.call(next, 'follow') ? !!next.follow : !!previous.follow;
      navigation = state;
      clearPreloads();
      if (state.follow && state.position) setView(state.position);
      schedulePreloads();
      emit('navigationchange', { navigation: getNavigation() });
      return api;
    }

    function clearTiles() {
      if (zoomPruneTimer) root.clearTimeout(zoomPruneTimer);
      zoomPruneTimer = 0;
      lastTileZoom = null;
      for (var z in panes) {
        if (panes[z].parentNode === tileLayer) tileLayer.removeChild(panes[z]);
      }
      panes = Object.create(null);
      tiles = Object.create(null);
      tilePending = Object.create(null);
      tileErrors = Object.create(null);
    }

    // Replace the XYZ source without recreating the map. This is useful for
    // switching between an online basemap and a local/offline tile endpoint.
    function setTiles(nextSource, sourceOptions) {
      if (destroyed) return api;
      if (nextSource !== false && (!nextSource || (typeof nextSource !== 'string' && typeof nextSource !== 'function'))) {
        throw new Error('microMap: tiles must be a URL template or function (or false for overlays only)');
      }
      sourceOptions = sourceOptions || {};
      if (sourceOptions.subdomains != null) {
        if (typeof sourceOptions.subdomains !== 'string' || !sourceOptions.subdomains) {
          throw new Error('microMap: subdomains must be a non-empty string');
        }
        subdomains = sourceOptions.subdomains;
      }
      if (sourceOptions.crossOrigin !== undefined) crossOrigin = sourceOptions.crossOrigin;
      if (sourceOptions.referrerPolicy !== undefined) referrerPolicy = sourceOptions.referrerPolicy;
      source = nextSource || null;
      sourceVersion++;
      clearPreloads();
      clearTiles();
      schedule();
      emit('tileschange', { tiles: source });
      return api;
    }

    function resize() {
      if (destroyed) return api;
      var oldWidth = width;
      var oldHeight = height;
      width = element.clientWidth;
      height = element.clientHeight;
      limitCenter();
      schedule();
      if (width !== oldWidth || height !== oldHeight) {
        emit('resize', { size: [width, height], oldSize: [oldWidth, oldHeight] });
      }
      return api;
    }

    function on(type, handler) {
      if (!destroyed) (listeners[type] || (listeners[type] = [])).push(handler);
      return api;
    }

    // Register a one-shot lifecycle/interaction handler. Store the original
    // callback on the wrapper so off(type, handler) can also cancel it before
    // the event occurs, just like an ordinary registration.
    function once(type, handler) {
      if (typeof handler !== 'function') return api;
      function onceHandler(event) {
        off(type, onceHandler);
        handler(event);
      }
      onceHandler._microMapOnce = handler;
      return on(type, onceHandler);
    }

    function off(type, handler) {
      var list = listeners[type];
      if (!list) return api;
      if (!handler) delete listeners[type];
      else {
        var index = list.indexOf(handler);
        if (index < 0) for (index = 0; index < list.length; index++) {
          if (list[index]._microMapOnce === handler) break;
        }
        if (index > -1 && index < list.length) list.splice(index, 1);
      }
      return api;
    }

    function onMenuOutside(event) {
      if (menuEl && !menuEl.contains(event.target)) closeMenu();
    }

    function onMenuKey(event) {
      if (event.key === 'Escape') closeMenu();
    }

    function closeMenu() {
      if (!menuEl) return api;
      var el = menuEl;
      menuEl = null;
      off('move', closeMenu);
      off('zoom', closeMenu);
      root.document.removeEventListener('pointerdown', onMenuOutside, true);
      root.document.removeEventListener('keydown', onMenuKey, true);
      if (el.parentNode === element) element.removeChild(el);
      if (root.document.activeElement && el.contains(root.document.activeElement) && element.focus) element.focus();
      return api;
    }

    // A minimal, ready-to-fill context/click menu: pass an array of
    // {label, onClick, disabled?, keepOpen?} items (or '-' for a separator)
    // and it handles positioning, dismissal (outside click, Escape, map
    // move/zoom, destroy()) and cleanup. Not tied to right-click — call it
    // from any event handler (e.g. 'click') to build a left-click menu too.
    function openMenu(point, items, menuOptions) {
      if (destroyed || !items || !items.length) return null;
      closeMenu();
      menuOptions = menuOptions || {};
      var menu = root.document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Map actions');
      menu.className = menuOptions.className || 'micromap-menu';
      menu.style.cssText = 'position:absolute;z-index:3;min-width:140px;padding:4px;' +
        'background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:6px;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.18);font:13px/1.4 sans-serif;user-select:none';
      menu.onpointerdown = function (event) { event.stopPropagation(); };
      menu.oncontextmenu = function (event) { event.preventDefault(); event.stopPropagation(); };

      var i;
      var item;
      var entry;
      var firstEnabled = null;
      for (i = 0; i < items.length; i++) {
        item = items[i];
        if (item === '-' || item == null) {
          entry = root.document.createElement('div');
          entry.style.cssText = 'margin:4px 2px;border-top:1px solid rgba(0,0,0,.1)';
          menu.appendChild(entry);
          continue;
        }
        entry = root.document.createElement('button');
        entry.type = 'button';
        entry.setAttribute('role', 'menuitem');
        entry.textContent = item.label;
        entry.disabled = !!item.disabled;
        entry.style.cssText = 'display:block;width:100%;margin:0;padding:6px 10px;border:0;' +
          'background:none;text-align:left;font:inherit;color:inherit;border-radius:4px' +
          (item.disabled ? ';opacity:.45' : ';cursor:pointer');
        if (!item.disabled) {
          if (!firstEnabled) firstEnabled = entry;
          entry.onmouseenter = function () { this.style.background = 'rgba(0,0,0,.06)'; };
          entry.onmouseleave = function () { this.style.background = 'none'; };
          entry.onclick = (function (clickedItem) {
            return function (clickEvent) {
              if (!clickedItem.keepOpen) closeMenu();
              if (clickedItem.onClick) clickedItem.onClick(clickEvent);
            };
          }(item));
        }
        menu.appendChild(entry);
      }

      element.appendChild(menu);
      menu.style.left = point[0] + 'px';
      menu.style.top = point[1] + 'px';
      var menuRect = menu.getBoundingClientRect();
      var boxRect = element.getBoundingClientRect();
      if (point[0] + menuRect.width > boxRect.width) {
        menu.style.left = Math.max(0, boxRect.width - menuRect.width) + 'px';
      }
      if (point[1] + menuRect.height > boxRect.height) {
        menu.style.top = Math.max(0, boxRect.height - menuRect.height) + 'px';
      }

      menuEl = menu;
      on('move', closeMenu);
      on('zoom', closeMenu);
      root.document.addEventListener('pointerdown', onMenuOutside, true);
      root.document.addEventListener('keydown', onMenuKey, true);
      if (firstEnabled && firstEnabled.focus) firstEnabled.focus();
      return { element: menu, close: closeMenu };
    }

    function addMarker(lonLat, markerOptions) {
      if (destroyed) return null;
      markerOptions = markerOptions || {};
      var el = markerOptions.element || root.document.createElement('div');
      if (!markerOptions.element) {
        el.className = markerOptions.className || 'micromap-marker';
        el.style.cssText = 'position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;' +
          'border-radius:50%;background:#e74c3c;border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.4)';
      } else {
        el.style.position = 'absolute';
      }
      // Vector canvases deliberately sit above the raster pane. Keep marker
      // overlays above that canvas unless the caller supplied their own layer.
      if (!el.style.zIndex) el.style.zIndex = '3';
      var stopMarkerPointer = null;
      if (markerOptions.interactive) {
        stopMarkerPointer = function (event) { event.stopPropagation(); };
        el.addEventListener('pointerdown', stopMarkerPointer);
      } else el.style.pointerEvents = 'none';
      var anchor = markerOptions.anchor || [0, 0];
      var point = lonLat;
      element.appendChild(el);

      function update() {
        var pixel = project(point);
        el.style.left = (pixel[0] - anchor[0]) + 'px';
        el.style.top = (pixel[1] - anchor[1]) + 'px';
      }

      var markerApi = {
        element: el,
        setLonLat: function (nextLonLat) { point = nextLonLat; update(); return markerApi; },
        getLonLat: function () { return point; },
        remove: function () {
          off('move', update);
          off('zoom', update);
          off('resize', update);
          if (stopMarkerPointer) el.removeEventListener('pointerdown', stopMarkerPointer);
          if (el.parentNode === element) element.removeChild(el);
          var index = markers.indexOf(markerApi);
          if (index > -1) markers.splice(index, 1);
          return api;
        }
      };
      on('move', update);
      on('zoom', update);
      on('resize', update);
      update();
      markers.push(markerApi);
      return markerApi;
    }

    // Routes are deliberately a compact SVG overlay rather than a new data
    // source model. Callers can feed it an already-routed GeoJSON coordinate
    // array, while the core keeps its pixels in the same camera transform as
    // tiles, vectors and markers.
    function addRoute(coordinates, routeOptions) {
      if (destroyed) return null;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error('microMap: route needs at least two [longitude, latitude] coordinates');
      }
      var points = [];
      var i;
      for (i = 0; i < coordinates.length; i++) {
        if (!coordinates[i] || coordinates[i].length < 2) {
          throw new Error('microMap: route coordinates must be [longitude, latitude] pairs');
        }
        toWorld(coordinates[i]);
        points.push([+coordinates[i][0], +coordinates[i][1]]);
      }
      routeOptions = routeOptions || {};
      var svg = root.document.createElementNS ? root.document.createElementNS('http://www.w3.org/2000/svg', 'svg') : root.document.createElement('svg');
      var casing = root.document.createElementNS ? root.document.createElementNS('http://www.w3.org/2000/svg', 'path') : root.document.createElement('path');
      var line = root.document.createElementNS ? root.document.createElementNS('http://www.w3.org/2000/svg', 'path') : root.document.createElement('path');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', routeOptions.className || 'micromap-route');
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:' +
        clamp(Math.floor(finite(routeOptions.zIndex, 2)), -100, 100) + ';overflow:visible;pointer-events:none';
      svg.appendChild(casing);
      svg.appendChild(line);
      element.appendChild(svg);

      function applyStyle() {
        var routeWidth = clamp(finite(routeOptions.width, 6), 1, 64);
        var outlineWidth = clamp(finite(routeOptions.outlineWidth, 2), 0, 32);
        var lineCap = routeOptions.lineCap || 'round';
        var lineJoin = routeOptions.lineJoin || 'round';
        casing.setAttribute('fill', 'none');
        casing.setAttribute('stroke', routeOptions.outlineColor || '#fff');
        casing.setAttribute('stroke-width', routeWidth + outlineWidth * 2);
        casing.setAttribute('stroke-linecap', lineCap);
        casing.setAttribute('stroke-linejoin', lineJoin);
        casing.setAttribute('opacity', outlineWidth ? finite(routeOptions.outlineOpacity, 0.9) : 0);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', routeOptions.color || '#1769e0');
        line.setAttribute('stroke-width', routeWidth);
        line.setAttribute('stroke-linecap', lineCap);
        line.setAttribute('stroke-linejoin', lineJoin);
        line.setAttribute('opacity', finite(routeOptions.opacity, 1));
        if (routeOptions.dashArray != null) line.setAttribute('stroke-dasharray', routeOptions.dashArray);
        else line.removeAttribute('stroke-dasharray');
      }

      function update() {
        var routeWidth = Math.max(1, width);
        var routeHeight = Math.max(1, height);
        var path = '';
        for (var index = 0; index < points.length; index++) {
          var pixel = project(points[index]);
          path += (index ? 'L' : 'M') + pixel[0] + ' ' + pixel[1];
        }
        svg.setAttribute('viewBox', '0 0 ' + routeWidth + ' ' + routeHeight);
        casing.setAttribute('d', path);
        line.setAttribute('d', path);
      }

      var routeApi = {
        element: svg,
        setCoordinates: function (nextCoordinates) {
          if (!Array.isArray(nextCoordinates) || nextCoordinates.length < 2) {
            throw new Error('microMap: route needs at least two [longitude, latitude] coordinates');
          }
          points = [];
          for (var index = 0; index < nextCoordinates.length; index++) {
            if (!nextCoordinates[index] || nextCoordinates[index].length < 2) {
              throw new Error('microMap: route coordinates must be [longitude, latitude] pairs');
            }
            toWorld(nextCoordinates[index]);
            points.push([+nextCoordinates[index][0], +nextCoordinates[index][1]]);
          }
          update();
          return routeApi;
        },
        getCoordinates: function () { return points.map(function (point) { return point.slice(); }); },
        setStyle: function (nextOptions) {
          if (nextOptions && typeof nextOptions === 'object') {
            for (var key in nextOptions) routeOptions[key] = nextOptions[key];
            applyStyle();
          }
          return routeApi;
        },
        remove: function () {
          off('move', update);
          off('resize', update);
          if (svg.parentNode === element) element.removeChild(svg);
          var index = routes.indexOf(routeApi);
          if (index > -1) routes.splice(index, 1);
          return api;
        }
      };
      applyStyle();
      on('move', update);
      on('resize', update);
      update();
      routes.push(routeApi);
      return routeApi;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      var waiters = idleWaiters.splice(0);
      for (var waiter = 0; waiter < waiters.length; waiter++) waiters[waiter].reject(new Error('microMap: map has been destroyed'));
      stopCameraAnim();
      emit('destroy');
      sourceVersion++;
      clearPreloads();
      stopInertia();
      stopZoomAnim();
      if (zoomPruneTimer) root.clearTimeout(zoomPruneTimer);
      finish();
      while (routes.length) routes[routes.length - 1].remove();
      while (markers.length) markers[markers.length - 1].remove();
      closeMenu();
      cancelBoxSelect();
      if (frame) cancelFrame.call(root, frame);
      if (observer) observer.disconnect();
      else if (root.removeEventListener) root.removeEventListener('resize', resize);
      for (var i = 0; i < events.length; i++) element.removeEventListener(events[i][0], events[i][1], events[i][2]);
      for (var z in panes) {
        if (panes[z].parentNode === tileLayer) tileLayer.removeChild(panes[z]);
      }
      if (tileLayer.parentNode === element) element.removeChild(tileLayer);
      if (attribution && attribution.parentNode === element) element.removeChild(attribution);
      element.style.cssText = oldStyle;
      if (oldTabindex == null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', oldTabindex);
      if (oldRole == null) element.removeAttribute('role');
      else element.setAttribute('role', oldRole);
      if (oldLabel == null) element.removeAttribute('aria-label');
      else element.setAttribute('aria-label', oldLabel);
      panes = Object.create(null);
      tiles = Object.create(null);
      tilePending = Object.create(null);
      tileErrors = Object.create(null);
      events = [];
      listeners = Object.create(null);
    }

    // MapLibre-shaped runtime switches: map.dragRotate.disable() and so on.
    function handler(read, write, extra) {
      var value = {
        enable: function () { write(true); return value; },
        disable: function () { write(false); return value; },
        isEnabled: function () { return !!read(); }
      };
      for (var key in extra) value[key] = extra[key];
      return value;
    }

    var api = {
      dragPan: handler(function () { return dragging; }, function (on) { dragging = on; }),
      scrollZoom: handler(function () { return scrollWheelZoom; }, function (on) { scrollWheelZoom = on; }),
      doubleClickZoom: handler(function () { return doubleClickZoom; }, function (on) { doubleClickZoom = on; }),
      keyboard: handler(function () { return keyboardEnabled; }, function (on) { keyboardEnabled = on; }),
      boxZoom: handler(function () { return boxSelect; }, function (on) { boxSelect = on; }),
      dragRotate: handler(function () { return dragRotate; }, function (on) { dragRotate = on; }),
      touchPitch: handler(function () { return touchPitch; }, function (on) { touchPitch = on; }),
      touchZoomRotate: handler(function () { return touchZoomEnabled; }, function (on) { touchZoomEnabled = on; }, {
        enableRotation: function () { touchRotate = true; },
        disableRotation: function () { touchRotate = false; },
        isRotationEnabled: function () { return touchRotate; }
      }),
      setView: setView,
      setCenter: function (lonLat) { return setView(lonLat); },
      setZoom: function (nextZoom, point, duration) {
        if (destroyed) return api;
        if (finite(duration, 0) > 0) animateZoomTo(nextZoom, point, duration);
        else zoomAt(nextZoom, point, null, true);
        return api;
      },
      // A direct camera call ends a running key or snap animation.
      setBearing: function (value, animating) { if (!animating) stopCameraAnim(); return setBearing(value, animating); },
      setPitch: function (value, animating) { if (!animating) stopCameraAnim(); return setPitch(value, animating); },
      fitBounds: fitBounds,
      setMaxBounds: setMaxBounds,
      setTiles: setTiles,
      loaded: function () { return loaded && !destroyed; },
      whenIdle: whenIdle,
      setPreload: setPreload,
      preload: preload,
      getPreload: getPreload,
      setNavigation: setNavigation,
      getNavigation: getNavigation,
      panBy: function (offset) {
        if (!destroyed && offset) moveCenter(+offset[0], +offset[1], null, true);
        return api;
      },
      getCenter: getCenter,
      getZoom: function () { return zoom; },
      getBearing: function () { return bearing; },
      getPitch: function () { return pitch; },
      getCameraState: getCameraState,
      getBounds: function () {
        var view = rawView();
        var size = worldSize();
        var west = toLonLat([centerX + (view.x0 - width / 2) / size, 0])[0];
        var east = toLonLat([centerX + (view.x1 - width / 2) / size, 0])[0];
        var north = toLonLat([0, centerY + (view.y0 - height / 2) / size])[1];
        var south = toLonLat([0, centerY + (view.y1 - height / 2) / size])[1];
        return [west, south, east, north];
      },
      project: project,
      unproject: unproject,
      resize: resize,
      addMarker: addMarker,
      addRoute: addRoute,
      openMenu: openMenu,
      closeMenu: closeMenu,
      cancelBoxSelect: cancelBoxSelect,
      distanceTo: function (a, b) { return distance(a, b); },
      getContainer: function () { return element; },
      on: on,
      once: once,
      off: off,
      destroy: destroy
    };

    addEvent('pointerdown', onPointerDown);
    addEvent('pointermove', onPointerMove);
    addEvent('pointerup', onPointerEnd);
    addEvent('pointercancel', onPointerEnd);
    addEvent('wheel', onWheel, { passive: false });
    addEvent('dblclick', onDoubleClick);
    addEvent('contextmenu', onContextMenu);
    addEvent('keydown', onKeyDown);

    var observer = null;
    if (root.ResizeObserver) {
      observer = new root.ResizeObserver(resize);
      observer.observe(element);
    } else if (root.addEventListener) root.addEventListener('resize', resize);

    // Navigation remains application-owned: this merely seeds the same state
    // that later calls to setNavigation() update. It never starts location
    // tracking or changes the camera unless follow is explicitly true.
    if (options.navigation != null) setNavigation(options.navigation);
    resize();
    return api;
  }

  microMap.search = search;
  return microMap;
}));
