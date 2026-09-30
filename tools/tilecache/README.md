# Local tile proxy

A Go development server for the checkout, with disk caching for XYZ raster tiles,
MVT/PBF tiles and TileJSON. Requires Go; uses no third-party Go modules.

## Run

From the repository root:

```sh
make dev
```

Open [the raster demo](http://127.0.0.1:8091/demo/?tiles=local) or
[the vector demo](http://127.0.0.1:8091/demo/vector.html). Override the address with
`make dev TILECACHE_ADDR=127.0.0.1:8092`.

To set additional flags, run from this directory, which owns the Go module:

```sh
cd tools/tilecache
go run . -static ../.. -upstream https://tile.openstreetmap.org
```

`make test-tilecache` runs the proxy tests from the repository root.

## Routes and cache

- `/{z}/{x}/{y}.ext` caches tiles from the configured upstream host.
- `/fetch?u=<encoded absolute URL>` caches public HTTP(S) resources. It rejects
  local/private addresses and validates redirects and connections.
- Other paths serve the `-static` directory; hidden paths such as `.git` are blocked.

Use the vector demo from the proxy's own origin. Its local proxy can be bypassed
with `?cache=off` when the upstream permits browser CORS. The proxy does not grant
CORS access to arbitrary other origins.

Karte.Bayern TileJSON, aerial imagery and orthophoto notices pass through live
without caching so revisions and credits remain current. Revisioned MVT tiles
are cached. Duplicate concurrent requests share one upstream fetch.

The cache does not expire. Stop the server and remove its cache directory when
fresh responses are needed. New misses fail when the cache reaches its size limit.
Respect provider usage policies; use this tool for interactive development rather
than bulk downloading.

## Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `-addr` | `127.0.0.1:8091` | Listen address |
| `-upstream` | `https://tile.openstreetmap.org` | Raster tile base URL |
| `-cache` | `./tilecache-data` | Disk cache directory, relative to the process |
| `-static` | `.` | Static root; empty disables static serving |
| `-max-inflight` | `2` | Concurrent upstream requests |
| `-max-response-bytes` | `8388608` | Per-response limit (8 MiB) |
| `-max-cache-bytes` | `268435456` | Total cache limit (256 MiB) |
| `-allow-remote-fetch` | `true` | Enable `/fetch` |
| `-user-agent` | `microMap.js-dev-tilecache/1.0 (local development proxy)` | Upstream request identification |

Use `go run . -h` for flag details. `make dev` serves the repository root and keeps
its cache in `tools/tilecache/tilecache-data/`; `make bench` uses `BENCH_CACHE`.
