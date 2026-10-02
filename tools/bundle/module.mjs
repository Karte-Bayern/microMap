// Entry of dist/micromap.mjs: the same modules as named ES exports, so that
// `import { Map, Marker } from '@karte.bayern/micromap/bundle'` replaces
// `import { Map, Marker } from 'maplibre-gl'`.
import microMap from '../../lib/microMap.js';
import vector from '../../lib/microMap.vector.js';
import geojson from '../../lib/microMap.geojson.js';
import camera from '../../lib/microMap.camera.js';
import compose from '../../lib/microMap.compose.js';
import ui from '../../lib/microMap.ui.js';
import raster from '../../lib/microMap.raster.js';
import pmtiles from '../../lib/microMap.pmtiles.js';
import exporter from '../../lib/microMap.export.js';
import maplibre from '../../lib/microMap.maplibre.js';

export default microMap;
export { microMap, vector, geojson, camera, compose, ui, raster, pmtiles, exporter as export, maplibre };
export const Map = maplibre.Map;
export const Marker = maplibre.Marker;
export const Popup = maplibre.Popup;
export const NavigationControl = maplibre.NavigationControl;
export const ScaleControl = maplibre.ScaleControl;
export const GeolocateControl = maplibre.GeolocateControl;
export const AttributionControl = maplibre.AttributionControl;
export const FullscreenControl = maplibre.FullscreenControl;
export const LngLat = maplibre.LngLat;
export const LngLatBounds = maplibre.LngLatBounds;
export const addProtocol = maplibre.addProtocol;
export const removeProtocol = maplibre.removeProtocol;
export const getVersion = maplibre.getVersion;
export const setWorkerUrl = maplibre.setWorkerUrl;
export const getWorkerUrl = maplibre.getWorkerUrl;
export const setRTLTextPlugin = maplibre.setRTLTextPlugin;
export const getRTLTextPluginStatus = maplibre.getRTLTextPluginStatus;
