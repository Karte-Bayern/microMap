/*! microMap.network.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapNetwork = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var R = 6371008.8;
  var RAD = Math.PI / 180;
  function fail(message) { throw new Error('microMap.network: ' + message); }
  function point(value, name) {
    var x = Array.isArray(value) ? +value[0] : value && +value.lng;
    var y = Array.isArray(value) ? +value[1] : value && +value.lat;
    if (!isFinite(x) || !isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) fail(name + ' must be a WGS84 [longitude, latitude] pair');
    return [x, y];
  }
  function distance(a, b) {
    var lat1 = a[1] * RAD, lat2 = b[1] * RAD;
    var dlat = (b[1] - a[1]) * RAD, dlon = (b[0] - a[0]) * RAD;
    var h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function copy(value, depth, ancestors) {
    depth = depth || 0;
    ancestors = ancestors || [];
    if (depth > 16) fail('graph values are nested too deeply');
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!isFinite(value)) fail('graph values must be finite'); return value; }
    if (Array.isArray(value)) {
      if (ancestors.indexOf(value) >= 0) fail('graph values must not contain cycles');
      ancestors.push(value);
      var array = value.map(function (item) { return copy(item, depth + 1, ancestors); });
      ancestors.pop();
      return array;
    }
    if (typeof value !== 'object') fail('graph values must be JSON-compatible');
    var prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('graph values must be JSON-compatible');
    if (ancestors.indexOf(value) >= 0) fail('graph values must not contain cycles');
    ancestors.push(value);
    var result = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) Object.defineProperty(result, key, {
      value: copy(value[key], depth + 1, ancestors), enumerable: true, configurable: true, writable: true
    });
    ancestors.pop();
    return result;
  }

  // Generic weighted network routing. Coordinates are WGS84 [longitude,
  // latitude], but edge weights and mode/access rules belong to the caller.
  function network(input, options) {
    if (typeof microMap !== 'function') fail('load microMap.js first');
    options = options || {};
    var rawNodes = input && input.nodes;
    var rawEdges = input && input.edges;
    if (!Array.isArray(rawNodes) || !rawNodes.length || rawNodes.length > 100000) fail('graph needs 1–100,000 nodes');
    if (!Array.isArray(rawEdges) || rawEdges.length > 500000) fail('graph needs up to 500,000 edges');
    var nodes = [];
    var byId = new Map();
    var edges = [];
    var edgeById = new Map();
    var adjacency = [];
    var defaultSpeed = Math.max(0.1, +options.defaultSpeedKph || 30);

    rawNodes.forEach(function (value, index) {
      if (!value || typeof value !== 'object') fail('nodes must be objects');
      var id = value.id == null ? String(index) : String(value.id);
      if (!id || byId.has(id)) fail('node ids must be unique');
      var item = { id: id, coordinates: point(value.coordinates || value.position, 'node ' + id), properties: copy(value.properties || {}) };
      byId.set(id, index);
      nodes.push(item);
      adjacency.push([]);
    });

    rawEdges.forEach(function (value, index) {
      if (!value || typeof value !== 'object') fail('edges must be objects');
      var id = value.id == null ? 'edge-' + index : String(value.id);
      var fromId = String(value.from), toId = String(value.to);
      var from = byId.get(fromId), to = byId.get(toId);
      if (!edgeById.has(id) && id) edgeById.set(id, []); else fail('edge ids must be unique');
      if (from == null || to == null || from === to) fail('edge ' + id + ' needs two different existing node ids');
      var shape = value.coordinates == null ? [nodes[from].coordinates, nodes[to].coordinates] : value.coordinates.map(function (coordinate) { return point(coordinate, 'edge coordinates'); });
      if (shape.length < 2) fail('edge geometry needs at least two coordinates');
      var length = value.distance == null ? 0 : +value.distance;
      if (length < 0 || !isFinite(length)) fail('edge distance must be finite and non-negative');
      if (!length) for (var p = 1; p < shape.length; p++) length += distance(shape[p - 1], shape[p]);
      var edge = {
        id: id, from: from, to: to, fromId: fromId, toId: toId, coordinates: shape,
        distance: length, cost: value.cost == null ? null : +value.cost,
        time: value.time == null ? null : +value.time,
        speedKph: value.speedKph == null ? null : +value.speedKph,
        modes: Array.isArray(value.modes) ? value.modes.map(String) : null,
        oneWay: value.oneWay === true,
        closed: !!value.closed || !!(value.properties && value.properties.closed), properties: copy(value.properties || {})
      };
      if (edge.cost != null && (!isFinite(edge.cost) || edge.cost < 0)) fail('edge cost must be finite and non-negative');
      if (edge.time != null && (!isFinite(edge.time) || edge.time < 0)) fail('edge time must be finite and non-negative');
      if (edge.speedKph != null && (!isFinite(edge.speedKph) || edge.speedKph <= 0)) fail('edge speedKph must be positive');
      var edgeIndex = edges.length;
      edges.push(edge);
      edgeById.get(id).push(edgeIndex);
      adjacency[from].push({ edge: edgeIndex, to: to, reverse: false });
      if (value.oneWay !== true) adjacency[to].push({ edge: edgeIndex, to: from, reverse: true });
    });

    function nearest(coordinates) {
      var target = point(coordinates, 'coordinate');
      var best = Infinity, index = -1;
      for (var i = 0; i < nodes.length; i++) {
        var next = distance(target, nodes[i].coordinates);
        if (next < best) { best = next; index = i; }
      }
      return { index: index, distance: best };
    }
    function nodeIndex(value) {
      if ((typeof value === 'string' || typeof value === 'number') && byId.has(String(value))) return { index: byId.get(String(value)), distance: 0 };
      if (value && typeof value === 'object' && value.id != null && byId.has(String(value.id))) return { index: byId.get(String(value.id)), distance: 0 };
      return nearest(value);
    }
    function edgeCost(edge, from, to, settings) {
      if (edge.closed || settings.mode && edge.modes && edge.modes.indexOf(settings.mode) < 0) return Infinity;
      if (typeof settings.cost === 'function') {
        var custom = +settings.cost({
          id: edge.id, from: nodes[from].id, to: nodes[to].id,
          distance: edge.distance, cost: edge.cost, time: edge.time,
          speedKph: edge.speedKph, modes: edge.modes && edge.modes.slice(),
          properties: copy(edge.properties)
        }, nodes[from].id, nodes[to].id);
        return isFinite(custom) && custom >= 0 ? custom : Infinity;
      }
      if (settings.cost === 'time') return edge.time != null ? edge.time : edge.distance / ((edge.speedKph || defaultSpeed) * 1000 / 3600);
      if (settings.cost === 'distance') return edge.distance;
      return edge.cost == null ? edge.distance : edge.cost;
    }
    function run(origin, settings, destination) {
      settings = settings || {};
      var start = nodeIndex(origin);
      var goal = destination == null ? -1 : nodeIndex(destination).index;
      var maxCost = settings.maxCost == null ? Infinity : +settings.maxCost;
      if (maxCost < 0 || !isFinite(maxCost) && maxCost !== Infinity) fail('maxCost must be non-negative');
      var costs = new Float64Array(nodes.length);
      var previous = new Int32Array(nodes.length);
      var previousEdge = new Int32Array(nodes.length);
      var previousReverse = new Uint8Array(nodes.length);
      for (var i = 0; i < nodes.length; i++) { costs[i] = Infinity; previous[i] = -1; previousEdge[i] = -1; }
      var heap = [];
      function push(cost, index) {
        var value = [cost, index], at = heap.length;
        heap.push(value);
        while (at) { var parent = (at - 1) >> 1; if (heap[parent][0] <= cost) break; heap[at] = heap[parent]; at = parent; }
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
      costs[start.index] = 0;
      push(0, start.index);
      while (heap.length) {
        var current = pop(), atNode = current[1];
        if (current[0] !== costs[atNode]) continue;
        if (current[0] > maxCost || atNode === goal) break;
        var links = adjacency[atNode];
        for (var e = 0; e < links.length; e++) {
          var link = links[e], nextEdge = edges[link.edge];
          var increment = edgeCost(nextEdge, atNode, link.to, settings);
          var candidate = current[0] + increment;
          if (!isFinite(candidate) || candidate > maxCost || candidate >= costs[link.to]) continue;
          costs[link.to] = candidate;
          previous[link.to] = atNode;
          previousEdge[link.to] = link.edge;
          previousReverse[link.to] = link.reverse ? 1 : 0;
          push(candidate, link.to);
        }
      }
      return { start: start, goal: goal, costs: costs, previous: previous, previousEdge: previousEdge, previousReverse: previousReverse };
    }
    function route(from, to, settings) {
      settings = settings || {};
      var result = run(from, settings, to);
      var goal = result.goal;
      if (result.costs[goal] === Infinity) return null;
      var nodePath = [];
      var edgePath = [];
      for (var current = goal; current !== -1; current = result.previous[current]) {
        nodePath.push(current);
        if (current !== result.start.index) edgePath.push({ index: result.previousEdge[current], reverse: !!result.previousReverse[current] });
        if (current === result.start.index) break;
      }
      if (nodePath[nodePath.length - 1] !== result.start.index) return null;
      nodePath.reverse(); edgePath.reverse();
      var coordinates = [];
      var meters = 0;
      var edgeIds = [];
      for (var e = 0; e < edgePath.length; e++) {
        var pathEdge = edges[edgePath[e].index];
        var geometry = pathEdge.coordinates;
        var step = edgePath[e].reverse ? -1 : 1;
        var p = step === 1 ? 0 : geometry.length - 1;
        var last = coordinates[coordinates.length - 1];
        if (last && last[0] === geometry[p][0] && last[1] === geometry[p][1]) p += step;
        // Append once per coordinate; concatenating the accumulated route for
        // every edge makes long routes quadratic. Copy points for caller ownership.
        for (; p >= 0 && p < geometry.length; p += step) coordinates.push(geometry[p].slice());
        meters += pathEdge.distance;
        edgeIds.push(pathEdge.id);
      }
      if (!coordinates.length) coordinates = [nodes[result.start.index].coordinates.slice()];
      return { coordinates: coordinates, distance: meters, cost: result.costs[goal], nodeIds: nodePath.map(function (index) { return nodes[index].id; }), edgeIds: edgeIds, startDistance: result.start.distance };
    }
    function reachable(origin, settings) {
      settings = settings || {};
      if (settings.maxCost == null || !isFinite(+settings.maxCost) || +settings.maxCost < 0) fail('reachable() requires a finite non-negative maxCost');
      var result = run(origin, settings, null);
      var features = [];
      var reached = Object.create(null);
      for (var i = 0; i < nodes.length; i++) if (result.costs[i] <= +settings.maxCost) {
        reached[i] = true;
        features.push({ type: 'Feature', id: 'node-' + nodes[i].id, properties: { nodeId: nodes[i].id, cost: result.costs[i], kind: 'reachable-node' }, geometry: { type: 'Point', coordinates: nodes[i].coordinates.slice() } });
      }
      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var forward = reached[edge.from] && reached[edge.to] && isFinite(edgeCost(edge, edge.from, edge.to, settings));
        var reverse = !edge.oneWay && reached[edge.to] && reached[edge.from] && isFinite(edgeCost(edge, edge.to, edge.from, settings));
        if (forward || reverse) features.push({ type: 'Feature', id: 'edge-' + edge.id, properties: { edgeId: edge.id, kind: 'reachable-edge' }, geometry: { type: 'LineString', coordinates: edge.coordinates.map(function (item) { return item.slice(); }) } });
      }
      return { type: 'FeatureCollection', features: features, nodeIds: Object.keys(reached).map(function (index) { return nodes[+index].id; }), origin: nodes[result.start.index].coordinates.slice(), maxCost: +settings.maxCost };
    }
    function setEdgeState(id, patch) {
      var matches = edgeById.get(String(id));
      if (!matches) fail('unknown edge ' + String(id));
      if (!patch || typeof patch !== 'object') fail('edge state must be an object');
      var nextClosed = patch.closed == null ? null : !!patch.closed;
      var nextCost = patch.cost == null ? null : +patch.cost;
      if (nextCost != null && (!isFinite(nextCost) || nextCost < 0)) fail('edge cost must be finite and non-negative');
      var nextProperties = patch.properties == null ? null : copy(patch.properties);
      matches.forEach(function (index) {
        var edge = edges[index];
        if (nextClosed != null) {
          edge.closed = nextClosed;
          if (Object.prototype.hasOwnProperty.call(edge.properties, 'closed')) edge.properties.closed = nextClosed;
        }
        if (nextCost != null) edge.cost = nextCost;
        if (nextProperties != null) for (var key in nextProperties) edge.properties[key] = nextProperties[key];
      });
      return api;
    }
    function getGraph() {
      return {
        nodes: nodes.map(function (item) { return { id: item.id, coordinates: item.coordinates.slice(), properties: copy(item.properties) }; }),
        edges: edges.map(function (item) { return { id: item.id, from: item.fromId, to: item.toId, coordinates: item.coordinates.map(function (value) { return value.slice(); }), distance: item.distance, cost: item.cost, time: item.time, speedKph: item.speedKph, modes: item.modes && item.modes.slice(), oneWay: item.oneWay, closed: item.closed, properties: copy(item.properties) }; })
      };
    }
    var api = {
      closest: function (value) { var found = nearest(value); var node = nodes[found.index]; return { node: { id: node.id, coordinates: node.coordinates.slice(), properties: copy(node.properties) }, distance: found.distance }; },
      route: route,
      reachable: reachable,
      setEdgeState: setEdgeState,
      getGraph: getGraph,
      getNodeCount: function () { return nodes.length; },
      getEdgeCount: function () { return edges.length; }
    };
    return api;
  }

  if (typeof microMap === 'function' && !microMap.network) microMap.network = network;
  return network;
});
