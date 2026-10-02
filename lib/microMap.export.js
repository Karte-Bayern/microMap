/*! microMap.export.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapExport = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  function capture(map, options) {
    if (!map || typeof map.getContainer !== 'function') throw new Error('microMap.export: pass a microMap instance');
    options = options || {};
    var container = map.getContainer();
    var width = container.clientWidth;
    var height = container.clientHeight;
    var scale = options.scale == null ? 1 : +options.scale;
    if (!width || !height || !isFinite(scale) || scale <= 0 || scale > 4 || width * height * scale * scale > 16000000) {
      throw new Error('microMap.export: invalid size or scale (maximum 16 million pixels)');
    }
    var canvas = root.document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    var context = canvas.getContext('2d');
    if (!context) throw new Error('microMap.export: Canvas 2D is required');
    context.setTransform(scale, 0, 0, scale, 0, 0);
    var background = options.background || root.getComputedStyle(container).backgroundColor;
    context.fillStyle = !background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)' ? '#ffffff' : background;
    context.fillRect(0, 0, width, height);

    // The core's raster pane uses two CSS transforms. Reapply both in the
    // export canvas, then paint the already-rendered optional canvas layers.
    var tileLayer = container.querySelector('[aria-hidden="true"]');
    if (tileLayer) {
      var panes = tileLayer.children;
      for (var p = 0; p < panes.length; p++) {
        var images = panes[p].querySelectorAll('img');
        for (var i = 0; i < images.length; i++) {
          var image = images[i];
          if (!image.complete || !image.naturalWidth || image.style.visibility === 'hidden') continue;
          context.save();
          transform(context, tileLayer);
          transform(context, panes[p]);
          context.drawImage(image, parseFloat(image.style.left) || 0, parseFloat(image.style.top) || 0,
            parseFloat(image.style.width) || image.width, parseFloat(image.style.height) || image.height);
          context.restore();
        }
      }
    }

    var layers = Array.prototype.slice.call(container.querySelectorAll('canvas')).map(function (node, index) {
      return { node: node, index: index, z: parseInt(root.getComputedStyle(node).zIndex, 10) || 0 };
    }).sort(function (a, b) { return a.z - b.z || a.index - b.index; });
    layers.forEach(function (layer) {
      var node = layer.node;
      if (!node.width || !node.height || root.getComputedStyle(node).visibility === 'hidden') return;
      context.drawImage(node, parseFloat(node.style.left) || 0, parseFloat(node.style.top) || 0,
        parseFloat(node.style.width) || width, parseFloat(node.style.height) || height);
    });

    var attribution = options.attribution;
    if (attribution == null) {
      var control = container.querySelector('.micromap-ctrl-attrib-inner');
      attribution = control ? control.textContent : '';
      if (!attribution) for (var c = 0; c < container.children.length; c++) {
        var child = container.children[c];
        if (child.style.right === '0px' && child.style.bottom === '0px' && child !== tileLayer) { attribution = child.textContent; break; }
      }
    }
    if (attribution) {
      attribution = String(attribution);
      context.font = '11px sans-serif';
      var textWidth = Math.min(width - 8, context.measureText(attribution).width + 10);
      context.fillStyle = 'rgba(255,255,255,.88)';
      context.fillRect(width - textWidth, height - 18, textWidth, 18);
      context.fillStyle = '#17202a';
      context.textAlign = 'right';
      context.fillText(attribution, width - 5, height - 5, width - 10);
    }
    return canvas;
  }

  function transform(context, element) {
    var value = root.getComputedStyle(element).transform;
    if (!value || value === 'none') return;
    var Matrix = root.DOMMatrix || root.WebKitCSSMatrix;
    if (!Matrix) throw new Error('microMap.export: DOMMatrix is required to export a transformed raster map');
    var matrix = new Matrix(value);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }

  function blob(canvas) {
    return new Promise(function (resolve, reject) {
      try { canvas.toBlob(function (value) { value ? resolve(value) : reject(new Error('microMap.export: canvas could not be exported; check tile CORS headers')); }, 'image/png'); }
      catch (error) { reject(new Error('microMap.export: canvas could not be exported; check tile CORS headers: ' + error.message)); }
    });
  }

  function download(map, options) {
    options = options || {};
    return blob(capture(map, options)).then(function (data) {
      var url = root.URL.createObjectURL(data);
      var link = root.document.createElement('a');
      link.href = url;
      link.download = options.filename || 'map.png';
      root.document.body.appendChild(link);
      link.click();
      link.remove();
      root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 60000);
      return data;
    });
  }

  function print(map, options) {
    options = options || {};
    var page = root.open('', '_blank');
    if (!page) return Promise.reject(new Error('microMap.export: popup was blocked'));
    try {
      var image = capture(map, options).toDataURL('image/png');
      page.onload = function () { page.focus(); page.print(); };
      page.document.open();
      page.document.write('<!doctype html><title>Map print</title><style>body{margin:0}img{display:block;max-width:100%;max-height:100vh;margin:auto}@page{margin:10mm}</style><img alt="Map" src="' + image + '">');
      page.document.close();
      return Promise.resolve(page);
    } catch (error) {
      page.close();
      return Promise.reject(new Error('microMap.export: print image could not be prepared; check tile CORS headers: ' + error.message));
    }
  }

  var api = { capture: capture, download: download, print: print };
  if (typeof microMap === 'function' && !microMap.export) microMap.export = api;
  return api;
});
