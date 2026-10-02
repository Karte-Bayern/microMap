/*! microMap.raster.js v0.2.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapRaster = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;
  var MAX_LAT = 85.05112878;
  var EARTH_RADIUS = 6378137;

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function finite(value, fallback) { value = +value; return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function positive(value, fallback, maximum) { return clamp(finite(value, fallback), 1, maximum || 1e6); }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    for (var key in value) if (own(value, key)) result[key] = clone(value[key]);
    return result;
  }

  function worldY(latitude) {
    latitude = clamp(+latitude, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return .5 - Math.log((1 + Math.sin(latitude)) / (1 - Math.sin(latitude))) / (4 * Math.PI);
  }

  function longitudeAt(tileX, count) { return tileX / count * 360 - 180; }
  function latitudeAt(tileY, count) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / count))) * 180 / Math.PI; }
  function metersX(longitude) { return EARTH_RADIUS * longitude * Math.PI / 180; }
  function metersY(latitude) {
    latitude = clamp(latitude, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  }

  function point(map, coordinate) {
    var result = map.project(coordinate);
    return Array.isArray(result) ? result : [result.x, result.y];
  }

  function affine(s0, s1, s2, d0, d1, d2) {
    var a = s1[0] - s0[0];
    var b = s1[1] - s0[1];
    var c = s2[0] - s0[0];
    var d = s2[1] - s0[1];
    var determinant = a * d - b * c;
    if (!determinant) return null;
    var x1 = d1[0] - d0[0];
    var y1 = d1[1] - d0[1];
    var x2 = d2[0] - d0[0];
    var y2 = d2[1] - d0[1];
    var aa = (x1 * d - x2 * b) / determinant;
    var cc = (x2 * a - x1 * c) / determinant;
    var bb = (y1 * d - y2 * b) / determinant;
    var dd = (y2 * a - y1 * c) / determinant;
    return [aa, bb, cc, dd, d0[0] - aa * s0[0] - cc * s0[1], d0[1] - bb * s0[0] - dd * s0[1]];
  }

  // `grow` widens the clip triangle by that many pixels around its centre so
  // that neighbouring triangles overlap instead of leaving hairline seams.
  function drawTriangle(context, dpr, image, sourcePoints, destinationPoints, width, height, grow) {
    var transform = affine(sourcePoints[0], sourcePoints[1], sourcePoints[2], destinationPoints[0], destinationPoints[1], destinationPoints[2]);
    if (!transform) return;
    var clip = destinationPoints;
    if (grow) {
      var cx = (clip[0][0] + clip[1][0] + clip[2][0]) / 3;
      var cy = (clip[0][1] + clip[1][1] + clip[2][1]) / 3;
      clip = clip.map(function (corner) {
        var dx = corner[0] - cx;
        var dy = corner[1] - cy;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        return [corner[0] + dx / length * grow, corner[1] + dy / length * grow];
      });
    }
    context.save();
    context.beginPath();
    context.moveTo(clip[0][0], clip[0][1]);
    context.lineTo(clip[1][0], clip[1][1]);
    context.lineTo(clip[2][0], clip[2][1]);
    context.closePath();
    context.clip();
    context.setTransform(transform[0] * dpr, transform[1] * dpr, transform[2] * dpr, transform[3] * dpr, transform[4] * dpr, transform[5] * dpr);
    context.drawImage(image, 0, 0, width, height);
    context.restore();
  }

  function rasterMap(map, options) {
    if (typeof microMap !== 'function' || !map || typeof map.getContainer !== 'function' || typeof map.project !== 'function') {
      throw new Error('microMap.raster: pass a microMap instance');
    }
    options = options || {};
    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext && canvas.getContext('2d');
    if (!context) throw new Error('microMap.raster: Canvas 2D is required');
    var sources = Object.create(null);
    var layers = [];
    var layerByID = Object.create(null);
    var listeners = Object.create(null);
    var cache = Object.create(null);
    var cacheClock = 0;
    var width = 0;
    var height = 0;
    var dpr = 1;
    var frame = 0;
    var destroyed = false;
    var maxTiles = Math.floor(positive(options.maxTiles, 128, 1024));

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:' + clamp(Math.floor(finite(options.zIndex, 0)), -100, 100) + ';pointer-events:none';
    container.appendChild(canvas);

    function emit(type, extra) {
      var list = listeners[type];
      if (!list) return;
      list = list.slice();
      for (var i = 0; i < list.length; i++) {
        var event = { type: type, target: api, map: map };
        if (extra) for (var key in extra) event[key] = extra[key];
        list[i](event);
      }
    }

    function schedule() {
      if (!frame && !destroyed) frame = requestFrame.call(root, draw);
    }

    function resize() {
      width = Math.max(0, container.clientWidth || 0);
      height = Math.max(0, container.clientHeight || 0);
      dpr = clamp(finite(root.devicePixelRatio, 1), 1, 4);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    }

    function sourceURL(source, z, x, y, count) {
      var template = typeof source.tiles === 'function' ? source.tiles : (Array.isArray(source.tiles) ? source.tiles[0] : source.tiles);
      var wrappedX = ((x % count) + count) % count;
      var subdomain = source.subdomains ? source.subdomains.charAt(((x + y) % source.subdomains.length + source.subdomains.length) % source.subdomains.length) : '';
      var url;
      if (source.type === 'wms') {
        url = String(source.url || '');
        var west = metersX(longitudeAt(wrappedX, count));
        var east = metersX(longitudeAt(wrappedX + 1, count));
        var north = metersY(latitudeAt(y, count));
        var south = metersY(latitudeAt(y + 1, count));
        var bbox = west + ',' + south + ',' + east + ',' + north;
        var hadBbox = /\{bbox(?:-epsg-3857)?\}/i.test(url);
        url = url.replace(/\{bbox(?:-epsg-3857)?\}/gi, bbox).replace(/\{width\}/gi, String(source.tileSize)).replace(/\{height\}/gi, String(source.tileSize));
        if (!hadBbox) url += (url.indexOf('?') < 0 ? '?' : '&') + 'BBOX=' + bbox + '&WIDTH=' + source.tileSize + '&HEIGHT=' + source.tileSize;
        return url;
      }
      if (typeof template === 'function') return template(z, wrappedX, y);
      url = String(template || '').replace(/\{z\}/g, z).replace(/\{x\}/g, wrappedX).replace(/\{y\}/g, y).replace(/\{-y\}/g, count - y - 1).replace(/\{s\}/g, subdomain);
      return url;
    }

    function tileKey(sourceID, z, x, y) { return sourceID + '/' + z + '/' + x + '/' + y; }

    function loadTile(sourceID, source, z, x, y, count) {
      var key = tileKey(sourceID, z, x, y);
      var tile = cache[key];
      if (tile) {
        tile.used = ++cacheClock;
        return tile;
      }
      var image = root.Image ? new root.Image() : root.document.createElement('img');
      tile = cache[key] = { key: key, source: sourceID, z: z, x: x, y: y, image: image, used: ++cacheClock, loaded: false, error: false, objectURL: null, removed: false };
      image.decoding = 'async';
      if (source.crossOrigin != null) image.crossOrigin = source.crossOrigin;
      function releaseURL() { if (tile.objectURL) { root.URL.revokeObjectURL(tile.objectURL); tile.objectURL = null; } }
      image.onload = function () { if (tile.removed) return; tile.loaded = true; tile.error = false; releaseURL(); emit('tileload', { source: sourceID, z: z, x: x, y: y, url: image.src }); schedule(); };
      image.onerror = function () { if (tile.removed) return; tile.error = true; releaseURL(); emit('tileerror', { source: sourceID, z: z, x: x, y: y, url: image.src }); schedule(); };
      function assign(value) {
        if (tile.removed) return;
        if (root.Blob && value instanceof root.Blob) {
          tile.objectURL = root.URL.createObjectURL(value);
          image.src = tile.objectURL;
        } else if (typeof value === 'string' && value) image.src = value;
        else throw new Error('microMap.raster: tile source must return a URL or Blob');
      }
      try {
        var result = sourceURL(source, z, x, y, count);
        if (result && typeof result.then === 'function') Promise.resolve(result).then(assign).catch(function (error) {
          if (tile.removed) return;
          tile.error = true;
          emit('tileerror', { source: sourceID, z: z, x: x, y: y, error: error });
          schedule();
        });
        else assign(result);
      } catch (error) {
        tile.error = true;
        emit('tileerror', { source: sourceID, z: z, x: x, y: y, error: error });
      }
      return tile;
    }

    function removeTile(tile) {
      if (!tile) return;
      tile.removed = true;
      tile.image.onload = tile.image.onerror = null;
      tile.image.src = '';
      if (tile.objectURL) root.URL.revokeObjectURL(tile.objectURL);
      delete cache[tile.key];
    }

    function evict() {
      var keys = Object.keys(cache);
      if (keys.length <= maxTiles) return;
      keys.sort(function (a, b) { return cache[a].used - cache[b].used; });
      for (var i = 0, excess = keys.length - maxTiles; i < excess; i++) removeTile(cache[keys[i]]);
    }

    function tilePlan(sourceID, source) {
      var state = map.getCameraState ? map.getCameraState() : { center: map.getCenter(), zoom: map.getZoom(), width: width, height: height, tileSize: source.tileSize };
      var center = Array.isArray(state.center) ? state.center : [state.center.lng, state.center.lat];
      // A tilted perspective camera: levels of detail by distance, from the
      // core's own cover (coarse tiles first, so finer ones paint on top).
      var camera = finite(state.pitch, 0) > 0 && typeof map.getCamera === 'function' ? map.getCamera() : null;
      if (camera && camera.width === width && camera.height === height) {
        var levelZoom = finite(state.zoom, 0) + Math.log(finite(state.tileSize, 256) / source.tileSize) / Math.LN2;
        return camera.cover({
          tileSize: source.tileSize, zoom: levelZoom, centerX: (center[0] + 180) / 360, centerY: worldY(center[1]),
          minZoom: source.minzoom, maxZoom: source.maxzoom, buffer: 0, maxTiles: 160
        }).map(function (tile) { return { z: tile.z, x: tile.x, y: tile.y, count: Math.pow(2, tile.z), camera: camera }; });
      }
      var zoom = clamp(Math.round(finite(state.zoom, 0)), source.minzoom, source.maxzoom);
      var count = Math.pow(2, zoom);
      var centerX = Math.floor(((center[0] + 180) / 360) * count);
      var centerY = Math.floor(worldY(center[1]) * count);
      var scale = Math.pow(2, finite(state.zoom, zoom) - zoom);
      var range = clamp(Math.ceil(Math.max(width, height) / (source.tileSize * scale)) + 2, 2, 6);
      var result = [];
      for (var y = Math.max(0, centerY - range); y <= Math.min(count - 1, centerY + range); y++) {
        for (var x = centerX - range; x <= centerX + range; x++) result.push({ z: zoom, x: x, y: y, count: count });
      }
      return result;
    }

    function tileCorners(plan) {
      var x = plan.x, y = plan.y, count = plan.count;
      return [
        point(map, [longitudeAt(x, count), latitudeAt(y, count)]),
        point(map, [longitudeAt(x + 1, count), latitudeAt(y, count)]),
        point(map, [longitudeAt(x, count), latitudeAt(y + 1, count)]),
        point(map, [longitudeAt(x + 1, count), latitudeAt(y + 1, count)])
      ];
    }

    function outsideView(corners) {
      // Conservative screen bounds remain valid with affine bearing/pitch.
      // Keep a one-pixel fringe so rounding cannot open a tile-edge gap.
      var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (var i = 0; i < corners.length; i++) {
        left = Math.min(left, corners[i][0]); right = Math.max(right, corners[i][0]);
        top = Math.min(top, corners[i][1]); bottom = Math.max(bottom, corners[i][1]);
      }
      return right < -1 || bottom < -1 || left > width + 1 || top > height + 1;
    }

    function drawTile(tile, source, opacity, corners, plan) {
      if (!tile.loaded || tile.error) return;
      var nw = corners[0], ne = corners[1], sw = corners[2], se = corners[3];
      var imageWidth = imageWidthOf(tile.image, source.tileSize);
      var imageHeight = imageHeightOf(tile.image, source.tileSize);
      context.globalAlpha = opacity;
      if (plan && plan.camera) {
        // Perspective is not affine: a grid of small triangles, finer for
        // tiles that are large on screen, keeps the image straight.
        var span = Math.max(Math.abs(se[0] - nw[0]), Math.abs(se[1] - nw[1]), Math.abs(ne[0] - sw[0]), Math.abs(ne[1] - sw[1]));
        var steps = clamp(Math.ceil(span / 96), 1, 8);
        var grid = [];
        for (var gy = 0; gy <= steps; gy++) {
          var row = [];
          for (var gx = 0; gx <= steps; gx++) {
            row.push(point(map, [longitudeAt(plan.x + gx / steps, plan.count), latitudeAt(plan.y + gy / steps, plan.count)]));
          }
          grid.push(row);
        }
        for (gy = 0; gy < steps; gy++) {
          for (gx = 0; gx < steps; gx++) {
            var u0 = imageWidth * gx / steps, u1 = imageWidth * (gx + 1) / steps;
            var v0 = imageHeight * gy / steps, v1 = imageHeight * (gy + 1) / steps;
            drawTriangle(context, dpr, tile.image, [[u0, v0], [u1, v0], [u0, v1]], [grid[gy][gx], grid[gy][gx + 1], grid[gy + 1][gx]], imageWidth, imageHeight, 0.6);
            drawTriangle(context, dpr, tile.image, [[u1, v1], [u1, v0], [u0, v1]], [grid[gy + 1][gx + 1], grid[gy][gx + 1], grid[gy + 1][gx]], imageWidth, imageHeight, 0.6);
          }
        }
        return;
      }
      // The native bearing/pitch camera maps a tile to a parallelogram.
      // Draw it once to avoid two clips, duplicate sampling and a diagonal seam.
      // Keep triangulation for adapters with a non-affine projection.
      if (Math.abs(nw[0] + se[0] - ne[0] - sw[0]) < 1e-6 &&
          Math.abs(nw[1] + se[1] - ne[1] - sw[1]) < 1e-6) {
        context.save();
        context.setTransform((ne[0] - nw[0]) / imageWidth * dpr, (ne[1] - nw[1]) / imageWidth * dpr,
          (sw[0] - nw[0]) / imageHeight * dpr, (sw[1] - nw[1]) / imageHeight * dpr, nw[0] * dpr, nw[1] * dpr);
        context.drawImage(tile.image, 0, 0, imageWidth, imageHeight);
        context.restore();
        return;
      }
      drawTriangle(context, dpr, tile.image, [[0, 0], [imageWidth, 0], [0, imageHeight]], [nw, ne, sw], imageWidth, imageHeight);
      drawTriangle(context, dpr, tile.image, [[imageWidth, imageHeight], [imageWidth, 0], [0, imageHeight]], [se, ne, sw], imageWidth, imageHeight);
    }

    function imageWidthOf(image, fallback) { return finite(image.naturalWidth || image.width, fallback); }
    function imageHeightOf(image, fallback) { return finite(image.naturalHeight || image.height, fallback); }

    function draw() {
      frame = 0;
      if (destroyed) return;
      resize();
      if (!width || !height) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      var zoom = map.getZoom ? map.getZoom() : 0;
      for (var l = 0; l < layers.length; l++) {
        var layer = layers[l];
        if (layer.layout.visibility === 'none' || (layer.minzoom != null && zoom < +layer.minzoom) || (layer.maxzoom != null && zoom >= +layer.maxzoom)) continue;
        var source = sources[layer.source];
        if (!source) continue;
        var opacity = clamp(finite(layer.paint['raster-opacity'], 1), 0, 1);
        if (!opacity) continue;
        var plans = tilePlan(layer.source, source);
        for (var p = 0; p < plans.length; p++) {
          var corners = tileCorners(plans[p]);
          if (!plans[p].camera && outsideView(corners)) continue;
          var tile = loadTile(layer.source, source, plans[p].z, plans[p].x, plans[p].y, plans[p].count);
          drawTile(tile, source, opacity, corners, plans[p]);
        }
      }
      evict();
    }

    function normalizeSource(id, specification) {
      if (!specification || typeof specification !== 'object') throw new Error('microMap.raster: source must be an object');
      var type = specification.type || 'raster';
      if (type !== 'raster' && type !== 'wms') throw new Error('microMap.raster: source type must be raster or wms');
      if (type === 'wms' && typeof specification.url !== 'string') throw new Error('microMap.raster: WMS source requires url');
      if (type === 'raster' && typeof specification.tiles !== 'string' && !Array.isArray(specification.tiles) && typeof specification.tiles !== 'function' && typeof specification.url !== 'string') throw new Error('microMap.raster: raster source requires tiles or url');
      return {
        id: id, type: type, tiles: specification.tiles || specification.url, url: specification.url,
        tileSize: Math.floor(positive(specification.tileSize, 256, 2048)),
        minzoom: clamp(Math.floor(finite(specification.minzoom, 0)), 0, 24),
        maxzoom: clamp(Math.floor(finite(specification.maxzoom, 22)), 0, 24),
        crossOrigin: specification.crossOrigin == null ? 'anonymous' : specification.crossOrigin,
        subdomains: specification.subdomains || ''
      };
    }

    function addSource(id, specification) {
      if (destroyed) return api;
      if (typeof id !== 'string' || !id) throw new Error('microMap.raster: source requires a non-empty id');
      if (sources[id]) throw new Error('microMap.raster: source already exists: ' + id);
      sources[id] = normalizeSource(id, specification);
      emit('sourcechange', { source: id });
      schedule();
      return api;
    }

    function getSource(id) {
      var source = sources[id];
      if (!source) return null;
      return {
        type: source.type, tiles: source.tiles, url: source.url, tileSize: source.tileSize,
        setTiles: function (tiles) { source.tiles = tiles; source.url = source.type === 'wms' ? tiles : source.url; clearSourceTiles(id); schedule(); return this; },
        getTiles: function () { return source.tiles; }
      };
    }

    function clearSourceTiles(id) {
      for (var key in cache) if (cache[key].source === id) removeTile(cache[key]);
    }

    function removeSource(id) {
      if (destroyed || !sources[id]) return api;
      for (var i = 0; i < layers.length; i++) if (layers[i].source === id) throw new Error('microMap.raster: remove layers before their source');
      clearSourceTiles(id);
      delete sources[id];
      emit('sourcechange', { source: id, removed: true });
      schedule();
      return api;
    }

    function addLayer(specification, beforeID) {
      if (destroyed) return api;
      if (!specification || typeof specification.id !== 'string' || !specification.id) throw new Error('microMap.raster: layer requires a non-empty id');
      if (specification.type !== 'raster') throw new Error('microMap.raster: layer type must be raster');
      if (!sources[specification.source]) throw new Error('microMap.raster: layer source must name an existing raster source');
      if (layerByID[specification.id]) throw new Error('microMap.raster: layer already exists: ' + specification.id);
      var layer = { id: specification.id, type: 'raster', source: specification.source, minzoom: specification.minzoom, maxzoom: specification.maxzoom, paint: clone(specification.paint || {}), layout: clone(specification.layout || {}) };
      if (layer.layout.visibility == null) layer.layout.visibility = 'visible';
      var index = beforeID == null ? -1 : layers.findIndex(function (candidate) { return candidate.id === beforeID; });
      if (beforeID != null && index < 0) throw new Error('microMap.raster: before layer does not exist: ' + beforeID);
      if (index < 0) layers.push(layer); else layers.splice(index, 0, layer);
      layerByID[layer.id] = layer;
      emit('stylechange', { layer: layer.id });
      schedule();
      return api;
    }

    function getLayer(id) {
      var layer = layerByID[id];
      return layer ? { id: layer.id, type: layer.type, source: layer.source, minzoom: layer.minzoom, maxzoom: layer.maxzoom, paint: clone(layer.paint), layout: clone(layer.layout) } : null;
    }

    function removeLayer(id) {
      if (destroyed || !layerByID[id]) return api;
      var layer = layerByID[id];
      var index = layers.indexOf(layer);
      if (index > -1) layers.splice(index, 1);
      delete layerByID[id];
      emit('stylechange', { layer: id, removed: true });
      schedule();
      return api;
    }

    function setPaintProperty(id, property, value) {
      var layer = layerByID[id];
      if (destroyed || !layer) return api;
      if (property !== 'raster-opacity') throw new Error('microMap.raster: only raster-opacity is supported');
      layer.paint[property] = clamp(finite(value, 1), 0, 1);
      emit('stylechange', { layer: id, property: property });
      schedule();
      return api;
    }

    function setLayoutProperty(id, property, value) {
      var layer = layerByID[id];
      if (destroyed || !layer) return api;
      if (property !== 'visibility' || (value !== 'visible' && value !== 'none')) throw new Error('microMap.raster: only visible/none visibility is supported');
      layer.layout[property] = value;
      emit('stylechange', { layer: id, property: property });
      schedule();
      return api;
    }

    function on(type, handler) {
      if (typeof handler === 'function') (listeners[type] || (listeners[type] = [])).push(handler);
      return api;
    }

    function off(type, handler) {
      if (!listeners[type]) return api;
      if (!handler) delete listeners[type];
      else listeners[type] = listeners[type].filter(function (candidate) { return candidate !== handler; });
      return api;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      for (var key in cache) removeTile(cache[key]);
      map.off('load', schedule).off('move', schedule).off('zoom', schedule).off('rotate', schedule).off('pitch', schedule).off('resize', schedule).off('destroy', destroy);
      if (canvas.parentNode === container) container.removeChild(canvas);
      sources = Object.create(null);
      layers = [];
      layerByID = Object.create(null);
      listeners = Object.create(null);
    }

    var api = {
      addSource: addSource, getSource: getSource, removeSource: removeSource,
      addLayer: addLayer, getLayer: getLayer, removeLayer: removeLayer,
      setPaintProperty: setPaintProperty, setLayoutProperty: setLayoutProperty,
      on: on, off: off, redraw: function () { schedule(); return api; },
      getCanvas: function () { return canvas; }, destroy: destroy
    };

    map.on('load', schedule).on('move', schedule).on('zoom', schedule).on('rotate', schedule).on('pitch', schedule).on('resize', schedule).on('destroy', destroy);
    schedule();
    return api;
  }

  if (typeof microMap === 'function' && !microMap.raster) microMap.raster = rasterMap;
  return rasterMap;
});
