# Core API

`microMap(container, options)` creates a Web Mercator map. `container` is a DOM
element or CSS selector with a non-zero height. Coordinates use
`[longitude, latitude]`; bounds use `[west, south, east, north]` or two corners.
The constructor requires a browser DOM.

## Loading

With a bundler, use `import microMap from '@karte.bayern/micromap'`.
CommonJS uses `require('@karte.bayern/micromap')`. The modules are CommonJS with
ESM default-import interop; `@karte.bayern/micromap/bundle` (`dist/micromap.mjs`)
is a native ES module with every general-purpose module and MapLibre-style
named exports. TypeScript declarations are included.

For a page without a bundler:

```html
<div id="map" style="height:420px"></div>
<script src="lib/microMap.min.js"></script>
<script>
  const map = microMap('#map', {
    center: [12.491, 48.63],
    zoom: 12,
    tiles: '/tiles/{z}/{x}/{y}.png',
    attribution: 'Your tile provider'
  });
</script>
```

Paths are relative to your page; copy the scripts from the package's `lib/`
directory. Load optional browser scripts after the core and their prerequisites.
See [modules](modules.md).

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `tiles` | required | XYZ URL template, `(z, x, y) => url`, or `false` for a vector/overlay-only map |
| `center`, `zoom` | `[0, 0]`, `0` | Initial position and fractional zoom |
| `minZoom`, `maxZoom` | `0`, `19` | Camera zoom limits |
| `tileSize` | `256` | Tile size in CSS pixels |
| `bearing`, `pitch` | `0`, `0` | Bearing and perspective tilt in degrees |
| `maxPitch` | `60` | Steepest allowed tilt, at most 85° |
| `sky` | defaults | `{ skyColor, horizonColor, fogColor, fogBlend }` above the horizon of steep views; `false` disables it |
| `maxBounds` | none | Bounds constraining the map center |
| `zoomSnap` | `0` | Zoom step; zero allows continuous zoom |
| `attribution` | none | Provider credit; accepts trusted HTML, never pass unsanitized user input |
| `ariaLabel` | `Interactive map` | Accessible name for the map region |
| `crossOrigin` | unset | Tile image CORS mode; use `anonymous` when exporting permitted cross-origin tiles |
| `tileBuffer` | `1` | Extra tile rows/columns around the viewport |
| `preload` | off | Optional bounded preload policy; `true` enables defaults |

Mouse, touch and keyboard interaction are enabled by default. Set `dragging`,
`scrollWheelZoom`, `doubleClickZoom`, `touchZoom`, `keyboard` or `inertia` to
`false` to disable the corresponding behavior. `zoomAnimation: false` disables
animated core zoom. Shift-drag selects a box; `boxSelect: false` disables it.

Tile templates support `{z}`, `{x}`, `{y}`, `{-y}` (TMS row) and `{s}`
(subdomain, selected from `subdomains`, default `abc`).

## Methods and events

| Method | Purpose |
| --- | --- |
| `setView(center, zoom?)`, `setCenter(center)`, `setZoom(zoom)` | Move the camera |
| `setBearing(degrees)`, `setPitch(degrees)` | Rotate or tilt |
| `setMinZoom(z)`, `setMaxZoom(z)`, `setMaxPitch(degrees)` | Change camera limits at runtime |
| `setSky(options \| false)`, `getSky()` | Sky and fog of tilted views |
| `getCamera()` | The perspective camera: `project(dx, dy, dz)`, `unproject(x, y)`, `unprojectAt(x, y, dz)`, `cover(options)` in raw map pixels |
| `fitBounds(bounds, padding?)` | Fit an extent; use the camera add-on for detailed fitting options |
| `getCenter()`, `getZoom()`, `getBounds()` | Read camera position and visible bounds |
| `project(coordinate)`, `unproject([x, y])` | Convert coordinates to/from container pixels |
| `setTiles(template, options?)` | Replace the raster source; `false` removes it |
| `addMarker(coordinate, options?)` | Add a DOM marker; returned handle has `setLonLat()` and `remove()` |
| `addRoute(coordinates, options?)` | Add an SVG route; returned handle has `setCoordinates()`, `setStyle()` and `remove()` |
| `on(type, handler)`, `once(type, handler)`, `off(type, handler)` | Subscribe or unsubscribe |
| `whenIdle()` | Wait for movement, the next draw and visible core raster requests to settle |
| `resize()` | Re-read container size |
| `destroy()` | Release the map, listeners and requests |

Common events include `click`, `move`, `moveend`, `zoom`, `zoomend`, `resize`
and `boxselect`. Core click events contain `lonLat` and container-pixel `point`:

```js
function showPosition(event) { console.log(event.lonLat); }
map.on('click', showPosition);
// Later:
map.off('click', showPosition);
map.destroy();
```

Destroy separately created add-on surfaces before destroying the core. A compose
facade offers `remove()` for full teardown. Core `whenIdle()` does not wait for
optional vector or overlay requests.

## Camera

The camera is a pinhole camera with MapLibre's 36.87° vertical field of view,
orbiting the map centre: `zoom` is the scale at the centre, nearer ground is
larger and far ground shrinks towards a horizon. A tilted map loads coarser
tiles towards the horizon, so the request count stays bounded at any pitch;
above the far row (ground smaller than a fifth of its size at the centre) the
sky and fog are shown. `project()` and `unproject()` are exact inverses below
that row, and straight lines stay straight, so overlays may project vertices
one by one. `microMap.createCamera(state)` exposes the same mathematics for
tests and add-ons.

## Limits

- There is no terrain or globe projection yet.
- MapLibre Style v8 support covers the commonly used layer types, sources and
  expressions; see the [migration guide](maplibre.md). Inspect
  `vectors.getStyleReport()` for unsupported or approximated features. Fonts use
  browser fonts instead of glyph-PBF atlases; road labels are not bent around
  curves.
- The separate GeoJSON overlay supports a smaller expression set and draws on its
  own canvas. Use vector-owned GeoJSON for ordering among basemap layers.
- The library does not supply tile hosting, geocoding, road data or offline package
  generation. Cross-origin data needs provider CORS support. PNG export also
  requires origin-clean images/canvases.
- Automated tests use local fixtures and simulated DOM/Canvas APIs. They verify
  behavior, not visual parity or device FPS; check your workload in a real browser.
