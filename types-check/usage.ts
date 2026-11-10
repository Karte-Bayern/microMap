import microMap = require('../types/micromap');
import maplibre = require('../types/maplibre');
import bundle = require('../types/bundle');
import formats = require('../types/formats');
import sources = require('../types/sources');

const options: microMap.MapOptions = { tiles: false, center: [11.5, 48.1], zoom: 12 };
const tms: microMap.MapOptions = { tiles: '/{z}/{x}/{y}.png', scheme: 'tms' };
void tms;
declare const core: microMap.MicroMap;
core.setView(options.center!, options.zoom).setPitch(20).getCamera();
core.setTiles('/{z}/{x}/{y}.png', { scheme: 'tms' });

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

const imported: formats.FeatureCollection = formats.parse('{"type":"Point","coordinates":[12,48]}');
map.addSource('imported', { type: 'geojson', data: imported });
formats.topojson({ type: 'Topology', objects: {}, arcs: [] }, { object: ['roads'], maxCoordinates: 10000 });
formats.geojsonSeq('\u001e{"type":"Point","coordinates":[12,48]}\n', {
  onError(error, recordIndex) { const message: string = recordIndex + ': ' + error.message; void message; }
});
// @ts-expect-error Unknown tile schemes are rejected.
core.setTiles('/{z}/{x}/{y}.png', { scheme: 'quadkey' });
// @ts-expect-error Unsupported conversion format.
formats.parse('{}', { format: 'shapefile' });

const aerial: maplibre.SourceSpecification = sources.bayernRaster('by_dop');
map.addSource('aerial', aerial);
const bayernStyle: string = sources.bayernVector('light');
void bayernStyle;
map.addSource('osm-map', sources.osm());
const osmData: formats.FeatureCollection = formats.osm({ elements: [] }, { includeUntaggedNodes: true });
map.addSource('osm-data', { type: 'geojson', data: osmData });
// @ts-expect-error Unknown official raster layer.
sources.bayernRaster('secret-layer');
