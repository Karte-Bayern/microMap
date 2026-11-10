/*! microMap.sources.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.microMapSources = factory();
    if (typeof root.microMap === 'function') root.microMap.sources = root.microMapSources;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Verified against the provider's WMTS Capabilities on 2026-11-10.
  // smerc is its global EPSG:3857 matrix set, with numeric matrices 0–19.
  var bounds = [8.945107890491915, 47.248466288051446, 13.90891310401004, 50.57987000589413];
  var baseCredit = '© Datenquellen: <a href="https://www.geodaten.bayern.de/">Bayerische Vermessungsverwaltung</a>';
  var mapCredit = baseCredit + ', GeoBasis-DE / BKG 2023 – Daten verändert';
  var imageryCredit = baseCredit + ', Europäische Union, enthält Copernicus Sentinel-2 Daten 2018, verarbeitet durch das Bundesamt für Kartographie und Geodäsie (BKG)';
  var layers = {
    by_webkarte: mapCredit,
    by_webkarte_grau: mapCredit,
    by_label: mapCredit,
    by_amtl_karte: baseCredit + ', GeoBasis-DE / BKG 2021/2023 – Daten verändert',
    by_dop: imageryCredit,
    by_dop_cir: imageryCredit
  };
  var styles = ['light', 'standard', 'grau', 'luftbild', 'nacht', 'wandern', 'radln', 'oepnv', 'baeume', 'gelaende', 'hangneigung', 'winter'];

  function osm() {
    return {
      type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256, minzoom: 0, maxzoom: 19, scheme: 'xyz',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    };
  }

  function bayernRaster(layer) {
    if (layer == null) layer = 'by_webkarte';
    if (typeof layer !== 'string' || !Object.prototype.hasOwnProperty.call(layers, layer)) throw new Error('microMap.sources: unknown Bayern raster layer ' + String(layer));
    return {
      type: 'raster', tiles: ['https://wmtsod1.bayernwolke.de/wmts/' + layer + '/smerc/{z}/{x}/{y}'],
      tileSize: 256, minzoom: 0, maxzoom: 19, scheme: 'xyz', bounds: bounds.slice(),
      attribution: layers[layer]
    };
  }

  function bayernVector(style) {
    if (style == null) style = 'light';
    if (styles.indexOf(style) < 0) throw new Error('microMap.sources: unknown Bayern vector style ' + String(style));
    return 'https://vtod1.bayernwolke.de/styles/by_style_' + style + '.json';
  }

  return { osm: osm, bayernRaster: bayernRaster, bayernVector: bayernVector };
});
