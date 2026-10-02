# Migrating from MapLibre GL JS

microMap implements the parts of MapLibre GL JS that most applications use,
with the same names, arguments and events. In many applications migrating is
a change of import:

```diff
-import maplibregl from 'maplibre-gl';
-import 'maplibre-gl/dist/maplibre-gl.css';
+import * as maplibregl from '@karte.bayern/micromap/bundle';
```

or, without a bundler:

```diff
-<script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js"></script>
-<link href="https://unpkg.com/maplibre-gl/dist/maplibre-gl.css" rel="stylesheet">
+<script src="https://unpkg.com/@karte.bayern/micromap/dist/micromap.min.js"></script>
+<script>const maplibregl = microMap.maplibre;</script>
```

No stylesheet is needed; controls, markers and popups inject their own small
CSS with `micromap-` class names.

## What behaves the same

- **Map options**: `container`, `style` (URL or object), `center`, `zoom`,
  `bearing`, `pitch`, `minZoom`, `maxZoom`, `minPitch`, `maxPitch` (≤ 85),
  `maxBounds`, `bounds` + `fitBoundsOptions`, `interactive` and the individual
  handler switches, `attributionControl`, `hash`, `transformRequest`.
  Zoom levels use MapLibre's 512 px tiles.
- **Style loading**: style JSON by URL (relative URLs resolve against it),
  TileJSON for vector sources, several vector sources, GeoJSON (including
  clustering), raster/XYZ and WMS-style raster sources, sprites (`@2x` on dense
  screens), the style's default camera, `sky`.
- **Style editing**: `addSource`, `getSource().setData()`, `removeSource`,
  `addLayer(layer, beforeId)`, `moveLayer`, `removeLayer`, `setPaintProperty`,
  `setLayoutProperty`, `setFilter`, `setLayerZoomRange`, `getStyle`,
  `setStyle`, `getLayersOrder`, `addImage`/`updateImage`/`removeImage`/`loadImage`.
- **Data**: `queryRenderedFeatures(point, { layers })`,
  `querySourceFeatures(source, { sourceLayer, filter })`, `setFeatureState`,
  `getFeatureState`, `removeFeatureState`, `['feature-state', …]` in paint.
- **Camera**: `jumpTo`, `easeTo`, `flyTo`, `panTo`, `panBy`, `zoomTo`,
  `zoomIn`, `zoomOut`, `rotateTo`, `resetNorth`, `resetNorthPitch`,
  `snapToNorth`, `fitBounds`, `cameraForBounds`, `stop`, `project`,
  `unproject`, `getBounds`, zoom and pitch limit setters. Animations respect
  `prefers-reduced-motion` unless `essential`.
- **Events**: `load`, `idle`, `style.load`, `styledata`, `sourcedata`, `data`,
  `error`, `remove`, `render`, camera events (`move`, `zoom`, `rotate`,
  `pitch` with `*start`/`*end`), pointer events and layer-scoped
  `map.on('click', layerId, …)`, `mouseenter`/`mouseleave`; `once(type)`
  without a handler returns a Promise.
- **UI**: `Marker` (draggable, popups, rotation), `Popup`,
  `NavigationControl`, `ScaleControl`, `GeolocateControl`,
  `AttributionControl`, `FullscreenControl`, custom `IControl`s.
- **Globals**: `addProtocol`/`removeProtocol` (e.g. for PMTiles loaders),
  `LngLat`, `LngLatBounds`, `getVersion`. `setWorkerUrl`, `setRTLTextPlugin`
  and similar are accepted as no-ops.

## Style specification

| Area | Support |
| --- | --- |
| Layer types | `background`, `fill`, `line`, `circle`, `symbol`, `fill-extrusion`, `raster` |
| Not rendered (reported in `getStyleReport().skippedLayers`) | `heatmap` (use the `heatmap` module), `hillshade`, `color-relief`, `raster-dem` sources, `image`/`video`/`canvas` sources |
| Expressions | data, zoom and feature-state expressions: `get`, `has`, `id`, `geometry-type`, `properties`, `let`/`var`, `case`, `match`, `coalesce`, `step`, `interpolate` (linear, exponential; `-hcl`/`-lab` interpolate in RGB), comparisons, `all`/`any`/`!`/`in`, type assertions and conversions, `to-rgba`, `rgb`/`rgba`, string, array (`at`, `slice`, `index-of`) and math operators, `format` (text only), `number-format`, legacy filters and functions |
| Approximated | per-section `format` fonts and colours, `text-letter-spacing`, `text-halo-blur`, `symbol-spacing`, pitch/rotation alignment, variable anchors, sort keys, `icon-text-fit`, raster colour adjustments |
| Text | browser fonts chosen from `text-font`; `glyphs` are not downloaded. Line labels are placed along their line but not bent around curves |
| Terrain, globe, light | `setTerrain`, `setProjection({ type: 'globe' })` and `setLight` are accepted and ignored with a console warning |

`map._vector.getStyleReport()` lists every skipped layer and every ignored or
approximated property of the loaded style, so differences are never silent.

## Rendering differences

- Map tiles are painted with Canvas 2D (one canvas per visible tile, reused
  across pans and rotations) and composited by the browser's GPU compositor.
  A tilted view uses coarser tiles towards the horizon; text and icons are
  drawn on a screen-aligned canvas above.
- Buildings (`fill-extrusion`) are drawn with WebGL when available, otherwise
  with Canvas 2D. Translucent buildings are composed opaque first, as in
  MapLibre.
- Far ground in steep views fades into fog; above the far row the sky is
  drawn from the style's `sky` (or defaults). `map.setSky(false)` disables it.
- Labels keep a constant size with distance; MapLibre shrinks distant labels
  slightly.
- `getCanvas()` returns the label canvas, not a single WebGL canvas. Use the
  `export` module for image export.

## Coexisting with microMap's own APIs

`map.getMap()` returns the underlying core (`microMap(…)` instance) for
features beyond MapLibre's API: raster `preload`, navigation-aware preloading,
context menus, `addRoute`, the perspective camera via `getCamera()`, and the
specialised modules (heatmap, measure, field annotations, routing networks,
scenarios). The core and modules use plain `[longitude, latitude]` arrays.
