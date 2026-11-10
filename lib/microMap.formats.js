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

  // Overpass JSON is not GeoJSON. Resolve complete ways and area relations;
  // an out center/bb response must never silently replace their geometry.
  function osm(input, options) {
    options = options || {};
    var data = json(input);
    if (!object(data) || !Array.isArray(data.elements)) fail('expected OSM JSON with an elements array');
    if (data.remark) fail('OSM response contains an error: ' + data.remark);
    if (options.onError != null && typeof options.onError !== 'function') fail('onError must be a function');
    if (options.includeUntaggedNodes != null && typeof options.includeUntaggedNodes !== 'boolean') fail('includeUntaggedNodes must be a boolean');
    var count = budget(options), features = [], featureIndexes = [], deferredWays = [], indexed = Object.create(null), usedNodes = Object.create(null), relationWays = Object.create(null), usedWays = Object.create(null);
    if (data.elements.length > count.maxCoordinates + count.maxFeatures) fail('OSM element limit exceeded', 'limit');
    function id(value) {
      if (typeof value === 'number' ? Number.isSafeInteger(value) : typeof value === 'string' && /^-?\d+$/.test(value)) return String(value);
      fail('OSM elements need an integer id');
    }
    function key(element) {
      if (!object(element) || ['node', 'way', 'relation'].indexOf(element.type) < 0) fail('unsupported OSM element type');
      return element.type + '/' + id(element.id);
    }
    function tags(element) {
      if (element.tags == null) return {};
      if (!object(element.tags)) fail('OSM tags must be an object');
      return copy(element.tags);
    }
    data.elements.forEach(function (element) {
      try { indexed[key(element)] = element; } catch (error) { /* Diagnosed per element below. */ }
    });
    for (var indexedKey in indexed) {
      var element = indexed[indexedKey];
      if (element && element.type === 'way' && Array.isArray(element.nodes)) element.nodes.forEach(function (ref) { usedNodes[String(ref)] = true; });
      if (element && element.type === 'relation' && element.tags && /^(multipolygon|boundary)$/.test(element.tags.type) && Array.isArray(element.members)) {
        element.members.forEach(function (member) { if (member && member.type === 'way') relationWays[String(member.ref)] = true; });
      }
    }
    function area(tags) {
      if (tags.area === 'no') return false;
      if (tags.area === 'yes') return true;
      if (tags.building && tags.building !== 'no' || tags['building:part'] && tags['building:part'] !== 'no' || tags.landuse || tags.landcover || tags.amenity || tags.shop || tags.tourism || tags.office || tags.military) return true;
      if (tags.leisure && tags.leisure !== 'track') return true;
      return /^(water|wood|scrub|wetland|grassland|heath|sand|beach|bare_rock|scree|shingle|glacier|mud|fell)$/.test(tags.natural) ||
        tags.waterway === 'riverbank' || /^(aerodrome|apron|helipad)$/.test(tags.aeroway);
    }
    function signedArea(ring) {
      var sum = 0;
      var x = ring[0][0], y = ring[0][1];
      for (var i = 1; i < ring.length; i++) sum += (ring[i - 1][0] - x) * (ring[i][1] - y) - (ring[i][0] - x) * (ring[i - 1][1] - y);
      return sum;
    }
    function winding(ring, inner) { return (signedArea(ring) < 0) !== inner ? ring.slice().reverse() : ring; }
    function geometry(element) {
      var work = 0;
      function point(value) {
        if (++work > count.maxCoordinates) fail('coordinate limit exceeded', 'limit');
        if (!object(value) || !Number.isFinite(value.lon) || !Number.isFinite(value.lat) ||
          value.lon < -180 || value.lon > 180 || value.lat < -90 || value.lat > 90) fail('OSM coordinates need finite longitude/latitude');
        return [value.lon, value.lat];
      }
      function way(value) {
        if (Array.isArray(value.geometry)) {
          if (value.geometry.length < 2) fail('OSM ways need at least two positions');
          return value.geometry.map(point);
        }
        if (!Array.isArray(value.nodes) || value.nodes.length < 2) fail('OSM way geometry is missing; use out geom or include referenced nodes');
        return value.nodes.map(function (ref) {
          var node = indexed['node/' + id(ref)];
          if (!node) fail('OSM way references missing node ' + ref);
          return point(node);
        });
      }
      function rings(segments) {
        var result = [], ends = Object.create(null), used = [];
        function endpoint(point) { return JSON.stringify(point); }
        segments.forEach(function (segment, index) {
          if (equal(segment[0], segment[segment.length - 1])) { used[index] = true; result.push(segment); return; }
          [segment[0], segment[segment.length - 1]].forEach(function (point) {
            var at = endpoint(point);
            (ends[at] || (ends[at] = [])).push(index);
          });
        });
        Object.keys(ends).forEach(function (at) { if (ends[at].length !== 2) fail('OSM multipolygon has open or ambiguous ring joins'); });
        for (var s = 0; s < segments.length; s++) {
          if (used[s]) continue;
          used[s] = true;
          var ring = segments[s].slice();
          while (!equal(ring[0], ring[ring.length - 1])) {
            var last = ring[ring.length - 1], next = ends[endpoint(last)];
            var index = used[next[0]] ? next[1] : next[0];
            if (used[index]) fail('OSM multipolygon ring cannot be closed');
            used[index] = true;
            var segment = segments[index];
            if (!equal(last, segment[0])) segment = segment.slice().reverse();
            for (var p = 1; p < segment.length; p++) ring.push(segment[p]);
          }
          result.push(ring);
        }
        result.forEach(function (ring) { if (ring.length < 4) fail('OSM polygon rings need four positions'); });
        return result;
      }
      if (element.type === 'node') return { type: 'Point', coordinates: point(element) };
      if (element.type === 'way') {
        var coords = way(element);
        var closed = Array.isArray(element.nodes) && element.nodes.length ?
          element.nodes.length > 1 && id(element.nodes[0]) === id(element.nodes[element.nodes.length - 1]) : equal(coords[0], coords[coords.length - 1]);
        return closed && area(element.tags || {}) ?
          { type: 'Polygon', coordinates: [winding(coords, false)] } : { type: 'LineString', coordinates: coords };
      }
      if (!element.tags || !/^(multipolygon|boundary)$/.test(element.tags.type)) fail('unsupported OSM relation; only multipolygon and boundary areas are supported');
      if (!Array.isArray(element.members)) fail('OSM relation needs members');
      var outer = [], inner = [];
      element.members.forEach(function (member) {
        if (!object(member)) fail('OSM relation members must be objects');
        var role = member.role || 'outer';
        if (member.type !== 'way') {
          if (role === 'outer' || role === 'inner') fail('OSM area relations require way members, not nested relations or nodes');
          return;
        }
        if (role !== 'outer' && role !== 'inner') fail('unsupported OSM area member role ' + role);
        var value = Array.isArray(member.geometry) ? member : indexed['way/' + id(member.ref)];
        if (!value) fail('OSM relation references missing way ' + member.ref);
        (role === 'inner' ? inner : outer).push(way(value));
      });
      outer = rings(outer); inner = rings(inner);
      if (!outer.length) fail('OSM multipolygon has no outer ring');
      var polygons = outer.map(function (ring) { return [winding(ring, false)]; }), checks = 0;
      var outerSizes = outer.map(function (ring) { return Math.abs(signedArea(ring)); });
      function contains(ring, point) {
        var inside = false;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if (++checks > count.maxCoordinates * 10) fail('OSM multipolygon containment limit exceeded', 'limit');
          var a = ring[i], b = ring[j];
          if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      }
      inner.forEach(function (ring) {
        var parent = -1, size = Infinity;
        outer.forEach(function (candidate, index) {
          var nextSize = outerSizes[index];
          if (nextSize < size && contains(candidate, ring[0])) { parent = index; size = nextSize; }
        });
        if (parent < 0) fail('OSM multipolygon inner ring has no containing outer ring');
        polygons[parent].push(winding(ring, true));
      });
      return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    }
    function convert(element, index, defer) {
      var beforeFeatures = count.features, beforeCoordinates = count.coordinates;
      try {
        var name = key(element);
        if (indexed[name] !== element) return; // Repeated out statements: last version wins.
        var properties = tags(element);
        if (!Object.keys(properties).length) {
          if (element.type === 'node' && usedNodes[id(element.id)] && !options.includeUntaggedNodes) return;
          if (element.type === 'way' && relationWays[id(element.id)]) {
            if (defer) { deferredWays.push({ element: element, index: index }); return; }
            if (usedWays[id(element.id)]) return;
          }
        }
        var value = { type: 'Feature', id: name, properties: properties, geometry: geoGeometry(geometry(element), count, 0) };
        addFeature(features, value, count);
        featureIndexes.push(index);
        if (element.type === 'relation') element.members.forEach(function (member) { if (member.type === 'way') usedWays[String(member.ref)] = true; });
      } catch (cause) {
        count.features = beforeFeatures; count.coordinates = beforeCoordinates;
        var error = new Error('microMap.formats: invalid OSM element ' + (index + 1) + ': ' + cause.message);
        error.elementIndex = index + 1;
        if (cause.code) error.code = cause.code;
        if (!options.onError || cause.code === 'limit') throw error;
        options.onError(error, index + 1);
      }
    }
    data.elements.forEach(function (element, index) { convert(element, index, true); });
    var beforeDeferred = features.length;
    deferredWays.forEach(function (entry) { convert(entry.element, entry.index, false); });
    if (features.length > beforeDeferred) features = features.map(function (feature, index) { return { feature: feature, index: featureIndexes[index] }; })
      .sort(function (a, b) { return a.index - b.index; }).map(function (entry) { return entry.feature; });
    return collection(features);
  }

  function parse(input, options) {
    options = options || {};
    var format = options.format;
    if (format === 'geojson-seq' || !format && typeof input === 'string' && input.trimStart().charAt(0) === '\u001e') return geojsonSeq(input, options);
    var value = json(input);
    if (format === 'osm' || !format && value && Array.isArray(value.elements)) return osm(value, options);
    if (format === 'topojson' || !format && value && value.type === 'Topology') return topojson(value, options);
    if (format && format !== 'geojson') fail('unsupported format ' + String(format));
    var features = [];
    addGeoJSON(features, value, budget(options));
    return collection(features);
  }

  var api = { parse: parse, topojson: topojson, geojsonSeq: geojsonSeq, osm: osm };
  if (typeof root.microMap === 'function' && !root.microMap.formats) root.microMap.formats = api;
  return api;
});
