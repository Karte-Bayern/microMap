/*! microMap.heatmap.js v0.1.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapHeatmap = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var COLORS = ['#2563eb', '#06b6d4', '#84cc16', '#facc15', '#ef4444'];
  function finite(value, fallback) { var number = +value; return isFinite(number) ? number : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function timestamp(value) {
    if (value == null || value === '') return null;
    var parsed = typeof value === 'number' ? value : Date.parse(value);
    if (!isFinite(parsed)) throw new Error('microMap.heatmap: invalid time value');
    return parsed;
  }
  function color(value) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('microMap.heatmap: palette colors must be #rrggbb');
    return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
  }
  function settings(value) {
    value = value || {};
    if (!Array.isArray(value.palette || COLORS)) throw new Error('microMap.heatmap: palette must be an array');
    var result = {
      radius: clamp(finite(value.radius, 30), 2, 150),
      intensity: clamp(finite(value.intensity, 0.16), 0, 5),
      opacity: clamp(finite(value.opacity, 0.85), 0, 1),
      resolution: clamp(finite(value.resolution, 0.5), 0.2, 1),
      cellSize: clamp(finite(value.cellSize, 4), 1, 32),
      palette: (value.palette || COLORS).map(color)
    };
    if (result.palette.length < 2 || result.palette.length > 16) throw new Error('microMap.heatmap: palette needs 2–16 colors');
    return result;
  }
  function colorTable(paint) {
    // Density is an 8-bit alpha value. Interpolate each possible color once,
    // retaining ImageData's clamped rounding for identical pixel output.
    var table = new Uint8ClampedArray(256 * 4);
    var palette = paint.palette;
    for (var alpha = 1; alpha < 256; alpha++) {
      var position = alpha / 255 * (palette.length - 1);
      var lower = Math.min(palette.length - 2, Math.floor(position));
      var fraction = position - lower;
      for (var channel = 0; channel < 3; channel++) table[alpha * 4 + channel] = palette[lower][channel] * (1 - fraction) + palette[lower + 1][channel] * fraction;
      table[alpha * 4 + 3] = Math.round(alpha * paint.opacity);
    }
    return table;
  }
  function heatmap(map, options) {
    if (typeof microMap !== 'function' || !map || typeof map.project !== 'function' || typeof map.getContainer !== 'function' || typeof map.on !== 'function') {
      throw new Error('microMap.heatmap: pass a microMap instance');
    }
    options = options || {};
    var paint = settings(options);
    var colors = colorTable(paint);
    var weightProperty = options.weightProperty || 'weight';
    var timeProperty = options.timeProperty || 'time';
    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext('2d');
    var densityCanvas = root.document.createElement('canvas');
    var density = densityCanvas.getContext('2d');
    if (!context || !density) throw new Error('microMap.heatmap: Canvas 2D is required');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:' + Math.floor(finite(options.zIndex, 2)) + ';pointer-events:none';
    container.appendChild(canvas);
    var points = [];
    var timeRange = null;
    var frame = 0;
    var destroyed = false;
    var stamp = null;
    var stampRadius = 0;
    var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
    var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;

    function schedule() { if (!destroyed && !frame) frame = requestFrame.call(root, draw); }
    function setData(data) {
      if (destroyed) return api;
      var values = Array.isArray(data) ? data : data && data.type === 'FeatureCollection' ? data.features : null;
      if (!Array.isArray(values) || values.length > 200000) throw new Error('microMap.heatmap: expected up to 200,000 points or GeoJSON features');
      var next = [];
      values.forEach(function (item) {
        var geometry = item && item.geometry;
        var coordinates = geometry ? (geometry.type === 'Point' ? [geometry.coordinates] : geometry.type === 'MultiPoint' ? geometry.coordinates : []) : item && item.coordinates ? [item.coordinates] : [];
        var properties = geometry ? item.properties || {} : item || {};
        var weight = properties[weightProperty] == null ? 1 : +properties[weightProperty];
        if (!isFinite(weight) || weight < 0) throw new Error('microMap.heatmap: weights must be finite and non-negative');
        var time = timestamp(properties[timeProperty]);
        coordinates.forEach(function (position) {
          if (!Array.isArray(position) || !isFinite(+position[0]) || !isFinite(+position[1])) throw new Error('microMap.heatmap: invalid coordinates');
          if (next.length >= 200000) throw new Error('microMap.heatmap: too many point coordinates');
          next.push({ coordinates: [+position[0], +position[1]], weight: weight, time: time });
        });
      });
      points = next;
      schedule();
      return api;
    }
    function setTimeRange(range) {
      if (destroyed) return api;
      if (range == null) timeRange = null;
      else {
        if (!Array.isArray(range) || range.length !== 2) throw new Error('microMap.heatmap: time range must be [start, end]');
        var start = timestamp(range[0]); var end = timestamp(range[1]);
        if (start == null || end == null || start > end) throw new Error('microMap.heatmap: invalid time range');
        timeRange = [start, end];
      }
      schedule();
      return api;
    }
    function setPaint(value) {
      if (destroyed) return api;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('microMap.heatmap: paint must be an object');
      var merged = {};
      for (var key in paint) merged[key] = paint[key];
      for (key in value) if (Object.prototype.hasOwnProperty.call(value, key)) merged[key] = value[key];
      // Existing palette is numeric; convert it back before validation.
      if (!value || !Object.prototype.hasOwnProperty.call(value, 'palette')) merged.palette = paint.palette.map(function (rgb) {
        return '#' + rgb.map(function (channel) { return ('0' + channel.toString(16)).slice(-2); }).join('');
      });
      paint = settings(merged);
      colors = colorTable(paint);
      stamp = null;
      schedule();
      return api;
    }
    function stampFor(radius) {
      if (stamp && radius === stampRadius) return stamp;
      stampRadius = radius;
      stamp = root.document.createElement('canvas');
      stamp.width = stamp.height = radius * 2;
      var ctx = stamp.getContext('2d');
      var gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, stamp.width, stamp.height);
      return stamp;
    }
    function draw() {
      frame = 0;
      if (destroyed) return;
      var width = container.clientWidth;
      var height = container.clientHeight;
      if (!width || !height) return;
      var scale = Math.min(paint.resolution, Math.sqrt(2000000 / (width * height)));
      var pixelWidth = Math.max(1, Math.round(width * scale));
      var pixelHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = densityCanvas.width = pixelWidth;
        canvas.height = densityCanvas.height = pixelHeight;
      }
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      density.clearRect(0, 0, pixelWidth, pixelHeight);
      if (!points.length || !paint.opacity || !paint.intensity) return;
      var radius = Math.max(1, Math.round(paint.radius * scale));
      var kernel = stampFor(radius);
      var cellSize = Math.max(paint.cellSize, Math.sqrt(width * height / 50000));
      var cells = Object.create(null);
      for (var i = 0; i < points.length; i++) {
        var point = points[i];
        if (!point.weight || (timeRange && (point.time == null || point.time < timeRange[0] || point.time > timeRange[1]))) continue;
        var projected = map.project(point.coordinates);
        var x = Array.isArray(projected) ? projected[0] : projected.x;
        var y = Array.isArray(projected) ? projected[1] : projected.y;
        if (x < -paint.radius || x > width + paint.radius || y < -paint.radius || y > height + paint.radius) continue;
        var column = Math.floor(x / cellSize);
        var row = Math.floor(y / cellSize);
        var key = column + '/' + row;
        if (!cells[key]) cells[key] = { x: (column + .5) * cellSize, y: (row + .5) * cellSize, weight: 0 };
        cells[key].weight += point.weight;
      }
      density.globalCompositeOperation = 'lighter';
      for (var cellKey in cells) {
        var cell = cells[cellKey];
        density.globalAlpha = clamp(cell.weight * paint.intensity, 0, 1);
        density.drawImage(kernel, Math.round(cell.x * scale) - radius, Math.round(cell.y * scale) - radius);
      }
      density.globalAlpha = 1;
      density.globalCompositeOperation = 'source-over';
      var pixels = density.getImageData(0, 0, pixelWidth, pixelHeight);
      var rgba = pixels.data;
      for (i = 0; i < rgba.length; i += 4) {
        var colorIndex = rgba[i + 3] * 4;
        if (!colorIndex) continue;
        rgba[i] = colors[colorIndex];
        rgba[i + 1] = colors[colorIndex + 1];
        rgba[i + 2] = colors[colorIndex + 2];
        rgba[i + 3] = colors[colorIndex + 3];
      }
      context.putImageData(pixels, 0, 0);
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      map.off('move', schedule).off('zoom', schedule).off('rotate', schedule).off('pitch', schedule).off('resize', schedule).off('destroy', destroy);
      if (canvas.parentNode === container) container.removeChild(canvas);
      points = [];
    }
    var api = {
      setData: setData, setTimeRange: setTimeRange, setPaint: setPaint,
      getData: function () { return points.map(function (item) { return { coordinates: item.coordinates.slice(), weight: item.weight, time: item.time }; }); },
      getCanvas: function () { return canvas; }, redraw: schedule, destroy: destroy
    };
    map.on('move', schedule).on('zoom', schedule).on('rotate', schedule).on('pitch', schedule).on('resize', schedule).on('destroy', destroy);
    if (options.data) setData(options.data); else schedule();
    if (options.timeRange) setTimeRange(options.timeRange);
    return api;
  }
  if (typeof microMap === 'function' && !microMap.heatmap) microMap.heatmap = heatmap;
  return heatmap;
});
