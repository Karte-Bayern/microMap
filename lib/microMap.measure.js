/*! microMap.measure.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'), require('./microMap.geojson.js'));
  else root.microMapMeasure = factory(root, root.microMap, root.microMapGeoJSON);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, geoJSON) {
  'use strict';

  var R = 6371008.8;
  var RAD = Math.PI / 180;
  var instance = 0;
  function coordinate(value) {
    if (!Array.isArray(value) || value.length < 2 || !isFinite(+value[0]) || !isFinite(+value[1]) || +value[1] < -90 || +value[1] > 90) {
      throw new Error('microMap.measure: expected [longitude, latitude] with latitude from -90 to 90');
    }
    return [+value[0], +value[1]];
  }
  function distance(a, b) {
    var lat1 = a[1] * RAD, lat2 = b[1] * RAD;
    var dlat = (b[1] - a[1]) * RAD, dlon = (b[0] - a[0]) * RAD;
    var h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function pathLength(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
    return total;
  }
  function destination(center, bearing, meters) {
    var lat = center[1] * RAD, lon = center[0] * RAD, angular = meters / R;
    var nextLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
    var nextLon = lon + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat));
    return [((nextLon / RAD + 540) % 360) - 180, nextLat / RAD];
  }
  function circleRing(center, radius) {
    var points = [];
    for (var i = 0; i < 64; i++) points.push(destination(center, 2 * Math.PI * i / 64, radius));
    points.push(points[0].slice());
    return points;
  }
  function area(ring) {
    var sum = 0;
    for (var i = 1; i < ring.length; i++) {
      var delta = (ring[i][0] - ring[i - 1][0]) * RAD;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      sum += delta * (2 + Math.sin(ring[i - 1][1] * RAD) + Math.sin(ring[i][1] * RAD));
    }
    var sphere = 4 * Math.PI * R * R;
    var square = (Math.abs(sum) * R * R / 2) % sphere;
    return Math.min(square, sphere - square);
  }
  function greatCircle(a, b) {
    var steps = Math.max(1, Math.min(64, Math.ceil(distance(a, b) / 50000)));
    var start = vector(a), end = vector(b);
    var angle = Math.acos(Math.max(-1, Math.min(1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2])));
    if (angle < 0.000001 || Math.abs(Math.sin(angle)) < 0.000001) return [a, b];
    var result = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps, first = Math.sin((1 - t) * angle) / Math.sin(angle), second = Math.sin(t * angle) / Math.sin(angle);
      var x = first * start[0] + second * end[0], y = first * start[1] + second * end[1], z = first * start[2] + second * end[2];
      result.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
    }
    return result;
  }
  function vector(point) {
    var lat = point[1] * RAD, lon = point[0] * RAD;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function labelMeters(value) { return value >= 1000 ? (value / 1000).toFixed(2) + ' km' : Math.round(value) + ' m'; }
  function labelArea(value) { return value >= 1000000 ? (value / 1000000).toFixed(2) + ' km²' : Math.round(value) + ' m²'; }
  function feature(geometry, props, id) { return { type: 'Feature', id: id, properties: props, geometry: geometry }; }

  // Dijkstra over an application-owned, non-negative weighted road graph.
  // The heap avoids scanning every node for each visited intersection.
  function shortestPath(graph, from, to) {
    from = coordinate(from); to = coordinate(to);
    var nodes = graph && graph.nodes, edges = graph && graph.edges;
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 10000 || !Array.isArray(edges) || edges.length !== nodes.length) {
      throw new Error('microMap.measure: graph needs 1–10,000 nodes and one edge list per node');
    }
    function nearest(point) {
      var chosen = 0, best = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var score = distance(point, coordinate(nodes[i]));
        if (score < best) { best = score; chosen = i; }
      }
      return chosen;
    }
    var start = nearest(from), goal = nearest(to);
    var cost = new Float64Array(nodes.length), previous = new Int32Array(nodes.length), heap = [], visitedEdges = 0;
    for (var i = 0; i < cost.length; i++) { cost[i] = Infinity; previous[i] = -1; }
    function push(value) {
      var at = heap.length; heap.push(value);
      while (at) {
        var parent = Math.floor((at - 1) / 2);
        if (heap[parent][0] <= value[0]) break;
        heap[at] = heap[parent]; at = parent;
      }
      heap[at] = value;
    }
    function pop() {
      var first = heap[0], last = heap.pop();
      if (heap.length) {
        var at = 0;
        while (at * 2 + 1 < heap.length) {
          var child = at * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
          if (last[0] <= heap[child][0]) break;
          heap[at] = heap[child]; at = child;
        }
        heap[at] = last;
      }
      return first;
    }
    cost[start] = 0; push([0, start]);
    while (heap.length) {
      var current = pop(), index = current[1];
      if (current[0] !== cost[index]) continue;
      if (index === goal) break;
      if (!Array.isArray(edges[index])) throw new Error('microMap.measure: graph edge lists must be arrays');
      for (var e = 0; e < edges[index].length; e++) {
        if (++visitedEdges > 200000) throw new Error('microMap.measure: graph has too many edges');
        var edge = edges[index][e], next = edge && edge.to;
        if (!Number.isInteger(next) || next < 0 || next >= nodes.length) throw new Error('microMap.measure: graph edge has an invalid destination');
        var weight = edge.cost == null ? distance(coordinate(nodes[index]), coordinate(nodes[next])) : +edge.cost;
        if (!isFinite(weight) || weight < 0) throw new Error('microMap.measure: graph edge cost must be finite and non-negative');
        var candidate = cost[index] + weight;
        if (candidate < cost[next]) { cost[next] = candidate; previous[next] = index; push([candidate, next]); }
      }
    }
    if (!isFinite(cost[goal])) throw new Error('microMap.measure: no connected route in graph');
    var path = [goal], cursor = goal;
    while (cursor !== start) { cursor = previous[cursor]; path.push(cursor); }
    path.reverse();
    return { type: 'LineString', coordinates: [from].concat(path.map(function (index) { return coordinate(nodes[index]); }), [to]) };
  }

  function measure(map, options) {
    if (!map || typeof map.on !== 'function' || typeof map.off !== 'function') throw new Error('microMap.measure: pass a microMap instance');
    if (typeof geoJSON !== 'function') throw new Error('microMap.measure: load microMap.geojson.js first');
    options = options || {};
    var router = options.router || (options.graph && function (from, to) { return shortestPath(options.graph, from, to); });
    if (router != null && typeof router !== 'function') throw new Error('microMap.measure: router must be a function');
    var overlay = options.overlay || geoJSON(map, options.geojson);
    var ownsOverlay = !options.overlay;
    var prefix = options.id || 'measure-' + ++instance;
    if (typeof prefix !== 'string' || !prefix) throw new Error('microMap.measure: id must be a non-empty string');
    var sourceID = prefix + '-data', draftID = prefix + '-draft';
    var layerIDs = [prefix + '-fill', prefix + '-line', prefix + '-label', prefix + '-draft-line', prefix + '-draft-point'];
    var records = [], serial = 0, points = [], tool = null, destroyed = false, activeRequest = null, requestVersion = 0;
    var onChange = typeof options.onChange === 'function' ? options.onChange : null;
    var onError = typeof options.onError === 'function' ? options.onError : null;
    var color = options.color || '#1769e0';
    var empty = { type: 'FeatureCollection', features: [] };
    overlay.addSource(sourceID, { type: 'geojson', data: empty });
    overlay.addSource(draftID, { type: 'geojson', data: empty });
    overlay.addLayer({ id: layerIDs[0], source: sourceID, type: 'fill', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': .16, 'fill-outline-color': color, 'fill-outline-width': 2 } });
    overlay.addLayer({ id: layerIDs[1], source: sourceID, type: 'line', filter: ['==', '$type', 'LineString'], paint: { 'line-color': color, 'line-width': 3 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    overlay.addLayer({ id: layerIDs[2], source: sourceID, type: 'symbol', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-size': 13, 'text-offset': [0, -1.2] }, paint: { 'text-color': color } });
    overlay.addLayer({ id: layerIDs[3], source: draftID, type: 'line', paint: { 'line-color': color, 'line-width': 2, 'line-dasharray': [5, 4] } });
    overlay.addLayer({ id: layerIDs[4], source: draftID, type: 'circle', paint: { 'circle-color': color, 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } });

    function refresh() {
      var output = [];
      records.forEach(function (item) {
        output.push(item.feature);
        output.push(feature({ type: 'Point', coordinates: item.anchor }, { label: item.label }, item.id + '-label'));
      });
      overlay.getSource(sourceID).setData({ type: 'FeatureCollection', features: output });
    }
    function draft() {
      var output = [];
      if (points.length > 1) output.push(feature({ type: 'LineString', coordinates: points }, {}, prefix + '-draft-line'));
      points.forEach(function (point, index) { output.push(feature({ type: 'Point', coordinates: point }, {}, prefix + '-draft-' + index)); });
      overlay.getSource(draftID).setData({ type: 'FeatureCollection', features: output });
    }
    function add(type, geometry, anchor, result, label) {
      if (destroyed) return null;
      if (records.length >= 1000) throw new Error('microMap.measure: maximum of 1,000 measurements');
      var id = prefix + '-' + ++serial;
      var item = { id: id, type: type, feature: feature(geometry, { measureKind: type }, id), anchor: anchor, label: label, result: result };
      records.push(item);
      try {
        var source = overlay.getSource(sourceID);
        if (typeof source.updateData === 'function') {
          source.updateData({ add: [item.feature, feature({ type: 'Point', coordinates: item.anchor }, { label: item.label }, item.id + '-label')] });
        } else refresh();
      } catch (error) { records.pop(); throw error; }
      if (onChange) onChange(api.getMeasurements());
      return clone({ id: id, type: type, geometry: geometry, label: label, ...result });
    }
    function line(a, b) {
      a = coordinate(a); b = coordinate(b);
      var length = distance(a, b), path = greatCircle(a, b);
      return add('line', { type: 'LineString', coordinates: path }, path[Math.floor(path.length / 2)], { distanceMeters: length }, labelMeters(length));
    }
    function circle(center, radiusMeters) {
      center = coordinate(center); radiusMeters = +radiusMeters;
      if (!isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 10000000) throw new Error('microMap.measure: circle radius must be greater than 0 and at most 10,000 km');
      var ring = circleRing(center, radiusMeters), angular = radiusMeters / R;
      var result = { radiusMeters: radiusMeters, circumferenceMeters: 2 * Math.PI * R * Math.sin(angular), areaM2: 2 * Math.PI * R * R * (1 - Math.cos(angular)) };
      return add('circle', { type: 'Polygon', coordinates: [ring] }, center, result, labelMeters(radiusMeters) + ' radius');
    }
    function polygon(vertices) {
      if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 10000) throw new Error('microMap.measure: polygon needs 3–10,000 positions');
      var ring = vertices.map(coordinate);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0].slice());
      if (ring.length < 4) throw new Error('microMap.measure: polygon needs three distinct positions');
      var result = { perimeterMeters: pathLength(ring), areaM2: area(ring) };
      return add('polygon', { type: 'Polygon', coordinates: [ring] }, ring[0], result, labelArea(result.areaM2));
    }
    function route(a, b) {
      if (destroyed) return Promise.resolve(null);
      if (typeof router !== 'function') return Promise.reject(new Error('microMap.measure: shortest route needs options.router or options.graph'));
      a = coordinate(a); b = coordinate(b);
      if (activeRequest) activeRequest.abort();
      var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      activeRequest = controller;
      var version = ++requestVersion;
      return Promise.resolve().then(function () {
        if (destroyed || version !== requestVersion) return null;
        return router(a.slice(), b.slice(), { signal: controller && controller.signal });
      }).then(function (response) {
        if (destroyed || version !== requestVersion) return null;
        var geometry = response && response.type === 'Feature' ? response.geometry : response && response.geometry || response;
        var coords = Array.isArray(geometry) ? geometry : geometry && geometry.type === 'LineString' && geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2 || coords.length > 100000) throw new Error('microMap.measure: router must return a LineString, Feature or coordinate array with 2–100,000 positions');
        coords = coords.map(coordinate);
        activeRequest = null;
        var length = pathLength(coords);
        return add('route', { type: 'LineString', coordinates: coords }, coords[Math.floor(coords.length / 2)], { distanceMeters: length }, labelMeters(length));
      }).catch(function (error) {
        if (version === requestVersion) activeRequest = null;
        throw error;
      });
    }
    function cancel() {
      requestVersion++;
      if (activeRequest) activeRequest.abort();
      activeRequest = null;
      points = [];
      if (!destroyed) draft();
      return api;
    }
    function setTool(value) {
      if (destroyed) return api;
      if (value != null && value !== 'line' && value !== 'circle' && value !== 'polygon' && value !== 'route') throw new Error('microMap.measure: tool must be line, circle, polygon, route or null');
      if (value === 'route' && typeof router !== 'function') throw new Error('microMap.measure: route tool needs options.router');
      cancel(); tool = value;
      return api;
    }
    function finish() {
      if (tool !== 'polygon' || points.length < 3) return null;
      var result = polygon(points);
      cancel();
      return result;
    }
    function onClick(event) {
      if (!tool || destroyed || !event || !event.lonLat) return;
      points.push(coordinate(event.lonLat));
      if (tool === 'polygon' || points.length === 1) { draft(); return; }
      var a = points[0], b = points[1], selected = tool;
      cancel();
      try {
        if (selected === 'line') line(a, b);
        else if (selected === 'circle') circle(a, distance(a, b));
        else route(a, b).catch(function (error) { if (onError && error.name !== 'AbortError') onError(error); });
      } catch (error) { if (onError) onError(error); else throw error; }
    }
    function clear() {
      cancel();
      var previous = records;
      records = [];
      if (!destroyed) {
        try { refresh(); } catch (error) { records = previous; throw error; }
        if (onChange) onChange(api.getMeasurements());
      }
      return api;
    }
    function destroy() {
      if (destroyed) return;
      cancel();
      map.off('click', onClick).off('destroy', destroy);
      for (var i = layerIDs.length - 1; i >= 0; i--) overlay.removeLayer(layerIDs[i]);
      overlay.removeSource(draftID).removeSource(sourceID);
      if (ownsOverlay) overlay.destroy();
      records = [];
      destroyed = true;
    }
    var api = {
      line: line, circle: circle, polygon: polygon, route: route,
      shortestPath: shortestPath,
      setTool: setTool, getTool: function () { return tool; }, finish: finish, cancel: cancel, clear: clear,
      getMeasurements: function () { return clone(records.map(function (item) { return { id: item.id, type: item.type, label: item.label, geometry: item.feature.geometry, ...item.result }; })); },
      getData: function () { return { type: 'FeatureCollection', features: clone(records.map(function (item) { return item.feature; })) }; },
      getOverlay: function () { return overlay; }, destroy: destroy
    };
    map.on('click', onClick).on('destroy', destroy);
    return api;
  }
  measure.shortestPath = shortestPath;
  if (typeof microMap === 'function' && !microMap.measure) microMap.measure = measure;
  return measure;
});
