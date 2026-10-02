// Type declarations for @karte.bayern/micromap/bundle (dist/micromap.mjs):
// MapLibre-style named exports plus the microMap core as default export.

import microMap = require('./micromap');
import maplibre = require('./maplibre');

export default microMap;
export { microMap };
export import Map = maplibre.Map;
export import Marker = maplibre.Marker;
export import Popup = maplibre.Popup;
export import NavigationControl = maplibre.NavigationControl;
export import ScaleControl = maplibre.ScaleControl;
export import GeolocateControl = maplibre.GeolocateControl;
export import AttributionControl = maplibre.AttributionControl;
export import FullscreenControl = maplibre.FullscreenControl;
export import LngLat = maplibre.LngLat;
export import LngLatBounds = maplibre.LngLatBounds;
export import addProtocol = maplibre.addProtocol;
export import removeProtocol = maplibre.removeProtocol;
export import getVersion = maplibre.getVersion;
export import setWorkerUrl = maplibre.setWorkerUrl;
export import getWorkerUrl = maplibre.getWorkerUrl;
export import setRTLTextPlugin = maplibre.setRTLTextPlugin;
export import getRTLTextPluginStatus = maplibre.getRTLTextPluginStatus;
export type MapOptions = maplibre.MapOptions;
export type StyleSpecification = maplibre.StyleSpecification;
export type LayerSpecification = maplibre.LayerSpecification;
export type SourceSpecification = maplibre.SourceSpecification;
export type LngLatLike = maplibre.LngLatLike;
export type LngLatBoundsLike = maplibre.LngLatBoundsLike;
export type MapGeoJSONFeature = maplibre.MapGeoJSONFeature;
export type IControl = maplibre.IControl;
export { maplibre };
/** Further modules bundled alongside. */
export const vector: unknown;
export const geojson: unknown;
export const camera: unknown;
export const compose: unknown;
export const ui: unknown;
export const raster: unknown;
export const pmtiles: unknown;
