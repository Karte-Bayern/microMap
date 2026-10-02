/*! microMap.field.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'), require('./microMap.geojson.js'));
  else root.microMapField = factory(root, root.microMap, root.microMapGeoJSON);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, geoJSON) {
  'use strict';

  var nextInstance = 0;
  function collection(features) { return { type: 'FeatureCollection', features: features }; }
  function coordinate(value) {
    if (!Array.isArray(value) || value.length < 2 || !isFinite(+value[0]) || !isFinite(+value[1])) {
      throw new Error('microMap.field: expected [longitude, latitude]');
    }
    return [+value[0], +value[1]];
  }
  function properties(value, defaultColor) {
    if (value == null) value = {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('microMap.field: properties must be an object');
    var copy = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) {
      Object.defineProperty(copy, key, { value: value[key], enumerable: true, configurable: true, writable: true });
    }
    if (copy.color == null) copy.color = defaultColor;
    return copy;
  }

  // Field annotations are an opt-in surface. The application owns storage,
  // domain records and synchronization; this module only draws local data.
  function fieldMap(map, options) {
    if (!map || typeof map.on !== 'function' || typeof map.off !== 'function') throw new Error('microMap.field: pass a microMap instance');
    if (typeof geoJSON !== 'function') throw new Error('microMap.field: load microMap.geojson.js first');
    options = options || {};
    var historyLimit = options.historyLimit == null ? 20 : Number(options.historyLimit);
    if (!isFinite(historyLimit) || historyLimit < 0 || historyLimit > 100 || Math.floor(historyLimit) !== historyLimit) {
      throw new Error('microMap.field: historyLimit must be an integer from 0 to 100');
    }
    var logLimit = options.logLimit == null ? 20 : Number(options.logLimit);
    if (!isFinite(logLimit) || logLimit < 0 || logLimit > 100 || Math.floor(logLimit) !== logLimit) {
      throw new Error('microMap.field: logLimit must be an integer from 0 to 100');
    }
    var overlay = options.overlay || geoJSON(map, options.geojson);
    var ownsOverlay = !options.overlay;
    var prefix = options.id || 'field-' + ++nextInstance;
    if (typeof prefix !== 'string' || !prefix) throw new Error('microMap.field: id must be a non-empty string');
    var sourceID = prefix + '-data';
    var draftID = prefix + '-draft';
    var layerIDs = [prefix + '-areas', prefix + '-lines', prefix + '-points', prefix + '-labels', prefix + '-draft-line', prefix + '-draft-points'];
    var features = [];
    var vertices = [];
    var mode = null;
    var current = {};
    var serial = 0;
    var destroyed = false;
    var onChange = typeof options.onChange === 'function' ? options.onChange : null;
    var undoStack = [];
    var redoStack = [];
    var logStart = collection([]);
    var logSteps = [];

    overlay.addSource(sourceID, { type: 'geojson', data: collection([]) });
    overlay.addSource(draftID, { type: 'geojson', data: collection([]) });
    overlay.addLayer({ id: layerIDs[0], source: sourceID, type: 'fill', filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#1769e0'], 'fill-opacity': 0.2,
        'fill-outline-color': ['coalesce', ['get', 'color'], '#1769e0'], 'fill-outline-width': 2 } });
    overlay.addLayer({ id: layerIDs[1], source: sourceID, type: 'line', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': ['coalesce', ['get', 'color'], '#1769e0'], 'line-width': 4 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    overlay.addLayer({ id: layerIDs[2], source: sourceID, type: 'circle', filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': ['coalesce', ['get', 'color'], '#1769e0'], 'circle-radius': 7,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    overlay.addLayer({ id: layerIDs[3], source: sourceID, type: 'symbol', filter: ['has', 'label'],
      layout: { 'text-field': ['get', 'label'], 'text-size': 13, 'text-offset': [0, -1.6] },
      paint: { 'text-color': '#17202a' } });
    overlay.addLayer({ id: layerIDs[4], source: draftID, type: 'line',
      paint: { 'line-color': '#1769e0', 'line-width': 3, 'line-dasharray': [5, 4] } });
    overlay.addLayer({ id: layerIDs[5], source: draftID, type: 'circle',
      paint: { 'circle-color': '#1769e0', 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } });

    function data() { return overlay.getSource(sourceID); }
    function nextID() {
      var id;
      do { id = prefix + '-' + ++serial; }
      while (features.some(function (feature) { return feature.id === id; }));
      return id;
    }
    function changed() {
      if (onChange) onChange(data().getData());
    }
    function remember(previous) {
      if (historyLimit) {
        undoStack.push(previous);
        if (undoStack.length > historyLimit) undoStack.shift();
      }
      redoStack = [];
    }
    function record(operation) {
      if (!logLimit) return;
      logSteps.push({ operation: operation, data: data().getData() });
      if (logSteps.length > logLimit) logStart = logSteps.shift().data;
    }
    function replace(value, operation) {
      var previous = data().getData();
      data().setData(value);
      features = data().getData().features;
      remember(previous);
      record(operation);
      changed();
    }
    function commit(geometry, props) {
      if (destroyed) return null;
      var feature = { type: 'Feature', id: nextID(), properties: properties(props, '#1769e0'), geometry: geometry };
      replace(collection(features.concat([feature])), 'add');
      return features[features.length - 1].id;
    }
    function updateDraft() {
      var preview = [];
      if (vertices.length > 1) preview.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: vertices } });
      for (var i = 0; i < vertices.length; i++) preview.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: vertices[i] } });
      overlay.getSource(draftID).setData(collection(preview));
    }
    function addPoint(position, props) { return commit({ type: 'Point', coordinates: coordinate(position) }, props); }
    function addLine(positions, props) {
      if (!Array.isArray(positions) || positions.length < 2) throw new Error('microMap.field: line needs two positions');
      return commit({ type: 'LineString', coordinates: positions.map(coordinate) }, props);
    }
    function addArea(positions, props) {
      if (!Array.isArray(positions) || positions.length < 3) throw new Error('microMap.field: area needs three positions');
      var ring = positions.map(coordinate);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0].slice());
      return commit({ type: 'Polygon', coordinates: [ring] }, props);
    }
    function setData(value) {
      if (destroyed) return api;
      var previous = data().getData();
      // Let the GeoJSON module validate/copy before replacing our snapshot.
      data().setData(value);
      features = data().getData().features;
      var used = Object.create(null);
      var repaired = false;
      for (var i = 0; i < features.length; i++) {
        var id = features[i].id;
        if (id == null || used[String(id)]) { features[i].id = nextID(); repaired = true; }
        used[String(features[i].id)] = true;
      }
      if (repaired) data().setData(collection(features));
      features = data().getData().features;
      remember(previous);
      record('setData');
      changed();
      return api;
    }
    function update(id, patch) {
      if (destroyed) return false;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('microMap.field: update needs a patch object');
      if (!Object.prototype.hasOwnProperty.call(patch, 'geometry') && !Object.prototype.hasOwnProperty.call(patch, 'properties')) return false;
      if (!features.some(function (feature) { return feature.id === id; })) return false;
      var change = { id: id };
      if (Object.prototype.hasOwnProperty.call(patch, 'geometry')) change.newGeometry = patch.geometry;
      if (Object.prototype.hasOwnProperty.call(patch, 'properties')) {
        if (!patch.properties || typeof patch.properties !== 'object' || Array.isArray(patch.properties)) {
          throw new Error('microMap.field: updated properties must be an object');
        }
        change.addOrUpdateProperties = [];
        for (var key in patch.properties) if (Object.prototype.hasOwnProperty.call(patch.properties, key)) {
          change.addOrUpdateProperties.push({ key: key, value: patch.properties[key] });
        }
      }
      var previous = data().getData();
      data().updateData({ update: [change] });
      features = data().getData().features;
      remember(previous);
      record('update');
      changed();
      return true;
    }
    function remove(id) {
      if (destroyed) return false;
      var next = features.filter(function (feature) { return feature.id !== id; });
      if (next.length === features.length) return false;
      replace(collection(next), 'remove');
      return true;
    }
    function clear() {
      if (destroyed) return api;
      cancel();
      if (features.length) replace(collection([]), 'clear');
      return api;
    }
    function undo() {
      if (destroyed || !undoStack.length) return false;
      var previous = undoStack.pop();
      var current = data().getData();
      data().setData(previous);
      features = data().getData().features;
      redoStack.push(current);
      record('undo');
      changed();
      return true;
    }
    function redo() {
      if (destroyed || !redoStack.length) return false;
      var next = redoStack.pop();
      var current = data().getData();
      data().setData(next);
      features = data().getData().features;
      if (historyLimit) undoStack.push(current);
      record('redo');
      changed();
      return true;
    }
    function setTool(tool, props) {
      if (destroyed) return api;
      if (tool != null && tool !== 'point' && tool !== 'line' && tool !== 'area') throw new Error('microMap.field: tool must be point, line, area or null');
      cancel();
      mode = tool;
      current = properties(props, '#1769e0');
      return api;
    }
    function finish() {
      if (destroyed || (mode !== 'line' && mode !== 'area')) return null;
      if (vertices.length < (mode === 'line' ? 2 : 3)) return null;
      var id = mode === 'line' ? addLine(vertices, current) : addArea(vertices, current);
      cancel();
      return id;
    }
    function cancel() {
      vertices = [];
      if (!destroyed) updateDraft();
      return api;
    }
    function undoVertex() {
      if (vertices.length) { vertices.pop(); updateDraft(); }
      return api;
    }
    function onClick(event) {
      if (!mode || destroyed || !event || !event.lonLat) return;
      if (mode === 'point') addPoint(event.lonLat, current);
      else { vertices.push(coordinate(event.lonLat)); updateDraft(); }
    }
    function destroy() {
      if (destroyed) return;
      map.off('click', onClick).off('destroy', destroy);
      for (var i = layerIDs.length - 1; i >= 0; i--) overlay.removeLayer(layerIDs[i]);
      overlay.removeSource(draftID).removeSource(sourceID);
      if (ownsOverlay) overlay.destroy();
      destroyed = true;
      features = [];
      vertices = [];
      undoStack = [];
      redoStack = [];
      logSteps = [];
      logStart = collection([]);
    }

    var api = {
      addPoint: addPoint, addLine: addLine, addArea: addArea,
      setData: setData, getData: function () { return destroyed ? collection([]) : data().getData(); },
      update: update, remove: remove, clear: clear, setTool: setTool, getTool: function () { return mode; },
      undo: undo, redo: redo,
      getEditLog: function () {
        return JSON.parse(JSON.stringify({ version: 1, initial: logLimit || destroyed ? logStart : data().getData(), steps: logSteps }));
      },
      canUndo: function () { return !destroyed && undoStack.length > 0; },
      canRedo: function () { return !destroyed && redoStack.length > 0; },
      finish: finish, cancel: cancel, undoVertex: undoVertex,
      getBounds: function () { return destroyed ? null : overlay.getBounds(sourceID); },
      queryRenderedFeatures: function (point, queryOptions) {
        if (destroyed) return [];
        queryOptions = queryOptions || {};
        return overlay.queryRenderedFeatures(point, { layers: layerIDs.slice(0, 4), radius: queryOptions.radius });
      },
      getOverlay: function () { return overlay; }, destroy: destroy
    };
    map.on('click', onClick).on('destroy', destroy);
    return api;
  }

  if (typeof microMap === 'function' && !microMap.field) microMap.field = fieldMap;
  return fieldMap;
});
