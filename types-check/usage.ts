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
