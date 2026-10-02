/*! microMap.pmtiles.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapPMTiles = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var MIME = { 1: 'application/vnd.mapbox-vector-tile', 2: 'image/png', 3: 'image/jpeg', 4: 'image/webp', 5: 'image/avif', 6: 'application/vnd.maplibre-vector-tile' };
  function fail(message) { throw new Error('microMap.pmtiles: ' + message); }
  function u64(view, offset) {
    var value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 4294967296;
    if (!Number.isSafeInteger(value)) fail('archive offset exceeds JavaScript safe integer range');
    return value;
  }
  function bounds(offset, length, maximum) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > maximum) fail('archive section is out of bounds');
  }
  function tileID(z, x, y) {
    if (!Number.isInteger(z) || z < 0 || z > 26) fail('zoom must be an integer from 0 to 26');
    var size = Math.pow(2, z);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) fail('tile coordinates are out of range');
    var id = (Math.pow(4, z) - 1) / 3;
    for (var step = size / 2; step >= 1; step /= 2) {
      var rx = x & step ? 1 : 0;
      var ry = y & step ? 1 : 0;
      id += step * step * ((3 * rx) ^ ry);
      if (!ry) {
        if (rx) { x = step - 1 - x; y = step - 1 - y; }
        var swap = x; x = y; y = swap;
      }
    }
    return id;
  }
  function varint(bytes, state) {
    var result = 0;
    var multiplier = 1;
    for (var i = 0; i < 8; i++) {
      if (state.at >= bytes.length) fail('truncated directory');
      var byte = bytes[state.at++];
      result += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(result)) fail('directory integer exceeds safe range');
      if (!(byte & 128)) return result;
      multiplier *= 128;
    }
    fail('directory varint is too long');
  }
  function directory(bytes) {
    var state = { at: 0 };
    var count = varint(bytes, state);
    if (!count || count > 100000) fail('directory entry count is invalid');
    var entries = new Array(count);
    var last = 0;
    var i;
    for (i = 0; i < count; i++) {
      last += varint(bytes, state);
      entries[i] = { id: last };
      if (i && last <= entries[i - 1].id) fail('directory IDs must increase');
    }
    for (i = 0; i < count; i++) entries[i].run = varint(bytes, state);
    for (i = 0; i < count; i++) {
      entries[i].length = varint(bytes, state);
      if (!entries[i].length) fail('directory entry has zero length');
    }
    for (i = 0; i < count; i++) {
      var value = varint(bytes, state);
      entries[i].offset = value ? value - 1 : (i ? entries[i - 1].offset + entries[i - 1].length : -1);
      if (entries[i].offset < 0) fail('first directory offset is invalid');
    }
    if (state.at !== bytes.length) fail('unexpected directory bytes');
    return entries;
  }
  function find(entries, id) {
    var low = 0; var high = entries.length - 1;
    while (low <= high) {
      var mid = Math.floor((low + high) / 2);
      if (entries[mid].id <= id) low = mid + 1; else high = mid - 1;
    }
    if (high < 0) return null;
    var entry = entries[high];
    return entry.run ? (id < entry.id + entry.run ? entry : null) : entry;
  }
  function decompress(bytes, compression, maximum) {
    if (compression === 1) {
      if (bytes.byteLength > maximum) fail('decoded section exceeds limit');
      return Promise.resolve(bytes);
    }
    var format = compression === 2 ? 'gzip' : compression === 3 ? 'brotli' : compression === 4 ? 'zstd' : null;
    if (!format || !root.DecompressionStream) return Promise.reject(new Error('microMap.pmtiles: unsupported compression ' + compression));
    try {
      var reader = new root.Blob([bytes]).stream().pipeThrough(new root.DecompressionStream(format)).getReader();
      var chunks = []; var size = 0;
      function next() {
        return reader.read().then(function (step) {
          if (step.done) {
            var result = new Uint8Array(size); var at = 0;
            chunks.forEach(function (chunk) { result.set(chunk, at); at += chunk.length; });
            return result;
          }
          size += step.value.length;
          if (size > maximum) { reader.cancel(); fail('decoded section exceeds limit'); }
          chunks.push(step.value);
          return next();
        });
      }
      return next();
    } catch (error) { return Promise.reject(error); }
  }

  function PMTiles(source, options) {
    if (!(this instanceof PMTiles)) return new PMTiles(source, options);
    options = options || {};
    if (typeof source !== 'string' && !(root.Blob && source instanceof root.Blob)) fail('source must be an HTTP URL or Blob');
    this.source = source;
    this.fetcher = options.fetch || root.fetch;
    this.maxTileBytes = Math.min(67108864, Math.max(1024, +options.maxTileBytes || 8388608));
    this.headerPromise = null;
    this.rootPromise = null;
    this.leaves = new Map();
    this.etag = null;
  }
  PMTiles.prototype.read = function (offset, length, signal) {
    var self = this;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || !length || length > 67108864 || !Number.isSafeInteger(offset + length)) {
      return Promise.reject(new Error('microMap.pmtiles: invalid byte range'));
    }
    if (root.Blob && this.source instanceof root.Blob) {
      bounds(offset, length, this.source.size);
      return this.source.slice(offset, offset + length).arrayBuffer().then(function (data) { return new Uint8Array(data); });
    }
    if (typeof this.fetcher !== 'function') return Promise.reject(new Error('microMap.pmtiles: fetch is required'));
    var headers = { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
    return Promise.resolve(this.fetcher(this.source, { headers: headers, signal: signal })).then(function (response) {
      if (!response || response.status !== 206) fail('HTTP source must support byte ranges (206)');
      var range = response.headers && response.headers.get && response.headers.get('Content-Range');
      if (!range || !new RegExp('^bytes ' + offset + '-' + (offset + length - 1) + '/').test(range)) fail('server returned an unexpected byte range');
      var etag = response.headers.get('ETag');
      if (self.etag && etag && etag !== self.etag) fail('archive changed during reading');
      if (!self.etag && etag) self.etag = etag;
      return response.arrayBuffer();
    }).then(function (data) {
      if (data.byteLength !== length) fail('server returned the wrong number of bytes');
      return new Uint8Array(data);
    });
  };
  PMTiles.prototype.getHeader = function () {
    if (this.headerPromise) return this.headerPromise;
    var self = this;
    this.headerPromise = this.read(0, 127).then(function (bytes) {
      var magic = 'PMTiles';
      for (var i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) fail('invalid PMTiles magic');
      if (bytes[7] !== 3) fail('only PMTiles v3 is supported');
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var header = {
        rootOffset: u64(view, 8), rootLength: u64(view, 16),
        metadataOffset: u64(view, 24), metadataLength: u64(view, 32),
        leafOffset: u64(view, 40), leafLength: u64(view, 48),
        tileOffset: u64(view, 56), tileLength: u64(view, 64),
        internalCompression: bytes[97], tileCompression: bytes[98], tileType: bytes[99],
        minZoom: bytes[100], maxZoom: bytes[101],
        bounds: [view.getInt32(102, true) / 1e7, view.getInt32(106, true) / 1e7, view.getInt32(110, true) / 1e7, view.getInt32(114, true) / 1e7],
        center: [view.getInt32(119, true) / 1e7, view.getInt32(123, true) / 1e7], centerZoom: bytes[118]
      };
      if (header.rootOffset < 127 || header.rootOffset + header.rootLength > 16384 || !header.rootLength) fail('root directory must fit in the first 16 KiB');
      if (header.maxZoom > 26) fail('archive zoom exceeds supported safe tile ID range');
      self.rootPromise = self.read(header.rootOffset, header.rootLength).then(function (rootBytes) {
        return decompress(rootBytes, header.internalCompression, 4194304);
      }).then(directory);
      return self.rootPromise.then(function () { return header; });
    });
    return this.headerPromise;
  };
  PMTiles.prototype.getMetadata = function () {
    var self = this;
    return this.getHeader().then(function (header) {
      if (header.metadataLength > 1048576) fail('metadata exceeds 1 MiB');
      return self.read(header.metadataOffset, header.metadataLength).then(function (bytes) {
        return decompress(bytes, header.internalCompression, 1048576);
      }).then(function (decoded) { return JSON.parse(new TextDecoder().decode(decoded)); });
    });
  };
  PMTiles.prototype.getTile = function (z, x, y, signal) {
    var self = this;
    var id = tileID(z, x, y);
    return this.getHeader().then(function (header) {
      if (z < header.minZoom || z > header.maxZoom) return null;
      function lookup(entries, depth) {
        var entry = find(entries, id);
        if (!entry) return Promise.resolve(null);
        if (entry.run) {
          bounds(entry.offset, entry.length, header.tileLength);
          if (entry.length > self.maxTileBytes) fail('tile exceeds maxTileBytes');
          return self.read(header.tileOffset + entry.offset, entry.length, signal).then(function (bytes) {
            return decompress(bytes, header.tileCompression, self.maxTileBytes);
          }).then(function (data) { return { data: data, mime: MIME[header.tileType] || 'application/octet-stream' }; });
        }
        if (depth >= 4) fail('too many leaf directory levels');
        bounds(entry.offset, entry.length, header.leafLength);
        if (entry.length > 4194304) fail('leaf directory exceeds limit');
        var key = entry.offset + '/' + entry.length;
        var promise = self.leaves.get(key);
        if (!promise) {
          promise = self.read(header.leafOffset + entry.offset, entry.length).then(function (bytes) {
            return decompress(bytes, header.internalCompression, 4194304);
          }).then(directory);
          self.leaves.set(key, promise);
          if (self.leaves.size > 32) self.leaves.delete(self.leaves.keys().next().value);
        }
        return promise.then(function (leaf) { return lookup(leaf, depth + 1); });
      }
      return self.rootPromise.then(function (rootDirectory) { return lookup(rootDirectory, 0); });
    });
  };
  PMTiles.prototype.vectorOptions = function () {
    var self = this;
    var fallback = this.fetcher;
    return {
      tiles: function (z, x, y) { var count = Math.pow(2, z); return 'micromap-pmtiles://' + z + '/' + ((x % count + count) % count) + '/' + y; },
      fetch: function (url, options) {
        var match = /^micromap-pmtiles:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
        if (!match) return fallback(url, options);
        return self.getHeader().then(function (header) {
          if (header.tileType !== 1) fail('vectorOptions requires an MVT archive');
          return self.getTile(+match[1], +match[2], +match[3], options && options.signal);
        }).then(function (tile) {
          return { ok: !!tile, status: tile ? 200 : 404, arrayBuffer: function () { return Promise.resolve(tile && tile.data.buffer.slice(tile.data.byteOffset, tile.data.byteOffset + tile.data.byteLength)); } };
        });
      }
    };
  };
  PMTiles.prototype.rasterSource = function () {
    var self = this;
    return { type: 'raster', tiles: function (z, x, y) {
      return self.getTile(z, x, y).then(function (tile) {
        if (!tile) throw new Error('microMap.pmtiles: raster tile not found');
        if (tile.mime.indexOf('image/') !== 0) fail('archive does not contain raster images');
        return new root.Blob([tile.data], { type: tile.mime });
      });
    } };
  };

  PMTiles.tileID = tileID;
  if (typeof microMap === 'function' && !microMap.pmtiles) microMap.pmtiles = PMTiles;
  return PMTiles;
});
