/*! microMap.mlt.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'), require('./microMap.vector.js'));
  else root.microMapMLT = factory(root, root.microMap, root.microMapVector);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, vectorMap) {
  'use strict';

  function fail(message) { throw new Error('microMap.mlt: ' + message); }

  function pointCoordinates(point) {
    if (Array.isArray(point)) return [point[0], point[1]];
    if (point && typeof point === 'object') return [point.x, point.y];
    return null;
  }

  function normalizeGeometry(feature) {
    var geometry = feature && feature.geometry;
    if (!geometry || !Array.isArray(geometry.coordinates)) fail('MLT decoder returned invalid geometry');
    var kind = geometry.type;
    var type = kind === 0 || kind === 3 ? 1 : kind === 1 || kind === 4 ? 2 : kind === 2 || kind === 5 ? 3 : 0;
    if (!type) fail('MLT decoder returned an unsupported geometry type');
    var parts = [];
    for (var p = 0; p < geometry.coordinates.length; p++) {
      var source = geometry.coordinates[p];
      if (!Array.isArray(source)) fail('MLT decoder returned invalid geometry coordinates');
      var part = new Array(source.length);
      for (var i = 0; i < source.length; i++) {
        part[i] = pointCoordinates(source[i]);
        if (!part[i] || !Number.isFinite(part[i][0]) || !Number.isFinite(part[i][1])) fail('MLT decoder returned invalid point coordinates');
      }
      parts.push(part);
    }
    return { id: feature.id == null ? null : feature.id, type: type, properties: feature.properties || {}, parts: parts };
  }

  function normalizeTables(tables) {
    if (!Array.isArray(tables)) fail('decoder must return MLT FeatureTables');
    var layers = new Array(tables.length);
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      if (!table || typeof table.name !== 'string' || !table.name || typeof table.getFeatures !== 'function') fail('decoder returned an invalid MLT FeatureTable');
      var sourceFeatures = table.getFeatures();
      if (!Array.isArray(sourceFeatures)) fail('FeatureTable.getFeatures() must return an array');
      var features = new Array(sourceFeatures.length);
      for (var f = 0; f < sourceFeatures.length; f++) features[f] = normalizeGeometry(sourceFeatures[f]);
      layers[i] = { name: table.name, extent: table.extent == null ? 4096 : table.extent, features: features };
    }
    return { layers: layers };
  }

  function mltMap(map, options, decoder) {
    if (typeof vectorMap !== 'function') fail('load microMap.vector.js first');
    options = options || {};
    decoder = decoder || options.mltDecoder || (root.MLT && root.MLT.decodeTile) || root.decodeMltTile;
    if (typeof decoder !== 'function') fail('pass @maplibre/mlt decodeTile as the third argument or options.mltDecoder');
    var settings = {};
    for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key) && key !== 'mltDecoder') settings[key] = options[key];
    settings.decodeTile = function (buffer) {
      var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      return Promise.resolve(decoder(bytes, undefined, true)).then(normalizeTables);
    };
    return vectorMap(map, settings);
  }

  mltMap.normalize = normalizeTables;
  if (typeof microMap === 'function' && !microMap.mlt) microMap.mlt = mltMap;
  return mltMap;
});
