/*! microMap.graticule.js v0.2.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapGraticule = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var INTERVALS = [90, 45, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.01];
  function finite(value, fallback) { value = +value; return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function graticule(map, options) {
    if (typeof microMap !== 'function' || !map || typeof map.project !== 'function' || typeof map.getBounds !== 'function' || typeof map.getContainer !== 'function') {
      throw new Error('microMap.graticule: pass a microMap instance');
    }
    options = options || {};
    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext('2d');
    var destroyed = false;
    var maxDpr = clamp(finite(options.maxDpr, 2), 1, 4);
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:' + (options.zIndex == null ? '0' : options.zIndex);
    container.appendChild(canvas);

    function intervalFor(zoom, latitude) {
      if (options.interval > 0 && isFinite(options.interval)) return options.interval;
      var scale = 256 * Math.pow(2, zoom) * Math.max(0.01, Math.cos(latitude * Math.PI / 180)) / 360;
      var best = INTERVALS[0];
      var score = Infinity;
      for (var i = 0; i < INTERVALS.length; i++) {
        var distance = Math.abs(Math.log(Math.max(1, scale * INTERVALS[i]) / 100));
        if (distance < score) { score = distance; best = INTERVALS[i]; }
      }
      return best;
    }

    function draw() {
      if (destroyed) return;
      var width = container.clientWidth || 0;
      var height = container.clientHeight || 0;
      var dpr = clamp(finite(root.devicePixelRatio, 1), 1, maxDpr);
      var pixelWidth = Math.round(width * dpr);
      var pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!width || !height) return;

      var bounds = map.getBounds();
      var west = bounds[0];
      var east = bounds[2];
      if (east < west) east += 360;
      var south = clamp(bounds[1], -85, 85);
      var north = clamp(bounds[3], -85, 85);
      var center = map.getCenter ? map.getCenter() : [0, 0];
      var step = intervalFor(map.getZoom ? map.getZoom() : 0, center[1]);
      var samples = Math.min(360, Math.max(12, Math.ceil((east - west) / 4)));
      context.beginPath();
      for (var longitude = Math.ceil(west / step) * step, count = 0; longitude <= east && count++ < 500; longitude += step) {
        for (var s = 0; s <= samples; s++) {
          var point = map.project([longitude, south + (north - south) * s / samples]);
          if (s) context.lineTo(point[0], point[1]); else context.moveTo(point[0], point[1]);
        }
      }
      var latSamples = Math.min(360, Math.max(12, Math.ceil((east - west) / 4)));
      for (var latitude = Math.ceil(south / step) * step, latCount = 0; latitude <= north && latCount++ < 500; latitude += step) {
        for (s = 0; s <= latSamples; s++) {
          point = map.project([west + (east - west) * s / latSamples, latitude]);
          if (s) context.lineTo(point[0], point[1]); else context.moveTo(point[0], point[1]);
        }
      }
      context.strokeStyle = options.color || 'rgba(30, 70, 90, .38)';
      context.lineWidth = Math.max(0.25, finite(options.width, 1));
      if (options.dash && context.setLineDash) context.setLineDash(options.dash);
      context.stroke();
      if (context.setLineDash) context.setLineDash([]);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      map.off('move', draw).off('resize', draw).off('destroy', destroy);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    var api = { map: map, canvas: canvas, redraw: draw, destroy: destroy };
    map.on('move', draw).on('resize', draw).on('destroy', destroy);
    draw();
    return api;
  }

  if (typeof microMap === 'function' && !microMap.graticule) microMap.graticule = graticule;
  return graticule;
});
