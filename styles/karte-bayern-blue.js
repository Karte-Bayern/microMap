/*
 * Karte.Bayern blue: a small, declarative MicroMap style profile for the
 * Karte.Bayern vector-tile schema. It deliberately keeps paths and service
 * spurs out of the base map; callers can opt into the outdoor paths layer.
 */
(function (root, factory) {
  var profile = factory();
  if (typeof module === 'object' && module.exports) module.exports = profile;
  else root.microMapKarteBayernBlueStyle = profile;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var round = { 'line-cap': 'round', 'line-join': 'round' };
  var prominentPOI = ['museum', 'theatre', 'cinema', 'hospital', 'pharmacy', 'defibrillator', 'police', 'fire_station', 'railway_station', 'supermarket'];
  var settlements = ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood'];
  var requiredLayers = {
    landuse: ['class'],
    water: [],
    waterway: ['class'],
    building: [],
    transportation: ['class'],
    poi: ['class'],
    housenumber: ['housenumber']
  };
  var lightColors = {
    background: '#f0f4f2', forest: '#c6e2d1', farmland: '#efe6ce', green: '#b8dec8', grass: '#dcebdc', wetland: '#d1e5e4',
    water: '#b0d9eb', waterOutline: '#8bbfd8', river: '#4b9fc8', canal: '#61a9c5', stream: '#77b6ce',
    major: '#fff1d3', majorCasing: '#cba878', connector: '#ffffff', connectorCasing: '#aebdb8',
    local: '#ffffff', localCasing: '#b6c3bd', paths: '#cbb99e',
    building: '#e1e1dc', buildingOutline: '#bfc5be', roof: '#eeeee9', wall: '#abb5af',
    label: '#314853', minorLabel: '#495e64', halo: '#f9fbf9', waterLabel: '#336b88', waterHalo: '#e9f6fb',
    poi: '#487e9e', poiStroke: '#ffffff', houseLabel: '#695c4f'
  };
  var darkColors = {
    background: '#17212b', forest: '#284038', farmland: '#403c31', green: '#315343', grass: '#34483d', wetland: '#29464b',
    water: '#1a4a65', waterOutline: '#377291', river: '#5999be', canal: '#518aa9', stream: '#69a6c5',
    major: '#efbd82', majorCasing: '#614d3f', connector: '#d7d4c6', connectorCasing: '#55575a',
    local: '#8799a3', localCasing: '#394751', paths: '#9b977e',
    building: '#52616a', buildingOutline: '#77848a', roof: '#718087', wall: '#394b54',
    label: '#f0f2ec', minorLabel: '#d4dfdf', halo: '#17212b', waterLabel: '#bbdef3', waterHalo: '#17394d',
    poi: '#86c8e9', poiStroke: '#17212b', houseLabel: '#dfd2bc'
  };
  var contrastColors = {
    background: '#ffffff', forest: '#b5dfba', farmland: '#ffebaf', green: '#8fcf9b', grass: '#d3ebc8', wetland: '#b7dbe0',
    water: '#0871ad', waterOutline: '#003f67', river: '#005387', canal: '#005387', stream: '#005387',
    major: '#ffe055', majorCasing: '#111111', connector: '#ffffff', connectorCasing: '#111111',
    local: '#ffffff', localCasing: '#242424', paths: '#7a531d',
    building: '#d5d5d5', buildingOutline: '#111111', roof: '#eeeeee', wall: '#424242',
    label: '#000000', minorLabel: '#111111', halo: '#ffffff', waterLabel: '#ffffff', waterHalo: '#003f67',
    poi: '#005387', poiStroke: '#ffffff', houseLabel: '#111111'
  };
  var themes = {
    warm: null,
    light: lightColors,
    dark: darkColors,
    night: Object.assign({}, darkColors, {
      background: '#0c1620', forest: '#172e29', farmland: '#302d26', green: '#1b3d32', grass: '#23372e', wetland: '#183a43',
      water: '#103b58', waterOutline: '#286486', major: '#e7ae65', majorCasing: '#54402f',
      connector: '#c5c7bf', connectorCasing: '#454c55', local: '#8f9fa9', localCasing: '#34414c',
      label: '#eef2f2', minorLabel: '#c4d2d8', halo: '#0c1620', waterHalo: '#103b58'
    }),
    contrast: contrastColors
  };

  function applyTheme(layers, theme) {
    var colors = themes[theme];
    if (!colors) return;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var id = layer.id;
      var paint = layer.paint;
      if (id.indexOf('landuse-') === 0) {
        paint.color = colors[id.slice(8)];
        if (theme === 'contrast') paint.opacity = 1;
      } else if (id === 'water') {
        paint.color = colors.water;
        paint.outlineColor = colors.waterOutline;
        paint.opacity = 1;
      } else if (id.indexOf('waterway-') === 0 && id !== 'waterway-labels') {
        paint.color = colors[id.slice(9)];
      } else if (id.indexOf('roads-') === 0) {
        var casing = id.endsWith('-casing');
        var key = id.indexOf('major') >= 0 ? 'major' : id.indexOf('connectors') >= 0 ? 'connector' : 'local';
        paint.color = colors[key + (casing ? 'Casing' : '')];
        if (theme === 'contrast' && casing) paint.width += 0.45;
      } else if (id === 'outdoor-paths') {
        paint.color = colors.paths;
      } else if (id === 'buildings') {
        paint.color = layer.type === 'fill-extrusion' ? colors.wall : colors.building;
        if (layer.type === 'fill-extrusion') paint.roofColor = colors.roof;
        else paint.outlineColor = colors.buildingOutline;
        if (theme === 'contrast') paint.opacity = 1;
      } else if (layer.type === 'symbol') {
        paint['text-color'] = id === 'waterway-labels' ? colors.waterLabel : id === 'housenumber-labels' ? colors.houseLabel :
          id.indexOf('poi-') === 0 ? colors.minorLabel : colors.label;
        paint['text-halo-color'] = id === 'waterway-labels' ? colors.waterHalo : colors.halo;
        if (theme === 'contrast') paint['text-halo-width'] += 0.35;
      } else if (id.indexOf('poi-circle') === 0) {
        paint.color = colors.poi;
        paint.strokeColor = colors.poiStroke;
        if (theme === 'contrast') paint.opacity = 1;
      }
    }
  }

  // Keep the source contract beside the style rather than buried in a demo.
  // It is intentionally metadata-only: the server remains free to add layers
  // such as district boundaries without breaking a compatible base map.
  function validateTileJSON(tileJSON) {
    var errors = [];
    var warnings = [];
    if (!tileJSON || typeof tileJSON !== 'object' || Array.isArray(tileJSON)) {
      return { valid: false, errors: ['TileJSON must be an object.'], warnings: warnings };
    }
    var format = String(tileJSON.format || '').toLowerCase();
    if (format !== 'mvt' && format !== 'pbf') errors.push('TileJSON format must be mvt or pbf.');
    if (tileJSON.scheme && String(tileJSON.scheme).toLowerCase() !== 'xyz') errors.push('TileJSON scheme must be xyz.');
    var tiles = tileJSON.tiles;
    var template = Array.isArray(tiles) && typeof tiles[0] === 'string' &&
      tiles[0].indexOf('{z}') >= 0 && tiles[0].indexOf('{x}') >= 0 && tiles[0].indexOf('{y}') >= 0;
    if (!template) errors.push('TileJSON needs an XYZ tile template.');
    var minZoom = Number(tileJSON.minzoom);
    var maxZoom = Number(tileJSON.maxzoom);
    if (!isFinite(minZoom) || !isFinite(maxZoom) || minZoom < 0 || maxZoom < minZoom) {
      errors.push('TileJSON needs a valid minzoom/maxzoom range.');
    }
    var bounds = tileJSON.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !isFinite(+bounds[0]) || !isFinite(+bounds[1]) ||
        !isFinite(+bounds[2]) || !isFinite(+bounds[3]) || +bounds[0] < -180 || +bounds[2] > 180 ||
        +bounds[1] < -85.0511287798 || +bounds[3] > 85.0511287798 || +bounds[2] < +bounds[0] || +bounds[3] < +bounds[1]) {
      errors.push('TileJSON needs valid geographic bounds.');
    }
    if (tileJSON['kb:tile_schema_version'] == null) {
      warnings.push('TileJSON does not declare kb:tile_schema_version.');
    // Versions 2/3 add POI metadata and classes without removing the v1
    // source layers or fields used by this intentionally small profile.
    } else if (!/^[123]$/.test(String(tileJSON['kb:tile_schema_version']))) {
      errors.push('Unsupported Karte.Bayern tile schema version: ' + tileJSON['kb:tile_schema_version'] + '.');
    }
    var declared = Object.create(null);
    var i;
    if (Array.isArray(tileJSON.vector_layers)) for (i = 0; i < tileJSON.vector_layers.length; i++) {
      var layer = tileJSON.vector_layers[i];
      if (layer && typeof layer.id === 'string') declared[layer.id] = layer.fields || {};
    }
    for (var name in requiredLayers) {
      if (!declared[name]) {
        errors.push('Missing required vector layer: ' + name + '.');
        continue;
      }
      for (var field = 0; field < requiredLayers[name].length; field++) {
        if (!Object.prototype.hasOwnProperty.call(declared[name], requiredLayers[name][field])) {
          errors.push('Layer ' + name + ' is missing field: ' + requiredLayers[name][field] + '.');
        }
      }
    }
    return { valid: !errors.length, errors: errors, warnings: warnings };
  }

  function line(id, minzoom, maxzoom, classes, color, width) {
    var layer = {
      id: id,
      sourceLayer: 'transportation',
      type: 'line',
      minzoom: minzoom,
      filter: ['in', 'class'].concat(classes),
      paint: { color: color, width: width },
      layout: round
    };
    if (maxzoom != null) layer.maxzoom = maxzoom;
    return layer;
  }

  function roadBand(layers, id, minzoom, maxzoom, classes, casingWidth, fillWidth, fillColor, casingColor) {
    layers.push(line(id + '-casing', minzoom, maxzoom, classes, casingColor || '#c9c6bd', casingWidth));
    layers.push(line(id, minzoom, maxzoom, classes, fillColor, fillWidth));
  }

  // Return fresh style descriptors so callers may safely modify a profile
  // locally (for example, to change colours for a branded product map).
  function karteBayernBlueStyle(options) {
    options = options || {};
    var theme = Object.prototype.hasOwnProperty.call(themes, options.theme) ? options.theme : 'warm';
    var layers = [
      {
        id: 'landuse-forest', sourceLayer: 'landuse', type: 'fill', minzoom: 10,
        filter: ['in', 'class', 'forest', 'wood'], paint: { color: '#d1e4d0', opacity: 0.92 }
      },
      {
        id: 'landuse-farmland', sourceLayer: 'landuse', type: 'fill', minzoom: 10,
        filter: ['in', 'class', 'farmland', 'orchard', 'vineyard'], paint: { color: '#f0e8cf', opacity: 0.82 }
      },
      {
        id: 'landuse-green', sourceLayer: 'landuse', type: 'fill', minzoom: 12,
        filter: ['in', 'class', 'park', 'garden'], paint: { color: '#cde5d0', opacity: 0.9 }
      },
      {
        id: 'landuse-grass', sourceLayer: 'landuse', type: 'fill', minzoom: 12,
        filter: ['in', 'class', 'meadow', 'grass'], paint: { color: '#e3ecd8', opacity: 0.72 }
      },
      {
        id: 'landuse-wetland', sourceLayer: 'landuse', type: 'fill', minzoom: 12,
        filter: ['in', 'class', 'wetland', 'scrub', 'heath'], paint: { color: '#dbe8de', opacity: 0.78 }
      },
      {
        id: 'water', sourceLayer: 'water', type: 'fill',
        paint: { color: '#b8d9ef', opacity: 0.96, outlineColor: '#94c3e3', outlineWidth: 0.65 }
      },
      {
        id: 'waterway-river', sourceLayer: 'waterway', type: 'line', minzoom: 9,
        filter: ['in', 'class', 'river'], paint: { color: '#5aaae8', width: 3.4 }, layout: round
      },
      {
        id: 'waterway-canal', sourceLayer: 'waterway', type: 'line', minzoom: 12,
        filter: ['in', 'class', 'canal'], paint: { color: '#6ab5d8', width: 2.1 }, layout: round
      },
      {
        id: 'waterway-stream', sourceLayer: 'waterway', type: 'line', minzoom: 14,
        filter: ['in', 'class', 'stream', 'drain'], paint: { color: '#7abfe8', width: 1.15 }, layout: round
      },
    ];

    // The overview's sweet spot: a connected road network without local
    // pedestrian geometry. Wider bands approximate the source style's zoom
    // interpolation while preserving pre-feature-loop min/max zoom culling.
    roadBand(layers, 'roads-major-low', 6, 9, ['motorway', 'trunk', 'primary'], 2.4, 1.2, '#fff5df', '#d8c3a5');
    roadBand(layers, 'roads-major-mid', 9, 12, ['motorway', 'trunk', 'primary'], 3.5, 2.0, '#fff5df', '#d8c3a5');
    roadBand(layers, 'roads-major-detail', 12, null, ['motorway', 'trunk', 'primary'], 5.2, 3.4, '#fff5df', '#d8c3a5');
    roadBand(layers, 'roads-connectors-mid', 10, 13, ['secondary', 'tertiary'], 2.4, 1.15, '#ffffff');
    roadBand(layers, 'roads-connectors-detail', 13, null, ['secondary', 'tertiary'], 3.7, 2.25, '#ffffff');
    roadBand(layers, 'roads-local', 13, 16, ['residential', 'unclassified', 'minor', 'living_street', 'service'], 2.0, 1.0, '#ffffff');
    roadBand(layers, 'roads-local-detail', 16, null, ['residential', 'unclassified', 'minor', 'living_street', 'service'], 3.0, 1.7, '#ffffff');

    if (options.showOutdoorPaths === true) {
      layers.push(line('outdoor-paths', 16, null, ['path', 'footway', 'cycleway', 'bridleway', 'steps', 'track'], '#e7ddcc', 1.15));
    }

    // Draw roads on the ground and roofs above them, then put labels on top.
    if (options.buildings !== false) {
      layers.push(options.extrudeBuildings === true ? {
        id: 'buildings', sourceLayer: 'building', type: 'fill-extrusion', minzoom: 13,
        paint: {
          color: '#b5b0a9', roofColor: '#e7e4df', opacity: 0.88,
          height: ['case', ['>', ['get', 'height'], 0], ['get', 'height'], Math.max(3, Math.min(40, Number(options.buildingHeight) || 10))]
        }
      } : {
        id: 'buildings', sourceLayer: 'building', type: 'fill', minzoom: 13,
        paint: { color: '#e1ded8', opacity: 0.88, outlineColor: '#c8c3bb', outlineWidth: 0.45 }
      });
    }

    layers.push(
      {
        id: 'place-cities', sourceLayer: 'poi', type: 'symbol', minzoom: 5,
        filter: ['in', 'class', 'city', 'town'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 16, 'text-font': '700 "Noto Sans", system-ui, sans-serif' },
        paint: { 'text-color': '#3f4d5a', 'text-halo-color': '#fffdf9', 'text-halo-width': 2.2 }, priority: 10
      },
      {
        id: 'place-villages', sourceLayer: 'poi', type: 'symbol', minzoom: 10,
        filter: ['in', 'class', 'village'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 13, 'text-font': '700 "Noto Sans", system-ui, sans-serif' },
        paint: { 'text-color': '#3f4d5a', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.8 }, priority: 8
      },
      {
        id: 'place-local', sourceLayer: 'poi', type: 'symbol', minzoom: 14,
        filter: ['in', 'class', 'hamlet', 'suburb', 'neighbourhood'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': '600 "Noto Sans", system-ui, sans-serif' },
        paint: { 'text-color': '#3f4d5a', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.5 }, priority: 6
      },
      {
        id: 'waterway-labels', sourceLayer: 'waterway', type: 'symbol', minzoom: 14,
        filter: ['has', 'name'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': '400 "Noto Sans", system-ui, sans-serif', 'symbol-placement': 'line' },
        paint: { 'text-color': '#4b76a6', 'text-halo-color': '#f8fbff', 'text-halo-width': 1.5 }, priority: 7
      },
      {
        id: 'road-labels-major', sourceLayer: 'transportation', type: 'symbol', minzoom: 11,
        filter: ['in', 'class', 'motorway', 'trunk', 'primary'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-font': '700 "Noto Sans", system-ui, sans-serif', 'symbol-placement': 'line' },
        paint: { 'text-color': '#3f4d5a', 'text-halo-color': '#fffdf9', 'text-halo-width': 2 }, priority: 7
      },
      {
        id: 'road-labels-local', sourceLayer: 'transportation', type: 'symbol', minzoom: 15,
        filter: ['in', 'class', 'secondary', 'tertiary', 'residential', 'unclassified'],
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': '600 "Noto Sans", system-ui, sans-serif', 'symbol-placement': 'line' },
        paint: { 'text-color': '#3f4d5a', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.6 }, priority: 4
      },
      {
        id: 'poi-circle', sourceLayer: 'poi', type: 'circle', minzoom: 15,
        filter: ['in', 'class'].concat(prominentPOI),
        paint: { color: '#527fae', radius: 2.7, strokeColor: '#ffffff', strokeWidth: 1, opacity: 0.82 }
      },
      {
        id: 'poi-labels', sourceLayer: 'poi', type: 'symbol', minzoom: 16,
        filter: ['in', 'class'].concat(prominentPOI),
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': '400 "Noto Sans", system-ui, sans-serif', 'text-offset': [0, 0.75], 'text-anchor': 'top' },
        paint: { 'text-color': '#44505a', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.5 }, priority: 3
      },
      {
        id: 'poi-circle-detail', sourceLayer: 'poi', type: 'circle', minzoom: 17,
        filter: ['!in', 'class'].concat(settlements, prominentPOI),
        paint: { color: '#7e98aa', radius: 2, strokeColor: '#ffffff', strokeWidth: 0.7, opacity: 0.7 }
      },
      {
        id: 'poi-labels-detail', sourceLayer: 'poi', type: 'symbol', minzoom: 18,
        filter: ['!in', 'class'].concat(settlements, prominentPOI),
        layout: { 'text-field': ['get', 'name'], 'text-size': 10.5, 'text-font': '400 "Noto Sans", system-ui, sans-serif', 'text-offset': [0, 0.65], 'text-anchor': 'top' },
        paint: { 'text-color': '#56616a', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.4 }, priority: 1
      },
      {
        id: 'housenumber-labels', sourceLayer: 'housenumber', type: 'symbol', minzoom: 16,
        layout: { 'text-field': ['get', 'housenumber'], 'text-size': 10.5, 'text-font': '400 "Noto Sans", system-ui, sans-serif' },
        paint: { 'text-color': '#7a6553', 'text-halo-color': '#fffdf9', 'text-halo-width': 1.25 }, priority: 2
      }
    );

    if (options.showDensePoints === false) {
      layers = layers.filter(function (layer) {
        return layer.id !== 'poi-circle-detail' && layer.id !== 'poi-labels-detail';
      });
    }
    applyTheme(layers, theme);
    return {
      name: theme === 'warm' ? 'karte-bayern-blue' : 'karte-bayern-' + theme,
      tileSchema: 'karte-bayern-v1',
      background: themes[theme] ? themes[theme].background : '#f7f6f2',
      layers: layers
    };
  }

  karteBayernBlueStyle.validateTileJSON = validateTileJSON;
  karteBayernBlueStyle.themes = ['warm', 'light', 'dark', 'night', 'contrast'];

  return karteBayernBlueStyle;
}));
