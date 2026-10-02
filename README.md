# microMap.js

A lightweight, dependency-free JavaScript map library with a **MapLibre-shaped
API for a documented subset of MapLibre GL JS**. It renders MapLibre style
documents (vector, GeoJSON and raster sources, sprites, expressions) with a
real perspective camera, 3D buildings, markers, popups and controls — in about
115 KB (min+gzip) for everything, or from 16 KB for a raster-only map. MIT
licensed.

```js
import { Map, Marker, Popup, NavigationControl } from '@karte.bayern/micromap/bundle';

const map = new Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [11.576, 48.137],
  zoom: 14,
  pitch: 60
});
map.addControl(new NavigationControl());
map.on('load', () => {
  new Marker().setLngLat([11.5755, 48.1374])
    .setPopup(new Popup().setText('Marienplatz'))
    .addTo(map);
});
```

## Why microMap

- **Familiar MapLibre-shaped API.** `Map`, `Marker`, `Popup`, controls,
  `addSource`/`addLayer`, paint/layout/filter setters, feature state,
  `queryRenderedFeatures`, `querySourceFeatures`, `flyTo`/`easeTo`/`fitBounds`,
  `addProtocol`, `transformRequest` and MapLibre-style events are available.
  The [migration guide](docs/maplibre.md) lists the supported subset and the
  rendering differences.
- **Real perspective.** Pitch up to 85° with a horizon, sky and fog; tiles of
  several zoom levels by distance; buildings drawn in 3D with WebGL and a
  depth buffer (Canvas 2D fallback). Raster, vector, GeoJSON, markers and hit
  testing share one camera.
- **Small and modular.** Import only what you use: the raster core is 16 KB,
  the style renderer 53 KB, UI 14 KB. No runtime dependencies, no build step
  required, plain `<script>` tags work.
- **Works without a GPU.** Map tiles are painted with Canvas 2D and composited
  by the browser; WebGL is only an accelerator for 3D buildings.
- **Typed.** TypeScript declarations for the core, the MapLibre API and the
  bundle are included.

| | microMap 0.2 | MapLibre GL JS 6 |
| --- | --- | --- |
| Download (min+gzip, everything) | ~115 KB | ~156 KB (main + worker) |
| Raster-only map | ~16 KB | ~156 KB |
| Runtime dependencies | none | several |
| Rendering | Canvas 2D tiles, CSS 3D compositing, WebGL for buildings | WebGL / WebGPU |
| Perspective pitch | up to 85°, sky and fog | up to 85°, sky, fog, terrain |
| Globe projection, terrain, hillshade | not yet | yes |
| Text | browser fonts (straight labels along lines) | SDF glyphs, curved labels |

## Install

```sh
npm install @karte.bayern/micromap
```

| Entry point | Use |
| --- | --- |
| `@karte.bayern/micromap/bundle` | ES module with MapLibre-style named exports (`Map`, `Marker`, …) |
| `@karte.bayern/micromap/maplibre` | The same API as a CommonJS module sharing the separately imported modules |
| `@karte.bayern/micromap` | The core camera and raster map, `microMap(container, options)` |
| `@karte.bayern/micromap/<module>` | Optional modules: `vector`, `geojson`, `ui`, `camera`, `raster`, `pmtiles`, … |

Without a bundler, load `dist/micromap.min.js` (classic script, global
`microMap` with `microMap.Map`, `microMap.Marker`, …) or import
`dist/micromap.mjs` from a CDN. The raster core alone is `lib/microMap.min.js`:

```html
<div id="map" style="height:420px"></div>
<script src="https://unpkg.com/@karte.bayern/micromap/lib/microMap.min.js"></script>
<script>
  microMap('#map', {
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    center: [12.491, 48.63], zoom: 12, pitch: 45
  });
</script>
```

Tile and style providers must allow your requests (CORS) and require their
attribution; the map shows the attribution of the sources a style uses.

## Documentation

- [Migrating from MapLibre GL JS](docs/maplibre.md) — compatibility matrix
- [Core API](docs/reference.md) — camera, raster tiles, events, limits
- [Optional modules](docs/modules.md) — vector styles, GeoJSON, UI, PMTiles…
- [Demos](https://github.com/Karte-Bayern/microMap/tree/main/demo)

## Development

Use Node.js 22 or newer:

```sh
npm ci
npm run check
make serve
```

`npm run check` verifies the minified bundles and size budgets, runs the tests,
type-checks the declarations and installs the packed tarball. After editing
`lib/`, run `npm run build`. For rendering or interaction changes also open the
relevant `test/` or `demo/` page in a browser: automated tests use simulated
DOM and Canvas APIs and verify behaviour, not pixels.

Maintained by [Simon Waldherr](https://github.com/SimonWaldherr/).
[MIT license](LICENSE); map data and imagery have separate licenses.
