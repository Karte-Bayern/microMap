/*! microMap.inspect.js v0.2.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.microMapInspect = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function inspect(data, options) {
    options = options || {};
    var maxFeatures = limit(options.maxFeatures, 10000);
    var maxCoordinates = limit(options.maxCoordinates, 100000);
    var maxIssues = limit(options.maxIssues, 50);
    var issues = [];
    var count = 0;
    var hasError = false;
    function report(severity, code, index, id, path, message) {
      var issue = { severity: severity, code: code, featureIndex: index, featureId: id, path: path, message: message };
      if (severity === 'error') hasError = true;
      if (issues.length < maxIssues) issues.push(issue);
      else if (severity === 'error' && !issues.some(function (item) { return item.severity === 'error'; })) issues[issues.length - 1] = issue;
    }
    function point(value, index, id, path) {
      count++;
      if (count > maxCoordinates) { report('error', 'coordinate-limit', index, id, path, 'Too many coordinates; simplify or tile the dataset before loading it.'); return; }
      if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(+value[0]) || !Number.isFinite(+value[1])) {
        report('error', 'coordinate', index, id, path, 'Expected finite [longitude, latitude] coordinates.'); return;
      }
      if (+value[0] < -180 || +value[0] > 180 || +value[1] < -85.05112878 || +value[1] > 85.05112878) {
        report('warning', 'mercator-range', index, id, path, 'Coordinates fall outside the usual Web Mercator display range; check CRS and longitude/latitude order.');
      }
    }
    function turn(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    function crosses(a, b, c, d) {
      return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
    }
    function ring(value, index, id, path) {
      if (!Array.isArray(value) || value.length < 4) {
        report('error', 'ring-length', index, id, path, 'Polygon ring needs at least four positions, including its closing position.'); return;
      }
      value.forEach(function (item, at) { point(item, index, id, path + '[' + at + ']'); });
      var first = value[0], last = value[value.length - 1];
      if (Array.isArray(first) && Array.isArray(last) && (first[0] !== last[0] || first[1] !== last[1])) {
        report('error', 'ring-open', index, id, path, 'Polygon ring is open; repeat the first position at the end.');
      }
      // Keep diagnosis bounded: detailed topology repair belongs upstream.
      if (value.length > 256) return;
      for (var a = 0; a < value.length - 1; a++) for (var b = a + 2; b < value.length - 1; b++) {
        if (a === 0 && b === value.length - 2) continue;
        var p = value[a], q = value[a + 1], r = value[b], s = value[b + 1];
        if ([p, q, r, s].every(function (item) { return Array.isArray(item) && Number.isFinite(+item[0]) && Number.isFinite(+item[1]); }) && crosses(p, q, r, s)) {
          report('error', 'self-intersection', index, id, path, 'Polygon ring crosses itself; repair its topology before using it.'); return;
        }
      }
    }
    function coordinates(value, depth, index, id, path) {
      if (depth === 0) { point(value, index, id, path); return; }
      if (!Array.isArray(value)) { report('error', 'coordinates', index, id, path, 'Expected an array of coordinates.'); return; }
      value.forEach(function (item, at) { if (count <= maxCoordinates) coordinates(item, depth - 1, index, id, path + '[' + at + ']'); });
    }
    function geometry(value, index, id, path, depth) {
      if ((depth || 0) > 32) { report('error', 'geometry-depth', index, id, path, 'GeometryCollection is too deeply nested.'); return; }
      if (value == null) return;
      if (!value || typeof value !== 'object') { report('error', 'geometry', index, id, path, 'Expected a GeoJSON geometry.'); return; }
      var type = value.type, coords = value.coordinates;
      if (type === 'GeometryCollection') {
        if (!Array.isArray(value.geometries)) report('error', 'geometry', index, id, path, 'GeometryCollection needs a geometries array.');
        else value.geometries.forEach(function (item, at) { geometry(item, index, id, path + '.geometries[' + at + ']', (depth || 0) + 1); });
      } else if (type === 'Point') coordinates(coords, 0, index, id, path + '.coordinates');
      else if (type === 'MultiPoint' || type === 'LineString') {
        if (type === 'LineString' && (!Array.isArray(coords) || coords.length < 2)) report('error', 'line-length', index, id, path, 'LineString needs at least two positions.');
        coordinates(coords, 1, index, id, path + '.coordinates');
      } else if (type === 'MultiLineString') coordinates(coords, 2, index, id, path + '.coordinates');
      else if (type === 'Polygon' || type === 'MultiPolygon') {
        if (!Array.isArray(coords) || !coords.length) { report('error', 'polygon', index, id, path, 'Polygon needs at least one ring.'); return; }
        var polygons = type === 'Polygon' ? [coords] : coords;
        polygons.forEach(function (polygon, p) {
          if (!Array.isArray(polygon) || !polygon.length) { report('error', 'polygon', index, id, path, 'Polygon needs at least one ring.'); return; }
          polygon.forEach(function (part, r) { ring(part, index, id, path + '.coordinates' + (type === 'MultiPolygon' ? '[' + p + ']' : '') + '[' + r + ']'); });
        });
      } else report('error', 'geometry-type', index, id, path, 'Unsupported GeoJSON geometry type: ' + type + '.');
    }
    var features = data && data.type === 'FeatureCollection' ? data.features : data && data.type === 'Feature' ? [data] : null;
    if (!Array.isArray(features)) report('error', 'input', -1, null, '$', 'Expected a GeoJSON FeatureCollection or Feature.');
    else {
      if (features.length > maxFeatures) report('error', 'feature-limit', -1, null, '$.features', 'Too many features; filter or tile the dataset before loading it.');
      features.slice(0, maxFeatures).forEach(function (feature, index) {
        var id = feature && feature.id == null ? null : feature && feature.id;
        if (!feature || feature.type !== 'Feature') report('error', 'feature', index, id, '$.features[' + index + ']', 'Expected a GeoJSON Feature.');
        else geometry(feature.geometry, index, id, '$.features[' + index + '].geometry');
      });
    }
    return { valid: !hasError, featureCount: features && features.length || 0, coordinateCount: count, issues: issues };
  }
  function limit(value, fallback) {
    value = value == null ? fallback : Number(value);
    if (!Number.isInteger(value) || value < 1 || value > 1000000) throw new Error('microMap.inspect: limits must be integers from 1 to 1,000,000');
    return value;
  }
  if (root.microMap && typeof root.microMap === 'function' && !root.microMap.inspect) root.microMap.inspect = inspect;
  return inspect;
});
