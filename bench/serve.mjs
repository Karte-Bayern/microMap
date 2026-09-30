// Local-only benchmark server: serves this repository and MVT tiles from an
// MBTiles file, so bench/browser.html can measure real rasterisation.
//
//   node bench/serve.mjs path/to/tiles.mbtiles [port] [--style=style.json]
//
// --style serves a MapLibre style at /style.json with its first vector
// source pointed at the local tiles (bench/browser.html?style=/style.json).
// --proxy=https://origin rewrites raster tile URLs of that origin in the
// style to /proxy/… and fetches them server-side (for browsers that cannot
// reach the origin themselves). Images are kept in a small memory cache so
// repeated panning does not hit the origin again.
// Needs Node >= 22.5 (node:sqlite). It binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const styleArg = process.argv.slice(2).find(arg => arg.startsWith('--style='));
const proxyArg = process.argv.slice(2).find(arg => arg.startsWith('--proxy='));
const proxyOrigin = proxyArg ? new URL(proxyArg.slice(8)).origin : null;
const proxyCache = new Map();
const PROXY_CACHE_LIMIT = 2000;
const mbtiles = args[0];
const port = Number(args[1] || 8093);
if (!mbtiles) {
  console.error('usage: node bench/serve.mjs tiles.mbtiles [port]');
  process.exit(2);
}
const db = new DatabaseSync(path.resolve(mbtiles), { readOnly: true });
const tileQuery = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
const metadata = Object.fromEntries(db.prepare('SELECT name, value FROM metadata').all().map(row => [row.name, row.value]));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const tile = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
  if (tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    const row = z <= 30 ? tileQuery.get(z, x, (2 ** z) - 1 - y) : null;
    if (!row) {
      response.writeHead(404).end();
      return;
    }
    const data = Buffer.from(row.tile_data);
    const headers = { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' };
    if (data[0] === 0x1f && data[1] === 0x8b) headers['Content-Encoding'] = 'gzip';
    response.writeHead(200, headers).end(data);
    return;
  }
  if (url.pathname === '/tiles.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      tilejson: '3.0.0', format: 'pbf', scheme: 'xyz', tiles: ['/tiles/{z}/{x}/{y}.pbf'],
      minzoom: +metadata.minzoom || 0, maxzoom: +metadata.maxzoom || 14
    }));
    return;
  }
  if (url.pathname === '/style.json' && styleArg) {
    const style = JSON.parse(await readFile(path.resolve(styleArg.slice(8)), 'utf8'));
    for (const source of Object.values(style.sources || {})) {
      if (source && source.type === 'vector') {
        delete source.url;
        source.tiles = ['/tiles/{z}/{x}/{y}.pbf'];
        break;
      }
    }
    if (proxyOrigin) {
      for (const source of Object.values(style.sources || {})) {
        if (!source || source.type !== 'raster' || !Array.isArray(source.tiles)) continue;
        source.tiles = source.tiles.map(tile => tile.startsWith(proxyOrigin + '/') ? '/proxy' + tile.slice(proxyOrigin.length) : tile);
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(style));
    return;
  }
  if (proxyOrigin && url.pathname.startsWith('/proxy/')) {
    const target = proxyOrigin + url.pathname.slice(6) + url.search;
    let entry = proxyCache.get(target);
    if (!entry) {
      try {
        const upstream = await fetch(target, { headers: { Accept: request.headers.accept || '*/*' } });
        entry = { status: upstream.status, type: upstream.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await upstream.arrayBuffer()) };
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(error && error.message || error));
        return;
      }
      if (entry.status === 200) {
        if (proxyCache.size >= PROXY_CACHE_LIMIT) proxyCache.delete(proxyCache.keys().next().value);
        proxyCache.set(target, entry);
      }
    }
    response.writeHead(entry.status, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' }).end(entry.body);
    return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) || file.split(path.sep).some(part => part.startsWith('.'))) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log('MicroMap bench on http://127.0.0.1:' + port + '/bench/browser.html');
});
