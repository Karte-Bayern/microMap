/*! microMap.camera.js v0.2.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapCamera = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function centerValues(value) {
    if (Array.isArray(value)) return [+value[0], +value[1]];
    if (value && typeof value === 'object') return [+(value.lng != null ? value.lng : value.lon), +value.lat];
    throw new Error('microMap.camera: center must be [longitude, latitude] or {lng, lat}');
  }

  function validCenter(value) {
    return value.length >= 2 && isFinite(value[0]) && isFinite(value[1]);
  }

  function shortestDelta(from, to, period) {
    var delta = (to - from) % period;
    if (delta > period / 2) delta -= period;
    if (delta < -period / 2) delta += period;
    return delta;
  }

  function worldPoint(lon, lat) {
    var sine = Math.sin(clamp(lat, -85.0511287798, 85.0511287798) * Math.PI / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)];
  }

  function boundsValues(bounds) {
    var box = Array.isArray(bounds) && bounds.length === 2 && Array.isArray(bounds[0]) && Array.isArray(bounds[1]) ?
      bounds[0].slice(0, 2).concat(bounds[1].slice(0, 2)) : bounds;
    if (!Array.isArray(box) || box.length !== 4 || box.some(function (value) { return typeof value !== 'number' || !isFinite(value); }) ||
        box[1] > box[3] || box[1] < -90 || box[3] > 90 || Math.abs(box[2] - box[0]) > 360) {
      throw new Error('microMap.camera: bounds need finite [west, south, east, north] coordinates');
    }
    return box;
  }

  // CSS cubic-bezier easing (MapLibre's flyTo default is 'ease').
  function bezier(x1, y1, x2, y2) {
    var cx = 3 * x1;
    var bx = 3 * (x2 - x1) - cx;
    var ax = 1 - cx - bx;
    var cy = 3 * y1;
    var by = 3 * (y2 - y1) - cy;
    var ay = 1 - cy - by;
    function curveX(t) { return ((ax * t + bx) * t + cx) * t; }
    return function (x) {
      var t = x;
      for (var i = 0; i < 8; i++) {
        var error = curveX(t) - x;
        var slope = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(error) < 1e-7 || Math.abs(slope) < 1e-7) break;
        t -= error / slope;
      }
      t = clamp(t, 0, 1);
      return ((ay * t + by) * t + cy) * t;
    };
  }

  var ease = bezier(0.25, 0.1, 0.25, 1);

  function cosh(value) { return (Math.exp(value) + Math.exp(-value)) / 2; }
  function sinh(value) { return (Math.exp(value) - Math.exp(-value)) / 2; }

  function reducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  function paddingValues(padding) {
    if (padding == null) padding = 0;
    var sides;
    if (typeof padding === 'number') sides = [padding, padding, padding, padding];
    else if (Array.isArray(padding) && padding.length === 2) sides = [padding[1], padding[0], padding[1], padding[0]];
    else if (padding && typeof padding === 'object' && !Array.isArray(padding)) {
      sides = ['top', 'right', 'bottom', 'left'].map(function (side) { return padding[side] == null ? 0 : padding[side]; });
    }
    if (!sides || sides.some(function (value) { return typeof value !== 'number' || !isFinite(value) || value < 0; })) {
      throw new Error('microMap.camera: padding needs finite non-negative pixels');
    }
    return sides;
  }

  function cameraMap(map, options) {
    if (typeof microMap !== 'function' || !map || typeof map.setView !== 'function' || typeof map.getCenter !== 'function') {
      throw new Error('microMap.camera: pass a microMap instance');
    }
    options = options || {};
    var destroyed = false;
    var frame = 0;
    // The running animation: { started, duration, easing, at(k) -> camera }.
    var animation = null;

    function readCamera() {
      var center = centerValues(map.getCenter());
      return {
        lon: center[0], lat: center[1],
        zoom: finite(map.getZoom && map.getZoom(), 0),
        bearing: finite(map.getBearing && map.getBearing(), 0),
        pitch: finite(map.getPitch && map.getPitch(), 0)
      };
    }

    function cancelAnimation() {
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      animation = null;
      return api;
    }

    function assertOptions(next) {
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('microMap.camera: camera options must be an object');
      if (next.padding != null && (Array.isArray(next.padding) ? next.padding.some(function (value) { return +value !== 0; }) : +next.padding !== 0)) {
        throw new Error('microMap.camera: padding is not supported by this adapter');
      }
      if (next.offset != null && (Array.isArray(next.offset) ? next.offset.some(function (value) { return +value !== 0; }) : +next.offset !== 0)) {
        throw new Error('microMap.camera: offset is not supported by this adapter');
      }
    }

    function cameraTarget(next) {
      assertOptions(next);
      var current = readCamera();
      var target = {
        lon: current.lon, lat: current.lat, zoom: current.zoom,
        bearing: current.bearing, pitch: current.pitch
      };
      if (next.center != null) {
        var center = centerValues(next.center);
        if (!validCenter(center)) throw new Error('microMap.camera: center coordinates must be finite');
        target.lon = center[0];
        target.lat = center[1];
      }
      if (next.zoom != null) {
        target.zoom = +next.zoom;
        if (!isFinite(target.zoom)) throw new Error('microMap.camera: zoom must be finite');
      }
      if (next.bearing != null) {
        target.bearing = +next.bearing;
        if (!isFinite(target.bearing)) throw new Error('microMap.camera: bearing must be finite');
      }
      if (next.pitch != null) {
        target.pitch = +next.pitch;
        if (!isFinite(target.pitch)) throw new Error('microMap.camera: pitch must be finite');
      }
      return { current: current, target: target };
    }

    // Bearing and pitch first: the final setView then ends the whole
    // movement once, so moveend/zoomend/rotateend fire once per animation.
    function apply(camera, animating) {
      if (destroyed) return;
      if (typeof map.setBearing === 'function') map.setBearing(camera.bearing, true);
      if (typeof map.setPitch === 'function') map.setPitch(camera.pitch, true);
      map.setView([camera.lon, camera.lat], camera.zoom, animating);
    }

    function jumpTo(next) {
      if (destroyed) return api;
      cancelAnimation();
      var values = cameraTarget(next || {});
      apply(values.target, false);
      return api;
    }

    function step() {
      var current = animation;
      if (destroyed || !current) {
        frame = 0;
        return;
      }
      var progress = current.duration ? clamp((Date.now() - current.started) / current.duration, 0, 1) : 1;
      var done = progress >= 1;
      var eased = done ? 1 : clamp(+current.easing(progress), 0, 1);
      var camera = current.at(eased);
      if (done) {
        frame = 0;
        animation = null;
      }
      apply(camera, !done);
      if (!done && animation === current) frame = requestFrame.call(root, step);
    }

    // Like MapLibre, a non-essential animation becomes a jump when the user
    // asked the operating system for reduced motion.
    function animated(next, duration) {
      return next.animate !== false && duration > 0 && (next.essential || !reducedMotion());
    }

    function start(duration, easing, at) {
      if (easing != null && typeof easing !== 'function') throw new Error('microMap.camera: easing must be a function');
      animation = { started: Date.now(), duration: duration, easing: easing || function (t) { return 1 - Math.pow(1 - t, 3); }, at: at };
      frame = requestFrame.call(root, step);
      return api;
    }

    function easeTo(next) {
      if (destroyed) return api;
      next = next || {};
      var values = cameraTarget(next);
      cancelAnimation();
      var duration = clamp(finite(next.duration, finite(options.duration, 300)), 0, 120000);
      if (!animated(next, duration)) return jumpTo(next);
      var from = values.current;
      var to = values.target;
      return start(duration, next.easing, function (k) {
        return {
          lon: from.lon + shortestDelta(from.lon, to.lon, 360) * k,
          lat: from.lat + (to.lat - from.lat) * k,
          zoom: from.zoom + (to.zoom - from.zoom) * k,
          bearing: from.bearing + shortestDelta(from.bearing, to.bearing, 360) * k,
          pitch: from.pitch + (to.pitch - from.pitch) * k
        };
      });
    }

    // MapLibre's flyTo: van Wijk and Nuij, "Smooth and efficient zooming and
    // panning" (2003). The camera zooms out and back in along the optimal
    // path, so long jumps stay readable instead of smearing across the map.
    function flyTo(next) {
      if (destroyed) return api;
      next = next || {};
      var values = cameraTarget(next);
      cancelAnimation();
      var state = map.getCameraState ? map.getCameraState() : null;
      var from = values.current;
      var to = values.target;
      if (state) to.zoom = clamp(to.zoom, state.minZoom, state.maxZoom);
      var start0 = worldPoint(from.lon, from.lat);
      var end = worldPoint(to.lon, to.lat);
      var dx = shortestDelta(start0[0], end[0], 1);
      var dy = end[1] - start0[1];
      var worldSize = (state ? state.tileSize : 256) * Math.pow(2, from.zoom);
      var rho = finite(next.curve, 1.42);
      if (!(rho > 0)) throw new Error('microMap.camera: curve must be positive');
      // Spans in pixels at the start scale: w0 visible now, w1 visible at the end.
      var w0 = Math.max(state ? state.width : 0, state ? state.height : 0, 1);
      var w1 = w0 / Math.pow(2, to.zoom - from.zoom);
      var u1 = Math.sqrt(dx * dx + dy * dy) * worldSize;
      if (next.minZoom != null && u1) {
        var lowest = clamp(Math.min(+next.minZoom, from.zoom, to.zoom), state ? state.minZoom : 0, state ? state.maxZoom : 30);
        rho = Math.sqrt(w0 / Math.pow(2, lowest - from.zoom) / u1 * 2);
      }
      var rho2 = rho * rho;
      function r(i) {
        var b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1);
        return Math.log(Math.sqrt(b * b + 1) - b);
      }
      var r0 = r(0);
      var w = function (s) { return cosh(r0) / cosh(r0 + rho * s); };
      var u = function (s) { return w0 * ((cosh(r0) * Math.tanh(r0 + rho * s) - sinh(r0)) / rho2) / u1; };
      var S = (r(1) - r0) / rho;
      if (Math.abs(u1) < 1e-6 || !isFinite(S)) {
        // Hardly any distance: a pure zoom (or nothing to animate).
        if (Math.abs(w0 - w1) < 1e-6) return easeTo(next);
        var k = w1 < w0 ? -1 : 1;
        S = Math.abs(Math.log(w1 / w0)) / rho;
        u = function () { return 0; };
        w = function (s) { return Math.exp(k * rho * s); };
      }
      var duration = next.duration != null ? +next.duration
        : 1000 * S / (next.screenSpeed != null ? +next.screenSpeed / rho : finite(next.speed, 1.2));
      if (next.maxDuration != null && duration > +next.maxDuration) duration = 0;
      duration = clamp(finite(duration, 0), 0, 120000);
      if (!animated(next, duration)) return jumpTo(next);
      return start(duration, next.easing || ease, function (progress) {
        if (progress >= 1) return to;
        var s = progress * S;
        var fraction = u(s);
        var x = start0[0] + dx * fraction;
        var y = start0[1] + dy * fraction;
        return {
          lon: ((x * 360 % 360) + 360) % 360 - 180,
          lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI,
          zoom: from.zoom + Math.log(1 / w(s)) / Math.LN2,
          bearing: from.bearing + shortestDelta(from.bearing, to.bearing, 360) * progress,
          pitch: from.pitch + (to.pitch - from.pitch) * progress
        };
      });
    }

    function panTo(center, options) {
      options = Object.assign({}, options || {}, { center: center });
      return easeTo(options);
    }

    // A tilted perspective camera: the largest zoom at which the box's four
    // corners project inside the padded viewport, with the centre moved so
    // that their projection sits in its middle. Pure, like the flat case.
    function perspectiveFit(state, nw, se, padding, ceiling, maxZoom) {
      var view = microMap.createCamera({ width: state.width, height: state.height, bearing: state.bearing, pitch: state.pitch });
      var corners = [[nw[0], nw[1]], [se[0], nw[1]], [se[0], se[1]], [nw[0], se[1]]];
      var left = padding[3];
      var right = state.width - padding[1];
      var top = Math.max(padding[0], view.horizonRow);
      var bottom = state.height - padding[2];
      var cx = (nw[0] + se[0]) / 2;
      var cy = (nw[1] + se[1]) / 2;
      function extent(zoom) {
        var size = state.tileSize * Math.pow(2, zoom);
        var box = [Infinity, Infinity, -Infinity, -Infinity];
        for (var i = 0; i < 4; i++) {
          var point = view.project((corners[i][0] - cx) * size, (corners[i][1] - cy) * size);
          box[0] = Math.min(box[0], point[0]); box[1] = Math.min(box[1], point[1]);
          box[2] = Math.max(box[2], point[0]); box[3] = Math.max(box[3], point[1]);
        }
        return box;
      }
      function fits(zoom) {
        var box = extent(zoom);
        return box[0] >= left - 0.5 && box[2] <= right + 0.5 && box[1] >= top - 0.5 && box[3] <= bottom + 0.5;
      }
      var zoom = state.minZoom;
      for (var pass = 0; pass < 4; pass++) {
        var low = state.minZoom;
        var high = Math.max(low, ceiling);
        if (fits(high)) low = high;
        else for (var step = 0; step < 30; step++) {
          var mid = (low + high) / 2;
          if (fits(mid)) low = mid; else high = mid;
        }
        zoom = low;
        var box = extent(zoom);
        var size = state.tileSize * Math.pow(2, zoom);
        var seen = view.unproject((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
        var wanted = view.unproject((left + right) / 2, (top + bottom) / 2);
        cx += (seen[0] - wanted[0]) / size;
        cy += (seen[1] - wanted[1]) / size;
      }
      while (zoom > state.minZoom && !fits(zoom)) zoom -= 0.01;
      if (state.zoomSnap) zoom = Math.floor((zoom + 1e-10) / state.zoomSnap) * state.zoomSnap;
      zoom = clamp(Math.min(zoom, maxZoom), state.minZoom, state.maxZoom);
      return {
        center: [((cx * 360 % 360) + 360) % 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180 / Math.PI],
        zoom: zoom, bearing: state.bearing, pitch: state.pitch
      };
    }

    // Compute in the core's Mercator camera, keeping the result pure so
    // applications can inspect it without briefly moving the visible map.
    function cameraForBounds(bounds, next) {
      next = typeof next === 'number' || Array.isArray(next) ? { padding: next } : next || {};
      if (typeof next !== 'object') throw new Error('microMap.camera: fit options must be an object');
      var box = boundsValues(bounds);
      var padding = paddingValues(next.padding);
      var state = map.getCameraState();
      var width = state.width - padding[1] - padding[3];
      var height = state.height - padding[0] - padding[2];
      if (width <= 0 || height <= 0) throw new Error('microMap.camera: padding leaves no visible viewport');
      var maxZoom = next.maxZoom == null ? state.maxZoom : next.maxZoom;
      if (typeof maxZoom !== 'number' || !isFinite(maxZoom)) throw new Error('microMap.camera: maxZoom must be finite');
      maxZoom = clamp(maxZoom, state.minZoom, state.maxZoom);
      var nw = worldPoint(box[0], box[3]);
      var se = worldPoint(box[2], box[1]);
      if (box[2] < box[0]) se[0] += 1;
      var dx = se[0] - nw[0];
      var dy = se[1] - nw[1];
      var radians = -state.bearing * Math.PI / 180;
      var cosine = Math.cos(radians);
      var sine = Math.sin(radians);
      var tilt = Math.cos(state.pitch * Math.PI / 180);
      var extentX = Math.abs(cosine) * dx + Math.abs(sine) * dy;
      var extentY = tilt * (Math.abs(sine) * dx + Math.abs(cosine) * dy);
      var zoom = Math.min(maxZoom,
        extentX ? Math.log(width / (state.tileSize * extentX)) / Math.LN2 : maxZoom,
        extentY ? Math.log(height / (state.tileSize * extentY)) / Math.LN2 : maxZoom);
      if (state.pitch > 0 && microMap && typeof microMap.createCamera === 'function') {
        return perspectiveFit(state, nw, se, padding, Math.min(maxZoom, zoom + Math.log(1 / tilt) / Math.LN2 + 1), maxZoom);
      }
      // Rounding upwards clips stops at the edge of a fitted tour.
      if (state.zoomSnap) zoom = Math.floor((zoom + 1e-10) / state.zoomSnap) * state.zoomSnap;
      zoom = clamp(zoom, state.minZoom, state.maxZoom);
      var scale = state.tileSize * Math.pow(2, zoom);
      var shiftX = (padding[3] - padding[1]) / 2;
      var shiftY = (padding[0] - padding[2]) / 2;
      var rawShiftY = shiftY / tilt;
      var x = (nw[0] + se[0]) / 2 - (shiftX * cosine + rawShiftY * sine) / scale;
      var y = (nw[1] + se[1]) / 2 - (-shiftX * sine + rawShiftY * cosine) / scale;
      return {
        center: [((x * 360 % 360) + 360) % 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI],
        zoom: zoom, bearing: state.bearing, pitch: state.pitch
      };
    }

    function fitBounds(bounds, next) {
      if (destroyed) return api;
      var target = cameraForBounds(bounds, next);
      if (next && next.duration != null) target.duration = next.duration;
      if (next && next.easing != null) target.easing = next.easing;
      if (next && next.animate != null) target.animate = next.animate;
      if (next && next.essential != null) target.essential = next.essential;
      return target.duration > 0 ? easeTo(target) : jumpTo(target);
    }

    // Keep the camera in the URL fragment for shareable views. Existing
    // parameters survive, and writes are coalesced to one per animation frame.
    function linkHash(settings) {
      settings = settings || {};
      if (!root.location || !root.history || !root.URLSearchParams) throw new Error('microMap.camera: URL hash support is unavailable');
      var prefix = settings.prefix == null ? '' : String(settings.prefix);
      var keys = { lon: prefix + 'lon', lat: prefix + 'lat', zoom: prefix + 'zoom', bearing: prefix + 'bearing', pitch: prefix + 'pitch' };
      var pending = 0;
      var active = true;

      function readHash() {
        var params = new root.URLSearchParams(root.location.hash.slice(1));
        var lon = +params.get(keys.lon);
        var lat = +params.get(keys.lat);
        if (!params.has(keys.lon) || !params.has(keys.lat) || !isFinite(lon) || !isFinite(lat)) return;
        var target = { center: [lon, lat] };
        ['zoom', 'bearing', 'pitch'].forEach(function (name) {
          var value = params.get(keys[name]);
          if (value != null && value !== '' && isFinite(+value)) target[name] = +value;
        });
        jumpTo(target);
      }

      function writeHash() {
        pending = 0;
        if (!active || destroyed) return;
        var camera = readCamera();
        var params = new root.URLSearchParams(root.location.hash.slice(1));
        params.set(keys.lon, camera.lon.toFixed(5));
        params.set(keys.lat, camera.lat.toFixed(5));
        params.set(keys.zoom, camera.zoom.toFixed(2));
        if (camera.bearing) params.set(keys.bearing, camera.bearing.toFixed(1)); else params.delete(keys.bearing);
        if (camera.pitch) params.set(keys.pitch, camera.pitch.toFixed(1)); else params.delete(keys.pitch);
        var hash = params.toString();
        if (root.location.hash.slice(1) !== hash) root.history.replaceState(null, '', root.location.pathname + root.location.search + (hash ? '#' + hash : ''));
      }

      function onMove() { if (!pending) pending = requestFrame.call(root, writeHash); }
      function onHashChange() { readHash(); }
      function dispose() {
        if (!active) return;
        active = false;
        if (pending) cancelFrame.call(root, pending);
        pending = 0;
        if (typeof map.off === 'function') map.off('move', onMove).off('destroy', dispose);
        if (root.removeEventListener) root.removeEventListener('hashchange', onHashChange);
      }

      if (settings.read !== false) readHash();
      if (typeof map.on === 'function') {
        if (settings.write !== false) map.on('move', onMove);
        map.on('destroy', dispose);
      }
      if (settings.listen !== false && root.addEventListener) root.addEventListener('hashchange', onHashChange);
      return { read: readHash, write: writeHash, destroy: dispose };
    }

    function onMove(event) {
      if (event.originalEvent) cancelAnimation();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimation();
      if (typeof map.off === 'function') map.off('destroy', destroy).off('move', onMove);
    }

    var api = {
      map: map,
      jumpTo: jumpTo,
      easeTo: easeTo,
      flyTo: flyTo,
      panTo: panTo,
      isEasing: function () { return !!animation; },
      fitBounds: fitBounds,
      cameraForBounds: cameraForBounds,
      linkHash: linkHash,
      cancelCamera: cancelAnimation,
      getCameraState: map.getCameraState ? function () { return map.getCameraState(); } : readCamera,
      getCenter: function () { return map.getCenter(); },
      getZoom: function () { return map.getZoom(); },
      getBearing: function () { return map.getBearing(); },
      getPitch: function () { return map.getPitch(); },
      setView: function (center, zoom) { if (!destroyed) { cancelAnimation(); map.setView(center, zoom); } return api; },
      on: function (type, handler) { map.on(type, handler); return api; },
      once: function (type, handler) { if (typeof map.once === 'function') map.once(type, handler); else map.on(type, handler); return api; },
      off: function (type, handler) { map.off(type, handler); return api; },
      destroy: destroy
    };

    if (typeof map.on === 'function') map.on('destroy', destroy).on('move', onMove);
    return api;
  }

  if (typeof microMap === 'function' && !microMap.camera) microMap.camera = cameraMap;
  return cameraMap;
});
