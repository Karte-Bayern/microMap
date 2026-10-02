/*! microMap.webgl.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapWebGL = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  // This deliberately owns only a WebGL drawing surface and its map lifecycle.
  // Keeping MVT decoding and style evaluation out of this small bridge lets a
  // future GPU vector renderer grow without changing the camera API or making
  // the Canvas vector add-on a runtime dependency.
  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function webglMap(map, options) {
    if (!map || typeof map.getContainer !== 'function' || typeof map.on !== 'function' || typeof map.off !== 'function') {
      throw new Error('microMap.webgl: pass a microMap instance');
    }
    if (typeof microMap !== 'function') throw new Error('microMap.webgl: load microMap.js before microMap.webgl.js');
    options = options || {};
    if (options.render != null && typeof options.render !== 'function') throw new Error('microMap.webgl: render must be a function');

    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var attributes = options.contextAttributes || {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default'
    };
    var gl2 = canvas.getContext && canvas.getContext('webgl2', attributes);
    var gl = gl2 || (canvas.getContext && (canvas.getContext('webgl', attributes) || canvas.getContext('experimental-webgl', attributes)));
    if (!gl) throw new Error('microMap.webgl: WebGL is required');
    var version = gl2 ? 'webgl2' : 'webgl';
    var width = 0;
    var height = 0;
    var dpr = 1;
    var maxDpr = clamp(finite(options.maxDpr, 2), 1, 4);
    var pixelWidth = -1;
    var pixelHeight = -1;
    var cssWidth = -1;
    var cssHeight = -1;
    var viewportWidth = -1;
    var viewportHeight = -1;
    var frame = 0;
    var lost = false;
    var destroyed = false;

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:' + clamp(Math.floor(finite(options.zIndex, 1)), -100, 100) + ';pointer-events:none';
    container.appendChild(canvas);

    function resize() {
      width = Math.max(0, container.clientWidth || 0);
      height = Math.max(0, container.clientHeight || 0);
      dpr = clamp(finite(root.devicePixelRatio, 1), 1, maxDpr);
      var nextPixelWidth = Math.round(width * dpr);
      var nextPixelHeight = Math.round(height * dpr);
      if (canvas.width !== nextPixelWidth) canvas.width = nextPixelWidth;
      if (canvas.height !== nextPixelHeight) canvas.height = nextPixelHeight;
      if (cssWidth !== width) { canvas.style.width = width + 'px'; cssWidth = width; }
      if (cssHeight !== height) { canvas.style.height = height + 'px'; cssHeight = height; }
      if (viewportWidth !== nextPixelWidth || viewportHeight !== nextPixelHeight) {
        gl.viewport(0, 0, nextPixelWidth, nextPixelHeight);
        viewportWidth = nextPixelWidth;
        viewportHeight = nextPixelHeight;
      }
      pixelWidth = nextPixelWidth;
      pixelHeight = nextPixelHeight;
    }

    function state() {
      return {
        gl: gl, canvas: canvas, map: map,
        width: width, height: height, dpr: dpr,
        pixelWidth: pixelWidth, pixelHeight: pixelHeight,
        renderer: version
      };
    }

    function draw() {
      frame = 0;
      if (destroyed || lost) return;
      resize();
      if (!width || !height) return;
      if (options.render) options.render(state());
      else {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    function schedule() {
      if (!frame && !destroyed) frame = requestFrame.call(root, draw);
    }

    function lose(event) {
      if (event && event.preventDefault) event.preventDefault();
      lost = true;
      if (typeof options.onContextLost === 'function') options.onContextLost(event);
    }

    function restore(event) {
      lost = false;
      viewportWidth = viewportHeight = -1;
      if (typeof options.onContextRestored === 'function') options.onContextRestored(event, state());
      schedule();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      map.off('load', schedule).off('move', schedule).off('zoom', schedule).off('rotate', schedule).off('pitch', schedule).off('resize', schedule).off('destroy', destroy);
      canvas.removeEventListener('webglcontextlost', lose, false);
      canvas.removeEventListener('webglcontextrestored', restore, false);
      if (canvas.parentNode === container) container.removeChild(canvas);
    }

    canvas.addEventListener('webglcontextlost', lose, false);
    canvas.addEventListener('webglcontextrestored', restore, false);
    map.on('load', schedule).on('move', schedule).on('zoom', schedule).on('rotate', schedule).on('pitch', schedule).on('resize', schedule).on('destroy', destroy);
    schedule();
    return {
      redraw: function () { schedule(); return this; },
      destroy: destroy,
      getCanvas: function () { return canvas; },
      getContext: function () { return gl; },
      getRenderer: function () { return version; },
      isContextLost: function () { return lost; }
    };
  }

  webglMap.isSupported = function () {
    var canvas = root.document && root.document.createElement && root.document.createElement('canvas');
    return !!(canvas && canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  };
  if (typeof microMap === 'function' && !microMap.webgl) microMap.webgl = webglMap;
  return webglMap;
});
