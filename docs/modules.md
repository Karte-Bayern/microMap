# Optional modules

Import only the modules your application needs. npm subpaths use
`@karte.bayern/micromap/<module>`; browser scripts use
`lib/microMap.<module>.min.js` and attach to `microMap.<module>`.
Load the core first. Modules use CommonJS with ESM default-import interop;
keep their imports when configuring bundler side-effect elimination.

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
`await vector.fromStyle(map, styleDocument, options)`.

Use `setStyle()`, `setTiles()`, `queryRenderedFeatures(point, options?)` and
`destroy()` on the returned surface. Inspect `getStyleReport()` when importing
Style v8; strict validation is enabled by default. With `strict: false`,
unsupported properties are skipped and reported. Bundled applications should
supply a standalone vector script URL through `worker` for worker decoding;
otherwise decoding falls back to the main thread.

The Karte.Bayern-specific style is exported as
`@karte.bayern/micromap/styles/karte-bayern-blue`. Its factory accepts
`{ theme: 'warm' | 'light' | 'dark' | 'night' | 'contrast' }`.

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

Use `setPaintProperty()`, `setLayoutProperty()`, `setFilter()`,
`queryRenderedFeatures()` and `getBounds(sourceId?)` to update or inspect the
overlay. `on('click', layerId, handler)` registers a layer click handler.
Call `destroy()` when the overlay is no longer needed.

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
| `heatmap` | Weighted points with optional time filtering |
| `graticule` | Coordinate grid |
| `export` | PNG and print capture; cross-origin images need CORS permission |
| `pmtiles` | PMTiles v3 reader; use `vector` for MVT or `raster` for images |
| `mmt` | MMT v1 decoder for the vector renderer; load `vector` first |
| `mlt` | Adapter for an application-supplied MLT decoder; load `vector` first |
| `network` | Routing on an application-supplied weighted graph |
| `scenario` | Time-based entities, events and playback |
| `webgl` | Optional WebGL surface, not a complete vector renderer |

PMTiles accepts an HTTP URL with byte-range/CORS support or a local File/Blob.
Use `getHeader()`, `getMetadata()`, `getTile()`, `vectorOptions()` or
`rasterSource()`. Compression support depends on browser `DecompressionStream`.
Archives are read on demand, not automatically downloaded for offline use.

See the [demo sources](https://github.com/Karte-Bayern/microMap/tree/main/demo)
for working examples of the specialized modules, and [core limits](reference.md#limits)
before migrating an existing map.
