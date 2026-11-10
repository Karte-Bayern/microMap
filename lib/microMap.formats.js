/*! microMap.formats.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.microMapFormats = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function fail(message, code) {
    var error = new Error('microMap.formats: ' + message);
    if (code) error.code = code;
    throw error;
  }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function depth(at) { if (at > 32) fail('data is nested too deeply'); }
  function copy(value, at) {
    depth(at || 0);
    if (Array.isArray(value)) return value.map(function (item) { return copy(item, (at || 0) + 1); });
    if (!object(value)) return value;
    var result = {};
    Object.keys(value).forEach(function (key) {
      Object.defineProperty(result, key, { value: copy(value[key], (at || 0) + 1), enumerable: true, configurable: true, writable: true });
    });
    return result;
  }
  function copyExcept(value, excluded) {
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (!own(excluded, key)) Object.defineProperty(result, key, { value: copy(value[key]), enumerable: true, configurable: true, writable: true });
    });
    return result;
  }
  function limit(value, fallback) {
    if (value == null) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 10000000) fail('limits must be integers from 1 to 10,000,000');
    return value;
  }
  function budget(options) {
    return { coordinates: 0, features: 0, maxCoordinates: limit(options.maxCoordinates, 1000000), maxFeatures: limit(options.maxFeatures, 50000) };
  }
  function position(value, count) {
    if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) fail('positions need at least two finite numbers');
    if (count && ++count.coordinates > count.maxCoordinates) fail('coordinate limit exceeded', 'limit');
    return value.slice();
  }
  function equal(a, b) { return a.length === b.length && a.every(function (value, i) { return value === b[i]; }); }
  function line(value, count, ring) {
    if (!Array.isArray(value) || value.length < (ring ? 4 : 2)) fail(ring ? 'polygon rings need four positions' : 'lines need two positions');
    var result = value.map(function (item) { return position(item, count); });
    if (ring && !equal(result[0], result[result.length - 1])) fail('polygon ring is not closed');
    return result;
  }
  function geometries(value, convert) {
    if (!Array.isArray(value)) fail('geometries must be an array');
    return value.map(convert);
  }
  function geoGeometry(value, count, at) {
    depth(at);
    if (value === null) return null;
    if (!object(value)) fail('expected a GeoJSON geometry');
    var type = value.type, coords = value.coordinates, result = copyExcept(value, { coordinates: true, geometries: true });
    function points(items) {
      if (!Array.isArray(items)) fail('coordinates must be arrays');
      return items.map(function (item) { return position(item, count); });
    }
    function lines(items, ring) {
      if (!Array.isArray(items)) fail('coordinates must be arrays');
      return items.map(function (item) { return line(item, count, ring); });
    }
    if (type === 'Point') result.coordinates = position(coords, count);
    else if (type === 'MultiPoint') result.coordinates = points(coords);
    else if (type === 'LineString') result.coordinates = line(coords, count, false);
    else if (type === 'MultiLineString') result.coordinates = lines(coords, false);
    else if (type === 'Polygon') result.coordinates = lines(coords, true);
    else if (type === 'MultiPolygon') {
      if (!Array.isArray(coords)) fail('coordinates must be arrays');
      result.coordinates = coords.map(function (items) { return lines(items, true); });
    } else if (type === 'GeometryCollection') {
      result.geometries = geometries(value.geometries, function (item) { if (item === null) fail('GeometryCollection members must be geometries'); return geoGeometry(item, count, at + 1); });
    } else fail('unsupported geometry type ' + String(type));
    return result;
  }
  function addFeature(list, feature, count) {
    if (++count.features > count.maxFeatures) fail('feature limit exceeded', 'limit');
    list.push(feature);
  }
  function addGeoJSON(list, value, count) {
    if (!object(value)) fail('expected a GeoJSON object');
    if (value.type === 'FeatureCollection') {
      if (!Array.isArray(value.features)) fail('FeatureCollection needs a features array');
      value.features.forEach(function (feature) {
        if (!object(feature) || feature.type !== 'Feature') fail('FeatureCollection members must be Features');
        addGeoJSON(list, feature, count);
      });
    } else if (value.type === 'Feature') {
      if (!own(value, 'geometry')) fail('Feature needs a geometry member');
      if (value.properties != null && !object(value.properties)) fail('Feature properties must be an object or null');
      var feature = copyExcept(value, { geometry: true });
      feature.geometry = geoGeometry(value.geometry, count, 0);
      if (!own(feature, 'properties')) feature.properties = {};
      addFeature(list, feature, count);
    } else addFeature(list, { type: 'Feature', properties: {}, geometry: geoGeometry(value, count, 0) }, count);
  }
  function collection(features) { return { type: 'FeatureCollection', features: features }; }
  function json(input) {
    if (typeof input !== 'string') return input;
    try { return JSON.parse(input); } catch (error) { fail('invalid JSON: ' + error.message); }
  }

  // TopoJSON 1.0: only transformed arcs are delta encoded; point positions
  // use the same scale/translate without accumulating previous positions.
  function topojson(input, options) {
    options = options || {};
    var topology = json(input);
    if (!object(topology) || topology.type !== 'Topology' || !object(topology.objects) || !Array.isArray(topology.arcs)) fail('expected a TopoJSON Topology with objects and arcs');
    var count = budget(options), features = [], decoded = Object.create(null), transform = topology.transform;
    if (transform != null && (!object(transform) || !Array.isArray(transform.scale) || transform.scale.length !== 2 ||
      !transform.scale.every(Number.isFinite) || !Array.isArray(transform.translate) || transform.translate.length !== 2 || !transform.translate.every(Number.isFinite))) fail('invalid TopoJSON transform');
    function point(value, output) {
      var result = position(value, output ? count : null);
      if (transform) {
        if (!Number.isInteger(result[0]) || !Number.isInteger(result[1])) fail('quantized positions must use integer x/y');
        result[0] = result[0] * transform.scale[0] + transform.translate[0];
        result[1] = result[1] * transform.scale[1] + transform.translate[1];
        if (!Number.isFinite(result[0]) || !Number.isFinite(result[1])) fail('transformed position is not finite');
      }
      return result;
    }
    function arc(index) {
      if (!Number.isInteger(index) || index < -2147483648 || index > 2147483647) fail('arc indexes must be signed 32-bit integers');
      var number = index < 0 ? ~index : index;
      if (number >= topology.arcs.length) fail('arc index out of range: ' + index);
      if (!own(decoded, number)) {
        var source = topology.arcs[number], x = 0, y = 0;
        if (!Array.isArray(source) || source.length < 2) fail('arcs need at least two positions');
        if (source.length > count.maxCoordinates) fail('coordinate limit exceeded', 'limit');
        decoded[number] = source.map(function (value) {
          var next = position(value);
          if (transform) { next[0] = x += next[0]; next[1] = y += next[1]; }
          return point(next, false);
        });
      }
      return { points: decoded[number], reverse: index < 0 };
    }
    function stitch(indexes, ring) {
      if (!Array.isArray(indexes) || !indexes.length) fail('lines need arc indexes');
      var result = [];
      indexes.forEach(function (index) {
        var value = arc(index), points = value.points, start = value.reverse ? points.length - 1 : 0, step = value.reverse ? -1 : 1;
        if (result.length && !equal(result[result.length - 1], points[start])) fail('adjacent arcs do not share an endpoint');
        for (var i = start + (result.length ? step : 0); i >= 0 && i < points.length; i += step) result.push(position(points[i], count));
      });
      if (result.length < (ring ? 4 : 2)) fail(ring ? 'polygon rings need four positions' : 'lines need two positions');
      if (ring && !equal(result[0], result[result.length - 1])) fail('polygon ring is not closed');
      return result;
    }
    function geometry(value, at) {
      depth(at);
      if (!object(value)) fail('expected a TopoJSON geometry');
      var type = value.type, result = { type: type };
      function rings(items) {
        if (!Array.isArray(items)) fail('polygon arcs must be arrays');
        return items.map(function (indexes) { return stitch(indexes, true); });
      }
      if (type === null) return null;
      if (type === 'Point') result.coordinates = point(value.coordinates, true);
      else if (type === 'MultiPoint') {
        if (!Array.isArray(value.coordinates)) fail('coordinates must be arrays');
        result.coordinates = value.coordinates.map(function (value) { return point(value, true); });
      } else if (type === 'LineString') result.coordinates = stitch(value.arcs, false);
      else if (type === 'MultiLineString') {
        if (!Array.isArray(value.arcs)) fail('line arcs must be arrays');
        result.coordinates = value.arcs.map(function (indexes) { return stitch(indexes, false); });
      } else if (type === 'Polygon') result.coordinates = rings(value.arcs);
      else if (type === 'MultiPolygon') {
        if (!Array.isArray(value.arcs)) fail('polygon arcs must be arrays');
        result.coordinates = value.arcs.map(rings);
      } else if (type === 'GeometryCollection') result.geometries = geometries(value.geometries, function (item) {
        var next = geometry(item, at + 1);
        if (next === null) fail('GeometryCollection members must be geometries');
        return next;
      });
      else fail('unsupported geometry type ' + String(type));
      if (own(value, 'bbox')) result.bbox = copy(value.bbox);
      return result;
    }
    function feature(value) {
      if (!object(value)) fail('expected a TopoJSON geometry');
      if (value.properties != null && !object(value.properties)) fail('geometry properties must be an object or null');
      var result = { type: 'Feature', properties: own(value, 'properties') ? copy(value.properties) : {}, geometry: geometry(value, 0) };
      if (own(value, 'id')) result.id = copy(value.id);
      if (own(value, 'bbox')) result.bbox = copy(value.bbox);
      addFeature(features, result, count);
    }
    var names = options.object == null ? Object.keys(topology.objects) : Array.isArray(options.object) ? options.object : [options.object];
    names.forEach(function (name) {
      if (typeof name !== 'string' || !own(topology.objects, name)) fail('unknown TopoJSON object ' + String(name));
      var value = topology.objects[name];
      if (object(value) && value.type === 'GeometryCollection') geometries(value.geometries, feature);
      else feature(value);
    });
    var result = collection(features);
    if (options.object == null && own(topology, 'bbox')) result.bbox = copy(topology.bbox);
    return result;
  }

  // RFC 8142 records are separated by RS, so pretty-printed GeoJSON and
  // newlines in the input do not accidentally split a record.
  function geojsonSeq(input, options) {
    options = options || {};
    if (typeof input !== 'string') fail('GeoJSON sequences must be text');
    if (options.onError != null && typeof options.onError !== 'function') fail('onError must be a function');
    var features = [], count = budget(options), records = input.split('\u001e');
    if (records[0].trim()) fail('GeoJSON sequences must start with a record separator');
    for (var i = 1; i < records.length; i++) {
      if (!records[i].trim()) continue;
      // Each record is atomic: a malformed collection contributes nothing.
      var record = [], beforeFeatures = count.features, beforeCoordinates = count.coordinates;
      try { addGeoJSON(record, JSON.parse(records[i]), count); }
      catch (cause) {
        count.features = beforeFeatures; count.coordinates = beforeCoordinates;
        var error = new Error('microMap.formats: invalid GeoJSON sequence record ' + i + ': ' + cause.message);
        error.record = i;
        if (cause.code) error.code = cause.code;
        if (!options.onError || cause.code === 'limit') throw error;
        options.onError(error, i);
        continue;
      }
      for (var f = 0; f < record.length; f++) features.push(record[f]);
    }
    return collection(features);
  }

  function parse(input, options) {
    options = options || {};
    var format = options.format;
    if (format === 'geojson-seq' || !format && typeof input === 'string' && input.trimStart().charAt(0) === '\u001e') return geojsonSeq(input, options);
    var value = json(input);
    if (format === 'topojson' || !format && value && value.type === 'Topology') return topojson(value, options);
    if (format && format !== 'geojson') fail('unsupported format ' + String(format));
    var features = [];
    addGeoJSON(features, value, budget(options));
    return collection(features);
  }

  var api = { parse: parse, topojson: topojson, geojsonSeq: geojsonSeq };
  if (typeof root.microMap === 'function' && !root.microMap.formats) root.microMap.formats = api;
  return api;
});
