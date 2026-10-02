// Entry of dist/micromap.js: every general-purpose module on one global,
// `microMap`, including the MapLibre-shaped `microMap.Map` and friends.
'use strict';
var microMap = require('../../lib/microMap.js');
require('../../lib/microMap.vector.js');
require('../../lib/microMap.geojson.js');
require('../../lib/microMap.camera.js');
require('../../lib/microMap.compose.js');
require('../../lib/microMap.ui.js');
require('../../lib/microMap.raster.js');
require('../../lib/microMap.pmtiles.js');
require('../../lib/microMap.export.js');
var maplibre = require('../../lib/microMap.maplibre.js');
['Map', 'Marker', 'Popup', 'NavigationControl', 'ScaleControl', 'GeolocateControl', 'AttributionControl', 'FullscreenControl',
  'LngLat', 'LngLatBounds', 'addProtocol', 'removeProtocol', 'getVersion', 'setWorkerUrl', 'getWorkerUrl',
  'setRTLTextPlugin', 'getRTLTextPluginStatus'].forEach(function (name) {
  if (maplibre[name] && !microMap[name]) microMap[name] = maplibre[name];
});
module.exports = microMap;
