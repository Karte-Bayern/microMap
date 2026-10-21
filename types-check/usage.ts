import microMap = require('../types/micromap');
import maplibre = require('../types/maplibre');
import bundle = require('../types/bundle');

const options: microMap.MapOptions = { tiles: false, center: [11.5, 48.1], zoom: 12 };
declare const core: microMap.MicroMap;
core.setView(options.center!, options.zoom).setPitch(20).getCamera();

const map: maplibre.Map = new maplibre.Map({ container: 'map', style: { version: 8, sources: {}, layers: [] } });
map.addLayer({ id: 'background', type: 'background' }).setPaintProperty('background', 'background-color', '#fff');
map.on('load', () => map.getCenter().toArray());

const named: typeof bundle.Map = bundle.Map;
void named;
const inBox: maplibre.MapGeoJSONFeature[] = map.queryRenderedFeatures([[0, 0], [100, 100]], { filter: ['==', ['get', 'class'], 'primary'] });
const everything: number = map.queryRenderedFeatures({ layers: ['points'] }).length + inBox.length;
void everything;

const dem: maplibre.SourceSpecification = {
  type: 'raster-dem', tiles: ['/dem/{z}/{x}/{y}.png'], tileSize: 256,
  encoding: 'custom', redFactor: 256, greenFactor: 1, blueFactor: 1 / 256, baseShift: -32768
};
const encoding: 'mapbox' | 'terrarium' | 'custom' | undefined = dem.encoding;
void encoding;
map.addSource('elevation', dem);
map.addLayer({ id: 'hills', type: 'hillshade', source: 'elevation', paint: { 'hillshade-exaggeration': 0.6 } });
map.addLayer({ id: 'relief', type: 'color-relief', source: 'elevation', paint: {
  'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#008000', 3000, '#ffffff']
} });
map.addSource('points', { type: 'geojson', data: '/points.geojson' });
map.addLayer({ id: 'density', type: 'heatmap', source: 'points', paint: {
  'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'transparent', 1, 'red']
} });
// @ts-expect-error DEM encoding factors are numeric.
map.addSource('invalid-dem', { type: 'raster-dem', encoding: 'custom', redFactor: '256' });
