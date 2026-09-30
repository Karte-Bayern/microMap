# microMap.js

A dependency-free JavaScript map library for XYZ raster tiles, with optional
vector rendering, GeoJSON overlays and UI controls. MIT licensed.

## Install

```sh
npm install @karte.bayern/micromap
```

Until the first npm release, use `npm pack` in this checkout and install the
resulting `.tgz` in your application.

## Quick start

Create a container with a height, then use the core in a browser application
with a bundler:

```html
<div id="map" style="height:420px"></div>
```

```js
import microMap from '@karte.bayern/micromap';

const map = microMap('#map', {
  center: [12.491, 48.63], // [longitude, latitude]
  zoom: 12,
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors'
});
```

Without a bundler, load `lib/microMap.min.js` with a script tag; it exposes
`window.microMap`. Tile sources must allow your requests and retain their required
attribution. Add-ons are imported separately, for example
`@karte.bayern/micromap/vector`.

## Documentation

- [Core API and limitations](docs/reference.md)
- [Optional modules and examples](docs/modules.md)
- [Browser demos](https://github.com/Karte-Bayern/microMap/tree/main/demo)

## Development

Use Node.js 22 or 24:

```sh
npm ci
npm run check
make serve
```

After editing `lib/`, run `npm run build` before checking. For rendering or
interaction changes, also open the relevant `test/` or `demo/` page in a browser.

Maintained by [Simon Waldherr](https://github.com/SimonWaldherr/).
[MIT license](LICENSE); map data and imagery have separate licenses.
