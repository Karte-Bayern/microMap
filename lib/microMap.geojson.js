/*! microMap.geojson.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapGeoJSON = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  // A deliberately small, optional GeoJSON overlay. It is not a Style v8
  // implementation: sources are application-provided data snapshots, and
  // visual layers cover the common route/track/area/point use cases without
  // adding a registry or a Canvas dependency to the raster core.
  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;
  var MAX_LAT = 85.05112878;

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function positiveInteger(value, fallback, max) {
    return clamp(Math.floor(finite(value, fallback)), 1, max || 0x7fffffff);
  }

  // GeoJSON sources are snapshots. Keep nested metadata isolated too: routes
  // and application features commonly carry arrays or small nested objects in
  // their properties. A shallow copy would let a caller mutate the active
  // source through its original input, getData() or a query result.
  function clonePropertyValue(value, depth, budget, ancestors) {
    if (value == null || typeof value !== 'object') return value;
    if (depth >= 32 || ++budget.nodes > 10000) throw new Error('microMap.geojson: properties are too deeply nested');
    if (ancestors.indexOf(value) >= 0) throw new Error('microMap.geojson: properties must not contain cycles');
    ancestors.push(value);
    var result;
    var i;
    if (Array.isArray(value)) {
      result = [];
      for (i = 0; i < value.length; i++) result.push(clonePropertyValue(value[i], depth + 1, budget, ancestors));
    } else {
      result = {};
      for (var key in value) if (own(value, key)) Object.defineProperty(result, key, {
        value: clonePropertyValue(value[key], depth + 1, budget, ancestors),
        enumerable: true, configurable: true, writable: true
      });
    }
    ancestors.pop();
    return result;
  }

  function cloneProperties(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return clonePropertyValue(value, 0, { nodes: 0 }, []);
  }

  function cloneCoordinates(value) {
    if (!Array.isArray(value)) return value;
    var result = [];
    for (var i = 0; i < value.length; i++) result.push(cloneCoordinates(value[i]));
    return result;
  }

  function cloneGeometry(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'GeometryCollection') {
      return {
        type: 'GeometryCollection',
        geometries: (geometry.geometries || []).map(cloneGeometry)
      };
    }
    return { type: geometry.type, coordinates: cloneCoordinates(geometry.coordinates) };
  }

  function cloneFeature(feature) {
    var result = {
      type: 'Feature',
      properties: cloneProperties(feature.properties),
      geometry: cloneGeometry(feature.geometry)
    };
    if (feature.id != null) result.id = feature.id;
    return result;
  }

  function normalizeCoordinate(value, budget) {
    if (!Array.isArray(value) || value.length < 2 || !isFinite(+value[0]) || !isFinite(+value[1])) {
      throw new Error('microMap.geojson: coordinates must contain finite longitude and latitude values');
    }
    if (++budget.coordinates > budget.maxCoordinates) throw new Error('microMap.geojson: source has too many coordinates');
    var longitude = +value[0];
    var latitude = clamp(+value[1], -MAX_LAT, MAX_LAT);
    if (budget.activeBounds) {
      budget.activeBounds.west = Math.min(budget.activeBounds.west, longitude);
      budget.activeBounds.south = Math.min(budget.activeBounds.south, latitude);
      budget.activeBounds.east = Math.max(budget.activeBounds.east, longitude);
      budget.activeBounds.north = Math.max(budget.activeBounds.north, latitude);
    }
    return [longitude, latitude];
  }

  function normalizeCoordinates(value, depth, budget) {
    if (depth === 0) return normalizeCoordinate(value, budget);
    if (!Array.isArray(value)) throw new Error('microMap.geojson: geometry coordinates must be arrays');
    var result = [];
    for (var i = 0; i < value.length; i++) result.push(normalizeCoordinates(value[i], depth - 1, budget));
    return result;
  }

  function ensureMinimum(value, minimum, type) {
    if (value.length < minimum) throw new Error('microMap.geojson: ' + type + ' has too few positions');
    return value;
  }

  function normalizeGeometry(geometry, budget) {
    if (geometry == null) return null;
    if (!geometry || typeof geometry !== 'object' || typeof geometry.type !== 'string') {
      throw new Error('microMap.geojson: feature geometry must be GeoJSON');
    }
    var coordinates;
    var i;
    if (geometry.type === 'Point') return { type: 'Point', coordinates: normalizeCoordinates(geometry.coordinates, 0, budget) };
    if (geometry.type === 'MultiPoint') return { type: 'MultiPoint', coordinates: normalizeCoordinates(geometry.coordinates, 1, budget) };
    if (geometry.type === 'LineString') {
      coordinates = ensureMinimum(normalizeCoordinates(geometry.coordinates, 1, budget), 2, 'LineString');
      return { type: 'LineString', coordinates: coordinates };
    }
    if (geometry.type === 'MultiLineString') {
      coordinates = normalizeCoordinates(geometry.coordinates, 2, budget);
      for (i = 0; i < coordinates.length; i++) ensureMinimum(coordinates[i], 2, 'LineString');
      return { type: 'MultiLineString', coordinates: coordinates };
    }
    if (geometry.type === 'Polygon') {
      coordinates = normalizeCoordinates(geometry.coordinates, 2, budget);
      for (i = 0; i < coordinates.length; i++) ensureMinimum(coordinates[i], 3, 'Polygon ring');
      return { type: 'Polygon', coordinates: coordinates };
    }
    if (geometry.type === 'MultiPolygon') {
      coordinates = normalizeCoordinates(geometry.coordinates, 3, budget);
      for (i = 0; i < coordinates.length; i++) for (var r = 0; r < coordinates[i].length; r++) {
        ensureMinimum(coordinates[i][r], 3, 'Polygon ring');
      }
      return { type: 'MultiPolygon', coordinates: coordinates };
    }
    if (geometry.type === 'GeometryCollection') {
      if (!Array.isArray(geometry.geometries)) throw new Error('microMap.geojson: GeometryCollection.geometries must be an array');
      return { type: 'GeometryCollection', geometries: geometry.geometries.map(function (item) { return normalizeGeometry(item, budget); }) };
    }
    throw new Error('microMap.geojson: unsupported geometry type ' + geometry.type);
  }

  function normalizeFeature(value, budget) {
    if (!value || typeof value !== 'object') throw new Error('microMap.geojson: source data must contain GeoJSON features');
    var feature = value.type === 'Feature' ? value : { type: 'Feature', properties: {}, geometry: value };
    var previousBounds = budget.activeBounds;
    var bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    var geometry;
    var beforeCoordinates = budget.coordinates;
    budget.activeBounds = bounds;
    try { geometry = normalizeGeometry(feature.geometry, budget); }
    finally { budget.activeBounds = previousBounds; }
    var result = {
      type: 'Feature',
      properties: cloneProperties(feature.properties),
      geometry: geometry
    };
    result._bbox = bounds.west === Infinity ? null : [bounds.west, bounds.south, bounds.east, bounds.north];
    result._coordinateCount = budget.coordinates - beforeCoordinates;
    if (feature.id != null) result.id = feature.id;
    return result;
  }

  function normalizeData(data, maxFeatures, maxCoordinates) {
    if (data == null) data = { type: 'FeatureCollection', features: [] };
    var values;
    if (data.type === 'FeatureCollection') values = data.features;
    else values = [data];
    if (!Array.isArray(values)) throw new Error('microMap.geojson: FeatureCollection.features must be an array');
    if (values.length > maxFeatures) throw new Error('microMap.geojson: source has too many features');
    var budget = { coordinates: 0, maxCoordinates: maxCoordinates };
    var result = [];
    for (var i = 0; i < values.length; i++) result.push(normalizeFeature(values[i], budget));
    return result;
  }

  function featureGeometryType(feature) {
    var type = feature && feature.geometry && feature.geometry.type;
    if (type === 'Point' || type === 'MultiPoint') return 'Point';
    if (type === 'LineString' || type === 'MultiLineString') return 'LineString';
    if (type === 'Polygon' || type === 'MultiPolygon') return 'Polygon';
    return type || null;
  }

  function filterValue(value, feature, propertyName) {
    if (Array.isArray(value) && value[0] === 'geometry-type') return featureGeometryType(feature);
    if (Array.isArray(value) && value[0] === 'get') {
      if (value[1] === '$type') return featureGeometryType(feature);
      if (value[1] === '$id') return feature.id;
      return feature.properties[value[1]];
    }
    if (propertyName && typeof value === 'string') {
      if (value === '$type') return featureGeometryType(feature);
      if (value === '$id') return feature.id;
      return feature.properties[value];
    }
    return value;
  }

  function matchesFilter(filter, feature) {
    if (!filter) return true;
    if (!Array.isArray(filter) || !filter.length) throw new Error('microMap.geojson: filter must be an array');
    var operator = filter[0];
    var i;
    if (operator === 'all') {
      for (i = 1; i < filter.length; i++) if (!matchesFilter(filter[i], feature)) return false;
      return true;
    }
    if (operator === 'any') {
      for (i = 1; i < filter.length; i++) if (matchesFilter(filter[i], feature)) return true;
      return false;
    }
    if (operator === 'none') {
      for (i = 1; i < filter.length; i++) if (matchesFilter(filter[i], feature)) return false;
      return true;
    }
    if (operator === '!') return !matchesFilter(filter[1], feature);
    if (operator === 'has' || operator === '!has') {
      var property = Array.isArray(filter[1]) && filter[1][0] === 'get' ? filter[1][1] : filter[1];
      return operator === 'has' ? own(feature.properties, property) : !own(feature.properties, property);
    }
    var left = filterValue(filter[1], feature, true);
    if (operator === '==' || operator === '!=') return operator === '==' ? left === filterValue(filter[2], feature) : left !== filterValue(filter[2], feature);
    if (operator === 'in' || operator === '!in') {
      var found = false;
      for (i = 2; i < filter.length; i++) if (left === filterValue(filter[i], feature)) found = true;
      return operator === 'in' ? found : !found;
    }
    throw new Error('microMap.geojson: unsupported filter operator ' + operator);
  }

  function validateFilter(filter) {
    if (!filter) return;
    if (!Array.isArray(filter) || !filter.length) throw new Error('microMap.geojson: filter must be an array');
    var operator = filter[0];
    if (operator === 'all' || operator === 'any' || operator === 'none') {
      for (var i = 1; i < filter.length; i++) validateFilter(filter[i]);
      return;
    }
    if (operator === '!') {
      validateFilter(filter[1]);
      return;
    }
    if (operator === 'has' || operator === '!has') return;
    if ((operator === '==' || operator === '!=') && filter.length === 3) return;
    if ((operator === 'in' || operator === '!in') && filter.length >= 3) return;
    throw new Error('microMap.geojson: unsupported filter operator ' + operator);
  }

  function validateExpression(expression) {
    if (!Array.isArray(expression) || typeof expression[0] !== 'string') return;
    var operator = expression[0];
    var i;
    if (operator === 'get') {
      if (expression.length !== 2 || typeof expression[1] !== 'string') throw new Error('microMap.geojson: get requires a property name');
      return;
    }
    if (operator === 'geometry-type' || operator === 'zoom') {
      if (expression.length !== 1) throw new Error('microMap.geojson: ' + operator + ' takes no arguments');
      return;
    }
    if (operator === 'literal') {
      if (expression.length !== 2) throw new Error('microMap.geojson: literal requires one value');
      return;
    }
    if (operator === 'coalesce') {
      if (expression.length < 2) throw new Error('microMap.geojson: coalesce requires a value');
      for (i = 1; i < expression.length; i++) validateExpression(expression[i]);
      return;
    }
    if (operator === 'match') {
      if (expression.length < 5) throw new Error('microMap.geojson: match requires labels and a fallback');
      validateExpression(expression[1]);
      for (i = 2; i + 1 < expression.length; i += 2) validateExpression(expression[i + 1]);
      validateExpression(expression[expression.length - 1]);
      return;
    }
    if (operator === 'interpolate') {
      if (expression.length < 7 || !Array.isArray(expression[1]) || expression[1][0] !== 'linear' || (expression.length - 3) % 2) {
        throw new Error('microMap.geojson: only linear interpolate expressions are supported');
      }
      validateExpression(expression[2]);
      for (i = 3; i + 1 < expression.length; i += 2) {
        if (!isFinite(+expression[i])) throw new Error('microMap.geojson: interpolate stops must be finite numbers');
        validateExpression(expression[i + 1]);
      }
      return;
    }
    throw new Error('microMap.geojson: unsupported expression operator ' + operator);
  }

  function validateStyleValues(style) {
    for (var key in style) if (own(style, key)) validateExpression(style[key]);
  }

  function numberExpression(value, feature, zoom) {
    var result = valueOf(value, feature, null, zoom);
    result = +result;
    return isFinite(result) ? result : null;
  }

  function valueOf(value, feature, fallback, zoom) {
    if (value == null) return fallback;
    if (!Array.isArray(value)) return value;
    if (value[0] === 'get' && typeof value[1] === 'string') {
      if (value[1] === '$type') return featureGeometryType(feature);
      if (value[1] === '$id') return feature.id;
      var property = feature.properties[value[1]];
      return property == null ? fallback : property;
    }
    if (value[0] === 'geometry-type') return featureGeometryType(feature);
    if (value[0] === 'zoom') return isFinite(+zoom) ? +zoom : fallback;
    if (value[0] === 'literal') return value[1];
    if (value[0] === 'coalesce') {
      for (var i = 1; i < value.length; i++) {
        var candidate = valueOf(value[i], feature, null, zoom);
        if (candidate != null) return candidate;
      }
    }
    if (value[0] === 'match' && value.length >= 5) {
      var matchValue = valueOf(value[1], feature, null, zoom);
      for (var m = 2; m + 1 < value.length; m += 2) {
        var labels = value[m];
        if (!Array.isArray(labels)) labels = [labels];
        for (var l = 0; l < labels.length; l++) if (matchValue === labels[l]) return valueOf(value[m + 1], feature, fallback, zoom);
      }
      return valueOf(value[value.length - 1], feature, fallback, zoom);
    }
    if (value[0] === 'interpolate' && value.length >= 7 && Array.isArray(value[1]) && value[1][0] === 'linear') {
      var input = numberExpression(value[2], feature, zoom);
      var firstStop = numberExpression(value[3], feature, zoom);
      var firstOutput = numberExpression(value[4], feature, zoom);
      if (input == null || firstStop == null || firstOutput == null) return fallback;
      if (input <= firstStop) return firstOutput;
      var previousStop = firstStop;
      var previousOutput = firstOutput;
      for (var s = 5; s + 1 < value.length; s += 2) {
        var nextStop = numberExpression(value[s], feature, zoom);
        var nextOutput = numberExpression(value[s + 1], feature, zoom);
        if (nextStop == null || nextOutput == null || nextStop <= previousStop) return fallback;
        if (input <= nextStop) {
          var ratio = (input - previousStop) / (nextStop - previousStop);
          return previousOutput + (nextOutput - previousOutput) * ratio;
        }
        previousStop = nextStop;
        previousOutput = nextOutput;
      }
      return previousOutput;
    }
    return fallback;
  }

  function stringOf(value, feature, fallback, zoom) {
    value = valueOf(value, feature, fallback, zoom);
    return typeof value === 'string' ? value : fallback;
  }

  function numberOf(value, feature, fallback, minimum, maximum, zoom) {
    return clamp(finite(valueOf(value, feature, fallback, zoom), fallback), minimum, maximum);
  }

  function textOf(value, feature, zoom) {
    value = valueOf(value, feature, '', zoom);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return '';
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function layerVisible(layer, zoom) {
    var layout = layer.layout || {};
    return layout.visibility !== 'none' && !(layer.minzoom != null && zoom < +layer.minzoom) && !(layer.maxzoom != null && zoom >= +layer.maxzoom);
  }

  function instructionFor(layer, feature, zoom) {
    if (!layerVisible(layer, zoom) || !matchesFilter(layer.filter, feature)) return null;
    var paint = layer.paint || {};
    var layout = layer.layout || {};
    if (layer.type === 'fill') return {
      type: 'fill', color: stringOf(paint['fill-color'] == null ? paint.color : paint['fill-color'], feature, '#4f8b63', zoom),
      opacity: numberOf(paint['fill-opacity'] == null ? paint.opacity : paint['fill-opacity'], feature, 1, 0, 1, zoom),
      outlineColor: stringOf(paint['fill-outline-color'] == null ? paint.outlineColor : paint['fill-outline-color'], feature, null, zoom),
      outlineWidth: numberOf(paint['fill-outline-width'] == null ? paint.outlineWidth : paint['fill-outline-width'], feature, 1, 0, 32, zoom)
    };
    if (layer.type === 'line') return {
      type: 'line', color: stringOf(paint['line-color'] == null ? paint.color : paint['line-color'], feature, '#1769e0', zoom),
      opacity: numberOf(paint['line-opacity'] == null ? paint.opacity : paint['line-opacity'], feature, 1, 0, 1, zoom),
      width: numberOf(paint['line-width'] == null ? paint.width : paint['line-width'], feature, 2, 0, 64, zoom),
      cap: layout['line-cap'] || layer.lineCap || 'round', join: layout['line-join'] || layer.lineJoin || 'round',
      dash: valueOf(paint['line-dasharray'] == null ? paint.dashArray : paint['line-dasharray'], feature, null, zoom)
    };
    if (layer.type === 'circle') return {
      type: 'circle', color: stringOf(paint['circle-color'] == null ? paint.color : paint['circle-color'], feature, '#1769e0', zoom),
      opacity: numberOf(paint['circle-opacity'] == null ? paint.opacity : paint['circle-opacity'], feature, 1, 0, 1, zoom),
      radius: numberOf(paint['circle-radius'] == null ? paint.radius : paint['circle-radius'], feature, 5, 0, 64, zoom),
      strokeColor: stringOf(paint['circle-stroke-color'] == null ? paint.strokeColor : paint['circle-stroke-color'], feature, null, zoom),
      strokeWidth: numberOf(paint['circle-stroke-width'] == null ? paint.strokeWidth : paint['circle-stroke-width'], feature, 0, 0, 32, zoom)
    };
    if (layer.type === 'symbol') return {
      type: 'symbol', text: textOf(layout['text-field'] == null ? layer.text : layout['text-field'], feature, zoom),
      color: stringOf(paint['text-color'] == null ? paint.color : paint['text-color'], feature, '#263238', zoom),
      opacity: numberOf(paint['text-opacity'] == null ? paint.opacity : paint['text-opacity'], feature, 1, 0, 1, zoom),
      size: numberOf(layout['text-size'] == null ? layer.size : layout['text-size'], feature, 12, 6, 48, zoom),
      font: stringOf(layout['text-font'] == null ? layer.font : layout['text-font'], feature, 'system-ui, sans-serif', zoom),
      offset: valueOf(layout['text-offset'] == null ? layer.offset : layout['text-offset'], feature, [0, 0], zoom)
    };
    return null;
  }

  function geometryEach(geometry, callback) {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (var i = 0; i < geometry.geometries.length; i++) geometryEach(geometry.geometries[i], callback);
    } else callback(geometry);
  }

  function pointEach(geometry, callback) {
    geometryEach(geometry, function (part) {
      var coordinates = part.coordinates;
      var i;
      if (part.type === 'Point') callback(coordinates);
      else if (part.type === 'MultiPoint') for (i = 0; i < coordinates.length; i++) callback(coordinates[i]);
    });
  }

  function lineEach(geometry, callback) {
    geometryEach(geometry, function (part) {
      var coordinates = part.coordinates;
      var i;
      if (part.type === 'LineString') callback(coordinates, false);
      else if (part.type === 'MultiLineString') for (i = 0; i < coordinates.length; i++) callback(coordinates[i], false);
      else if (part.type === 'Polygon') for (i = 0; i < coordinates.length; i++) callback(coordinates[i], true);
      else if (part.type === 'MultiPolygon') for (var p = 0; p < coordinates.length; p++) for (i = 0; i < coordinates[p].length; i++) callback(coordinates[p][i], true);
    });
  }

  function polygonEach(geometry, callback) {
    geometryEach(geometry, function (part) {
      if (part.type === 'Polygon') callback(part.coordinates);
      else if (part.type === 'MultiPolygon') for (var i = 0; i < part.coordinates.length; i++) callback(part.coordinates[i]);
    });
  }

  function coordinateEach(geometry, callback) {
    geometryEach(geometry, function (part) {
      var coordinates = part.coordinates;
      var i;
      var j;
      var r;
      if (part.type === 'Point') callback(coordinates);
      else if (part.type === 'MultiPoint' || part.type === 'LineString') {
        for (i = 0; i < coordinates.length; i++) callback(coordinates[i]);
      } else if (part.type === 'MultiLineString' || part.type === 'Polygon') {
        for (i = 0; i < coordinates.length; i++) for (j = 0; j < coordinates[i].length; j++) callback(coordinates[i][j]);
      } else if (part.type === 'MultiPolygon') {
        for (i = 0; i < coordinates.length; i++) for (r = 0; r < coordinates[i].length; r++) {
          for (j = 0; j < coordinates[i][r].length; j++) callback(coordinates[i][r][j]);
        }
      }
    });
  }

  // getBounds() encloses the rotated/pitched viewport. Extend that envelope by
  // a generous pixel margin so wide strokes and edge geometry are retained.
  // If coordinates are noncanonical or the view spans the world, skip culling
  // rather than risk hiding data with longitude wrapping.
  function intersectsView(feature, viewBounds, viewportWidth, viewportHeight) {
    var box = feature && feature._bbox;
    if (!box || !viewBounds || box[0] < -180 || box[2] > 180) return true;
    var west = +viewBounds[0];
    var south = +viewBounds[1];
    var east = +viewBounds[2];
    var north = +viewBounds[3];
    if (!isFinite(west) || !isFinite(south) || !isFinite(east) || !isFinite(north)) return true;
    while (east < west) east += 360;
    // A full-world viewport can wrap both edges to the same longitude.
    if (Math.abs(east - west) < 0.000001) return true;
    var longitudeSpan = east - west;
    var latitudeSpan = north - south;
    if (longitudeSpan + longitudeSpan * 2 >= 360) return true;
    var longitudePadding = Math.max(0.000001, longitudeSpan, longitudeSpan * 160 / Math.max(1, viewportWidth));
    var latitudePadding = Math.max(0.000001, latitudeSpan, latitudeSpan * 160 / Math.max(1, viewportHeight));
    if (box[3] < south - latitudePadding || box[1] > north + latitudePadding) return false;
    west -= longitudePadding;
    east += longitudePadding;
    for (var shift = -720; shift <= 720; shift += 360) {
      if (box[2] + shift >= west && box[0] + shift <= east) return true;
    }
    return false;
  }

  function wrappedLongitude(value) {
    value = ((value % 360) + 360) % 360;
    return value > 180 ? value - 360 : value;
  }

  function screenPoint(map, coordinate) {
    var point = map.project(coordinate);
    return Array.isArray(point) ? point : [point.x, point.y];
  }

  function drawLinePath(ctx, map, coordinates, close) {
    if (!coordinates.length) return;
    var point = screenPoint(map, coordinates[0]);
    ctx.moveTo(point[0], point[1]);
    for (var i = 1; i < coordinates.length; i++) {
      point = screenPoint(map, coordinates[i]);
      ctx.lineTo(point[0], point[1]);
    }
    if (close) ctx.closePath();
  }

  function segmentDistanceSquared(x, y, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var length = dx * dx + dy * dy;
    if (!length) return (x - x1) * (x - x1) + (y - y1) * (y - y1);
    var ratio = clamp(((x - x1) * dx + (y - y1) * dy) / length, 0, 1);
    dx = x - (x1 + dx * ratio);
    dy = y - (y1 + dy * ratio);
    return dx * dx + dy * dy;
  }

  function pointOnSegment(point, a, b) {
    return Math.abs((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) < 1e-7 &&
      point[0] >= Math.min(a[0], b[0]) - 1e-7 && point[0] <= Math.max(a[0], b[0]) + 1e-7 &&
      point[1] >= Math.min(a[1], b[1]) - 1e-7 && point[1] <= Math.max(a[1], b[1]) + 1e-7;
  }

  function containsRings(map, rings, point) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (!ring.length) continue;
      var a = screenPoint(map, ring[ring.length - 1]);
      for (var i = 0; i < ring.length; i++) {
        var b = screenPoint(map, ring[i]);
        if (pointOnSegment(point, a, b)) return true;
        if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        a = b;
      }
    }
    return inside;
  }

  function labelAnchor(map, geometry) {
    var coordinate = null;
    pointEach(geometry, function (point) { if (!coordinate) coordinate = point; });
    if (coordinate) return screenPoint(map, coordinate);
    lineEach(geometry, function (line) {
      if (coordinate || !line.length) return;
      coordinate = line[Math.floor(line.length / 2)];
    });
    if (coordinate) return screenPoint(map, coordinate);
    polygonEach(geometry, function (rings) {
      if (coordinate || !rings.length || !rings[0].length) return;
      coordinate = rings[0][Math.floor(rings[0].length / 2)];
    });
    return coordinate ? screenPoint(map, coordinate) : null;
  }

  function geoJSONMap(map, options) {
    if (!map || typeof map.getContainer !== 'function' || typeof map.project !== 'function' || typeof map.on !== 'function' || typeof map.off !== 'function') {
      throw new Error('microMap.geojson: pass a microMap instance');
    }
    if (typeof microMap !== 'function') throw new Error('microMap.geojson: load microMap.js before microMap.geojson.js');
    options = options || {};
    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext && canvas.getContext('2d');
    if (!context) throw new Error('microMap.geojson: Canvas 2D is required');
    var maxFeatures = positiveInteger(options.maxFeatures, 10000, 100000);
    var maxCoordinates = positiveInteger(options.maxCoordinates, 100000, 1000000);
    // Cap the backing store independently of the device's DPR. On a 3x
    // display this changes a full-screen overlay from 9 to 4 pixels per CSS
    // pixel; maps with fine labels can opt back into a higher cap.
    var maxDpr = clamp(finite(options.maxDpr, 2), 1, 4);
    var sources = Object.create(null);
    var layers = [];
    var layerByID = Object.create(null);
    var listeners = Object.create(null);
    var width = 0;
    var height = 0;
    var dpr = 1;
    var frame = 0;
    var destroyed = false;

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:' + clamp(Math.floor(finite(options.zIndex, 2)), -100, 100) + ';pointer-events:none';
    container.appendChild(canvas);

    function emit(type, extra) {
      var list = listeners[type];
      if (!list || !list.length) return;
      list = list.slice();
      for (var i = 0; i < list.length; i++) {
        var registered = list[i];
        var features = extra && extra.features;
        if (registered.layer) {
          features = (features || []).filter(function (feature) { return feature.layer && feature.layer.id === registered.layer; });
          if (!features.length) continue;
        }
        var event = { type: type, target: api, map: map };
        var key;
        if (extra) for (key in extra) event[key] = extra[key];
        if (registered.layer) event.features = features;
        registered.handler(event);
      }
    }

    function schedule() {
      if (!frame && !destroyed) frame = requestFrame.call(root, draw);
    }

    function resize() {
      width = Math.max(0, container.clientWidth || 0);
      height = Math.max(0, container.clientHeight || 0);
      dpr = clamp(finite(root.devicePixelRatio, 1), 1, maxDpr);
      var pixelWidth = Math.round(width * dpr);
      var pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      if (canvas.style.width !== width + 'px') canvas.style.width = width + 'px';
      if (canvas.style.height !== height + 'px') canvas.style.height = height + 'px';
    }

    function drawFill(feature, instruction) {
      var found = false;
      context.beginPath();
      polygonEach(feature.geometry, function (rings) {
        found = true;
        for (var r = 0; r < rings.length; r++) drawLinePath(context, map, rings[r], true);
      });
      if (!found) return;
      context.globalAlpha = instruction.opacity;
      context.fillStyle = instruction.color;
      context.fill('nonzero');
      if (instruction.outlineColor && instruction.outlineWidth) {
        context.strokeStyle = instruction.outlineColor;
        context.lineWidth = instruction.outlineWidth;
        context.stroke();
      }
    }

    function drawLine(feature, instruction) {
      var found = false;
      context.beginPath();
      lineEach(feature.geometry, function (coordinates, close) {
        found = true;
        drawLinePath(context, map, coordinates, close);
      });
      if (!found || !(instruction.width > 0)) return;
      context.globalAlpha = instruction.opacity;
      context.strokeStyle = instruction.color;
      context.lineWidth = instruction.width;
      context.lineCap = instruction.cap;
      context.lineJoin = instruction.join;
      if (context.setLineDash) context.setLineDash(Array.isArray(instruction.dash) ? instruction.dash.map(function (value) { return Math.max(0, finite(value, 0)); }) : []);
      context.stroke();
      if (context.setLineDash) context.setLineDash([]);
    }

    function drawCircle(feature, instruction) {
      if (!(instruction.radius > 0)) return;
      var found = false;
      context.beginPath();
      pointEach(feature.geometry, function (coordinate) {
        found = true;
        var point = screenPoint(map, coordinate);
        context.moveTo(point[0] + instruction.radius, point[1]);
        context.arc(point[0], point[1], instruction.radius, 0, Math.PI * 2);
      });
      if (!found) return;
      context.globalAlpha = instruction.opacity;
      context.fillStyle = instruction.color;
      context.fill('nonzero');
      if (instruction.strokeColor && instruction.strokeWidth) {
        context.strokeStyle = instruction.strokeColor;
        context.lineWidth = instruction.strokeWidth;
        context.stroke();
      }
    }

    function drawSymbol(feature, instruction) {
      if (!instruction.text || !(instruction.opacity > 0)) return;
      var anchor = labelAnchor(map, feature.geometry);
      if (!anchor) return;
      var offset = Array.isArray(instruction.offset) ? instruction.offset : [0, 0];
      context.save();
      context.globalAlpha = instruction.opacity;
      context.fillStyle = instruction.color;
      context.font = instruction.size + 'px ' + instruction.font;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      if (context.fillText) context.fillText(instruction.text, anchor[0] + finite(offset[0], 0) * instruction.size, anchor[1] + finite(offset[1], 0) * instruction.size);
      context.restore();
    }

    function draw() {
      frame = 0;
      if (destroyed) return;
      resize();
      if (!width || !height) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      var zoom = map.getZoom();
      var viewBounds = map.getBounds();
      for (var l = 0; l < layers.length; l++) {
        var layer = layers[l];
        if (!layerVisible(layer, zoom)) continue;
        var source = sources[layer.source];
        if (!source) continue;
        for (var f = 0; f < source.features.length; f++) {
          var feature = source.features[f];
          if (layer.type !== 'symbol' && !intersectsView(feature, viewBounds, width, height)) continue;
          var instruction = instructionFor(layer, feature, zoom);
          if (!instruction) continue;
          if (instruction.type === 'fill') drawFill(feature, instruction);
          else if (instruction.type === 'line') drawLine(feature, instruction);
          else if (instruction.type === 'circle') drawCircle(feature, instruction);
          else drawSymbol(feature, instruction);
        }
      }
    }

    function normalizeLayer(specification) {
      if (!specification || typeof specification !== 'object' || typeof specification.id !== 'string' || !specification.id) {
        throw new Error('microMap.geojson: layer requires a non-empty id');
      }
      if (specification.type !== 'fill' && specification.type !== 'line' && specification.type !== 'circle' && specification.type !== 'symbol') {
        throw new Error('microMap.geojson: layer type must be fill, line, circle, or symbol');
      }
      if (typeof specification.source !== 'string' || !sources[specification.source]) {
        throw new Error('microMap.geojson: layer source must name an existing GeoJSON source');
      }
      validateFilter(specification.filter);
      validateStyleValues(specification.paint || {});
      validateStyleValues(specification.layout || {});
      return {
        id: specification.id, type: specification.type, source: specification.source,
        minzoom: specification.minzoom, maxzoom: specification.maxzoom, filter: specification.filter || null,
        paint: cloneProperties(specification.paint), layout: cloneProperties(specification.layout),
        lineCap: specification.lineCap, lineJoin: specification.lineJoin, text: specification.text,
        size: specification.size, font: specification.font, offset: cloneCoordinates(specification.offset)
      };
    }

    function addSource(id, specification) {
      if (destroyed) return api;
      if (typeof id !== 'string' || !id) throw new Error('microMap.geojson: source requires a non-empty id');
      if (sources[id]) throw new Error('microMap.geojson: source already exists: ' + id);
      specification = specification || {};
      if (specification.type != null && specification.type !== 'geojson') throw new Error('microMap.geojson: only GeoJSON sources are supported');
      var source = {
        id: id,
        type: 'geojson',
        attribution: typeof specification.attribution === 'string' ? specification.attribution : undefined,
        features: normalizeData(specification.data, maxFeatures, maxCoordinates),
        api: null
      };
      source.api = {
        type: 'geojson',
        setData: function (data) {
          if (destroyed) return source.api;
          source.features = normalizeData(data, maxFeatures, maxCoordinates);
          emit('data', { source: id });
          schedule();
          return source.api;
        },
        updateData: function (diff) {
          if (destroyed) return source.api;
          if (!diff || typeof diff !== 'object' || Array.isArray(diff)) throw new Error('microMap.geojson: updateData needs a diff object');
          var next = new Map();
          for (var i = 0; i < source.features.length; i++) {
            var existing = source.features[i];
            if (existing.id == null || next.has(existing.id)) throw new Error('microMap.geojson: updateData requires unique feature IDs');
            next.set(existing.id, existing);
          }
          if (diff.removeAll) next.clear();
          if (diff.remove != null) {
            if (!Array.isArray(diff.remove)) throw new Error('microMap.geojson: updateData.remove must be an array');
            diff.remove.forEach(function (featureID) { next.delete(featureID); });
          }
          if (diff.add != null) {
            if (!Array.isArray(diff.add)) throw new Error('microMap.geojson: updateData.add must be an array');
            diff.add.forEach(function (feature) {
              if (!feature || feature.type !== 'Feature' || feature.id == null || next.has(feature.id)) throw new Error('microMap.geojson: added features need unique IDs');
              next.set(feature.id, normalizeFeature(feature, { coordinates: 0, maxCoordinates: maxCoordinates }));
            });
          }
          if (diff.update != null) {
            if (!Array.isArray(diff.update)) throw new Error('microMap.geojson: updateData.update must be an array');
            diff.update.forEach(function (patch) {
              if (!patch || patch.id == null) throw new Error('microMap.geojson: updated features need an ID');
              var current = next.get(patch.id);
              if (!current) return;
              var replacement = cloneFeature(current);
              if (own(patch, 'newGeometry')) replacement.geometry = patch.newGeometry;
              if (patch.removeAllProperties) replacement.properties = {};
              if (patch.removeProperties != null) {
                if (!Array.isArray(patch.removeProperties)) throw new Error('microMap.geojson: removeProperties must be an array');
                patch.removeProperties.forEach(function (key) { delete replacement.properties[key]; });
              }
              if (patch.addOrUpdateProperties != null) {
                if (!Array.isArray(patch.addOrUpdateProperties)) throw new Error('microMap.geojson: addOrUpdateProperties must be an array');
                patch.addOrUpdateProperties.forEach(function (entry) {
                  if (!entry || typeof entry.key !== 'string') throw new Error('microMap.geojson: property update needs a string key');
                  Object.defineProperty(replacement.properties, entry.key, { value: entry.value, enumerable: true, configurable: true, writable: true });
                });
              }
              next.set(patch.id, normalizeFeature(replacement, { coordinates: 0, maxCoordinates: maxCoordinates }));
            });
          }
          if (next.size > maxFeatures) throw new Error('microMap.geojson: source has too many features');
          var totalCoordinates = 0;
          next.forEach(function (feature) { totalCoordinates += feature._coordinateCount; });
          if (totalCoordinates > maxCoordinates) throw new Error('microMap.geojson: source has too many coordinates');
          source.features = Array.from(next.values());
          emit('data', { source: id });
          schedule();
          return source.api;
        },
        getData: function () {
          return { type: 'FeatureCollection', features: source.features.map(cloneFeature) };
        }
      };
      sources[id] = source;
      emit('data', { source: id });
      schedule();
      return api;
    }

    function getSource(id) {
      return sources[id] ? sources[id].api : null;
    }

    function getStyle() {
      var sourceSpecs = {};
      for (var id in sources) {
        if (!own(sources, id)) continue;
        sourceSpecs[id] = { type: 'geojson', data: sources[id].api.getData() };
        if (sources[id].attribution) sourceSpecs[id].attribution = sources[id].attribution;
      }
      return { version: 8, sources: sourceSpecs, layers: layers.map(function (layer) { return getLayer(layer.id); }) };
    }

    function removeSource(id) {
      if (destroyed || !sources[id]) return api;
      for (var i = 0; i < layers.length; i++) if (layers[i].source === id) throw new Error('microMap.geojson: remove layers before their source');
      delete sources[id];
      emit('data', { source: id, removed: true });
      schedule();
      return api;
    }

    function addLayer(specification, beforeID) {
      if (destroyed) return api;
      var layer = normalizeLayer(specification);
      if (layerByID[layer.id]) throw new Error('microMap.geojson: layer already exists: ' + layer.id);
      var index = beforeID == null ? -1 : layers.findIndex(function (candidate) { return candidate.id === beforeID; });
      if (beforeID != null && index < 0) throw new Error('microMap.geojson: before layer does not exist: ' + beforeID);
      if (index < 0) layers.push(layer);
      else layers.splice(index, 0, layer);
      layerByID[layer.id] = layer;
      emit('stylechange', { layer: layer.id });
      schedule();
      return api;
    }

    function getLayer(id) {
      var layer = layerByID[id];
      if (!layer) return null;
      return {
        id: layer.id, type: layer.type, source: layer.source, minzoom: layer.minzoom, maxzoom: layer.maxzoom,
        filter: cloneCoordinates(layer.filter), paint: cloneProperties(layer.paint), layout: cloneProperties(layer.layout)
      };
    }

    function removeLayer(id) {
      if (destroyed || !layerByID[id]) return api;
      var index = layers.indexOf(layerByID[id]);
      if (index > -1) layers.splice(index, 1);
      delete layerByID[id];
      emit('stylechange', { layer: id, removed: true });
      schedule();
      return api;
    }

    function patchStyle(id, kind, patch) {
      var layer = layerByID[id];
      if (destroyed || !layer) return api;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('microMap.geojson: ' + kind + ' patch must be an object');
      var names = Object.keys(patch);
      if (!names.length) return api;
      var next = cloneProperties(layer[kind]);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (kind === 'layout' && name === 'visibility' && patch[name] !== undefined && patch[name] !== 'visible' && patch[name] !== 'none') {
          throw new Error('microMap.geojson: visibility must be visible or none');
        }
        if (patch[name] === undefined) delete next[name];
        else Object.defineProperty(next, name, { value: clonePropertyValue(patch[name], 0, { nodes: 0 }, []), enumerable: true, configurable: true, writable: true });
      }
      validateStyleValues(next);
      layer[kind] = next;
      emit('stylechange', { layer: id, property: names.length === 1 ? names[0] : null, properties: names });
      schedule();
      return api;
    }

    function setPaintProperty(id, property, value) {
      if (typeof property !== 'string' || !property) throw new Error('microMap.geojson: paint property must be a string');
      var patch = {};
      Object.defineProperty(patch, property, { value: value, enumerable: true });
      return patchStyle(id, 'paint', patch);
    }

    function setLayoutProperty(id, property, value) {
      if (typeof property !== 'string' || !property) throw new Error('microMap.geojson: layout property must be a string');
      var patch = {};
      Object.defineProperty(patch, property, { value: value, enumerable: true });
      return patchStyle(id, 'layout', patch);
    }

    function setFilter(id, filter) {
      var layer = layerByID[id];
      if (destroyed || !layer) return api;
      validateFilter(filter);
      layer.filter = filter || null;
      emit('stylechange', { layer: id, property: 'filter' });
      schedule();
      return api;
    }

    // Return the shortest longitude interval containing source data. A west
    // value greater than east deliberately describes an antimeridian-crossing
    // extent, which microMap.fitBounds() already accepts.
    function getBounds(sourceID) {
      if (destroyed) return null;
      var selected = sourceID == null ? null : sources[sourceID];
      if (sourceID != null && !selected) return null;
      var longitudes = [];
      var south = Infinity;
      var north = -Infinity;
      for (var id in sources) {
        var source = sources[id];
        if (selected && source !== selected) continue;
        for (var f = 0; f < source.features.length; f++) coordinateEach(source.features[f].geometry, function (coordinate) {
          longitudes.push(((coordinate[0] % 360) + 360) % 360);
          south = Math.min(south, coordinate[1]);
          north = Math.max(north, coordinate[1]);
        });
      }
      if (!longitudes.length) return null;
      longitudes.sort(function (a, b) { return a - b; });
      var gap = -1;
      var gapIndex = 0;
      for (var i = 0; i < longitudes.length; i++) {
        var next = i + 1 < longitudes.length ? longitudes[i + 1] : longitudes[0] + 360;
        if (next - longitudes[i] > gap) {
          gap = next - longitudes[i];
          gapIndex = i;
        }
      }
      var west = longitudes[(gapIndex + 1) % longitudes.length];
      var east = longitudes[gapIndex];
      return [wrappedLongitude(west), south, wrappedLongitude(east), north];
    }

    function queryRenderedFeatures(point, queryOptions) {
      if (destroyed) return [];
      if (Array.isArray(point)) point = { x: point[0], y: point[1] };
      if (!point || !isFinite(+point.x) || !isFinite(+point.y)) return [];
      queryOptions = queryOptions || {};
      if (!queryOptions || typeof queryOptions !== 'object' || Array.isArray(queryOptions)) throw new Error('microMap.geojson: query options must be an object');
      var requested = null;
      if (queryOptions.layers != null) {
        if (!Array.isArray(queryOptions.layers) || !queryOptions.layers.every(function (id) { return typeof id === 'string'; })) {
          throw new Error('microMap.geojson: query layers must be an array of layer ids');
        }
        requested = Object.create(null);
        for (var q = 0; q < queryOptions.layers.length; q++) requested[queryOptions.layers[q]] = true;
      }
      var radius = clamp(finite(queryOptions.radius, 3), 0, 32);
      var screen = [+point.x, +point.y];
      var zoom = map.getZoom();
      var results = [];
      for (var l = layers.length - 1; l >= 0; l--) {
        var layer = layers[l];
        if ((requested && !requested[layer.id]) || !layerVisible(layer, zoom)) continue;
        var source = sources[layer.source];
        if (!source) continue;
        for (var f = source.features.length - 1; f >= 0; f--) {
          var feature = source.features[f];
          var instruction = instructionFor(layer, feature, zoom);
          if (!instruction || !(instruction.opacity > 0)) continue;
          var hit = false;
          if (instruction.type === 'fill') {
            polygonEach(feature.geometry, function (rings) { if (!hit && containsRings(map, rings, screen)) hit = true; });
          } else if (instruction.type === 'line') {
            var limit = instruction.width / 2 + radius;
            lineEach(feature.geometry, function (coordinates, close) {
              if (hit || coordinates.length < 2) return;
              var first = screenPoint(map, coordinates[0]);
              var a = first;
              for (var i = 1; i < coordinates.length; i++) {
                var b = screenPoint(map, coordinates[i]);
                if (segmentDistanceSquared(screen[0], screen[1], a[0], a[1], b[0], b[1]) <= limit * limit) { hit = true; return; }
                a = b;
              }
              if (close && coordinates.length > 2 && segmentDistanceSquared(screen[0], screen[1], first[0], first[1], a[0], a[1]) <= limit * limit) hit = true;
            });
          } else if (instruction.type === 'circle') {
            var circleLimit = instruction.radius + instruction.strokeWidth / 2 + radius;
            pointEach(feature.geometry, function (coordinate) {
              if (hit) return;
              var circle = screenPoint(map, coordinate);
              var dx = screen[0] - circle[0];
              var dy = screen[1] - circle[1];
              if (dx * dx + dy * dy <= circleLimit * circleLimit) hit = true;
            });
          } else {
            var anchor = labelAnchor(map, feature.geometry);
            if (anchor) {
              var deltaX = screen[0] - anchor[0];
              var deltaY = screen[1] - anchor[1];
              var symbolLimit = Math.max(6, instruction.size / 2) + radius;
              hit = deltaX * deltaX + deltaY * deltaY <= symbolLimit * symbolLimit;
            }
          }
          if (hit) {
            var result = cloneFeature(feature);
            result.source = layer.source;
            result.layer = { id: layer.id, type: layer.type, source: layer.source };
            results.push(result);
          }
        }
      }
      return results;
    }

    function on(type, layerID, handler) {
      if (typeof layerID === 'function') {
        handler = layerID;
        layerID = null;
      }
      if (!destroyed && typeof handler === 'function') (listeners[type] || (listeners[type] = [])).push({ layer: layerID, handler: handler });
      return api;
    }

    function off(type, layerID, handler) {
      if (typeof layerID === 'function') {
        handler = layerID;
        layerID = null;
      }
      var list = listeners[type];
      if (!list) return api;
      if (!handler) {
        listeners[type] = layerID == null ? [] : list.filter(function (entry) { return entry.layer !== layerID; });
      } else {
        listeners[type] = list.filter(function (entry) { return entry.handler !== handler || entry.layer !== layerID; });
      }
      return api;
    }

    function onMapClick(event) {
      var handlers = (listeners.click || []).concat(listeners.featureclick || []);
      if (!handlers.length) return;
      var ids = [];
      var allLayers = false;
      for (var i = 0; i < handlers.length; i++) {
        if (handlers[i].layer == null) { allLayers = true; break; }
        if (ids.indexOf(handlers[i].layer) < 0) ids.push(handlers[i].layer);
      }
      var features = queryRenderedFeatures(event && event.point, allLayers ? undefined : { layers: ids });
      emit('click', {
        point: event && event.point,
        lonLat: event && event.lonLat,
        originalEvent: event && event.originalEvent,
        features: features
      });
      if (features.length) emit('featureclick', {
        point: event && event.point,
        lonLat: event && event.lonLat,
        originalEvent: event && event.originalEvent,
        features: features
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      map.off('load', schedule).off('move', schedule).off('zoom', schedule).off('rotate', schedule).off('pitch', schedule).off('resize', schedule).off('click', onMapClick).off('destroy', destroy);
      if (canvas.parentNode === container) container.removeChild(canvas);
      sources = Object.create(null);
      layers = [];
      layerByID = Object.create(null);
      listeners = Object.create(null);
    }

    var api = {
      addSource: addSource,
      getSource: getSource,
      getStyle: getStyle,
      removeSource: removeSource,
      addLayer: addLayer,
      getLayer: getLayer,
      removeLayer: removeLayer,
      setPaintProperty: setPaintProperty,
      setLayoutProperty: setLayoutProperty,
      setPaintProperties: function (id, patch) { return patchStyle(id, 'paint', patch); },
      setLayoutProperties: function (id, patch) { return patchStyle(id, 'layout', patch); },
      setFilter: setFilter,
      getBounds: getBounds,
      queryRenderedFeatures: queryRenderedFeatures,
      on: on,
      off: off,
      redraw: function () { schedule(); return api; },
      getCanvas: function () { return canvas; },
      destroy: destroy
    };

    map.on('load', schedule).on('move', schedule).on('zoom', schedule).on('rotate', schedule).on('pitch', schedule).on('resize', schedule).on('click', onMapClick).on('destroy', destroy);
    schedule();
    return api;
  }

  if (typeof microMap === 'function' && !microMap.geojson) microMap.geojson = geoJSONMap;
  return geoJSONMap;
});
