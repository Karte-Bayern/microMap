import maplibre = require('./maplibre');

declare namespace sources {
  type BayernRasterLayer = 'by_webkarte' | 'by_webkarte_grau' | 'by_label' | 'by_amtl_karte' | 'by_dop' | 'by_dop_cir';
  type BayernVectorStyle = 'light' | 'standard' | 'grau' | 'luftbild' | 'nacht' | 'wandern' | 'radln' | 'oepnv' | 'baeume' | 'gelaende' | 'hangneigung' | 'winter';
  interface RasterSource extends maplibre.SourceSpecification {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    scheme: 'xyz';
    attribution: string;
  }
  /** Standard OSM raster tiles; no prefetch/offline configuration is enabled. */
  function osm(): RasterSource;
  /** Official Web Mercator WMTS source, including coverage and credits. */
  function bayernRaster(layer?: BayernRasterLayer): RasterSource;
  /** Official Style v8 URL; default light avoids buildings and individual trees. */
  function bayernVector(style?: BayernVectorStyle): string;
}
export = sources;
