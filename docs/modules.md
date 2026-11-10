# Optional modules

Import only the modules your application needs. npm subpaths use
`@karte.bayern/micromap/<module>`; browser scripts use
`lib/microMap.<module>.min.js` and attach to `microMap.<module>`.
Load the core first. Modules use CommonJS with ESM default-import interop;
keep their imports when configuring bundler side-effect elimination.

## MapLibre-compatible map

```js
import { Map, Marker, NavigationControl } from '@karte.bayern/micromap/bundle';

const map = new Map({ container: 'map', style: 'https://example.test/style.json', center: [12.49, 48.63], zoom: 12 });
```

`maplibre` (`microMap.Map` after loading `lib/microMap.maplibre.js`) composes
the core, `vector`, `camera`, `compose` and `ui` into MapLibre's `Map` class:
style loading, events, markers, popups and controls. The all-in-one files
`dist/micromap.min.js` (global `microMap`) and `dist/micromap.mjs` contain it
together with `geojson`, `raster`, `pmtiles` and `export`. See the
[migration guide](maplibre.md).

## Vector tiles

```js
import microMap from '@karte.bayern/micromap';
import vector from '@karte.bayern/micromap/vector';

const map = microMap('#map', { tiles: false, center: [12.491, 48.63], zoom: 12 });
const vectors = vector(map, {
  tiles: '/tiles/{z}/{x}/{y}.mvt',
  style: vector.basicStyle({ theme: 'light' })
});
```

`basicStyle()` supports `light`, `dark`, `outdoor` and `contrast`, using common
source layers such as `water`, `building` and `transportation`. Match styles to
your tiles' actual schema. For TileJSON use
`await vector.fromTileJSON(map, '/tilejson.json', { style })`; for Style v8 use
`await vector.fromStyle(map, styleDocument, options)` (all vector, GeoJSON and
raster sources of the style; `transformRequest(url, kind)` rewrites requests).

With a pitched camera the layer paints each tile of a level-of-detail cover
once into its own canvas and lets the browser composite them in perspective;
buildings use WebGL (`webgl: false` forces Canvas 2D). `perspective: false`
keeps the older affine 2.5D renderer for map adapters without a perspective
camera. `vector.evaluateExpression(expression, { properties, zoom })` evaluates
a style expression for one feature.

Use `setStyle()`, `setTiles()`, `queryRenderedFeatures(point, options?)` and
`destroy()` on the returned surface. Inspect `getStyleReport()` when importing
Style v8; strict validation is enabled by default. With `strict: false`,
unsupported properties are skipped and reported. Bundled applications should
supply a standalone vector script URL through `worker` for worker decoding;
otherwise decoding falls back to the main thread.

The Karte.Bayern-specific style is exported as
`@karte.bayern/micromap/styles/karte-bayern-blue`. Its factory accepts
`{ theme: 'warm' | 'light' | 'dark' | 'night' | 'contrast' }`.

For navigation interfaces such as Karte.Bayern and offline viewers such as
osmmini, keep frequently updated data separate from the basemap:

- With `compose`, `geojson: true` creates a separate overlay for live GPS and
  routes. Updating it does not repaint the vector basemap.
- In a Style v8 map, heatmap-, symbol- and extrusion-only GeoJSON updates keep
  pitched ground textures. Fully transparent query layers also keep them;
  feature-dependent opacity remains tracked.
- Repeating the same paint, layout, filter or zoom-range values does not
  recompile or redraw a layer. Fresh arrays with the same expression contents
  count as unchanged. Real changes still invalidate the affected rendering.
- Feature-state updates invalidate dependent buckets only in the affected
  source. Pitched ground textures remain cached when their visible layers do
  not use that source's state. Repeated equivalent state and removal of absent
  keys schedule no rendering; submitted nested state values are copied.
- `querySourceFeatures()` applies GeoJSON filters and returns clusters at the
  current 512px style zoom, even when the basemap is overzoomed. DOM search
  markers can use these results with `getClusterLeaves()` and
  `getClusterExpansionZoom()` instead of creating one marker per raw point.
- The MapLibre-shaped `Map` accepts `pixelRatio: 1`, `1.5` or `2` as a DPR cap
  for lower fill rate on mobile devices. `getPixelRatio()` reports the effective
  ratio, capped by the device ratio.

`test/consumer-browser.html` checks these patterns with independent synthetic
data and real Canvas pixels; `?min=1` checks the generated scripts. Applications
that vendor microMap must explicitly update their module or standalone assets
after building, together with any pinned revisions and asset checksums. Building
this library does not update a consumer's installed copy.

## Elevation and heatmap style layers

The vector renderer and the MapLibre-compatible `Map` support `hillshade`,
`color-relief` and `heatmap` style layers. They are included in the general-purpose
bundle. Add sources and layers after the map's `load` event:

```js
map.on('load', () => {
  map.addSource('elevation', {
    type: 'raster-dem',
    tiles: ['/dem/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 14
  });
  map.addLayer({
    id: 'elevation-colours', type: 'color-relief', source: 'elevation',
    paint: {
      'color-relief-color': ['interpolate', ['linear'], ['elevation'],
        0, '#406d50', 1000, '#b9b276', 3000, '#ffffff'],
      'color-relief-opacity': 0.8
    }
  });
  map.addLayer({
    id: 'shading', type: 'hillshade', source: 'elevation',
    paint: { 'hillshade-exaggeration': 0.5, 'hillshade-illumination-direction': 315 }
  });
});
```

Use your provider's DEM URL, encoding, tile size and maximum zoom. A source may
also use `url` to load TileJSON. DEM encoding defaults to `mapbox`, tile size to
512. `terrarium` is supported; `custom` uses `redFactor`, `greenFactor`,
`blueFactor` and `baseShift` to decode metres as
`R * redFactor + G * greenFactor + B * blueFactor + baseShift`.
The custom channel factors default to 1 and the shift to 0.
Cross-origin DEM images need CORS permission because their pixels are read.

`color-relief-color` must supply a colour or a ramp over `['elevation']` in metres;
without it the layer is transparent. Interpolation ramps blend their sampled
stop colours linearly; `step` ramps keep hard boundaries. Hillshade uses the
`standard` method; other `hillshade-method` values are reported as approximated.
Both layers colour the map surface and do not create 3D terrain.
`hillshade-illumination-anchor: 'map'` fixes the light to the compass;
the default `'viewport'` keeps it fixed to the screen as the map rotates.

Heatmaps use Point or MultiPoint features from GeoJSON or a vector source. For
example, inside the same `load` handler:

```js
map.addSource('observations', { type: 'geojson', data: '/observations.geojson' });
map.addLayer({
  id: 'density', type: 'heatmap', source: 'observations',
  paint: {
    'heatmap-radius': 24,
    'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
    'heatmap-intensity': 1,
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(0, 80, 255, 0)', 0.5, '#00d4b0', 1, '#ff5b32'],
    'heatmap-opacity': 0.8
  }
});
```

For vector tiles also set the layer's `source-layer`. Heatmaps are excluded from
`queryRenderedFeatures()`; use a separate circle layer if points need interaction.
The optional `heatmap` module is a separate overlay API with time filtering and
is not required for these style layers.

Heatmaps retain their order relative to ground layers in pitched views, so a
road or circle placed above a heatmap remains visible above its density colours.
Sparse heatmaps read and colour only the rectangle touched by visible kernels.
Ramps with a visible colour at zero density still colour the whole viewport.
Kernel sprites are created only for visible points and retained in a 64-entry
LRU cache. `node bench/style-heatmap-bench.cjs [vector-module-path]` compares
readback and colour-conversion work with a synthetic Canvas; it does not measure
browser rasterisation or compositing.

The vector layer's `getRenderStats()` includes a monotonic `frames` count and
the last frame's `renderMs` and `demMs`. In pitched mode, `groundMs`, `heatMs`
and `labelMs` distinguish ground, density and label work; `maxCellMs` measures
the slowest ground-cell painting step in that frame. DEM work is included in
ground time, so these timings are not additive. They exclude browser compositing.
Hillshade reuses direction-independent calculations in an LRU cache bounded to
24 MiB and 32 entries. Pitched ground painting can continue between style layers
and groups on later frames; completed cells remain visible until their replacement
is ready. Individual raster or geometry operations can still exceed the budget.
Use `test/terrain-real-browser.html` for a real-data check with JAXA elevations,
OpenFreeMap styles and repeatable full or quick rotation benchmarks. The page
reports phase distributions and browser long tasks when supported; compare the
same run type, style, viewport and cache conditions when evaluating a change.

## GeoJSON

```js
import geojson from '@karte.bayern/micromap/geojson';

const overlays = geojson(map);
overlays.addSource('route', {
  type: 'geojson',
  data: { type: 'Feature', properties: {}, geometry: {
    type: 'LineString', coordinates: [[12.48, 48.62], [12.50, 48.64]]
  } }
});
overlays.addLayer({
  id: 'route-line', source: 'route', type: 'line',
  paint: { 'line-color': '#1769e0', 'line-width': 4 }
});
```

Layer types are `fill`, `line`, `circle` and `symbol`. Replace data with
`getSource(id).setData(data)`; `getData()` returns a copy. Sources validate and
copy input, including nested properties. `updateData(diff)` is available for
collections with unique feature IDs. Fetch remote GeoJSON in application code.

Symbol overlays support `text-halo-color` and `text-halo-width` for a contour
behind their text, including the module's data and zoom expressions. The width
defaults to zero. Numeric arrays work directly for `text-offset` and
`line-dasharray`, or can be returned by an expression.

Circle fill and outline have independent opacity: `circle-opacity: 0` with
a positive `circle-stroke-width` and `circle-stroke-opacity` keeps a visible,
queryable ring in both the vector renderer and the GeoJSON overlay.
Polygon holes remain empty regardless of ring winding. Overlapping polygon
components share one fill, preserving their union and applying opacity once;
source coordinates retain their original order.

Use `setPaintProperty()`, `setLayoutProperty()`, `setFilter()`,
`queryRenderedFeatures()` and `getBounds(sourceId?)` to update or inspect the
overlay. `on('click', layerId, handler)` registers a layer click handler.
Call `destroy()` when the overlay is no longer needed.

## Data formats

The optional `formats` module converts
[TopoJSON 1.0](https://github.com/topojson/topojson-specification) and
[GeoJSON Text Sequences (RFC 8142)](https://www.rfc-editor.org/rfc/rfc8142)
into GeoJSON FeatureCollections. It also normalises ordinary GeoJSON input.
It has no runtime dependencies and is not included in the general-purpose
bundle; load it only where data imports are needed.

```js
import formats from '@karte.bayern/micromap/formats';

const response = await fetch('/areas.topojson');
if (!response.ok) throw new Error('Area data could not be loaded');
const data = formats.parse(await response.text(), {
  format: 'topojson', object: 'areas'
});
map.addSource('areas', { type: 'geojson', data });
map.addLayer({ id: 'areas', type: 'fill', source: 'areas',
  paint: { 'fill-color': '#679a80', 'fill-opacity': 0.5 }
});
```

Classic scripts use `lib/microMap.formats.min.js` and the global
`microMapFormats`. The converters do not require a DOM or a running map.

| Method | Input and result |
| --- | --- |
| `parse(input, options?)` | JSON object or text; detects Topology, ordinary GeoJSON or RS-framed sequences. Set `format` to `topojson`, `geojson` or `geojson-seq` to require that format. |
| `topojson(input, options?)` | Topology object or JSON text; `object` selects a named object or array of names. Omit it to merge all named objects in input order. |
| `geojsonSeq(text, options?)` | Complete sequence text with ASCII record separators (`\u001e`), including pretty-printed and mixed Geometry/Feature/FeatureCollection records. |

TopoJSON conversion handles shared and reversed arcs, delta-encoded quantized
arcs, scale/translate transforms, all geometry types, IDs, properties and
bounding boxes. Additional position dimensions, such as elevation, remain
unchanged. A selected top-level GeometryCollection becomes individual features;
nested collections remain geometries. Input objects and shared arc coordinates
are copied so edits to the output do not mutate the original topology.

Sequence parsing is strict by default. To report a malformed record and continue
at the next separator, pass `onError(error, recordIndex)`; indices start at one.
A bad record contributes no partial features. Limit errors always stop parsing.
Plain newline-delimited JSON is not RS-framed GeoJSON Text Sequences.

All converters return a FeatureCollection; bare geometries are wrapped as
features, and features may have null geometry. `maxFeatures` defaults to 50,000
and `maxCoordinates` to 1,000,000; nested data is limited to 32 levels. The module
parses complete inputs, not streaming chunks, and performs no CRS reprojection.
Coordinates passed to a map must already be WGS 84 longitude/latitude.

## Tile source schemes

The core, vector renderer and optional raster module support XYZ and
[TileJSON 3.0 TMS schemes](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0#315-scheme)
on the global Web Mercator grid. For Style v8 vector, raster or raster-dem
sources, set `scheme: 'tms'`; source definitions override the scheme advertised
by their TileJSON. The default is `xyz`.

```js
map.addSource('legacy-tiles', {
  type: 'raster', tileSize: 256, scheme: 'tms',
  tiles: ['/tiles/{z}/{x}/{y}.png']
});
map.addLayer({ id: 'legacy-tiles', type: 'raster', source: 'legacy-tiles' });
```

Only request rows change. Geometry, wrapping, cache keys and tile events retain
XYZ coordinates; `{-y}` remains an explicit inverted-XYZ placeholder even on a
TMS source. This is row numbering support, not a WMTS capabilities parser or
support for arbitrary projected tile matrix sets.

## Camera and UI

```js
import camera from '@karte.bayern/micromap/camera';
import compose from '@karte.bayern/micromap/compose';
import ui from '@karte.bayern/micromap/ui';

const view = compose(map, { camera: true });
view.addControl(new ui.NavigationControl());
new ui.Marker().setLngLat([12.491, 48.63])
  .setPopup(new ui.Popup().setText('Dingolfing')).addTo(view);
view.fitBounds([12.48, 48.62, 12.50, 48.64], { padding: 24, maxZoom: 15 });
// On leaving the viewer: view.remove();
```

The camera surface provides `jumpTo`, `easeTo`, `flyTo`, `fitBounds`, `cancelCamera` and
`linkHash`. Camera animations respect reduced-motion preferences unless marked
`essential`. Non-zero padding/offset for `easeTo` and `flyTo` are unsupported;
`fitBounds` accepts padding.

Compose combines selected surfaces and exposes source/layer methods and camera
controls. `destroy()` releases its own surfaces while preserving the base map and
externally supplied surfaces; `remove()` tears down the whole viewer.
UI offers markers, popups, tooltips, navigation, scale, geolocation, coordinate
and attribution controls. Class APIs use `[longitude, latitude]`; Leaflet-shaped
factories such as `ui.marker()` use `[latitude, longitude]`.

## Other modules

| Subpath | Purpose / prerequisites |
| --- | --- |
| `raster` | Additional XYZ/WMS layers via `addSource()` and `addLayer()` |
| `field` | Editable annotations, undo/redo; load `geojson` first |
| `measure` | Distances, areas and adapter-backed routes; load `geojson` first |
| `inspect` | GeoJSON validation before import |
| `formats` | TopoJSON and RFC 8142 GeoJSON Text Sequences to GeoJSON |
| `heatmap` | Weighted points with optional time filtering |
| `graticule` | Coordinate grid |
| `export` | PNG and print capture; cross-origin images need CORS permission |
| `pmtiles` | PMTiles v3 reader; use `vector` for MVT or `raster` for images |
| `mmt` | MMT v1 decoder for the vector renderer; load `vector` first |
| `mlt` | Adapter for an application-supplied MLT decoder; load `vector` first |
| `network` | Routing on an application-supplied weighted graph |
| `scenario` | Time-based entities, events and playback |
| `webgl` | Optional WebGL surface for custom drawing |

PMTiles accepts an HTTP URL with byte-range/CORS support or a local File/Blob.
Use `getHeader()`, `getMetadata()`, `getTile()`, `vectorOptions()` or
`rasterSource()`. Compression support depends on browser `DecompressionStream`.
Archives are read on demand, not automatically downloaded for offline use.

See the [demo sources](https://github.com/Karte-Bayern/microMap/tree/main/demo)
for working examples of the specialized modules, and [core limits](reference.md#limits)
before migrating an existing map.
