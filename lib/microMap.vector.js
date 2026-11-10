/*! microMap.vector.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapVector = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  // microMap.vector is deliberately a separate, dependency-free add-on. It
  // decodes Mapbox Vector Tiles (MVT/PBF) and draws a small, documented style
  // subset into a canvas; it is not a partial MapLibre GL replacement.
  var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
  var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;
  var EARTH_CIRCUMFERENCE = 40075016.6856; // meters, WGS84 equator, for fill-extrusion's meters-to-pixels
  var textDecoder = root.TextDecoder ? new root.TextDecoder('utf-8') : null;

  function finite(value, fallback) {
    value = +value;
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function positiveInteger(value, fallback, max) {
    value = Math.floor(finite(value, fallback));
    return clamp(value, 1, max || 0x7fffffff);
  }

  function nonNegativeInteger(value, fallback, max) {
    value = Math.floor(finite(value, fallback));
    return clamp(value, 0, max == null ? 0x7fffffff : max);
  }

  function decodeText(bytes) {
    if (textDecoder) return textDecoder.decode(bytes);
    var result = '';
    for (var i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
    return result;
  }

  function Reader(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.end = bytes.length;
  }

  Reader.prototype.varint = function () {
    // Most MVT varints (tags, deltas, command headers) fit in one byte.
    if (this.pos < this.end && this.bytes[this.pos] < 128) return this.bytes[this.pos++];
    var value = 0;
    var multiplier = 1;
    var byte;
    for (var i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('microMap.vector: truncated varint');
      byte = this.bytes[this.pos++];
      value += (byte & 127) * multiplier;
      if (value > 9007199254740991) {
        throw new Error('microMap.vector: integer exceeds the safe JavaScript range');
      }
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('microMap.vector: invalid varint');
  };

  // MVT permits 64-bit feature IDs and property values. Keep ordinary
  // protobuf fields as Numbers, but preserve large values as BigInts rather
  // than silently rounding them. BigInt has been available in the browsers
  // that expose the fetch/Canvas APIs this add-on needs; older runtimes still
  // decode values in the safe Number range through varint().
  Reader.prototype.varint64 = function () {
    if (typeof BigInt !== 'function') return this.varint();
    var value = BigInt(0);
    var shift = BigInt(0);
    var byte;
    for (var i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('microMap.vector: truncated varint');
      byte = this.bytes[this.pos++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
      shift += BigInt(7);
    }
    throw new Error('microMap.vector: invalid varint');
  };

  // Reads a length-delimited header and returns the field's end offset.
  Reader.prototype.lengthEnd = function () {
    var length = this.varint();
    if (!isFinite(length) || length < 0 || length > this.end - this.pos) {
      throw new Error('microMap.vector: invalid protobuf length');
    }
    return this.pos + length;
  };

  Reader.prototype.bytesValue = function () {
    var end = this.lengthEnd();
    var value = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return value;
  };

  Reader.prototype.fixed = function (length) {
    if (this.pos + length > this.end) throw new Error('microMap.vector: truncated fixed field');
    var value = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  };

  Reader.prototype.skip = function (wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.fixed(8);
    else if (wire === 2) this.bytesValue();
    else if (wire === 5) this.fixed(4);
    else throw new Error('microMap.vector: unsupported protobuf wire type ' + wire);
  };

  // Packed varints are read through the tile's single reader with a narrowed
  // end, so a value can never run past its field and no sub-reader is
  // allocated per feature. `base` makes the limit aggregate across repeated
  // packed fields; `bounds` checks alternating key/value tag indexes.
  function readPacked(reader, target, base, limit, bounds) {
    var end = reader.lengthEnd();
    var outer = reader.end;
    reader.end = end;
    while (reader.pos < end) {
      if (target.length - base >= limit) throw new Error('microMap.vector: packed field is too large');
      var value = reader.varint();
      if (bounds && value >= bounds[(target.length - base) % 2]) {
        throw new Error('microMap.vector: feature tag index is out of bounds');
      }
      target.push(value);
    }
    reader.end = outer;
  }

  // A growable typed array: a layer's coordinates, tag indexes and ring
  // offsets live in three compact arrays instead of one Array per vertex.
  function Growable(Type) {
    this.Type = Type;
    this.array = new Type(256);
    this.length = 0;
  }

  Growable.prototype.push = function (value) {
    if (this.length === this.array.length) {
      var next = new this.Type(this.length * 2);
      next.set(this.array);
      this.array = next;
    }
    this.array[this.length++] = value;
  };

  function zigZag(value) {
    return value % 2 ? -(value + 1) / 2 : value / 2;
  }

  function safeInteger(value) {
    if (typeof value !== 'bigint') return value;
    var maximum = BigInt(9007199254740991);
    return value >= -maximum && value <= maximum ? Number(value) : value;
  }

  function signedInteger(reader) {
    var value = reader.varint64();
    if (typeof value !== 'bigint') return value;
    var sign = BigInt(1) << BigInt(63);
    var range = BigInt(1) << BigInt(64);
    return safeInteger(value & sign ? value - range : value);
  }

  function zigZagInteger(reader) {
    var value = reader.varint64();
    if (typeof value !== 'bigint') return zigZag(value);
    return safeInteger((value >> BigInt(1)) ^ -(value & BigInt(1)));
  }

  function decodeValue(bytes) {
    var reader = new Reader(bytes);
    var value = null;
    while (reader.pos < reader.end) {
      var tag = reader.varint();
      var field = Math.floor(tag / 8);
      var wire = tag % 8;
      if (field === 1 && wire === 2) value = decodeText(reader.bytesValue());
      else if (field === 2 && wire === 5) value = new DataView(reader.fixed(4).buffer, reader.bytes.byteOffset + reader.pos - 4, 4).getFloat32(0, true);
      else if (field === 3 && wire === 1) value = new DataView(reader.fixed(8).buffer, reader.bytes.byteOffset + reader.pos - 8, 8).getFloat64(0, true);
      else if (field === 4 && wire === 0) value = signedInteger(reader);
      else if (field === 5 && wire === 0) value = safeInteger(reader.varint64());
      else if (field === 6 && wire === 0) value = zigZagInteger(reader);
      else if (field === 7 && wire === 0) value = !!reader.varint();
      else reader.skip(wire);
    }
    return value;
  }

  var commandScratch = [];

  function decodeGeometry(commands, type, store) {
    var x = 0;
    var y = 0;
    var index = 0;
    var open = false;
    var coords = store.coords;
    while (index < commands.length) {
      var command = commands[index++];
      var id = command % 8;
      var count = Math.floor(command / 8);
      if (!count) throw new Error('microMap.vector: geometry command has no count');
      if (id === 1 || id === 2) {
        if (id === 2 && (!open || type === 1)) throw new Error('microMap.vector: LineTo before MoveTo');
        if (index + 2 * count > commands.length) {
          throw new Error('microMap.vector: truncated ' + (id === 1 ? 'MoveTo' : 'LineTo') + ' command');
        }
        for (var i = 0; i < count; i++) {
          x += zigZag(commands[index++]);
          y += zigZag(commands[index++]);
          // Every MoveTo starts a part: a ring, a line or a single point.
          if (id === 1) store.parts.push(coords.length / 2);
          coords.push(x);
          coords.push(y);
        }
        open = true;
      } else if (id === 7) {
        if (!open || type !== 3) throw new Error('microMap.vector: unexpected ClosePath command');
      } else {
        throw new Error('microMap.vector: unsupported geometry command ' + id);
      }
    }
  }

  // Decoded features keep geometry and tags in their layer's shared typed
  // arrays: a dense city tile needs a few MiB instead of tens of MiB of
  // per-vertex Arrays. `properties` and the nested `geometry` arrays of the
  // public shape are only built when a caller actually reads them.
  function VectorFeature(layer, id, type, tagStart, tagEnd, partStart, partEnd) {
    this.id = id;
    this.type = type;
    this._layer = layer;
    this._tagStart = tagStart;
    this._tagEnd = tagEnd;
    this._partStart = partStart;
    this._partEnd = partEnd;
    this._properties = null;
    this._geometry = null;
  }

  Object.defineProperty(VectorFeature.prototype, 'properties', {
    get: function () {
      if (!this._properties) {
        var layer = this._layer;
        var properties = Object.create(null);
        for (var i = this._tagStart; i < this._tagEnd; i += 2) {
          properties[layer.keys[layer.tags[i]]] = layer.values[layer.tags[i + 1]];
        }
        this._properties = properties;
      }
      return this._properties;
    },
    set: function (value) { this._properties = value; }
  });

  Object.defineProperty(VectorFeature.prototype, 'geometry', {
    get: function () {
      if (!this._geometry) {
        var layer = this._layer;
        var geometry = [];
        for (var p = this._partStart; p < this._partEnd; p++) {
          var part = [];
          for (var i = layer.parts[p]; i < layer.parts[p + 1]; i++) part.push([layer.coords[2 * i], layer.coords[2 * i + 1]]);
          if (this.type === 3) part.closed = true;
          geometry.push(part);
        }
        this._geometry = geometry;
      }
      return this._geometry;
    },
    set: function (value) { this._geometry = value; }
  });

  VectorFeature.prototype.toJSON = function () {
    return { id: this.id, type: this.type, properties: this.properties, geometry: this.geometry };
  };

  // Filters and style values read single properties by comparing key indexes
  // in the shared tag array, without building a properties object.
  function prop(feature, key) {
    var layer = feature._layer;
    if (!layer || feature._properties || layer.duplicateKeys) return feature.properties[key];
    var index = layer.keyIndex[key];
    var value;
    if (index === undefined) return value;
    for (var i = feature._tagStart; i < feature._tagEnd; i += 2) {
      if (layer.tags[i] === index) value = layer.values[layer.tags[i + 1]];
    }
    return value;
  }

  function hasProp(feature, key) {
    var layer = feature._layer;
    if (!layer || feature._properties || layer.duplicateKeys) return own(feature.properties, key);
    var index = layer.keyIndex[key];
    if (index === undefined) return false;
    for (var i = feature._tagStart; i < feature._tagEnd; i += 2) if (layer.tags[i] === index) return true;
    return false;
  }

  function decodeFeature(reader, end, layer, store, limits) {
    var id = null;
    var type = 0;
    var tagStart = store.tags.length;
    var bounds = [layer.keys.length, layer.values.length];
    var commands = commandScratch;
    commands.length = 0;
    var outer = reader.end;
    reader.end = end;
    while (reader.pos < end) {
      var tag = reader.varint();
      var field = Math.floor(tag / 8);
      var wire = tag % 8;
      if (field === 1 && wire === 0) id = safeInteger(reader.varint64());
      else if (field === 2 && wire === 2) readPacked(reader, store.tags, tagStart, limits.maxTags, bounds);
      else if (field === 3 && wire === 0) type = reader.varint();
      else if (field === 4 && wire === 2) readPacked(reader, commands, 0, limits.maxCommands);
      else reader.skip(wire);
    }
    reader.end = outer;
    if (type < 1 || type > 3) throw new Error('microMap.vector: unsupported feature geometry type');
    if ((store.tags.length - tagStart) % 2) throw new Error('microMap.vector: feature tags are not pairs');
    var partStart = store.parts.length;
    decodeGeometry(commands, type, store);
    return new VectorFeature(layer, id, type, tagStart, store.tags.length, partStart, store.parts.length);
  }

  function decodeLayer(reader, end, limits) {
    var name = null;
    var ranges = [];
    var keys = [];
    var values = [];
    var extent = 4096;
    var version = null;
    var outer = reader.end;
    reader.end = end;
    while (reader.pos < end) {
      var tag = reader.varint();
      var field = Math.floor(tag / 8);
      var wire = tag % 8;
      if (field === 1 && wire === 2) name = decodeText(reader.bytesValue());
      else if (field === 2 && wire === 2) {
        if (ranges.length / 2 >= limits.maxFeatures) throw new Error('microMap.vector: tile has too many features');
        var featureEnd = reader.lengthEnd();
        // Features may precede keys/values in the message: decode them after.
        ranges.push(reader.pos, featureEnd);
        reader.pos = featureEnd;
      } else if (field === 3 && wire === 2) keys.push(decodeText(reader.bytesValue()));
      else if (field === 4 && wire === 2) values.push(decodeValue(reader.bytesValue()));
      else if (field === 5 && wire === 0) extent = reader.varint();
      else if (field === 15 && wire === 0) version = reader.varint();
      else reader.skip(wire);
    }
    if (!name) throw new Error('microMap.vector: MVT layer has no name');
    if (version !== 2) throw new Error('microMap.vector: only MVT version 2 is supported');
    if (!isFinite(extent) || extent < 1) throw new Error('microMap.vector: invalid MVT layer extent');
    var layer = newLayer(name, extent, version, keys, values);
    var store = { tags: new Growable(Uint32Array), parts: new Growable(Uint32Array), coords: new Growable(Int32Array) };
    for (var i = 0; i < ranges.length; i += 2) {
      if (limits.featureCount++ >= limits.maxFeatures) throw new Error('microMap.vector: tile has too many features');
      reader.pos = ranges[i];
      layer.features.push(decodeFeature(reader, ranges[i + 1], layer, store, limits));
    }
    // A final sentinel: part p always spans parts[p] .. parts[p + 1].
    store.parts.push(store.coords.length / 2);
    layer.tags = store.tags.array.slice(0, store.tags.length);
    layer.parts = store.parts.array.slice(0, store.parts.length);
    layer.coords = store.coords.array.slice(0, store.coords.length);
    reader.pos = end;
    reader.end = outer;
    return layer;
  }

  function newLayer(name, extent, version, keys, values) {
    var layer = {
      name: name, extent: extent, version: version, features: [], keys: keys, values: values,
      keyIndex: Object.create(null), duplicateKeys: false, tags: null, parts: null, coords: null
    };
    for (var k = 0; k < keys.length; k++) {
      if (own(layer.keyIndex, keys[k])) layer.duplicateKeys = true;
      else layer.keyIndex[keys[k]] = k;
    }
    return layer;
  }

  // ---- Worker decoding ------------------------------------------------------
  // A decoded tile crosses the worker boundary as its typed arrays (moved,
  // not copied) plus a small feature table; features are rebuilt around
  // them. The worker runs this same file, recognised by its worker name, so
  // no blob: URL or separate worker file is needed.
  var WORKER_NAME = 'micromap-vector-decoder';

  function packTile(tile) {
    var transfer = [];
    var layers = [];
    for (var l = 0; l < tile.layers.length; l++) {
      var layer = tile.layers[l];
      var count = layer.features.length;
      var ids = new Array(count);
      var types = new Uint8Array(count);
      var ranges = new Uint32Array(count * 4);
      for (var i = 0; i < count; i++) {
        var feature = layer.features[i];
        ids[i] = feature.id;
        types[i] = feature.type;
        ranges[4 * i] = feature._tagStart;
        ranges[4 * i + 1] = feature._tagEnd;
        ranges[4 * i + 2] = feature._partStart;
        ranges[4 * i + 3] = feature._partEnd;
      }
      transfer.push(layer.tags.buffer, layer.parts.buffer, layer.coords.buffer, types.buffer, ranges.buffer);
      layers.push({
        name: layer.name, extent: layer.extent, version: layer.version, keys: layer.keys, values: layer.values,
        tags: layer.tags, parts: layer.parts, coords: layer.coords, ids: ids, types: types, ranges: ranges
      });
    }
    return { layers: layers, transfer: transfer };
  }

  function unpackTile(packed) {
    if (!Array.isArray(packed)) throw new Error('microMap.vector: invalid worker response');
    var layers = [];
    for (var l = 0; l < packed.length; l++) {
      var value = packed[l];
      var layer = newLayer(value.name, value.extent, value.version, value.keys, value.values);
      layer.tags = value.tags;
      layer.parts = value.parts;
      layer.coords = value.coords;
      var ranges = value.ranges;
      for (var i = 0; i < value.types.length; i++) {
        layer.features.push(new VectorFeature(layer, value.ids[i], value.types[i], ranges[4 * i], ranges[4 * i + 1], ranges[4 * i + 2], ranges[4 * i + 3]));
      }
      layers.push(layer);
    }
    return { layers: layers };
  }

  function workerMessage(data) {
    data = data || {};
    try {
      var packed = packTile(decodeMVT(data.buffer, data.limits));
      return { message: { id: data.id, layers: packed.layers }, transfer: packed.transfer };
    } catch (error) {
      return { message: { id: data.id, error: String(error && error.message || error) }, transfer: [] };
    }
  }

  var DECODE_LIMITS = ['maxTileBytes', 'maxLayers', 'maxFeatures', 'maxTags', 'maxCommands'];
  var decoderPools = new Map();

  // One shared worker per script URL, used by every vector layer of a page.
  // If it cannot start or fails, its jobs and all later ones decode on the
  // main thread, so a strict CSP or a file:// page still renders.
  function decoderPool(url) {
    var pool = decoderPools.get(url);
    if (pool) {
      pool.users++;
      return pool;
    }
    pool = { url: url, worker: null, jobs: new Map(), next: 1, users: 1, failed: false };
    decoderPools.set(url, pool);
    try {
      pool.worker = new root.Worker(url, { name: WORKER_NAME });
      pool.worker.addEventListener('message', function (event) {
        var data = event.data || {};
        var job = pool.jobs.get(data.id);
        if (!job) return;
        pool.jobs.delete(data.id);
        if (data.error) job.reject(new Error(data.error));
        else {
          try {
            job.resolve(unpackTile(data.layers));
          } catch (error) {
            job.reject(error);
          }
        }
      });
      pool.worker.addEventListener('error', function () { failPool(pool); });
      pool.worker.addEventListener('messageerror', function () { failPool(pool); });
    } catch (error) {
      pool.failed = true;
    }
    return pool;
  }

  function failPool(pool) {
    if (pool.failed) return;
    pool.failed = true;
    if (pool.worker) pool.worker.terminate();
    pool.jobs.forEach(function (job) {
      try {
        job.resolve(decodeMVT(job.buffer, job.limits));
      } catch (error) {
        job.reject(error);
      }
    });
    pool.jobs.clear();
  }

  function releasePool(pool) {
    if (!pool || --pool.users > 0) return;
    if (pool.worker) pool.worker.terminate();
    pool.jobs.clear();
    decoderPools.delete(pool.url);
  }

  function decodeWith(pool, buffer, options) {
    var limits = {};
    for (var i = 0; i < DECODE_LIMITS.length; i++) if (options[DECODE_LIMITS[i]] != null) limits[DECODE_LIMITS[i]] = options[DECODE_LIMITS[i]];
    return new Promise(function (resolve, reject) {
      if (!pool || pool.failed) {
        resolve(decodeMVT(buffer, limits));
        return;
      }
      var id = pool.next++;
      // The buffer is copied, not moved, so a failing worker can fall back.
      pool.jobs.set(id, { resolve: resolve, reject: reject, buffer: buffer, limits: limits });
      pool.worker.postMessage({ id: id, buffer: buffer, limits: limits });
    });
  }

  // The script URL this file was loaded from, when it is the standalone
  // vector bundle or the all-in-one micromap bundle (not an application
  // bundle, which must not run in a worker).
  var scriptURL = null;
  try {
    var currentScript = root.document && root.document.currentScript;
    if (currentScript && /(microMap\.vector|\/micromap)(\.min)?\.js([?#]|$)/.test(currentScript.src || '')) scriptURL = currentScript.src;
  } catch (error) {
    scriptURL = null;
  }

  function limitsFor(options) {
    options = options || {};
    return {
      maxBytes: positiveInteger(options.maxTileBytes, 4 * 1024 * 1024, 64 * 1024 * 1024),
      maxLayers: positiveInteger(options.maxLayers, 64, 1024),
      maxFeatures: positiveInteger(options.maxFeatures, 20000, 500000),
      // Per feature. Coastlines and water at low zooms of planet tiles exceed
      // 200 000 commands; maxBytes already bounds a tile's total work.
      maxTags: positiveInteger(options.maxTags, 20000, 100000),
      maxCommands: positiveInteger(options.maxCommands, 2000000, 2000000),
      featureCount: 0
    };
  }

  function decodeMVT(input, options) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var limits = limitsFor(options);
    if (bytes.length > limits.maxBytes) throw new Error('microMap.vector: tile exceeds maxTileBytes');
    var reader = new Reader(bytes);
    var layers = [];
    while (reader.pos < reader.end) {
      var tag = reader.varint();
      var field = Math.floor(tag / 8);
      var wire = tag % 8;
      if (field === 3 && wire === 2) {
        if (layers.length >= limits.maxLayers) throw new Error('microMap.vector: tile has too many layers');
        layers.push(decodeLayer(reader, reader.lengthEnd(), limits));
      } else reader.skip(wire);
    }
    return { layers: layers };
  }

  // Optional format add-ons can decode into a small, format-neutral tile
  // shape. Keep conversion to the renderer's typed arrays here so style,
  // query and worker paths continue to consume one internal representation.
  function normalizeDecodedTile(value, options) {
    if (!value || !Array.isArray(value.layers)) throw new Error('microMap.vector: custom decoder must return { layers }');
    var limits = limitsFor(options);
    if (value.layers.length > limits.maxLayers) throw new Error('microMap.vector: tile has too many layers');
    var layers = [];
    for (var l = 0; l < value.layers.length; l++) {
      var source = value.layers[l];
      if (!source || typeof source.name !== 'string' || !source.name || !Array.isArray(source.features)) throw new Error('microMap.vector: custom decoder returned an invalid layer');
      var extent = +source.extent;
      if (!Number.isSafeInteger(extent) || extent < 1 || extent > 2147483647) throw new Error('microMap.vector: custom decoder returned an invalid extent');
      if (limits.featureCount + source.features.length > limits.maxFeatures) throw new Error('microMap.vector: tile has too many features');
      limits.featureCount += source.features.length;
      var layer = newLayer(source.name, extent, 2, [], []);
      var store = { parts: new Growable(Uint32Array), coords: new Growable(Int32Array) };
      var tagCount = 0;
      for (var f = 0; f < source.features.length; f++) {
        var item = source.features[f];
        if (!item || (item.type !== 1 && item.type !== 2 && item.type !== 3) || !Array.isArray(item.parts) || !item.parts.length) throw new Error('microMap.vector: custom decoder returned invalid feature geometry');
        if (item.id != null && typeof item.id !== 'string' && typeof item.id !== 'bigint' && (!Number.isSafeInteger(item.id) && !isFinite(item.id))) throw new Error('microMap.vector: custom decoder returned an invalid feature ID');
        var props = item.properties == null ? {} : item.properties;
        if (typeof props !== 'object' || Array.isArray(props)) throw new Error('microMap.vector: custom decoder returned invalid properties');
        for (var key in props) if (own(props, key) && props[key] != null) {
          var propValue = props[key];
          if (typeof propValue !== 'string' && typeof propValue !== 'boolean' && typeof propValue !== 'number') throw new Error('microMap.vector: custom decoder property values must be scalar');
          if (typeof propValue === 'number' && !isFinite(propValue)) throw new Error('microMap.vector: custom decoder returned a non-finite property');
          if ((tagCount += 2) > limits.maxTags) throw new Error('microMap.vector: tile has too many tags');
        }
        var partStart = store.parts.length;
        for (var p = 0; p < item.parts.length; p++) {
          var positions = item.parts[p];
          var minimum = item.type === 1 ? 1 : item.type === 2 ? 2 : 3;
          if (!Array.isArray(positions) || positions.length < minimum) throw new Error('microMap.vector: custom decoder returned an invalid geometry part');
          store.parts.push(store.coords.length / 2);
          for (var q = 0; q < positions.length; q++) {
            var point = positions[q];
            if (!Array.isArray(point) || point.length < 2 || !Number.isSafeInteger(point[0]) || !Number.isSafeInteger(point[1]) || point[0] < -2147483648 || point[0] > 2147483647 || point[1] < -2147483648 || point[1] > 2147483647) throw new Error('microMap.vector: custom decoder returned an invalid coordinate');
            store.coords.push(point[0]); store.coords.push(point[1]);
            if (store.coords.length / 2 > limits.maxCommands) throw new Error('microMap.vector: tile has too many coordinates');
          }
        }
        var feature = new VectorFeature(layer, item.id == null ? null : item.id, item.type, 0, 0, partStart, store.parts.length);
        feature._properties = props;
        layer.features.push(feature);
      }
      store.parts.push(store.coords.length / 2);
      layer.tags = new Uint32Array(0);
      layer.parts = store.parts.array.slice(0, store.parts.length);
      layer.coords = store.coords.array.slice(0, store.coords.length);
      layers.push(layer);
    }
    return { layers: layers };
  }

  function worldY(latitude) {
    var lat = clamp(finite(latitude, 0), -85.05112878, 85.05112878) * Math.PI / 180;
    return (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
  }

  function worldX(longitude) {
    return (finite(longitude, 0) + 180) / 360;
  }

  function templateUrl(source, z, x, y, subdomains, tms) {
    var count = Math.pow(2, z);
    if (typeof source === 'function') return source(z, x, tms ? count - y - 1 : y);
    var domain = subdomains.charAt(((x + y) % subdomains.length + subdomains.length) % subdomains.length);
    return source
      .split('{z}').join(z)
      .split('{x}').join(x)
      .split('{y}').join(tms ? count - y - 1 : y)
      .split('{-y}').join(count - y - 1)
      .split('{s}').join(domain);
  }

  function vectorTileJSONTemplate(tilejson, base) {
    var template = tilejson && tilejson.tiles && tilejson.tiles[0];
    if (typeof template !== 'string' || !template) throw invalidTileJSON('TileJSON has no tile template');
    if (template.indexOf('{z}') < 0 || template.indexOf('{x}') < 0 || (template.indexOf('{y}') < 0 && template.indexOf('{-y}') < 0)) {
      throw invalidTileJSON('TileJSON tile template must contain {z}, {x} and {y}');
    }
    var pathname = template.split('?')[0];
    var filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    var dot = filename.lastIndexOf('.');
    var extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
    var format = tilejson.format == null ? '' : String(tilejson.format).toLowerCase();
    var isMVTFormat = format === 'mvt' || format === 'pbf';
    var isMVTExtension = extension === 'mvt' || extension === 'pbf';
    var isRasterExtension = /^(png|jpg|jpeg|webp|avif|gif)$/.test(extension);
    if ((!format && !isMVTExtension) || (format && !isMVTFormat) || (isMVTFormat && isRasterExtension)) {
      throw invalidTileJSON('TileJSON must describe MVT/PBF tiles');
    }
    if (typeof root.URL === 'function') {
      try {
        var documentURL = root.location && root.location.href ? new root.URL(base, root.location.href).href : base;
        template = new root.URL(template, documentURL).href.replace(/%7B(z|x|y|-y|s)%7D/gi, '{$1}');
      } catch (error) {}
    }
    return template;
  }

  function invalidTileJSON(message) {
    var error = styleError(message);
    error.permanent = true;
    return error;
  }

  // ---- Style expressions ---------------------------------------------------
  // A compiled subset of the MapLibre style specification. Every value is
  // compiled once into a closure plus its dependencies (camera zoom and the
  // feature properties it reads). Buckets use those dependencies to group
  // features that always evaluate alike, so a data-driven, zoom-interpolated
  // road width still draws from a few cached paths per tile.
  var GEOMETRY_TYPES = [null, 'Point', 'LineString', 'Polygon'];
  var EMPTY_CONTEXT = { zoom: 0, feature: null };

  function styleError(message) {
    return new Error('microMap.vector: ' + message);
  }

  function constantNode(value) {
    return { fn: function () { return value; }, zoom: false, props: [], constant: true, value: value };
  }

  function combine(fn, children, zoom, name) {
    var props = [];
    for (var i = 0; i < children.length; i++) {
      zoom = zoom || children[i].zoom;
      for (var p = 0; p < children[i].props.length; p++) {
        if (props.indexOf(children[i].props[p]) < 0) props.push(children[i].props[p]);
      }
    }
    if (name != null && props.indexOf(name) < 0) props.push(name);
    // Fold constant sub-expressions at compile time.
    if (!zoom && !props.length) return constantNode(fn(EMPTY_CONTEXT));
    return { fn: fn, zoom: !!zoom, props: props, constant: false };
  }

  function compileAll(values, depth, scope) {
    var result = [];
    for (var i = 0; i < values.length; i++) result.push(compileExpression(values[i], depth, scope));
    return result;
  }

  function number(value) {
    return typeof value === 'number' ? value : null;
  }

  function toNumber(value) {
    if (value === null || value === false) return 0;
    if (value === true) return 1;
    if (typeof value === 'bigint') return Number(value);
    value = typeof value === 'string' && value.trim() ? +value : value;
    return typeof value === 'number' && !isNaN(value) ? value : null;
  }

  function toText(value) {
    if (value == null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function arithmetic(reduce) {
    return function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        var values = [];
        for (var i = 0; i < args.length; i++) {
          var value = number(args[i].fn(ctx));
          if (value === null) return null;
          values.push(value);
        }
        return reduce(values);
      }, args);
    };
  }

  function comparison(test) {
    return function (expression, depth, scope) {
      if (expression.length < 3 || expression.length > 4) throw styleError(expression[0] + ' needs two values');
      var left = compileExpression(expression[1], depth, scope);
      var right = compileExpression(expression[2], depth, scope);
      return combine(function (ctx) { return test(left.fn(ctx), right.fn(ctx)); }, [left, right]);
    };
  }

  function ordered(test) {
    return comparison(function (a, b) {
      return typeof a === typeof b && (typeof a === 'number' || typeof a === 'string') && test(a, b);
    });
  }

  function assertion(type) {
    return function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) {
          var value = args[i].fn(ctx);
          if (typeof value === type) return value;
        }
        return null;
      }, args);
    };
  }

  function unary(transform) {
    return function (expression, depth, scope) {
      var arg = compileExpression(expression[1], depth, scope);
      return combine(function (ctx) { return transform(arg.fn(ctx)); }, [arg]);
    };
  }

  function mathUnary(transform) {
    return unary(function (value) { return typeof value === 'number' ? transform(value) : null; });
  }

  var colorCache = new Map();
  // CSS named colours (MapLibre styles use them, e.g. its default heatmap).
  var NAMED_COLORS = null;
  var NAMED_COLOR_TABLE = 'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

  function namedColor(name) {
    if (!NAMED_COLORS) {
      NAMED_COLORS = Object.create(null);
      NAMED_COLOR_TABLE.split(',').forEach(function (entry) {
        var parts = entry.split(':');
        NAMED_COLORS[parts[0]] = parts[1];
      });
    }
    return NAMED_COLORS[name] || null;
  }

  // Parses CSS colors for interpolation; Canvas itself receives the source
  // strings unchanged whenever no interpolation is needed.
  function parseColor(value) {
    if (typeof value !== 'string') return null;
    var cached = colorCache.get(value);
    if (cached !== undefined) return cached;
    var text = value.trim().toLowerCase();
    var result = null;
    var match;
    if (text === 'transparent') result = [0, 0, 0, 0];
    else if (/^[a-z]+$/.test(text) && namedColor(text)) text = '#' + namedColor(text);
    if (result) { /* transparent */ }
    else if ((match = /^#([0-9a-f]{3,8})$/.exec(text)) && match[1].length !== 5 && match[1].length !== 7) {
      var hex = match[1];
      var short = hex.length < 5;
      var channel = function (index) {
        return short ? parseInt(hex[index] + hex[index], 16) : parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      };
      result = [channel(0), channel(1), channel(2), hex.length === 4 || hex.length === 8 ? channel(3) / 255 : 1];
    } else if ((match = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(text))) {
      var parts = match[2].split(/[\s,\/]+/).filter(Boolean).map(function (part) {
        return part.slice(-1) === '%' ? parseFloat(part) / 100 * (match[1] === 'rgb' ? 255 : 1) : parseFloat(part);
      });
      if (parts.length >= 3 && parts.every(isFinite)) {
        var alpha = parts.length > 3 ? clamp(parts[3] > 1 && /%\s*\)?$/.test(match[2]) ? parts[3] / 255 : parts[3], 0, 1) : 1;
        if (match[1] === 'rgb') result = [parts[0], parts[1], parts[2], alpha];
        else {
          var h = ((parts[0] % 360) + 360) % 360 / 360;
          var s = clamp(parts[1], 0, 1);
          var l = clamp(parts[2], 0, 1);
          var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          var p = 2 * l - q;
          var hue = function (t) {
            t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
            return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
          };
          result = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3), alpha];
        }
      }
    }
    if (colorCache.size > 512) colorCache.clear();
    colorCache.set(value, result);
    return result;
  }

  function interpolateValue(a, b, t) {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      return a.map(function (value, index) { return interpolateValue(value, b[index], t); });
    }
    var from = parseColor(a);
    var to = parseColor(b);
    if (from && to) {
      return 'rgba(' + Math.round(from[0] + (to[0] - from[0]) * t) + ',' + Math.round(from[1] + (to[1] - from[1]) * t) + ',' +
        Math.round(from[2] + (to[2] - from[2]) * t) + ',' + +(from[3] + (to[3] - from[3]) * t).toFixed(3) + ')';
    }
    return t < 0.5 ? a : b;
  }

  function stopsOf(expression, first, depth, scope) {
    var stops = [];
    var outputs = [];
    for (var i = first; i < expression.length; i += 2) {
      if (typeof expression[i] !== 'number' || (stops.length && expression[i] <= stops[stops.length - 1])) {
        throw styleError(expression[0] + ' stops must be ascending numbers');
      }
      stops.push(expression[i]);
      outputs.push(compileExpression(expression[i + 1], depth, scope));
    }
    if (!stops.length) throw styleError(expression[0] + ' needs at least one stop');
    return { stops: stops, outputs: outputs };
  }

  function stopIndex(stops, value) {
    var index = 0;
    while (index + 1 < stops.length && stops[index + 1] <= value) index++;
    return index;
  }

  var OPERATORS = {
    literal: function (expression) { return constantNode(expression[1]); },
    get: function (expression, depth, scope) {
      if (expression.length === 3) {
        var key = compileExpression(expression[1], depth, scope);
        var object = compileExpression(expression[2], depth, scope);
        return combine(function (ctx) {
          var target = object.fn(ctx);
          var value = target && typeof target === 'object' ? target[toText(key.fn(ctx))] : undefined;
          return value === undefined ? null : value;
        }, [key, object]);
      }
      if (expression.length !== 2 || typeof expression[1] !== 'string') throw styleError('get needs one literal property name');
      var name = expression[1];
      return combine(function (ctx) {
        var value = prop(ctx.feature, name);
        return value === undefined ? null : value;
      }, [], false, name);
    },
    has: function (expression) {
      if (expression.length !== 2 || typeof expression[1] !== 'string') throw styleError('has needs one literal property name');
      var name = expression[1];
      return combine(function (ctx) { return hasProp(ctx.feature, name); }, [], false, name);
    },
    id: function () { return combine(function (ctx) { return ctx.feature.id == null ? null : ctx.feature.id; }, [], false, '$id'); },
    // A feature's state from setFeatureState(); features group by state.
    'feature-state': function (expression, depth, scope) {
      var key = compileExpression(expression[1], depth, scope);
      return combine(function (ctx) {
        var state = ctx.feature && ctx.feature._state;
        var value = state ? state[toText(key.fn(ctx))] : undefined;
        return value === undefined ? null : value;
      }, [key], false, '$state');
    },
    'geometry-type': function () { return combine(function (ctx) { return GEOMETRY_TYPES[ctx.feature.type]; }, [], false, '$type'); },
    zoom: function () { return combine(function (ctx) { return ctx.zoom; }, [], true); },
    // `let` bindings are pure, so `var` can substitute the bound expression.
    let: function (expression, depth, scope) {
      var inner = Object.create(scope || null);
      for (var i = 1; i < expression.length - 1; i += 2) {
        if (typeof expression[i] !== 'string') throw styleError('let needs variable names');
        inner[expression[i]] = compileExpression(expression[i + 1], depth, scope);
      }
      return compileExpression(expression[expression.length - 1], depth, inner);
    },
    var: function (expression, depth, scope) {
      if (!scope || !(expression[1] in scope)) throw styleError('unknown variable ' + String(expression[1]));
      return scope[expression[1]];
    },
    coalesce: function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) {
          var value = args[i].fn(ctx);
          if (value != null) return value;
        }
        return null;
      }, args);
    },
    case: function (expression, depth, scope) {
      if (expression.length < 4 || expression.length % 2) throw styleError('case needs condition/output pairs and a fallback');
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        for (var i = 0; i < args.length - 1; i += 2) if (args[i].fn(ctx) === true) return args[i + 1].fn(ctx);
        return args[args.length - 1].fn(ctx);
      }, args);
    },
    match: function (expression, depth, scope) {
      if (expression.length < 5 || !(expression.length % 2)) throw styleError('match needs label/output pairs and a fallback');
      var input = compileExpression(expression[1], depth, scope);
      var outputs = [];
      var table = new Map();
      for (var i = 2; i < expression.length - 1; i += 2) {
        var labels = Array.isArray(expression[i]) ? expression[i] : [expression[i]];
        var index = outputs.push(compileExpression(expression[i + 1], depth, scope)) - 1;
        for (var l = 0; l < labels.length; l++) {
          if (typeof labels[l] !== 'string' && typeof labels[l] !== 'number') throw styleError('match labels must be strings or numbers');
          if (!table.has(labels[l])) table.set(labels[l], index);
        }
      }
      var fallback = compileExpression(expression[expression.length - 1], depth, scope);
      return combine(function (ctx) {
        var index = table.get(input.fn(ctx));
        return (index === undefined ? fallback : outputs[index]).fn(ctx);
      }, [input, fallback].concat(outputs));
    },
    interpolate: function (expression, depth, scope) {
      var curve = expression[1];
      var base = 1;
      if (!Array.isArray(curve)) throw styleError('interpolate needs an interpolation type');
      if (curve[0] === 'exponential') base = +curve[1];
      else if (curve[0] !== 'linear' && curve[0] !== 'cubic-bezier') throw styleError('unsupported interpolation ' + String(curve[0]));
      if (!(base > 0)) throw styleError('exponential interpolation needs a positive base');
      var input = compileExpression(expression[2], depth, scope);
      var table = stopsOf(expression, 3, depth, scope);
      var stops = table.stops;
      var outputs = table.outputs;
      var node = combine(function (ctx) {
        var value = input.fn(ctx);
        if (typeof value !== 'number') return null;
        var index = stopIndex(stops, value);
        if (value <= stops[0] || index === stops.length - 1) return outputs[index].fn(ctx);
        var range = stops[index + 1] - stops[index];
        var progress = value - stops[index];
        var t = base === 1 ? progress / range : (Math.pow(base, progress) - 1) / (Math.pow(base, range) - 1);
        return interpolateValue(outputs[index].fn(ctx), outputs[index + 1].fn(ctx), t);
      }, [input].concat(outputs));
      // Colour reliefs sample the curve at its stops.
      node.curve = { input: input, stops: stops, step: false };
      return node;
    },
    step: function (expression, depth, scope) {
      var input = compileExpression(expression[1], depth, scope);
      var first = compileExpression(expression[2], depth, scope);
      var table = stopsOf(expression, 3, depth, scope);
      var node = combine(function (ctx) {
        var value = input.fn(ctx);
        if (typeof value !== 'number' || value < table.stops[0]) return first.fn(ctx);
        return table.outputs[stopIndex(table.stops, value)].fn(ctx);
      }, [input, first].concat(table.outputs));
      node.curve = { input: input, stops: table.stops, step: true };
      return node;
    },
    '==': comparison(function (a, b) { return a === b; }),
    '!=': comparison(function (a, b) { return a !== b; }),
    '<': ordered(function (a, b) { return a < b; }),
    '<=': ordered(function (a, b) { return a <= b; }),
    '>': ordered(function (a, b) { return a > b; }),
    '>=': ordered(function (a, b) { return a >= b; }),
    '!': function (expression, depth, scope) {
      var arg = compileCondition(expression[1], depth, scope);
      return combine(function (ctx) { return arg.fn(ctx) !== true; }, [arg]);
    },
    all: function (expression, depth, scope) {
      var args = [];
      for (var i = 1; i < expression.length; i++) args.push(compileCondition(expression[i], depth, scope));
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) if (args[i].fn(ctx) !== true) return false;
        return true;
      }, args);
    },
    any: function (expression, depth, scope) {
      var args = [];
      for (var i = 1; i < expression.length; i++) args.push(compileCondition(expression[i], depth, scope));
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) if (args[i].fn(ctx) === true) return true;
        return false;
      }, args);
    },
    in: function (expression, depth, scope) {
      var needle = compileExpression(expression[1], depth, scope);
      var haystack = compileExpression(expression[2], depth, scope);
      return combine(function (ctx) {
        var list = haystack.fn(ctx);
        var value = needle.fn(ctx);
        if (Array.isArray(list)) return list.indexOf(value) >= 0;
        return typeof list === 'string' && list.indexOf(toText(value)) >= 0;
      }, [needle, haystack]);
    },
    number: assertion('number'),
    string: assertion('string'),
    boolean: assertion('boolean'),
    'to-number': function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) {
          var value = toNumber(args[i].fn(ctx));
          if (value !== null) return value;
        }
        return null;
      }, args);
    },
    'to-string': unary(toText),
    // A resolved image is its name here; the renderer looks it up.
    image: unary(toText),
    'to-boolean': unary(function (value) { return !!value && value === value; }),
    'to-color': unary(function (value) { return typeof value === 'string' ? value : null; }),
    concat: function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        var text = '';
        for (var i = 0; i < args.length; i++) text += toText(args[i].fn(ctx));
        return text;
      }, args);
    },
    upcase: unary(function (value) { return toText(value).toUpperCase(); }),
    downcase: unary(function (value) { return toText(value).toLowerCase(); }),
    length: unary(function (value) { return value != null && typeof value.length === 'number' ? value.length : null; }),
    '+': arithmetic(function (values) { return values.reduce(function (sum, value) { return sum + value; }, 0); }),
    '*': arithmetic(function (values) { return values.reduce(function (product, value) { return product * value; }, 1); }),
    '-': arithmetic(function (values) { return values.length === 1 ? -values[0] : values[0] - values[1]; }),
    '/': arithmetic(function (values) { return values[0] / values[1]; }),
    '%': arithmetic(function (values) { return values[0] % values[1]; }),
    '^': arithmetic(function (values) { return Math.pow(values[0], values[1]); }),
    min: arithmetic(function (values) { return Math.min.apply(Math, values); }),
    max: arithmetic(function (values) { return Math.max.apply(Math, values); }),
    round: mathUnary(function (value) { return value < 0 ? -Math.round(-value) : Math.round(value); }),
    floor: mathUnary(Math.floor),
    ceil: mathUnary(Math.ceil),
    abs: mathUnary(Math.abs),
    sqrt: mathUnary(Math.sqrt),
    ln: mathUnary(Math.log),
    log10: mathUnary(function (value) { return Math.log(value) / Math.LN10; }),
    log2: mathUnary(function (value) { return Math.log(value) / Math.LN2; }),
    pi: function () { return constantNode(Math.PI); },
    e: function () { return constantNode(Math.E); },
    sin: mathUnary(Math.sin),
    cos: mathUnary(Math.cos),
    tan: mathUnary(Math.tan),
    asin: mathUnary(Math.asin),
    acos: mathUnary(Math.acos),
    atan: mathUnary(Math.atan),
    rgb: colorExpression(false),
    rgba: colorExpression(true),
    'to-rgba': unary(function (value) {
      var rgba = parseColor(value);
      return rgba ? rgba.slice() : null;
    }),
    at: function (expression, depth, scope) {
      var index = compileExpression(expression[1], depth, scope);
      var list = compileExpression(expression[2], depth, scope);
      return combine(function (ctx) {
        var array = list.fn(ctx);
        var i = index.fn(ctx);
        return Array.isArray(array) && typeof i === 'number' && i >= 0 && i < array.length ? array[Math.floor(i)] : null;
      }, [index, list]);
    },
    'index-of': function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        var haystack = args[1].fn(ctx);
        var from = args[2] ? toNumber(args[2].fn(ctx)) || 0 : 0;
        if (Array.isArray(haystack)) return haystack.indexOf(args[0].fn(ctx), from);
        return typeof haystack === 'string' ? haystack.indexOf(toText(args[0].fn(ctx)), from) : -1;
      }, args);
    },
    slice: function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        var input = args[0].fn(ctx);
        if (!Array.isArray(input) && typeof input !== 'string') return null;
        var start = toNumber(args[1].fn(ctx)) || 0;
        return args[2] ? input.slice(start, toNumber(args[2].fn(ctx))) : input.slice(start);
      }, args);
    },
    array: function (expression, depth, scope) {
      var value = compileExpression(expression[expression.length - 1], depth, scope);
      return combine(function (ctx) {
        var result = value.fn(ctx);
        return Array.isArray(result) ? result : null;
      }, [value]);
    },
    object: assertion('object'),
    typeof: unary(function (value) {
      if (value === null || value === undefined) return 'null';
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'string' && parseColor(value)) return 'string';
      return typeof value;
    }),
    properties: function () {
      return combine(function (ctx) { return ctx.feature && ctx.feature.properties ? ctx.feature.properties : {}; }, [], false, '$properties');
    },
    // Rich text: sections keep their text; fonts, scales and colours of
    // individual sections are approximated by the layer's own.
    format: function (expression, depth, scope) {
      var parts = [];
      for (var i = 1; i < expression.length; i++) {
        var item = expression[i];
        if (item && typeof item === 'object' && !Array.isArray(item)) continue;
        parts.push(compileExpression(item, depth, scope));
      }
      return combine(function (ctx) {
        var text = '';
        for (var p = 0; p < parts.length; p++) text += toText(parts[p].fn(ctx));
        return text;
      }, parts);
    },
    'number-format': function (expression, depth, scope) {
      var value = compileExpression(expression[1], depth, scope);
      var settings = expression[2] && typeof expression[2] === 'object' ? expression[2] : {};
      var locale = typeof settings.locale === 'string' ? settings.locale : undefined;
      var format = {};
      if (typeof settings.currency === 'string') { format.style = 'currency'; format.currency = settings.currency; }
      if (typeof settings['min-fraction-digits'] === 'number') format.minimumFractionDigits = settings['min-fraction-digits'];
      if (typeof settings['max-fraction-digits'] === 'number') format.maximumFractionDigits = settings['max-fraction-digits'];
      return combine(function (ctx) {
        var number = toNumber(value.fn(ctx));
        if (number === null) return null;
        try { return new Intl.NumberFormat(locale, format).format(number); } catch (error) { return String(number); }
      }, [value]);
    },
    'interpolate-hcl': function (expression, depth, scope) { return OPERATORS.interpolate(expression, depth, scope); },
    'interpolate-lab': function (expression, depth, scope) { return OPERATORS.interpolate(expression, depth, scope); },
    collator: function () { return constantNode({ collator: true }); },
    'resolved-locale': function () {
      return constantNode(root.navigator && root.navigator.language ? root.navigator.language : 'en');
    },
    'is-supported-script': function () { return constantNode(true); },
    // Contexts this renderer does not evaluate per pixel.
    'line-progress': function () { return constantNode(0); },
    accumulated: function () { return constantNode(null); },
    // The density a heatmap colours; '$density' keeps it from being folded.
    'heatmap-density': function () { return combine(function (ctx) { return ctx.heatmapDensity || 0; }, [], false, '$density'); },
    // The elevation a colour relief colours (likewise kept unfolded).
    elevation: function () { return combine(function (ctx) { return ctx.elevation || 0; }, [], false, '$elevation'); },
    'global-state': function () { return constantNode(null); }
  };

  function colorExpression(alpha) {
    return function (expression, depth, scope) {
      var args = compileAll(expression.slice(1), depth, scope);
      return combine(function (ctx) {
        var values = [];
        for (var i = 0; i < args.length; i++) {
          var value = number(args[i].fn(ctx));
          if (value === null) return null;
          values.push(value);
        }
        var a = alpha && values.length > 3 ? clamp(values[3], 0, 1) : 1;
        return 'rgba(' + Math.round(clamp(values[0], 0, 255)) + ',' + Math.round(clamp(values[1], 0, 255)) + ',' + Math.round(clamp(values[2], 0, 255)) + ',' + a + ')';
      }, args);
    };
  }

  function isExpression(value) {
    return Array.isArray(value) && typeof value[0] === 'string' && own(OPERATORS, value[0]);
  }

  function compileExpression(value, depth, scope) {
    depth = (depth || 0) + 1;
    if (depth > 64) throw styleError('expression is nested too deeply');
    if (!Array.isArray(value)) {
      if (value && typeof value === 'object') throw styleError('object values need a literal expression');
      return constantNode(value);
    }
    if (!isExpression(value)) throw styleError('unsupported expression ' + String(value[0]));
    return OPERATORS[value[0]](value, depth, scope);
  }

  // MapLibre's rule for telling expression filters from legacy filters.
  function isExpressionFilter(filter) {
    if (filter === true || filter === false) return true;
    if (!Array.isArray(filter) || !filter.length) return false;
    switch (filter[0]) {
      case 'has': return filter.length >= 2 && filter[1] !== '$id' && filter[1] !== '$type';
      case 'in': return filter.length >= 3 && (typeof filter[1] !== 'string' || Array.isArray(filter[2]));
      case '!in': case '!has': case 'none': return false;
      case '==': case '!=': case '>': case '>=': case '<': case '<=':
        return filter.length !== 3 || Array.isArray(filter[1]) || Array.isArray(filter[2]);
      case 'any': case 'all':
        for (var i = 1; i < filter.length; i++) if (!isExpressionFilter(filter[i]) && typeof filter[i] !== 'boolean') return false;
        return true;
      default: return true;
    }
  }

  function legacyGetter(key) {
    if (typeof key !== 'string') throw styleError('legacy filters need a property name');
    return compileExpression(key === '$type' ? ['geometry-type'] : key === '$id' ? ['id'] : ['get', key]);
  }

  function compileLegacyFilter(filter, depth, scope) {
    var operator = filter[0];
    var i;
    var args = [];
    if (operator === 'all' || operator === 'any' || operator === 'none') {
      for (i = 1; i < filter.length; i++) args.push(compileCondition(filter[i], depth, scope));
      return combine(function (ctx) {
        for (var i = 0; i < args.length; i++) {
          var passed = args[i].fn(ctx) === true;
          if (operator === 'all' ? !passed : passed) return operator === 'any';
        }
        return operator !== 'any';
      }, args);
    }
    var getter = legacyGetter(filter[1]);
    if (operator === 'has' || operator === '!has') {
      var key = filter[1];
      var present = key === '$type' ? constantNode(true) : key === '$id' ? getter : compileExpression(['has', key]);
      return combine(function (ctx) { return (key === '$id' ? present.fn(ctx) != null : present.fn(ctx) === true) === (operator === 'has'); }, [present]);
    }
    if (operator === 'in' || operator === '!in') {
      var values = filter.slice(2);
      return combine(function (ctx) { return (values.indexOf(getter.fn(ctx)) >= 0) === (operator === 'in'); }, [getter]);
    }
    if (filter.length !== 3) throw styleError('unsupported filter ' + String(operator));
    var expected = filter[2];
    var test = operator === '==' ? function (value) { return value === expected; }
      : operator === '!=' ? function (value) { return value !== expected; }
        : /^[<>]=?$/.test(operator) ? function (value) {
          return typeof value === typeof expected && legacyCompare(operator, value, expected);
        } : null;
    if (!test) throw styleError('unsupported filter operator ' + String(operator));
    return combine(function (ctx) { return test(getter.fn(ctx)); }, [getter]);
  }

  function legacyCompare(operator, a, b) {
    if (typeof a !== 'number' && typeof a !== 'string') return false;
    return operator === '<' ? a < b : operator === '<=' ? a <= b : operator === '>' ? a > b : a >= b;
  }

  function compileCondition(filter, depth, scope) {
    if (filter === true || filter === false) return constantNode(filter);
    if (!Array.isArray(filter) || !filter.length) throw styleError('filter must be an array');
    return isExpressionFilter(filter) ? compileExpression(filter, depth, scope) : compileLegacyFilter(filter, depth, scope);
  }

  // Legacy property functions ({ stops, base, property, type }).
  // Legacy "{name}" tokens in text-field and icon-image strings.
  function tokenExpression(value) {
    if (typeof value !== 'string' || !/\{[^}]+\}/.test(value)) return value;
    var parts = ['concat'];
    value.replace(/\{([^}]+)\}|([^{]+)/g, function (whole, token, text) {
      parts.push(token ? ['coalesce', ['get', token], ''] : text);
      return whole;
    });
    return parts;
  }

  function functionExpression(value, tokens) {
    var type = value.type;
    // Like MapLibre, functions with values that cannot be interpolated
    // (strings other than colours, booleans) default to intervals.
    if (!type) {
      var smooth = (value.stops || []).every(function (stop) {
        var output = Array.isArray(stop) ? stop[1] : null;
        return typeof output === 'number' || (typeof output === 'string' && !!parseColor(output)) ||
          (Array.isArray(output) && output.every(function (entry) { return typeof entry === 'number'; }));
      });
      type = smooth ? 'exponential' : 'interval';
    }
    var input = value.property ? ['get', value.property] : ['zoom'];
    var stops = value.stops || [];
    var result;
    var i;
    if (type === 'identity') return value.property ? ['coalesce', input, value['default'] == null ? null : ['literal', value['default']]] : ['literal', value['default']];
    if (!Array.isArray(stops) || !stops.length || stops.some(function (stop) { return !Array.isArray(stop) || stop.length !== 2 || (stop[0] && typeof stop[0] === 'object'); })) {
      throw styleError('unsupported property function');
    }
    var output = function (stop) { return Array.isArray(stop[1]) ? ['literal', stop[1]] : tokens ? tokenExpression(stop[1]) : stop[1]; };
    var fallback = value['default'] == null ? null : (Array.isArray(value['default']) ? ['literal', value['default']] : value['default']);
    if (type === 'categorical') {
      result = ['match', input];
      for (i = 0; i < stops.length; i++) result.push(stops[i][0], output(stops[i]));
      result.push(fallback);
      return result;
    }
    if (type === 'interval') {
      result = ['step', input, output(stops[0])];
      for (i = 1; i < stops.length; i++) result.push(stops[i][0], output(stops[i]));
      return result;
    }
    result = ['interpolate', value.base && value.base !== 1 ? ['exponential', value.base] : ['linear'], input];
    for (i = 0; i < stops.length; i++) result.push(stops[i][0], output(stops[i]));
    return result;
  }

  // Array-valued properties accept bare arrays as literals.
  var ARRAY_PROPERTIES = { 'text-font': true, 'text-offset': true, 'line-dasharray': true, 'text-variable-anchor': true, 'icon-offset': true, 'icon-text-fit-padding': true, 'fill-translate': true, 'line-translate': true };

  function compileProperty(name, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!Array.isArray(value.stops) && value.type !== 'identity') throw styleError('object values need a literal expression (' + name + ')');
      value = functionExpression(value, name === 'text-field' || name === 'icon-image');
    }
    if (Array.isArray(value) && ARRAY_PROPERTIES[name] && !isExpression(value)) return constantNode(value);
    if (name === 'text-field' || name === 'icon-image') value = tokenExpression(value);
    return compileExpression(value);
  }

  // ---- Style layers ---------------------------------------------------------
  // Supported properties with their MapLibre defaults. Compact MicroMap
  // styles use short aliases and their own historical defaults.
  var PROPERTIES = {
    background: { 'background-color': '#000000', 'background-opacity': 1 },
    raster: {
      'raster-opacity': 1, 'raster-hue-rotate': 0, 'raster-brightness-min': 0, 'raster-brightness-max': 1, 'raster-saturation': 0,
      'raster-contrast': 0, 'raster-resampling': 'linear', 'raster-fade-duration': 300
    },
    fill: { 'fill-color': '#000000', 'fill-opacity': 1, 'fill-outline-color': null, 'fill-outline-width': 1, 'fill-antialias': true, 'fill-sort-key': 0, 'fill-pattern': null,
      'fill-translate': null, 'fill-translate-anchor': 'map' },
    line: {
      'line-color': '#000000', 'line-opacity': 1, 'line-width': 1, 'line-dasharray': null, 'line-cap': 'butt', 'line-join': 'miter',
      'line-blur': 0, 'line-miter-limit': 2, 'line-round-limit': 1.05, 'line-sort-key': 0, 'line-pattern': null, 'line-offset': 0,
      'line-gap-width': 0, 'line-translate': null, 'line-translate-anchor': 'map'
    },
    circle: {
      'circle-color': '#000000', 'circle-opacity': 1, 'circle-radius': 5, 'circle-stroke-color': '#000000', 'circle-stroke-width': 0,
      'circle-stroke-opacity': 1, 'circle-blur': 0, 'circle-pitch-alignment': 'viewport', 'circle-pitch-scale': 'map', 'circle-sort-key': 0
    },
    heatmap: {
      'heatmap-radius': 30, 'heatmap-weight': 1, 'heatmap-intensity': 1, 'heatmap-color': null, 'heatmap-opacity': 1
    },
    'color-relief': { 'color-relief-color': null, 'color-relief-opacity': 1 },
    hillshade: {
      'hillshade-illumination-direction': 335, 'hillshade-illumination-anchor': 'viewport', 'hillshade-exaggeration': 0.5,
      'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#000000',
      'hillshade-method': 'standard'
    },
    'fill-extrusion': {
      'fill-extrusion-color': '#000000', 'fill-extrusion-roof-color': null, 'fill-extrusion-opacity': 1, 'fill-extrusion-height': 0,
      'fill-extrusion-base': 0, 'fill-extrusion-vertical-gradient': true
    },
    symbol: {
      'text-field': '', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 16, 'text-color': '#000000',
      'text-opacity': 1, 'text-halo-color': 'rgba(0,0,0,0)', 'text-halo-width': 0, 'text-halo-blur': 0, 'text-offset': null,
      'text-radial-offset': 0, 'text-anchor': 'center', 'text-variable-anchor': null, 'text-max-width': 10, 'text-padding': 2,
      'text-allow-overlap': false, 'text-ignore-placement': false, 'text-optional': false, 'text-transform': 'none',
      'text-letter-spacing': 0, 'text-line-height': 1.2, 'text-justify': 'center', 'symbol-placement': 'point',
      'symbol-sort-key': 0, 'symbol-spacing': 250, 'symbol-avoid-edges': false, 'text-rotation-alignment': 'auto',
      'text-pitch-alignment': 'auto', 'text-keep-upright': true, 'text-max-angle': 45, 'symbol-z-order': 'auto',
      'icon-image': '', 'icon-size': 1, 'icon-opacity': 1, 'icon-anchor': 'center', 'icon-offset': null, 'icon-rotate': 0,
      'icon-allow-overlap': false, 'icon-ignore-placement': false, 'icon-optional': false, 'icon-padding': 2, 'icon-color': '#000000',
      'icon-rotation-alignment': 'auto', 'icon-pitch-alignment': 'auto', 'icon-keep-upright': false, 'icon-halo-color': 'rgba(0,0,0,0)',
      'icon-halo-width': 0, 'icon-halo-blur': 0, 'icon-text-fit': 'none', 'icon-text-fit-padding': null
    }
  };

  // Accepted, but only approximated (or purely cosmetic) on Canvas 2D.
  var APPROXIMATED = {
    'fill-antialias': 1, 'line-blur': 1, 'line-miter-limit': 1, 'line-round-limit': 1, 'circle-blur': 1, 'circle-pitch-alignment': 1,
    'circle-pitch-scale': 1, 'text-halo-blur': 1, 'text-letter-spacing': 1, 'text-justify': 1,
    'symbol-spacing': 1, 'symbol-avoid-edges': 1, 'text-rotation-alignment': 1, 'text-pitch-alignment': 1, 'text-keep-upright': 1,
    'symbol-z-order': 1, 'text-optional': 1, 'text-variable-anchor': 1, 'text-radial-offset': 1,
    'fill-sort-key': 1, 'line-sort-key': 1, 'circle-sort-key': 1, 'raster-hue-rotate': 1, 'raster-brightness-min': 1,
    'raster-brightness-max': 1, 'raster-saturation': 1, 'raster-contrast': 1, 'raster-fade-duration': 1,
    'icon-rotation-alignment': 1, 'icon-pitch-alignment': 1, 'icon-keep-upright': 1, 'icon-halo-color': 1, 'icon-halo-width': 1,
    'icon-halo-blur': 1, 'icon-text-fit': 1, 'icon-text-fit-padding': 1, 'fill-translate-anchor': 1, 'line-translate-anchor': 1,
    'hillshade-method': 1
  };

  var ALIASES = {
    background: { color: 'background-color', opacity: 'background-opacity' },
    fill: { color: 'fill-color', opacity: 'fill-opacity', outlineColor: 'fill-outline-color', outlineWidth: 'fill-outline-width' },
    line: { color: 'line-color', opacity: 'line-opacity', width: 'line-width' },
    circle: { color: 'circle-color', opacity: 'circle-opacity', radius: 'circle-radius', strokeColor: 'circle-stroke-color', strokeWidth: 'circle-stroke-width' },
    'fill-extrusion': { color: 'fill-extrusion-color', roofColor: 'fill-extrusion-roof-color', opacity: 'fill-extrusion-opacity', height: 'fill-extrusion-height', base: 'fill-extrusion-base', verticalGradient: 'fill-extrusion-vertical-gradient' },
    symbol: { color: 'text-color', opacity: 'text-opacity', haloColor: 'text-halo-color', haloWidth: 'text-halo-width' }
  };

  var LAYER_ALIASES = {
    lineCap: 'line-cap', lineJoin: 'line-join', size: 'text-size', font: 'text-font', offset: 'text-offset',
    placement: 'symbol-placement', anchor: 'text-anchor'
  };

  // The compact MicroMap format kept its own defaults.
  var COMPACT_DEFAULTS = {
    'fill-color': '#9fb8a8', 'line-color': '#607080', 'circle-color': '#303840', 'circle-radius': 3, 'circle-stroke-color': null,
    'fill-extrusion-color': '#9fb8a8', 'text-color': '#33424a', 'text-size': 12, 'text-font': null, 'text-halo-color': null,
    'text-max-width': 0, 'text-padding': null
  };

  var layerUid = 0;

  function compileLayer(layer, index, v8, strict, report) {
    if (!layer || typeof layer !== 'object') throw styleError('every style layer must be an object');
    var type = layer.type;
    if (!own(PROPERTIES, type) || (rasterLayer(type) && !v8)) throw styleError('style layer type ' + String(type) + ' is not supported' + (rasterLayer(type) ? ' without a MapLibre raster source' : ''));
    var table = PROPERTIES[type];
    var id = layer.id != null ? String(layer.id) : type + '-' + index;
    var compiled = {
      uid: ++layerUid, geojson: null, raster: null,
      id: id, type: type, source: layer.source, sourceLayer: sourceLayerOf(layer), minzoom: layer.minzoom, maxzoom: layer.maxzoom,
      index: index, v8: v8, visible: true, props: Object.create(null), groupProps: [], zoomDependent: false, version: 0,
      priority: v8 ? index : finite(layer.priority, 0), pixelOffset: [finite(layer.offsetX, 0), finite(layer.offsetY, 0)],
      defaults: v8 ? table : null, filter: null, raw: layer
    };
    if (!v8) {
      compiled.defaults = Object.create(table);
      for (var key in COMPACT_DEFAULTS) if (own(table, key)) compiled.defaults[key] = COMPACT_DEFAULTS[key];
    }
    try {
      compiled.filter = layer.filter == null ? null : compileCondition(layer.filter);
    } catch (error) {
      throw styleError(id + ': ' + error.message.replace('microMap.vector: ', ''));
    }
    function add(name, value) {
      if (name === 'visibility') {
        compiled.visible = value !== 'none';
        return;
      }
      if (!own(table, name)) {
        if (strict) throw styleError(id + ': ' + type + ' property ' + name + ' is not supported');
        if (report) report.ignored.push(id + ' ' + name);
        // A pattern replaces the colour in MapLibre: without pattern support
        // the layer draws nothing rather than its default black.
        if (/-pattern$/.test(name)) compiled.unpainted = true;
        return;
      }
      if (APPROXIMATED[name] && report && !(name === 'hillshade-method' && value === 'standard')) report.approximated.push(id + ' ' + name);
      try {
        compiled.props[name] = compileProperty(name, value);
      } catch (error) {
        throw styleError(id + ' ' + name + ': ' + error.message.replace('microMap.vector: ', ''));
      }
    }
    var groups = [layer.layout || {}, layer.paint || {}];
    for (var g = 0; g < groups.length; g++) {
      for (var name in groups[g]) if (own(groups[g], name)) add(ALIASES[type] && ALIASES[type][name] || name, groups[g][name]);
    }
    if (!v8) {
      for (var alias in LAYER_ALIASES) {
        if (layer[alias] != null && !compiled.props[LAYER_ALIASES[alias]] && own(table, LAYER_ALIASES[alias])) add(LAYER_ALIASES[alias], layer[alias]);
      }
    }
    if (type === 'symbol' && !compiled.props['text-field'] && !compiled.props['icon-image']) {
      if (strict) throw styleError(id + ': symbol layers need a text-field or an icon-image');
      if (report) report.ignored.push(id + ' (empty symbol layer)');
    }
    for (var property in compiled.props) {
      var node = compiled.props[property];
      if (node.zoom) compiled.zoomDependent = true;
      if (node.props.indexOf('$state') >= 0) compiled.stateDependent = true;
      // Text and sort keys are per label; everything else groups features.
      if (property === 'text-field' || property === 'icon-image' || property === 'symbol-sort-key') continue;
      for (var p = 0; p < node.props.length; p++) if (compiled.groupProps.indexOf(node.props[p]) < 0) compiled.groupProps.push(node.props[p]);
    }
    return compiled;
  }

  var evalContext = { zoom: 0, feature: null };

  function evaluate(layer, name, zoom, feature) {
    var node = layer.props[name];
    var value = null;
    if (node) {
      if (node.constant) value = node.value;
      else {
        evalContext.zoom = zoom;
        evalContext.feature = feature;
        try {
          value = node.fn(evalContext);
        } catch (error) {
          value = null;
        }
      }
    }
    return value == null ? layer.defaults[name] : value;
  }

  function passesFilter(layer, zoom, feature) {
    if (!layer.filter) return true;
    if (layer.filter.constant) return layer.filter.value === true;
    evalContext.zoom = zoom;
    evalContext.feature = feature;
    try {
      return layer.filter.fn(evalContext) === true;
    } catch (error) {
      return false;
    }
  }

  function numberOr(value, fallback) {
    value = typeof value === 'number' ? value : toNumber(value);
    return value === null || !isFinite(value) ? fallback : value;
  }

  function colorOr(value, fallback) {
    return typeof value === 'string' && value ? value : fallback;
  }

  // Labels come from untrusted tile properties. Canvas text cannot inject
  // HTML, but keeping it bounded and single-line also prevents one unusual
  // feature from monopolising a render frame or the collision index.
  function cleanLabelText(value) {
    var type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'bigint') return '';
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  var FONT_WEIGHTS = {
    thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, roman: 400,
    medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
  };

  function cssFamily(name) {
    // \x22 rather than a literal quote: build.mjs does not parse regex literals.
    name = String(name).replace(/[\u0000-\u001f\u007f\x22\\]/g, '').trim().slice(0, 80);
    return /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(name) ? name : '"' + name + '"';
  }

  // MapLibre fontstacks ("Noto Sans Bold Italic") become CSS fonts; the
  // browser's own fonts replace the glyph PBF pipeline.
  function fontFromStack(stack) {
    var weight = 400;
    var italic = false;
    var families = [];
    for (var i = 0; i < stack.length && i < 8; i++) {
      var words = String(stack[i]).split(/\s+/);
      while (words.length > 1) {
        var word = words[words.length - 1].toLowerCase();
        if (word === 'italic' || word === 'oblique') italic = italic || i === 0;
        else if (own(FONT_WEIGHTS, word)) { if (i === 0) weight = FONT_WEIGHTS[word]; } else break;
        words.pop();
      }
      var family = cssFamily(words.join(' '));
      if (families.indexOf(family) < 0) families.push(family);
    }
    families.push('sans-serif');
    return { prefix: (italic ? 'italic ' : '') + (weight === 400 ? '' : weight + ' '), family: families.join(', ') };
  }

  // Compact styles give a CSS family list, optionally led by style/weight.
  function fontFromCSS(value) {
    value = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    var lead = /^((?:italic|oblique|normal|bold|bolder|lighter|[1-9]00)\s+)+/i.exec(value);
    var family = lead ? value.slice(lead[0].length) : value;
    return { prefix: lead ? lead[0] : '', family: family || 'system-ui, sans-serif' };
  }

  var fontCache = new Map();

  function fontOf(value, v8) {
    var key = (v8 ? '8' : 'c') + (Array.isArray(value) ? value.join('\u0000') : String(value));
    var font = fontCache.get(key);
    if (!font) {
      font = Array.isArray(value) ? (v8 ? fontFromStack(value) : fontFromCSS(value.join(', '))) : fontFromCSS(value);
      if (fontCache.size > 256) fontCache.clear();
      fontCache.set(key, font);
    }
    return font;
  }

  // text-anchor names the side of the text placed at the anchor point.
  var ANCHORS = {
    center: ['center', 'middle', 0, 0], top: ['center', 'top', 0, 1], bottom: ['center', 'bottom', 0, -1],
    left: ['left', 'middle', 1, 0], right: ['right', 'middle', -1, 0], 'top-left': ['left', 'top', 1, 1],
    'top-right': ['right', 'top', -1, 1], 'bottom-left': ['left', 'bottom', 1, -1], 'bottom-right': ['right', 'bottom', -1, -1]
  };

  function textStyle(options) {
    var size = clamp(finite(options.size, 12), 1, 96);
    var anchor = ANCHORS[options.anchor] || ANCHORS.center;
    var offset = Array.isArray(options.offset) ? options.offset : [0, 0];
    var radial = finite(options.radialOffset, 0) * size;
    var font = options.font && options.font.family ? options.font : fontOf(options.font, false);
    var line = options.placement === 'line' || options.placement === 'line-center';
    if (line) anchor = ANCHORS.center;
    return {
      type: 'symbol',
      color: colorOr(options.color, '#33424a'),
      opacity: clamp(finite(options.opacity, 1), 0, 1),
      size: size,
      font: font.prefix + size + 'px ' + font.family,
      measureFont: font.prefix + '100px ' + font.family,
      haloColor: typeof options.haloColor === 'string' ? options.haloColor : null,
      haloWidth: clamp(finite(options.haloWidth, 0), 0, 8),
      offsetX: clamp(finite(offset[0], 0), -8, 8) * size + finite(options.offsetX, 0) + anchor[2] * radial * (anchor[3] ? 0.7071 : 1),
      offsetY: clamp(finite(offset[1], 0), -8, 8) * size + finite(options.offsetY, 0) + anchor[3] * radial * (anchor[2] ? 0.7071 : 1),
      placement: line ? 'line' : 'point',
      textAlign: anchor[0],
      textBaseline: anchor[1],
      priority: finite(options.priority, 0),
      padding: options.padding == null ? null : clamp(finite(options.padding, 2), 0, 64),
      allowOverlap: !!options.allowOverlap,
      ignorePlacement: !!options.ignorePlacement,
      maxWidth: clamp(finite(options.maxWidth, 0), 0, 100) * size,
      lineHeight: clamp(finite(options.lineHeight, 1.2), 0.5, 4) * size,
      maxAngle: clamp(finite(options.maxAngle, 45), 0, 180) * Math.PI / 180,
      letterSpacing: clamp(finite(options.letterSpacing, 0), -1, 4) * size,
      transform: options.transform
    };
  }

  function symbolInstruction(text, options) {
    text = cleanLabelText(text);
    if (!text) return null;
    options = options || {};
    var style = textStyle({
      color: options.color, opacity: options.opacity, size: options.size, font: options.font, haloColor: options.haloColor,
      haloWidth: options.haloWidth, offset: options.offset, offsetX: options.offsetX, offsetY: options.offsetY,
      placement: options.placement, anchor: options.anchor, priority: options.priority
    });
    style.text = text;
    return style;
  }

  function transformText(text, transform) {
    return transform === 'uppercase' ? text.toUpperCase() : transform === 'lowercase' ? text.toLowerCase() : text;
  }

  // Evaluates one layer for a zoom and a representative feature. Buckets
  // call this once per feature group and frame, not once per feature.
  function layerInstruction(layer, zoom, feature) {
    var type = layer.type;
    function value(name) { return evaluate(layer, name, zoom, feature); }
    if (type === 'heatmap') {
      return {
        type: type,
        radius: clamp(numberOr(value('heatmap-radius'), 30), 0, 256),
        weight: Math.max(0, numberOr(value('heatmap-weight'), 1)),
        intensity: Math.max(0, numberOr(value('heatmap-intensity'), 1)),
        opacity: clamp(numberOr(value('heatmap-opacity'), 1), 0, 1)
      };
    }
    if (type === 'symbol') {
      var offset = value('text-offset');
      var symbol = textStyle({
        color: value('text-color'), opacity: numberOr(value('text-opacity'), 1), size: numberOr(value('text-size'), 12),
        font: fontOf(value('text-font'), layer.v8), haloColor: value('text-halo-color'), haloWidth: numberOr(value('text-halo-width'), 0),
        offset: Array.isArray(offset) ? offset : null, offsetX: layer.pixelOffset[0], offsetY: layer.pixelOffset[1],
        radialOffset: numberOr(value('text-radial-offset'), 0), placement: value('symbol-placement'),
        anchor: value('text-anchor') || (Array.isArray(value('text-variable-anchor')) ? value('text-variable-anchor')[0] : null),
        priority: layer.priority, padding: layer.v8 ? numberOr(value('text-padding'), 2) : value('text-padding'),
        allowOverlap: value('text-allow-overlap') === true, ignorePlacement: value('text-ignore-placement') === true,
        maxWidth: numberOr(value('text-max-width'), 0), lineHeight: numberOr(value('text-line-height'), 1.2),
        maxAngle: numberOr(value('text-max-angle'), 45), letterSpacing: numberOr(value('text-letter-spacing'), 0),
        transform: value('text-transform')
      });
      symbol.textOptional = value('text-optional') === true;
      if (layer.props['icon-image']) {
        var iconOffset = value('icon-offset');
        symbol.icon = {
          size: Math.max(0, numberOr(value('icon-size'), 1)), opacity: clamp(numberOr(value('icon-opacity'), 1), 0, 1),
          anchor: ANCHORS[value('icon-anchor')] || ANCHORS.center, offset: Array.isArray(iconOffset) ? iconOffset : [0, 0],
          rotate: numberOr(value('icon-rotate'), 0), allowOverlap: value('icon-allow-overlap') === true,
          ignorePlacement: value('icon-ignore-placement') === true, optional: value('icon-optional') === true,
          padding: Math.max(0, numberOr(value('icon-padding'), 2)), color: colorOr(value('icon-color'), '#000'),
          fit: value('icon-text-fit') || 'none', fitPadding: value('icon-text-fit-padding'),
          haloColor: colorOr(value('icon-halo-color'), 'rgba(0,0,0,0)'),
          haloWidth: Math.max(0, numberOr(value('icon-halo-width'), 0)), haloBlur: Math.max(0, numberOr(value('icon-halo-blur'), 0))
        };
      }
      return symbol;
    }
    var opacity = function (name) { return clamp(numberOr(value(name), 1), 0, 1); };
    if (type === 'fill') {
      var fillPattern = value('fill-pattern');
      return {
        type: type, color: colorOr(value('fill-color'), '#000'), opacity: opacity('fill-opacity'), outlineColor: value('fill-outline-color'),
        outlineWidth: Math.max(0, numberOr(value('fill-outline-width'), 1)), pattern: fillPattern ? cleanLabelText(fillPattern) : null,
        translate: translateOf(value('fill-translate'))
      };
    }
    if (type === 'line') {
      var dash = value('line-dasharray');
      var width = Math.max(0, numberOr(value('line-width'), 1));
      return {
        type: type, color: colorOr(value('line-color'), '#000'), opacity: opacity('line-opacity'), width: width,
        lineCap: value('line-cap') || 'butt', lineJoin: value('line-join') || 'miter',
        pattern: value('line-pattern') ? cleanLabelText(value('line-pattern')) : null, offset: numberOr(value('line-offset'), 0),
        gap: Math.max(0, numberOr(value('line-gap-width'), 0)), translate: translateOf(value('line-translate')),
        dash: Array.isArray(dash) && dash.length && dash.every(function (part) { return part >= 0 && isFinite(part); }) && dash.some(Boolean) ? dash : null
      };
    }
    if (type === 'circle') {
      return {
        type: type, color: colorOr(value('circle-color'), '#000'), opacity: opacity('circle-opacity'), radius: Math.max(0, numberOr(value('circle-radius'), 5)),
        strokeColor: value('circle-stroke-color'), strokeWidth: Math.max(0, numberOr(value('circle-stroke-width'), 0)), strokeOpacity: opacity('circle-stroke-opacity')
      };
    }
    if (type === 'fill-extrusion') {
      return {
        type: type, color: colorOr(value('fill-extrusion-color'), '#000'), roofColor: value('fill-extrusion-roof-color'), opacity: opacity('fill-extrusion-opacity'),
        height: Math.max(0, numberOr(value('fill-extrusion-height'), 0)), base: Math.max(0, numberOr(value('fill-extrusion-base'), 0)),
        verticalGradient: value('fill-extrusion-vertical-gradient') !== false
      };
    }
    if (type === 'raster') {
      // Colour adjustments are approximated with a Canvas CSS filter.
      var filter = [];
      var saturation = numberOr(value('raster-saturation'), 0);
      var contrast = numberOr(value('raster-contrast'), 0);
      var hue = numberOr(value('raster-hue-rotate'), 0);
      var low = numberOr(value('raster-brightness-min'), 0);
      var high = numberOr(value('raster-brightness-max'), 1);
      if (saturation) filter.push('saturate(' + clamp(1 + saturation, 0, 2) + ')');
      if (contrast) filter.push('contrast(' + clamp(contrast > 0 ? 1 / (1 - Math.min(contrast, 0.99)) : 1 + contrast, 0, 10) + ')');
      if (hue) filter.push('hue-rotate(' + hue + 'deg)');
      if (low || high !== 1) filter.push('brightness(' + clamp((low + high) / 2 * 2, 0, 2) + ')');
      return { type: type, opacity: opacity('raster-opacity'), filter: filter.join(' ') || 'none', smooth: value('raster-resampling') !== 'nearest' };
    }
    if (type === 'color-relief') return { type: type, opacity: opacity('color-relief-opacity'), filter: 'none', smooth: true };
    if (type === 'hillshade') {
      return {
        type: type, opacity: 1, filter: 'none', smooth: true,
        direction: numberOr(value('hillshade-illumination-direction'), 335),
        anchor: value('hillshade-illumination-anchor'),
        exaggeration: clamp(numberOr(value('hillshade-exaggeration'), 0.5), 0, 1),
        shadow: parseColor(colorOr(value('hillshade-shadow-color'), '#000000')) || [0, 0, 0, 1],
        highlight: parseColor(colorOr(value('hillshade-highlight-color'), '#ffffff')) || [255, 255, 255, 1],
        accent: parseColor(colorOr(value('hillshade-accent-color'), '#000000')) || [0, 0, 0, 1]
      };
    }
    return { type: type, color: colorOr(value('background-color'), '#000'), opacity: opacity('background-opacity') };
  }

  function translateOf(value) {
    return Array.isArray(value) && (finite(value[0], 0) || finite(value[1], 0)) ? [finite(value[0], 0), finite(value[1], 0)] : null;
  }

  function layerText(layer, zoom, feature) {
    return transformText(cleanLabelText(evaluate(layer, 'text-field', zoom, feature)), evaluate(layer, 'text-transform', zoom, feature));
  }

  // Layers drawn from raster tiles; hillshade and color-relief from elevation.
  function demLayer(type) {
    return type === 'hillshade' || type === 'color-relief';
  }

  function rasterLayer(type) {
    return type === 'raster' || demLayer(type);
  }

  function typeMatches(type, featureType) {
    if (type === 'heatmap') return featureType === 1;
    return type === 'symbol' || (featureType === 3 ? type === 'fill' || type === 'fill-extrusion' : type === (featureType === 2 ? 'line' : 'circle'));
  }

  var callbackLayers = typeof WeakMap === 'function' ? new WeakMap() : null;

  function callbackInstruction(instruction, feature, zoom) {
    if (!instruction) return null;
    if (instruction.paint || instruction.layout) {
      // A layer-shaped callback result: compile it once per object.
      var layer = callbackLayers && callbackLayers.get(instruction);
      if (!layer) {
        layer = compileLayer(instruction, 0, false, true, null);
        if (callbackLayers) callbackLayers.set(instruction, layer);
      }
      if (!typeMatches(layer.type, feature.type) || !passesFilter(layer, zoom, feature)) return null;
      var result = layerInstruction(layer, zoom, feature);
      if (layer.type === 'symbol') {
        result.text = layerText(layer, zoom, feature);
        if (!result.text) return null;
      }
      return result;
    }
    var type = instruction.type || (feature.type === 3 ? 'fill' : feature.type === 2 ? 'line' : 'circle');
    if (type === 'symbol') return symbolInstruction(instruction.text, instruction);
    if ((type === 'fill' && feature.type !== 3) || (type === 'line' && feature.type !== 2) || (type === 'circle' && feature.type !== 1)) return null;
    return {
      type: type,
      color: instruction.color || (type === 'fill' ? '#9fb8a8' : type === 'line' ? '#607080' : '#303840'),
      opacity: clamp(finite(instruction.opacity, 1), 0, 1),
      width: Math.max(0, finite(instruction.width, 1)),
      radius: Math.max(0, finite(instruction.radius, 3)),
      outlineColor: instruction.outlineColor || null,
      outlineWidth: Math.max(0, finite(instruction.outlineWidth, 1)),
      strokeColor: instruction.strokeColor || null,
      strokeWidth: Math.max(0, finite(instruction.strokeWidth, 0)),
      lineCap: instruction.lineCap || 'butt',
      lineJoin: instruction.lineJoin || 'miter',
      dash: Array.isArray(instruction.dash) ? instruction.dash : null,
      height: Math.max(0, finite(instruction.height, 0)),
      base: Math.max(0, finite(instruction.base, 0)),
      roofColor: instruction.roofColor || null
    };
  }

  function callbackInstructions(instruction, feature, zoom) {
    var values = Array.isArray(instruction) ? instruction : [instruction];
    var result = [];
    for (var i = 0; i < values.length; i++) {
      var normalized = callbackInstruction(values[i], feature, zoom);
      if (normalized) result.push(normalized);
    }
    return result;
  }

  // MVT geometry is stored at tile extent precision, which is unnecessary
  // when a tile is shown small on screen. Simplify only the draw copy: the
  // decoded cache and rendered-feature queries retain the source geometry.
  function pointSegmentDistanceSquared(x, y, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var length = dx * dx + dy * dy;
    if (!length) { dx = x - x1; dy = y - y1; return dx * dx + dy * dy; }
    var fraction = clamp(((x - x1) * dx + (y - y1) * dy) / length, 0, 1);
    dx = x - (x1 + dx * fraction);
    dy = y - (y1 + dy * fraction);
    return dx * dx + dy * dy;
  }

  // Shifts a polyline of flat [x, y, …] pixels by `offset` to the right of
  // its direction, mitring the corners (limited like MapLibre's joins).
  function offsetLine(points, offset) {
    var count = points.length / 2;
    var result = new Array(points.length);
    for (var i = 0; i < count; i++) {
      var px = i > 0 ? points[2 * i] - points[2 * i - 2] : 0;
      var py = i > 0 ? points[2 * i + 1] - points[2 * i - 1] : 0;
      var nx = i < count - 1 ? points[2 * i + 2] - points[2 * i] : 0;
      var ny = i < count - 1 ? points[2 * i + 3] - points[2 * i + 1] : 0;
      var pl = Math.sqrt(px * px + py * py) || 1;
      var nl = Math.sqrt(nx * nx + ny * ny) || 1;
      // Right-hand normals (screen y points down) of both segments.
      var ax = i > 0 ? -py / pl : -ny / nl;
      var ay = i > 0 ? px / pl : nx / nl;
      var bx = i < count - 1 ? -ny / nl : ax;
      var by = i < count - 1 ? nx / nl : ay;
      var mx = ax + bx;
      var my = ay + by;
      var ml = Math.sqrt(mx * mx + my * my);
      if (ml > 1e-6) { mx /= ml; my /= ml; } else { mx = ax; my = ay; }
      // The mitre reaches offset / cos(half angle), at most 4× the offset.
      var reach = offset / Math.max(0.25, mx * ax + my * ay);
      result[2 * i] = points[2 * i] + mx * reach;
      result[2 * i + 1] = points[2 * i + 1] + my * reach;
    }
    for (i = 0; i < points.length; i++) points[i] = result[i];
    return points;
  }

  var keepScratch = new Uint8Array(1024);
  var stackScratch = new Int32Array(2048);

  // Douglas-Peucker over one flat coordinate range. Returns a shared keep
  // mask (valid until the next call) or null when a ring would collapse.
  function simplifyMask(coords, start, end, tolerance, closed) {
    var count = end - start;
    if (keepScratch.length < count) keepScratch = new Uint8Array(count * 2);
    if (stackScratch.length < count * 2 + 4) stackScratch = new Int32Array(count * 4 + 8);
    var keep = keepScratch;
    var stack = stackScratch;
    keep.fill(0, 0, count);
    keep[0] = keep[count - 1] = 1;
    var kept = 2;
    var top = 0;
    var toleranceSquared = tolerance * tolerance;
    stack[top++] = 0;
    stack[top++] = count - 1;
    while (top) {
      var last = stack[--top];
      var first = stack[--top];
      var ax = coords[2 * (start + first)];
      var ay = coords[2 * (start + first) + 1];
      var bx = coords[2 * (start + last)];
      var by = coords[2 * (start + last) + 1];
      var best = toleranceSquared;
      var index = -1;
      for (var p = first + 1; p < last; p++) {
        var distance = pointSegmentDistanceSquared(coords[2 * (start + p)], coords[2 * (start + p) + 1], ax, ay, bx, by);
        if (distance > best) { best = distance; index = p; }
      }
      if (index >= 0) {
        keep[index] = 1;
        kept++;
        stack[top++] = first;
        stack[top++] = index;
        stack[top++] = index;
        stack[top++] = last;
      }
    }
    return closed && kept < 3 ? null : keep;
  }

  // Emits a feature's lines or rings into a Canvas context or a Path2D,
  // mapping tile units through origin + coordinate * scale. A positive
  // tolerance (tile units) simplifies the emitted copy.
  function emitPath(sink, feature, originX, originY, scale, close, tolerance) {
    var layer = feature._layer;
    var coords = layer.coords;
    for (var p = feature._partStart; p < feature._partEnd; p++) {
      var start = layer.parts[p];
      var end = layer.parts[p + 1];
      var keep = tolerance > 0 && end - start > (close ? 3 : 2) ? simplifyMask(coords, start, end, tolerance, close) : null;
      var first = true;
      for (var i = start; i < end; i++) {
        if (keep && !keep[i - start]) continue;
        var x = originX + coords[2 * i] * scale;
        var y = originY + coords[2 * i + 1] * scale;
        if (first) sink.moveTo(x, y);
        else sink.lineTo(x, y);
        first = false;
      }
      if (close && !first) sink.closePath();
    }
  }

  function emitCircles(sink, feature, originX, originY, scale, radius) {
    var layer = feature._layer;
    for (var i = layer.parts[feature._partStart]; i < layer.parts[feature._partEnd]; i++) {
      var x = originX + layer.coords[2 * i] * scale;
      var y = originY + layer.coords[2 * i + 1] * scale;
      sink.moveTo(x + radius, y);
      sink.arc(x, y, radius, 0, Math.PI * 2);
    }
  }

  // Paints the current (or a cached) path. `unit` converts CSS pixels into
  // the context's user space: 1 for screen coordinates, 1 / scale for a
  // Path2D kept in tile units.
  var NO_DASH = [];

  function instructionPainted(instruction) {
    return !!instruction && (instruction.opacity > 0 || instruction.type === 'circle' && instruction.strokeColor &&
      instruction.strokeWidth > 0 && instruction.strokeOpacity > 0);
  }

  // Feature-dependent opacity/width may reveal pixels after data or state
  // updates, even when evaluating the layer without a feature returns zero.
  function layerMayPaintGround(layer, zoom) {
    function positive(name, fallback) {
      var node = layer.props[name];
      return !!(node && node.props.length) || numberOr(evaluate(layer, name, zoom, null), fallback) > 0;
    }
    return positive(layer.type + '-opacity', 1) || layer.type === 'circle' &&
      positive('circle-stroke-width', 0) && positive('circle-stroke-opacity', 1);
  }

  function paintInstruction(ctx, instruction, unit, path) {
    var type = instruction.type;
    ctx.globalAlpha = instruction.opacity == null ? 1 : instruction.opacity;
    if (type === 'line') {
      ctx.strokeStyle = instruction.color;
      ctx.lineWidth = instruction.width * unit;
      ctx.lineCap = instruction.lineCap;
      ctx.lineJoin = instruction.lineJoin;
      // Dash lengths are in line widths (MapLibre's line-dasharray).
      if (ctx.setLineDash) {
        var dash = instruction.dash;
        ctx.setLineDash(dash ? dash.map(function (part) { return part * instruction.width * unit; }) : NO_DASH);
      }
      if (path) ctx.stroke(path);
      else ctx.stroke();
      return;
    }
    ctx.fillStyle = instruction.color;
    if (path) ctx.fill(path, 'nonzero');
    else ctx.fill('nonzero');
    var outline = type === 'fill';
    var strokeColor = outline ? instruction.outlineColor : instruction.strokeColor;
    var strokeWidth = outline ? instruction.outlineWidth : instruction.strokeWidth;
    if (strokeColor && strokeWidth) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth * unit;
      if (!outline && instruction.strokeOpacity != null) ctx.globalAlpha = instruction.strokeOpacity;
      // Keep fill outlines independent from a preceding line's cap/join.
      if (outline) {
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
      }
      if (path) ctx.stroke(path);
      else ctx.stroke();
    }
  }

  function drawFeature(ctx, feature, instruction, originX, originY, scale, tolerance) {
    if (!instruction || !instruction.type) return;
    ctx.beginPath();
    if (instruction.type === 'circle') emitCircles(ctx, feature, originX, originY, scale, instruction.radius);
    else emitPath(ctx, feature, originX, originY, scale, instruction.type === 'fill', tolerance);
    paintInstruction(ctx, instruction, 1);
  }

  // 3D buildings (fill-extrusion). The camera is orthographic -- rotation
  // plus the same pitch foreshortening as the ground -- so a building is a
  // prism: its footprint, walls swept up by the per-meter "up" offset from
  // mapMetrics, and the roof. Prisms are drawn back to front, each with the
  // walls that face the viewer before its roof, and shaded with MapLibre's
  // default light (viewport anchor, position [1.15, 210, 30], intensity
  // 0.5). A translucent layer is composed opaque offscreen first, as in
  // MapLibre, so buildings never show through one another.
  var LIGHT_X = 0.2875;
  var LIGHT_Y = -0.498;
  var LIGHT_Z = 0.996;
  var shades = new Map();
  var extrusionCanvas = null;

  // Sutherland-Hodgman against one side of the tile square; side 0/1 clip
  // x/y at 0, side 2/3 at the extent. Clipped points lie exactly on it.
  function clipRing(ring, side, extent) {
    var axis = side & 1;
    var bound = side < 2 ? 0 : extent;
    var n = ring.length / 2;
    var out = [];
    for (var i = 0; i < n; i++) {
      var j = (i + n - 1) % n;
      var previous = ring[2 * j + axis];
      var current = ring[2 * i + axis];
      var inside = side < 2 ? current >= bound : current <= bound;
      if (inside !== (side < 2 ? previous >= bound : previous <= bound)) {
        var t = (bound - previous) / (current - previous);
        var other = ring[2 * j + 1 - axis] + (ring[2 * i + 1 - axis] - ring[2 * j + 1 - axis]) * t;
        out.push(axis ? other : bound, axis ? bound : other);
      }
      if (inside) out.push(ring[2 * i], ring[2 * i + 1]);
    }
    return out;
  }

  // Tile-unit prism of one polygon, cached on the feature. Rings are clipped
  // to the tile square, so the copies in neighbouring tiles meet without a
  // seam and edges on the square are no walls. A wall keeps its outward
  // normal: the first ring winds like every exterior, holes the other way.
  function extrusionPrism(feature) {
    if (feature._prism) return feature._prism;
    var layer = feature._layer;
    var extent = layer.extent;
    var coords = layer.coords;
    var rings = [];
    var walls = [];
    var sumX = 0;
    var sumY = 0;
    var count = 0;
    var exterior = 0;
    var box = [Infinity, Infinity, -Infinity, -Infinity];
    for (var p = feature._partStart; p < feature._partEnd; p++) {
      var ring = [];
      var i;
      for (i = layer.parts[p]; i < layer.parts[p + 1]; i++) ring.push(coords[2 * i], coords[2 * i + 1]);
      if (!exterior) {
        var area = 0;
        for (i = 0; i < ring.length; i += 2) area += ring[i] * ring[(i + 3) % ring.length] - ring[(i + 2) % ring.length] * ring[i + 1];
        exterior = area < 0 ? -1 : 1;
      }
      for (var side = 0; side < 4; side++) ring = clipRing(ring, side, extent);
      var n = ring.length / 2;
      if (n < 3) continue;
      rings.push(ring);
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n;
        var x1 = ring[2 * i];
        var y1 = ring[2 * i + 1];
        var x2 = ring[2 * j];
        var y2 = ring[2 * j + 1];
        sumX += x1;
        sumY += y1;
        count++;
        box[0] = Math.min(box[0], x1);
        box[1] = Math.min(box[1], y1);
        box[2] = Math.max(box[2], x1);
        box[3] = Math.max(box[3], y1);
        if ((x1 === x2 && (x1 === 0 || x1 === extent)) || (y1 === y2 && (y1 === 0 || y1 === extent))) continue;
        var length = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
        if (length) walls.push(x1, y1, x2, y2, (y2 - y1) * exterior / length, (x1 - x2) * exterior / length);
      }
    }
    return (feature._prism = { rings: rings, walls: walls, box: box, x: count ? sumX / count : 0, y: count ? sumY / count : 0 });
  }

  // Triangulates a polygon with holes (flat [x, y, …] rings, unclosed) by
  // ear clipping after bridging each hole into the outer ring. Building
  // footprints are small, so the simple quadratic method is fast enough.
  // Returns flat triangle corner coordinates [x, y, x, y, x, y, …].
  function signedRingArea(ring) {
    var area = 0;
    for (var i = 0, n = ring.length; i < n; i += 2) {
      var j = (i + 2) % n;
      area += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
    }
    return area / 2;
  }

  function reversedRing(ring) {
    var out = new Array(ring.length);
    for (var i = 0, n = ring.length / 2; i < n; i++) {
      out[2 * i] = ring[2 * (n - 1 - i)];
      out[2 * i + 1] = ring[2 * (n - 1 - i) + 1];
    }
    return out;
  }

  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    var d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    var d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    var d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    var d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function bridgeHole(outer, hole) {
    // The hole's rightmost vertex joins the nearest outer vertex that it can
    // see without crossing an edge of either ring.
    var h = 0;
    for (var i = 2; i < hole.length; i += 2) if (hole[i] > hole[h]) h = i;
    var hx = hole[h];
    var hy = hole[h + 1];
    var order = [];
    for (i = 0; i < outer.length; i += 2) order.push(i);
    order.sort(function (a, b) {
      return (outer[a] - hx) * (outer[a] - hx) + (outer[a + 1] - hy) * (outer[a + 1] - hy) -
        (outer[b] - hx) * (outer[b] - hx) - (outer[b + 1] - hy) * (outer[b + 1] - hy);
    });
    var best = order[0];
    for (var o = 0; o < order.length && o < 64; o++) {
      var k = order[o];
      var ox = outer[k];
      var oy = outer[k + 1];
      var blocked = false;
      for (var r = 0; r < 2 && !blocked; r++) {
        var ring = r ? hole : outer;
        for (i = 0; i < ring.length && !blocked; i += 2) {
          var j = (i + 2) % ring.length;
          blocked = segmentsCross(hx, hy, ox, oy, ring[i], ring[i + 1], ring[j], ring[j + 1]);
        }
      }
      if (!blocked) { best = k; break; }
    }
    var merged = outer.slice(0, best + 2);
    for (i = 0; i <= hole.length; i += 2) {
      var index = (h + i) % hole.length;
      merged.push(hole[index], hole[index + 1]);
    }
    merged.push(outer[best], outer[best + 1]);
    return merged.concat(outer.slice(best + 2));
  }

  function triangulate(rings, out) {
    out = out || [];
    var polygons = [];
    var sign = 0;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (ring.length < 6) continue;
      var area = signedRingArea(ring);
      if (!area) continue;
      if (!sign) sign = area > 0 ? 1 : -1;
      if ((area > 0 ? 1 : -1) === sign || !polygons.length) polygons.push({ outer: area > 0 ? ring : reversedRing(ring), holes: [] });
      else polygons[polygons.length - 1].holes.push(area < 0 ? ring : reversedRing(ring));
    }
    for (var p = 0; p < polygons.length; p++) {
      var points = polygons[p].outer;
      var holes = polygons[p].holes.slice().sort(function (a, b) {
        var maxA = -Infinity;
        var maxB = -Infinity;
        for (var i = 0; i < a.length; i += 2) maxA = Math.max(maxA, a[i]);
        for (i = 0; i < b.length; i += 2) maxB = Math.max(maxB, b[i]);
        return maxB - maxA;
      });
      for (var h = 0; h < holes.length && points.length < 4096; h++) points = bridgeHole(points, holes[h]);
      clipEars(points, out);
    }
    return out;
  }

  function clipEars(points, out) {
    var n = points.length / 2;
    var next = new Int32Array(n);
    var prev = new Int32Array(n);
    for (var i = 0; i < n; i++) { next[i] = (i + 1) % n; prev[i] = (i + n - 1) % n; }
    var remaining = n;
    var current = 0;
    var stall = 0;
    while (remaining > 3 && stall < remaining) {
      var a = prev[current];
      var c = next[current];
      var ax = points[2 * a], ay = points[2 * a + 1];
      var bx = points[2 * current], by = points[2 * current + 1];
      var cx = points[2 * c], cy = points[2 * c + 1];
      var cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      var ear = cross > 0;
      if (ear) {
        for (var k = next[c]; k !== a; k = next[k]) {
          var px = points[2 * k], py = points[2 * k + 1];
          if ((px === ax && py === ay) || (px === bx && py === by) || (px === cx && py === cy)) continue;
          if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0 && (cx - bx) * (py - by) - (cy - by) * (px - bx) >= 0 &&
            (ax - cx) * (py - cy) - (ay - cy) * (px - cx) >= 0) { ear = false; break; }
        }
      }
      if (ear) {
        out.push(ax, ay, bx, by, cx, cy);
        next[a] = c;
        prev[c] = a;
        remaining--;
        stall = 0;
        current = c;
      } else {
        current = next[current];
        stall++;
      }
    }
    // Leftovers of a degenerate ring: a fan keeps the roof closed.
    if (remaining >= 3) {
      var first = current;
      for (var v = next[first]; next[v] !== first; v = next[v]) {
        out.push(points[2 * first], points[2 * first + 1], points[2 * v], points[2 * v + 1], points[2 * next[v]], points[2 * next[v] + 1]);
      }
    }
    return out;
  }

  // WebGL program for buildings in the tilted view. Positions are tile units
  // and meters; the matrix carries the tile and the perspective camera, and
  // shading reproduces shadeOf() (MapLibre's default light).
  var EXTRUSION_VERTEX = 'attribute vec3 a_pos;attribute vec2 a_normal;attribute vec4 a_color;attribute vec2 a_shade;' +
    'uniform mat4 u_matrix;uniform vec2 u_light;varying vec4 v_color;' +
    'void main(){gl_Position=u_matrix*vec4(a_pos,1.0);' +
    'float light=a_shade.y>0.5?' + LIGHT_Z + ':dot(a_normal,u_light);' +
    'float f=(0.5+(max(1.5-a_color.a,1.0)-0.5)*clamp(light,0.0,1.0))*a_shade.x;' +
    'v_color=vec4(min(a_color.rgb*f,vec3(1.0)),1.0);}';
  var EXTRUSION_FRAGMENT = 'precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}';

  function extrusionProgram(gl) {
    function shader(type, sourceText) {
      var compiled = gl.createShader(type);
      gl.shaderSource(compiled, sourceText);
      gl.compileShader(compiled);
      return gl.getShaderParameter(compiled, gl.COMPILE_STATUS) ? compiled : null;
    }
    var vertex = shader(gl.VERTEX_SHADER, EXTRUSION_VERTEX);
    var fragment = shader(gl.FRAGMENT_SHADER, EXTRUSION_FRAGMENT);
    if (!vertex || !fragment) return null;
    var program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return {
      program: program,
      pos: gl.getAttribLocation(program, 'a_pos'),
      normal: gl.getAttribLocation(program, 'a_normal'),
      color: gl.getAttribLocation(program, 'a_color'),
      shade: gl.getAttribLocation(program, 'a_shade'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      light: gl.getUniformLocation(program, 'u_light')
    };
  }

  // Column-major matrix from (tile x, tile y, meters) to clip space for a
  // tile whose top-left is (ox, oy) raw pixels from the map centre.
  function extrusionMatrix(camera, ox, oy, scale, perMeter, out) {
    var d = camera.distance;
    var sinP = camera.sinPitch;
    var cosP = camera.cosPitch;
    var cosA = camera.cosBearing;
    var sinA = camera.sinBearing;
    var hw = camera.width / 2;
    var hh = camera.height / 2;
    var near = d * 0.02;
    var far = d * 12;
    var depthA = (far + near) / (far - near);
    var depthB = -2 * far * near / (far - near);
    // Rows of x_r, y_r and z in (tx, ty, meters, 1).
    var xr = [scale * cosA, -scale * sinA, 0, cosA * ox - sinA * oy];
    var yr = [scale * sinA, scale * cosA, 0, sinA * ox + cosA * oy];
    var zr = [0, 0, perMeter, 0];
    for (var c = 0; c < 4; c++) {
      var w = (c === 3 ? d : 0) - sinP * yr[c] - cosP * zr[c];
      out[c * 4] = d / hw * xr[c];
      out[c * 4 + 1] = -d / hh * (cosP * yr[c] - sinP * zr[c]);
      out[c * 4 + 2] = depthA * w + (c === 3 ? depthB : 0);
      out[c * 4 + 3] = w;
    }
    return out;
  }

  // MapLibre's directional wall light and vertical gradient, quantised to
  // 64 steps. An instruction parses its colour once; repeated walls hit its
  // shade table without parsing or building a global cache key.
  function shadeOf(instruction, normalLight, gradient, roof) {
    var color = roof ? instruction.roofColor || instruction.color : instruction.color;
    var table = roof ? instruction._roofShades : instruction._shades;
    if (!table) {
      table = [];
      var rgb = parseColor(color) || [0, 0, 0, 1];
      table.rgb = rgb;
      table.value = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
      if (roof) instruction._roofShades = table;
      else instruction._shades = table;
    }
    var value = table.value;
    var index = Math.round((0.5 + (Math.max(1.5 - value, 1) - 0.5) * clamp(normalLight, 0, 1)) * gradient * 64);
    if (table[index]) return table[index];
    var factor = index / 64;
    var key = color + '|' + Math.round(factor * 255);
    var result = shades.get(key);
    if (!result) {
      if (shades.size > 2048) shades.clear();
      var rgb = table.rgb;
      result = 'rgba(' + Math.round(Math.min(255, rgb[0] * factor)) + ',' + Math.round(Math.min(255, rgb[1] * factor)) + ',' +
        Math.round(Math.min(255, rgb[2] * factor)) + ',' + rgb[3] + ')';
      shades.set(key, result);
    }
    return (table[index] = result);
  }

  // pieces: { prism, x, y, scale, instruction } in the raw (pre-camera)
  // canvas space of the geometry pass. `cull` widens the culling box (for a
  // cache with a margin); `opaque` draws at full opacity for the caller to
  // compose.
  // With `job`, drawing is resumable: the first call culls and sorts, and
  // each call draws until job.deadline; it returns true when done.
  function drawExtrusions(ctx, pieces, metrics, cull, opaque, job) {
    var upX = metrics.extrudeDxPerMeter;
    var upY = metrics.extrudeDyPerMeter;
    // Depth follows the ground plane's screen y coordinate.
    var viewX = metrics.sine;
    var viewY = metrics.cosine;
    // The light stays fixed on screen: rotate it back into map space. It is
    // negated because MapLibre lights walls by their inward normal.
    var lightX = -viewY * LIGHT_X - viewX * LIGHT_Y;
    var lightY = viewX * LIGHT_X - viewY * LIGHT_Y;
    var view = cull || metrics.view;
    var i;
    var kept = 0;
    for (i = job && job.prepared ? pieces.length : 0; i < pieces.length; i++) {
      var item = pieces[i];
      var box = item.prism.box;
      var rise = item.instruction.height;
      // Cull by the footprint box swept up to the roof.
      if (item.x + box[0] * item.scale + Math.min(0, upX * rise) > view.x1 || item.x + box[2] * item.scale + Math.max(0, upX * rise) < view.x0 ||
        item.y + box[1] * item.scale + Math.min(0, upY * rise) > view.y1 || item.y + box[3] * item.scale + Math.max(0, upY * rise) < view.y0) continue;
      // Screen-down is towards the viewer: nearer prisms sort last.
      item.depth = (item.x + item.prism.x * item.scale) * viewX + (item.y + item.prism.y * item.scale) * viewY;
      pieces[kept++] = item;
    }
    if (!job || !job.prepared) {
      pieces.length = kept;
      pieces.sort(function (a, b) { return a.depth - b.depth || a.instruction.base - b.instruction.base; });
      if (job) job.prepared = true;
    }
    if (!pieces.length) return true;
    var opacity = opaque ? 1 : pieces[0].instruction.opacity;
    var target = ctx;
    if (opacity < 1 && typeof ctx.getTransform === 'function' && ctx.canvas) {
      extrusionCanvas = extrusionCanvas || root.document.createElement('canvas');
      if (extrusionCanvas.width !== ctx.canvas.width || extrusionCanvas.height !== ctx.canvas.height) {
        extrusionCanvas.width = ctx.canvas.width;
        extrusionCanvas.height = ctx.canvas.height;
      }
      target = extrusionCanvas.getContext('2d');
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, extrusionCanvas.width, extrusionCanvas.height);
      target.setTransform(ctx.getTransform());
    }
    target.globalAlpha = target === ctx ? opacity : 1;
    var visible = [];
    function nearer(a, b) {
      return (walls[b] + walls[b + 2] - walls[a] - walls[a + 2]) * viewX +
        (walls[b + 1] + walls[b + 3] - walls[a + 1] - walls[a + 3]) * viewY;
    }
    var walls;
    for (i = job ? job.index : 0; i < pieces.length; i++) {
      if (job && i > job.index && (i & 15) === 0 && now() > job.deadline) {
        job.index = i;
        return false;
      }
      var piece = pieces[i];
      var instruction = piece.instruction;
      var prism = piece.prism;
      var scale = piece.scale;
      var height = instruction.height;
      var base = Math.min(height, instruction.base);
      var topX = piece.x + upX * height;
      var topY = piece.y + upY * height;
      var w;
      if (height > base && metrics.pitch) {
        var baseX = piece.x + upX * base;
        var baseY = piece.y + upY * base;
        walls = prism.walls;
        var gradient = instruction.verticalGradient === false ? 0 : Math.sqrt(height / 150);
        var bottom = gradient ? clamp(base * gradient, 0.84, 1) : 1;
        var top = gradient ? clamp((1 + base) * gradient, 0.84, 1) : 1;
        visible.length = 0;
        for (w = 0; w < walls.length; w += 6) {
          if (walls[w + 4] * viewX + walls[w + 5] * viewY > 0) visible.push(w);
        }
        if (visible.length === 2) {
          if (nearer(visible[0], visible[1]) > 0) {
            var first = visible[0]; visible[0] = visible[1]; visible[1] = first;
          }
        } else if (visible.length > 2) visible.sort(nearer);
        // Consecutive walls of one shade share a path and a fill. Each quad
        // keeps one winding, so overlapping walls stay filled.
        var run = null;
        for (var v = visible.length - 1; v >= 0; v--) {
          w = visible[v];
          var light = walls[w + 4] * lightX + walls[w + 5] * lightY;
          var x1 = walls[w] * scale;
          var y1 = walls[w + 1] * scale;
          var x2 = walls[w + 2] * scale;
          var y2 = walls[w + 3] * scale;
          var style = bottom === top ? shadeOf(instruction, light, bottom) : null;
          if (!style || style !== run) {
            if (run) target.fill();
            target.beginPath();
            if (style) target.fillStyle = style;
            else {
              var fill = target.createLinearGradient(baseX + x1, baseY + y1, topX + x1, topY + y1);
              fill.addColorStop(0, shadeOf(instruction, light, bottom));
              fill.addColorStop(1, shadeOf(instruction, light, top));
              target.fillStyle = fill;
            }
          }
          run = style;
          if ((x2 - x1) * upY - (y2 - y1) * upX < 0) {
            var swapX = x1; x1 = x2; x2 = swapX;
            var swapY = y1; y1 = y2; y2 = swapY;
          }
          target.moveTo(baseX + x1, baseY + y1);
          target.lineTo(baseX + x2, baseY + y2);
          target.lineTo(topX + x2, topY + y2);
          target.lineTo(topX + x1, topY + y1);
          target.closePath();
          if (!style) target.fill();
        }
        if (run) target.fill();
      }
      target.beginPath();
      for (var r = 0; r < prism.rings.length; r++) {
        var ring = prism.rings[r];
        target.moveTo(topX + ring[0] * scale, topY + ring[1] * scale);
        for (w = 2; w < ring.length; w += 2) target.lineTo(topX + ring[w] * scale, topY + ring[w + 1] * scale);
        target.closePath();
      }
      target.fillStyle = shadeOf(instruction, LIGHT_Z, 1, true);
      target.fill('nonzero');
    }
    if (target !== ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = opacity;
      ctx.drawImage(extrusionCanvas, 0, 0);
      ctx.restore();
    }
    if (job) job.index = pieces.length;
    return true;
  }

  function firstPointAnchor(feature, originX, originY, scale) {
    if (feature._partEnd <= feature._partStart) return null;
    var layer = feature._layer;
    var i = layer.parts[feature._partStart];
    return { x: originX + layer.coords[2 * i] * scale, y: originY + layer.coords[2 * i + 1] * scale, angle: 0 };
  }

  function boundsAnchor(feature, originX, originY, scale) {
    var layer = feature._layer;
    var coords = layer.coords;
    var start = layer.parts[feature._partStart];
    var end = layer.parts[feature._partEnd];
    if (!(end > start)) return null;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = start; i < end; i++) {
      minX = Math.min(minX, coords[2 * i]);
      minY = Math.min(minY, coords[2 * i + 1]);
      maxX = Math.max(maxX, coords[2 * i]);
      maxY = Math.max(maxY, coords[2 * i + 1]);
    }
    return { x: originX + (minX + maxX) / 2 * scale, y: originY + (minY + maxY) / 2 * scale, angle: 0 };
  }

  // Midpoint of the longest part. Lengths and angles are measured in tile
  // units: a uniform scale changes neither the fraction nor the direction.
  function lineAnchor(feature, originX, originY, scale) {
    var layer = feature._layer;
    var coords = layer.coords;
    var selected = -1;
    var selectedLength = 0;
    var p;
    var i;
    for (p = feature._partStart; p < feature._partEnd; p++) {
      var length = 0;
      for (i = layer.parts[p] + 1; i < layer.parts[p + 1]; i++) {
        length += Math.sqrt(Math.pow(coords[2 * i] - coords[2 * i - 2], 2) + Math.pow(coords[2 * i + 1] - coords[2 * i - 1], 2));
      }
      if (length > selectedLength) {
        selected = p;
        selectedLength = length;
      }
    }
    if (selected < 0) return boundsAnchor(feature, originX, originY, scale);
    var target = selectedLength / 2;
    var travelled = 0;
    for (i = layer.parts[selected] + 1; i < layer.parts[selected + 1]; i++) {
      var startX = coords[2 * i - 2];
      var startY = coords[2 * i - 1];
      var deltaX = coords[2 * i] - startX;
      var deltaY = coords[2 * i + 1] - startY;
      var segmentLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (!segmentLength) continue;
      if (travelled + segmentLength >= target) {
        var fraction = (target - travelled) / segmentLength;
        var angle = Math.atan2(deltaY, deltaX);
        if (angle > Math.PI / 2 || angle <= -Math.PI / 2) angle += Math.PI;
        return {
          x: originX + (startX + deltaX * fraction) * scale,
          y: originY + (startY + deltaY * fraction) * scale,
          angle: angle,
          length: selectedLength
        };
      }
      travelled += segmentLength;
    }
    return boundsAnchor(feature, originX, originY, scale);
  }

  function linePartsOf(feature, target) {
    var layer = feature._layer;
    for (var p = feature._partStart; p < feature._partEnd; p++) {
      var start = layer.parts[p];
      var end = layer.parts[p + 1];
      if (end - start < 2) continue;
      target.push(Array.prototype.slice.call(layer.coords, 2 * start, 2 * end));
    }
  }

  // MapLibre's mergeLines: OSM ways are split at every junction, so join
  // same-text parts whose ends meet before placing labels along them.
  function mergeLines(parts) {
    if (parts.length < 2 || parts.length > 256) return parts;
    var pending = parts.slice();
    var result = [];
    while (pending.length) {
      var line = pending.pop();
      for (var joined = true; joined;) {
        joined = false;
        for (var i = pending.length - 1; i >= 0; i--) {
          var other = pending[i];
          if (line[line.length - 2] === other[0] && line[line.length - 1] === other[1]) line = line.concat(other.slice(2));
          else if (other[other.length - 2] === line[0] && other[other.length - 1] === line[1]) line = other.concat(line.slice(2));
          else continue;
          pending.splice(i, 1);
          joined = true;
        }
      }
      result.push(line);
    }
    return result;
  }

  // Anchors along a flat [x, y, ...] line: its middle, or one per
  // `spacing` tile units on long lines (symbol-spacing). Each anchor
  // reports the line length it may use, for the text-fits-the-line test.
  function lineAnchors(line, spacing) {
    var total = 0;
    var i;
    for (i = 2; i < line.length; i += 2) total += Math.sqrt(Math.pow(line[i] - line[i - 2], 2) + Math.pow(line[i + 1] - line[i - 1], 2));
    if (!total) return [];
    var count = spacing > 0 ? Math.max(1, Math.min(32, Math.floor(total / spacing))) : 1;
    var share = total / count;
    var anchors = [];
    var target = share / 2;
    var travelled = 0;
    for (i = 2; i < line.length && anchors.length < count; i += 2) {
      var dx = line[i] - line[i - 2];
      var dy = line[i + 1] - line[i - 1];
      var length = Math.sqrt(dx * dx + dy * dy);
      while (length && travelled + length >= target && anchors.length < count) {
        var fraction = (target - travelled) / length;
        var angle = Math.atan2(dy, dx);
        if (angle > Math.PI / 2 || angle <= -Math.PI / 2) angle += Math.PI;
        anchors.push({ x: line[i - 2] + dx * fraction, y: line[i - 1] + dy * fraction, angle: angle, length: share, along: target, line: line });
        target += share;
      }
      travelled += length;
    }
    return anchors;
  }

  function symbolAnchor(feature, instruction, originX, originY, scale) {
    if (instruction.placement === 'line' && feature.type === 2) return lineAnchor(feature, originX, originY, scale);
    if (feature.type === 1) return firstPointAnchor(feature, originX, originY, scale);
    return boundsAnchor(feature, originX, originY, scale);
  }

  // A bounded candidate list keeps a hostile or overly detailed source from
  // turning the label pass into unbounded layout work. Callers cull
  // off-screen candidates first, so the cap only applies to useful ones.
  var MAX_LABELS = 2000;

  function pushLabel(labels, style, text, x, y, angle, candidate, sortKey) {
    var icon = candidate && style.icon ? candidate.icon : '';
    if (labels.length >= MAX_LABELS || (!text && !icon)) return;
    labels.push({
      text: text,
      icon: icon,
      ax: x,
      ay: y,
      style: style,
      x: x + style.offsetX,
      y: y + style.offsetY,
      angle: angle,
      priority: style.priority,
      sortKey: finite(sortKey, 0),
      order: labels.length,
      candidate: candidate || null
    });
  }

  function collectSymbol(labels, feature, instruction, originX, originY, scale) {
    if (labels.length >= MAX_LABELS) return;
    var anchor = symbolAnchor(feature, instruction, originX, originY, scale);
    if (anchor) pushLabel(labels, instruction, instruction.text, anchor.x, anchor.y, anchor.angle);
  }

  // ctx.measureText forces the browser to shape/lay out the string, one of
  // the pricier Canvas 2D calls. Text is measured once at a 100px reference
  // size and scaled, so zoom-interpolated text sizes do not re-measure every
  // frame. Shared across map instances and reset past a few thousand
  // entries so an unbounded session cannot leak memory.
  var textMetricsCache = new Map();

  function measuredText(ctx, text, font) {
    var key = font + '\u0000' + text;
    var cached = textMetricsCache.get(key);
    if (cached) return cached;
    ctx.font = font;
    var measured = ctx.measureText ? ctx.measureText(text) : { width: text.length * 55 };
    var result = {
      width: finite(measured.width, text.length * 55),
      ascent: finite(measured.actualBoundingBoxAscent, 80),
      descent: finite(measured.actualBoundingBoxDescent, 20)
    };
    if (textMetricsCache.size >= 4000) textMetricsCache.clear();
    textMetricsCache.set(key, result);
    return result;
  }

  // Greedy word wrap for point labels (MapLibre's text-max-width, in ems),
  // measured in reference units. Line labels always stay on one line.
  function labelLayout(ctx, label) {
    var style = label.style;
    var wrap = style.maxWidth > 0 && label.angle === 0 && style.placement !== 'line' ? style.maxWidth / style.size * 100 : 0;
    var key = style.measureFont + '|' + wrap;
    var candidate = label.candidate;
    if (candidate && candidate.layout && candidate.layout.key === key) return candidate.layout;
    var words = wrap ? label.text.split(' ') : null;
    var lines = [label.text];
    if (words && words.length > 1 && measuredText(ctx, label.text, style.measureFont).width > wrap) {
      lines = [];
      var current = '';
      for (var i = 0; i < words.length; i++) {
        var next = current ? current + ' ' + words[i] : words[i];
        if (current && measuredText(ctx, next, style.measureFont).width > wrap) {
          lines.push(current);
          current = words[i];
        } else current = next;
      }
      lines.push(current);
    }
    var width = 0;
    var metrics = measuredText(ctx, label.text, style.measureFont);
    for (var l = 0; l < lines.length; l++) width = Math.max(width, lines.length > 1 ? measuredText(ctx, lines[l], style.measureFont).width : metrics.width);
    var layout = { key: key, lines: lines, width: width, height: metrics.ascent + metrics.descent };
    if (candidate) candidate.layout = layout;
    return layout;
  }

  // Scripts whose letters change shape with their neighbours (Arabic,
  // Hebrew, Indic, Thai, …) cannot be drawn one glyph at a time; their line
  // labels stay straight.
  var SHAPED_SCRIPT = /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u18af\ufb1d-\ufdff\ufe70-\ufeff]/;

  // Glyphs of a line label along its screen path (MapLibre's curved line
  // labels): each character is centred on the line at its own tangent; the
  // text reads left to right, and sharp bends (text-max-angle) or a line
  // too short for the text leave the label out. Returns its collision box
  // chain, or null.
  function curvedBox(ctx, label, padding) {
    var style = label.style;
    var text = label.layout.lines[0];
    var path = label.path;
    var n = path.length / 2;
    var cumulative = [0];
    for (var i = 1; i < n; i++) {
      var dx = path[2 * i] - path[2 * i - 2];
      var dy = path[2 * i + 1] - path[2 * i - 1];
      cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    var total = cumulative[n - 1];
    var scale = label.scale || 1;
    var unit = style.size / 100 * scale;
    var chars = Array.from(text);
    var advances = [];
    var width = 0;
    for (i = 0; i < chars.length; i++) {
      advances.push(measuredText(ctx, chars[i], style.measureFont).width * unit + (i < chars.length - 1 ? style.letterSpacing * scale : 0));
      width += advances[i];
    }
    var at = label.pathAt;
    var start = at - width / 2;
    if (start < 0 || start + width > total) return null;
    function pointAt(distance, reverse) {
      if (reverse) distance = total - distance;
      var low = 0;
      var high = n - 1;
      while (high - low > 1) {
        var middle = (low + high) >> 1;
        if (cumulative[middle] <= distance) low = middle; else high = middle;
      }
      var length = cumulative[high] - cumulative[low] || 1;
      var t = (distance - cumulative[low]) / length;
      var ax = path[2 * low];
      var ay = path[2 * low + 1];
      var bx = path[2 * high];
      var by = path[2 * high + 1];
      var angle = reverse ? Math.atan2(ay - by, ax - bx) : Math.atan2(by - ay, bx - ax);
      return [ax + (bx - ax) * t, ay + (by - ay) * t, angle];
    }
    // Read left to right: walk the path backwards when it points left.
    var first = pointAt(start, false);
    var last = pointAt(start + width, false);
    var reverse = last[0] < first[0];
    if (reverse) start = total - at - width / 2;
    var glyphs = [];
    var chain = [];
    var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, chain: chain };
    var offset = 0;
    var previous = null;
    var size = (style.size + 2 * padding) * scale;
    for (i = 0; i < chars.length; i++) {
      var point = pointAt(start + offset + advances[i] / 2, reverse);
      offset += advances[i];
      if (previous !== null) {
        var turn = point[2] - previous;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        if (Math.abs(turn) > style.maxAngle) return null;
      }
      previous = point[2];
      glyphs.push({ text: chars[i], x: point[0], y: point[1], angle: point[2] });
      if (chars[i] === ' ') continue;
      var box = { minX: point[0] - size / 2, minY: point[1] - size / 2, maxX: point[0] + size / 2, maxY: point[1] + size / 2 };
      chain.push(box);
      bounds.minX = Math.min(bounds.minX, box.minX);
      bounds.minY = Math.min(bounds.minY, box.minY);
      bounds.maxX = Math.max(bounds.maxX, box.maxX);
      bounds.maxY = Math.max(bounds.maxY, box.maxY);
    }
    if (!chain.length) return null;
    label.glyphs = glyphs;
    return bounds;
  }

  function labelBox(ctx, label) {
    var style = label.style;
    var layout = label.layout = labelLayout(ctx, label);
    label.glyphs = null;
    label.curvable = !!(label.path && style.placement === 'line' && layout.lines.length === 1 && !SHAPED_SCRIPT.test(label.text));
    var unit = style.size / 100;
    // A tilted view scales labels with distance (label.scale); label.top
    // stays in unscaled text units for drawing in a scaled context.
    var scale = label.scale || 1;
    var width = Math.max(1, layout.width * unit);
    var height = layout.lines.length > 1 ? layout.lines.length * style.lineHeight : Math.max(style.size, layout.height * unit);
    var padding = style.padding == null ? style.haloWidth + 2 : style.padding;
    if (label.angle) {
      // Rotated line labels are centered on their anchor. Like MapLibre's
      // collision circles, a chain of small boxes follows the text, so a
      // diagonal label does not block its whole axis-aligned bounding box.
      label.top = -height / 2;
      width *= scale;
      height *= scale;
      padding *= scale;
      var size = height + 2 * padding;
      var count = Math.max(1, Math.ceil((width + 2 * padding) / size));
      var step = (width + 2 * padding - size) / Math.max(1, count - 1);
      var dx = Math.cos(label.angle);
      var dy = Math.sin(label.angle);
      var chain = [];
      var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, chain: chain };
      for (var i = 0; i < count; i++) {
        var along = count > 1 ? -(width + 2 * padding - size) / 2 + i * step : 0;
        var cx = label.x + dx * along;
        var cy = label.y + dy * along;
        var box = { minX: cx - size / 2, minY: cy - size / 2, maxX: cx + size / 2, maxY: cy + size / 2 };
        chain.push(box);
        bounds.minX = Math.min(bounds.minX, box.minX);
        bounds.minY = Math.min(bounds.minY, box.minY);
        bounds.maxX = Math.max(bounds.maxX, box.maxX);
        bounds.maxY = Math.max(bounds.maxY, box.maxY);
      }
      return bounds;
    }
    var left = style.textAlign === 'left' ? 0 : style.textAlign === 'right' ? -width : -width / 2;
    var top = style.textBaseline === 'top' ? 0 : style.textBaseline === 'bottom' ? -height : -height / 2;
    label.top = top;
    left *= scale;
    top *= scale;
    width *= scale;
    height *= scale;
    padding *= scale;
    return { minX: label.x + left - padding, minY: label.y + top - padding, maxX: label.x + left + width + padding, maxY: label.y + top + height + padding };
  }

  // A 64px grid of placed label boxes. Boxes are culled to the viewport
  // first, so numeric cell keys stay small and unique.
  function collides(cells, box, insert) {
    var minX = Math.floor(box.minX / 64);
    var maxX = Math.floor(box.maxX / 64);
    var maxY = Math.floor(box.maxY / 64);
    for (var y = Math.floor(box.minY / 64); y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var key = x * 4096 + y;
        var list = cells.get(key);
        if (insert) {
          if (list) list.push(box);
          else cells.set(key, [box]);
        } else if (list) {
          for (var i = 0; i < list.length; i++) {
            var other = list[i];
            if (box.minX < other.maxX && box.maxX > other.minX && box.minY < other.maxY && box.maxY > other.minY) return true;
          }
        }
      }
    }
    return false;
  }

  // Rotated text is rasterised again at every new angle, which made each
  // frame of a rotation slow. Like MapLibre's glyph atlas, a rotated label
  // is drawn once, upright, into a small sprite and then only transformed.
  var labelSprites = new Map();

  function labelSprite(ctx, text, style, scale) {
    var key = style.font + '|' + style.color + '|' + style.haloColor + '|' + style.haloWidth + '|' + scale + '|' + text;
    var sprite = labelSprites.get(key);
    if (sprite) return sprite;
    var halo = style.haloColor && style.haloWidth ? style.haloWidth : 0;
    var metrics = measuredText(ctx, text, style.measureFont);
    var spriteWidth = Math.ceil(metrics.width * style.size / 100 + 2 * halo + 4);
    var spriteHeight = Math.ceil(style.size * 1.5 + 2 * halo + 4);
    var canvas = root.document.createElement('canvas');
    canvas.width = Math.ceil(spriteWidth * scale);
    canvas.height = Math.ceil(spriteHeight * scale);
    var sprite2d = canvas.getContext('2d');
    if (!sprite2d) return null;
    sprite2d.scale(scale, scale);
    sprite2d.font = style.font;
    sprite2d.textAlign = 'center';
    sprite2d.textBaseline = 'middle';
    if (halo && sprite2d.strokeText) {
      sprite2d.strokeStyle = style.haloColor;
      sprite2d.lineWidth = halo * 2;
      sprite2d.lineJoin = 'round';
      sprite2d.strokeText(text, spriteWidth / 2, spriteHeight / 2);
    }
    sprite2d.fillStyle = style.color;
    sprite2d.fillText(text, spriteWidth / 2, spriteHeight / 2);
    if (labelSprites.size >= 1500) labelSprites.clear();
    labelSprites.set(key, sprite = { canvas: canvas, width: spriteWidth, height: spriteHeight });
    return sprite;
  }

  // Screen box of a symbol's icon around its anchor; MapLibre's icon-anchor
  // names the side of the image at the anchor, icon-offset is in image
  // pixels times icon-size.
  function iconBoxOf(label, icon, image) {
    var scale = label.scale || 1;
    var iconWidth = image.width * icon.size * scale;
    var iconHeight = image.height * icon.size * scale;
    if (icon.fit !== 'none' && label.text && label.layout) {
      var padding = Array.isArray(icon.fitPadding) ? icon.fitPadding : [0, 0, 0, 0];
      var textWidth = label.layout.width * label.style.size / 100;
      var textHeight = label.layout.lines.length > 1 ? label.layout.lines.length * label.style.lineHeight : Math.max(label.style.size, label.layout.height * label.style.size / 100);
      var fitWidth = textWidth + finite(padding[1], 0) + finite(padding[3], 0);
      var fitHeight = textHeight + finite(padding[0], 0) + finite(padding[2], 0);
      if (icon.fit === 'width' || icon.fit === 'both') iconWidth = Math.max(1, fitWidth);
      if (icon.fit === 'height' || icon.fit === 'both') iconHeight = Math.max(1, fitHeight);
    }
    var anchor = icon.anchor;
    var left = (anchor[2] === 1 ? 0 : anchor[2] === -1 ? -iconWidth : -iconWidth / 2) + finite(icon.offset[0], 0) * icon.size * scale;
    var top = (anchor[3] === 1 ? 0 : anchor[3] === -1 ? -iconHeight : -iconHeight / 2) + finite(icon.offset[1], 0) * icon.size * scale;
    var rotation = icon.rotate * Math.PI / 180 + (label.style.placement === 'line' ? label.angle || 0 : 0);
    var reach = rotation ? Math.sqrt(iconWidth * iconWidth + iconHeight * iconHeight) / 2 : 0;
    var cx = label.ix + left + iconWidth / 2;
    var cy = label.iy + top + iconHeight / 2;
    var halfX = (reach || iconWidth / 2) + icon.padding;
    var halfY = (reach || iconHeight / 2) + icon.padding;
    return { minX: cx - halfX, minY: cy - halfY, maxX: cx + halfX, maxY: cy + halfY, left: left, top: top, width: iconWidth, height: iconHeight, rotation: rotation };
  }

  // SDF icons are single-colour masks tinted with icon-color.
  function iconSource(image, color) {
    if (!image.sdf) return image.source;
    var tinted = image.tinted || (image.tinted = new Map());
    var canvas = tinted.get(color);
    if (canvas) return canvas;
    canvas = root.document.createElement('canvas');
    canvas.width = image.sw;
    canvas.height = image.sh;
    var tint = canvas.getContext('2d');
    tint.drawImage(image.source, image.sx, image.sy, image.sw, image.sh, 0, 0, image.sw, image.sh);
    tint.globalCompositeOperation = 'source-in';
    tint.fillStyle = color;
    tint.fillRect(0, 0, image.sw, image.sh);
    if (tinted.size > 16) tinted.clear();
    tinted.set(color, canvas);
    return canvas;
  }

  function drawIcon(ctx, label, icon, image, box) {
    var source = iconSource(image, icon.color);
    var tintedWhole = source !== image.source;
    ctx.save();
    ctx.globalAlpha = icon.opacity;
    if (icon.haloWidth > 0 && icon.haloColor && icon.haloColor !== 'rgba(0,0,0,0)') {
      ctx.shadowColor = icon.haloColor;
      ctx.shadowBlur = icon.haloWidth + icon.haloBlur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.translate(label.ix, label.iy);
    if (box.rotation) ctx.rotate(box.rotation);
    ctx.drawImage(source, tintedWhole ? 0 : image.sx, tintedWhole ? 0 : image.sy, image.sw, image.sh, box.left, box.top, box.width, box.height);
    ctx.restore();
  }

  function onScreen(box, viewportWidth, viewportHeight) {
    return !(box.maxX < 0 || box.minX > viewportWidth || box.maxY < 0 || box.minY > viewportHeight);
  }

  // MapLibre places symbols from the top style layer down and, within a
  // layer, by ascending symbol-sort-key; compact styles use `priority`.
  // Icon and text of one symbol follow MapLibre's rules: both or neither,
  // unless text-optional or icon-optional lets one go alone.
  function drawLabels(ctx, labels, viewportWidth, viewportHeight, resolveImage) {
    var sprites = typeof ctx.getTransform === 'function' && root.document && typeof root.document.createElement === 'function';
    var pixelScale = 1;
    var current = sprites ? ctx.getTransform() : null;
    if (!current || !isFinite(current.a)) sprites = false;
    else pixelScale = Math.round(Math.sqrt(current.a * current.a + current.b * current.b) * 100) / 100 || 1;
    labels.sort(function (left, right) {
      return right.priority - left.priority || left.sortKey - right.sortKey || left.order - right.order;
    });
    var cells = new Map();
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var style = label.style;
      var box = label.text && style.opacity > 0 ? labelBox(ctx, label) : null;
      // A curved line label is laid out only if its straight box (a close
      // approximation) is free: most candidates collide and need no layout.
      if (box && label.curvable) {
        var blocked = false;
        var straight = box.chain || [box];
        if (!style.allowOverlap) for (var c = 0; c < straight.length && !blocked; c++) blocked = collides(cells, straight[c], false);
        box = blocked ? null : curvedBox(ctx, label, style.padding == null ? style.haloWidth + 2 : style.padding);
      }
      var icon = style.icon;
      var image = label.icon && icon && icon.opacity > 0 && resolveImage ? resolveImage(label.icon) : null;
      if (image && icon.fit !== 'none' && label.text && !label.layout) labelLayout(ctx, label);
      var iconBox = image ? iconBoxOf(label, icon, image) : null;
      if (box && !onScreen(box, viewportWidth, viewportHeight)) box = null;
      if (iconBox && !onScreen(iconBox, viewportWidth, viewportHeight)) iconBox = null;
      if (!box && !iconBox) continue;
      var parts = box ? box.chain || [box] : [];
      var placeText = !!box;
      var placeIcon = !!iconBox;
      for (var b = 0; b < parts.length && !style.allowOverlap && placeText; b++) placeText = !collides(cells, parts[b], false);
      if (placeIcon && !icon.allowOverlap) placeIcon = !collides(cells, iconBox, false);
      if (box && iconBox) {
        if (style.textOptional && !icon.optional) placeText = placeText && placeIcon;
        else if (icon.optional && !style.textOptional) placeIcon = placeIcon && placeText;
        else if (!style.textOptional) placeText = placeIcon = placeText && placeIcon;
      }
      if (!placeText && !placeIcon) continue;
      for (b = 0; b < parts.length && placeText && !style.ignorePlacement; b++) collides(cells, parts[b], true);
      if (placeIcon && !icon.ignorePlacement) collides(cells, iconBox, true);
      if (placeIcon) drawIcon(ctx, label, icon, image, iconBox);
      if (!placeText) continue;
      var lines = label.layout.lines;
      var multi = lines.length > 1;
      ctx.save();
      ctx.globalAlpha = style.opacity;
      ctx.font = style.font;
      ctx.textAlign = label.angle ? 'center' : style.textAlign;
      ctx.textBaseline = multi || label.angle ? 'middle' : style.textBaseline;
      if (label.glyphs) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var g = 0; g < label.glyphs.length; g++) {
          var glyph = label.glyphs[g];
          if (glyph.text === ' ') continue;
          var glyphSprite = sprites ? labelSprite(ctx, glyph.text, style, pixelScale) : null;
          ctx.save();
          ctx.translate(glyph.x, glyph.y);
          ctx.rotate(glyph.angle);
          if (label.scale && label.scale !== 1) ctx.scale(label.scale, label.scale);
          if (glyphSprite) ctx.drawImage(glyphSprite.canvas, -glyphSprite.width / 2, -glyphSprite.height / 2, glyphSprite.width, glyphSprite.height);
          else {
            if (style.haloColor && style.haloWidth && ctx.strokeText) {
              ctx.strokeStyle = style.haloColor;
              ctx.lineWidth = style.haloWidth * 2;
              ctx.lineJoin = 'round';
              ctx.strokeText(glyph.text, 0, 0);
            }
            ctx.fillStyle = style.color;
            if (ctx.fillText) ctx.fillText(glyph.text, 0, 0);
          }
          ctx.restore();
        }
        ctx.restore();
        continue;
      }
      ctx.translate(label.x, label.y);
      if (label.angle) ctx.rotate(label.angle);
      if (label.scale && label.scale !== 1) ctx.scale(label.scale, label.scale);
      var sprite = sprites && label.angle && !multi ? labelSprite(ctx, lines[0], style, pixelScale) : null;
      if (sprite) {
        ctx.drawImage(sprite.canvas, -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
        ctx.restore();
        continue;
      }
      for (var l = 0; l < lines.length; l++) {
        var y = multi ? label.top + (l + 0.5) * style.lineHeight : 0;
        if (style.haloColor && style.haloWidth && ctx.strokeText) {
          ctx.strokeStyle = style.haloColor;
          ctx.lineWidth = style.haloWidth * 2;
          ctx.lineJoin = 'round';
          ctx.strokeText(lines[l], 0, y);
        }
        ctx.fillStyle = style.color;
        if (ctx.fillText) ctx.fillText(lines[l], 0, y);
      }
      ctx.restore();
    }
  }

  // A small starting style for sources using these common layer names.
  // Applications can provide any style that matches their own tile schema.
  function basicStyle(options) {
    options = options || {};
    var theme = options.theme || 'light';
    if (theme !== 'light' && theme !== 'dark' && theme !== 'outdoor' && theme !== 'contrast') {
      throw styleError('basicStyle theme must be light, dark, outdoor or contrast');
    }
    var colors = theme === 'dark' ? {
      landcover: '#304638', water: '#214e65', building: '#526068', buildingOutline: '#6b7780',
      majorRoad: '#c78b67', secondaryRoad: '#8e9292', localRoad: '#6c777c', path: '#9cb598'
    } : theme === 'outdoor' ? {
      landcover: '#cfe4be', water: '#8ec5dc', building: '#ded3bf', buildingOutline: '#b4a891',
      majorRoad: '#ad7051', secondaryRoad: '#d8bd79', localRoad: '#f1e9d4', path: '#527a4d'
    } : theme === 'contrast' ? {
      landcover: '#f0f0e8', water: '#0072b2', building: '#383838', buildingOutline: '#000000',
      majorRoad: '#b02318', secondaryRoad: '#bc7500', localRoad: '#414141', path: '#2a5d32'
    } : {
      landcover: '#dfe9d7', water: '#b8dced', building: '#d7cdbf', buildingOutline: '#c4b9aa',
      majorRoad: '#e48c62', secondaryRoad: '#f9f6ef', localRoad: '#ffffff', path: '#82997c'
    };
    if (options.colors != null) {
      if (typeof options.colors !== 'object' || Array.isArray(options.colors)) throw styleError('basicStyle colors must be an object');
      for (var name in options.colors) if (own(options.colors, name)) {
        if (!own(colors, name) || typeof options.colors[name] !== 'string' || !options.colors[name]) throw styleError('invalid basicStyle color ' + name);
        colors[name] = options.colors[name];
      }
    }
    var bold = theme === 'contrast';
    var layers = [
      { id: 'landcover', sourceLayer: 'landcover', type: 'fill', paint: { color: colors.landcover } },
      { id: 'water', sourceLayer: 'water', type: 'fill', paint: { color: colors.water } },
      // Keep overview maps quiet. Source tiles may still contain dense local
      // geometry at a low z, but buildings and minor streets only become
      // useful once they have enough screen space to be legible.
      { id: 'buildings', sourceLayer: 'building', type: 'fill', minzoom: 13, paint: { color: colors.building, opacity: 0.82, outlineColor: colors.buildingOutline, outlineWidth: 0.5 } },
      { id: 'roads-major', sourceLayer: 'transportation', type: 'line', minzoom: 6, filter: ['in', 'class', 'motorway', 'trunk', 'primary'], paint: { color: colors.majorRoad, width: bold ? 3.4 : 2.6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
      // A useful overview needs connector roads, not every drawable way.
      // In particular, a broad "not major" filter pulls dense footways,
      // paths, tracks and service spurs into the Canvas pass. Those belong in
      // an explicit outdoor/detail style, not in the fast base preset.
      { id: 'roads-secondary', sourceLayer: 'transportation', type: 'line', minzoom: 10, filter: ['in', 'class', 'secondary', 'tertiary'], paint: { color: colors.secondaryRoad, width: bold ? 2.4 : 1.6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
      { id: 'roads-local', sourceLayer: 'transportation', type: 'line', minzoom: 13, filter: ['in', 'class', 'residential', 'unclassified', 'minor', 'living_street', 'service'], paint: { color: colors.localRoad, width: bold ? 1.8 : 1.2 }, layout: { 'line-cap': 'round', 'line-join': 'round' } }
    ];
    if (theme === 'outdoor') layers.push({ id: 'outdoor-paths', sourceLayer: 'transportation', type: 'line', minzoom: 15,
      filter: ['in', 'class', 'path', 'footway', 'pedestrian', 'track', 'cycleway'],
      paint: { color: colors.path, width: 1.2 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    return layers;
  }

  function sourceLayerOf(style) {
    return style.sourceLayer == null ? style['source-layer'] : style.sourceLayer;
  }

  var PATH_BUDGET_MS = 6;
  var clock = root.performance && typeof root.performance.now === 'function' ? root.performance : Date;

  function now() {
    return clock.now();
  }

  // Screen-space draw tolerance: up to 4px in overviews and a sub-pixel
  // 0.3px from z12 on. It is quantized to half octaves of the tile scale,
  // so a cached path changes detail a few times per zoom level at most.
  function lodFor(scale, zoom) {
    var tolerance = Math.max(0.3, clamp((12 - zoom) * 0.8, 0, 4)) / scale;
    return tolerance >= 0.5 ? Math.round(Math.log(tolerance) / Math.LN2 * 2) : -99;
  }

  function lodTolerance(lod) {
    return lod === -99 ? 0 : Math.pow(2, lod / 2);
  }

  function styleZoomVisible(style, zoom) {
    return !(style.minzoom != null && zoom < +style.minzoom) &&
      !(style.maxzoom != null && zoom >= +style.maxzoom);
  }

  // Declarative styles are evaluated into per-tile buckets, so keep a
  // private snapshot: later edits go through setStyle()/setPaintProperty().
  function cloneStyleValue(value, depth) {
    if (depth > 32) throw styleError('style is nested too deeply');
    var result;
    if (Array.isArray(value)) {
      result = [];
      for (var i = 0; i < value.length; i++) result.push(cloneStyleValue(value[i], depth + 1));
      return result;
    }
    if (!value || typeof value !== 'object') return value;
    result = {};
    for (var key in value) if (own(value, key)) result[key] = cloneStyleValue(value[key], depth + 1);
    return result;
  }

  // Application themes often resend freshly allocated expressions. Compare
  // their JSON structure, rather than invalidating tile buckets by identity.
  function sameStyleValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    var keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (var i = 0; i < keys.length; i++) if (!own(b, keys[i]) || !sameStyleValue(a[keys[i]], b[keys[i]])) return false;
    return true;
  }

  // Accepts a function style, a layer array, a compact profile ({ layers })
  // or a MapLibre style (version 8). For a MapLibre style, only background
  // layers and layers of the selected vector source are rendered here; the
  // others are listed in the report so an application can route them to
  // microMap.geojson. `strict: false` skips unsupported properties instead
  // of throwing, and lists them in the report too.
  function normalizeStyle(style, options) {
    options = options || {};
    if (style == null) style = basicStyle();
    if (typeof style === 'function') return style;
    var v8 = !!style && !Array.isArray(style) && style.version === 8;
    var layers = Array.isArray(style) ? style : style && Array.isArray(style.layers) ? style.layers : null;
    if (!layers) throw styleError('style must be a function, layer array, { layers } or a MapLibre style');
    if (layers.length > 1024) throw styleError('style has too many layers');
    layers = cloneStyleValue(layers, 0);
    var sourceID = options.source || null;
    if (v8 && !sourceID && style.sources) {
      for (var id in style.sources) {
        if (own(style.sources, id) && style.sources[id] && style.sources[id].type === 'vector') { sourceID = id; break; }
      }
    }
    var report = { source: sourceID, approximated: [], ignored: [], skippedLayers: [] };
    if (v8 && style.glyphs) report.approximated.push('glyphs (browser fonts are used)');

    var compiled = [];
    // GeoJSON sources render through the same pipeline, interleaved with
    // the vector layers and sharing label placement; so do further vector
    // sources, each with its own tiles.
    var geojson = Object.create(null);
    var rasters = Object.create(null);
    var vectors = Object.create(null);
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var layerV8 = v8 || !!(layer && layer.source);
      var spec = v8 && layer && layer.source && style.sources && own(style.sources, layer.source) ? style.sources[layer.source] : null;
      var isGeoJSON = !!(spec && spec.type === 'geojson');
      var isRaster = !!(spec && ((spec.type === 'raster' && layer.type === 'raster') || (spec.type === 'raster-dem' && demLayer(layer.type))));
      var isVector = !!(spec && spec.type === 'vector');
      if (v8 && layer && layer.type !== 'background' && !isGeoJSON && !isRaster && !isVector) {
        // Terrain, image, video and canvas sources.
        report.skippedLayers.push(layer.id);
        continue;
      }
      if (!v8 && layerV8 && layer && layer.type !== 'background' && sourceID && layer.source !== sourceID) {
        report.skippedLayers.push(layer.id);
        continue;
      }
      if (isVector && layer.source !== sourceID) vectors[layer.source] = spec;
      var entry = compileLayer(layer, compiled.length, layerV8, options.strict !== false, report);
      if (isGeoJSON) {
        entry.geojson = layer.source;
        geojson[layer.source] = spec;
      }
      if (isRaster) {
        entry.raster = layer.source;
        rasters[layer.source] = spec;
      }
      compiled.push(entry);
    }
    // Attribution HTML of every source this layer renders.
    report.attributions = {};
    [sourceID].concat(Object.keys(geojson), Object.keys(rasters), Object.keys(vectors)).forEach(function (id) {
      var value = v8 && id && own(style.sources, id) && style.sources[id].attribution;
      if (typeof value === 'string' && value) report.attributions[id] = value;
    });
    compiled.report = report;
    compiled.sprite = v8 && style.sprite ? style.sprite : null;
    compiled.maplibre = v8;
    compiled.geojson = geojson;
    compiled.rasters = rasters;
    compiled.vectors = vectors;
    return compiled;
  }

  // MapLibre's standard hillshade (as in version 6) over RGBA-encoded
  // elevation, in place:
  // Sobel slopes with its zoom-dependent exaggeration, then shadow,
  // highlight and accent colours by slope and aspect (premultiplied mixing
  // as in its shader, stored unpremultiplied). `encoding` is
  // [red, green, blue, base]; settings hold direction (degrees from north),
  // exaggeration (0-1) and shadow/highlight/accent as [r, g, b, a].
  function shadeDEM(data, size, z, tileY, encoding, settings, prepared) {
    var intensity = settings.exaggeration;
    if (intensity <= 0) {
      for (var clear = 3; clear < data.length; clear += 4) data[clear] = 0;
      return data;
    }
    if (prepared && prepared.ready) return shadePreparedDEM(data, prepared, settings);
    var elevation = new Float32Array(size * size);
    var missing = false;
    for (var i = 0; i < elevation.length; i++) {
      if (data[4 * i + 3] === 0) { elevation[i] = NaN; missing = true; }
      else elevation[i] = data[4 * i] * encoding[0] + data[4 * i + 1] * encoding[1] + data[4 * i + 2] * encoding[2] - encoding[3];
    }
    var factor = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3;
    var exaggerate = z < 15 ? (z - 15) * factor : 0;
    // As MapLibre 6: slopes per tile pixel, scaled by the tile size.
    var divisor = Math.pow(2, exaggerate + (28.2562 - z)) / size;
    var azimuth = settings.direction * Math.PI / 180 + Math.PI;
    var base = 1.875 - intensity * 1.75;
    var maxValue = 0.5 * Math.PI;
    var powerRange = Math.pow(base, maxValue) - 1;
    var strength = clamp(intensity * 2, 0, 1);
    var shadow = settings.shadow;
    var highlight = settings.highlight;
    var accent = settings.accent;
    var count = Math.pow(2, z);
    for (var row = 0; row < size; row++) {
      var latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + (row + 0.5) / size) / count)));
      var scaleFactor = Math.cos(latitude);
      var up = Math.max(0, row - 1) * size;
      var mid = row * size;
      var down = Math.min(size - 1, row + 1) * size;
      // At the tile edge the neighbour is missing: a one-sided difference
      // spans one pixel instead of two, so it counts double. Otherwise the
      // edge would show as a light seam.
      var rowWeight = row === 0 || row === size - 1 ? 2 : 1;
      for (var column = 0; column < size; column++) {
        var center = elevation[mid + column];
        if (!isFinite(center)) continue;
        var left = Math.max(0, column - 1);
        var right = Math.min(size - 1, column + 1);
        var columnWeight = column === 0 || column === size - 1 ? 2 : 1;
        var a = elevation[up + left], b = elevation[up + column], c = elevation[up + right];
        var d = elevation[mid + left], f = elevation[mid + right];
        var g = elevation[down + left], h = elevation[down + column], k = elevation[down + right];
        // Missing DEM samples are not sea-level/deep trenches. Preserve
        // holes and extend the valid centre into missing neighbours.
        if (missing) {
          a = finite(a, center); b = finite(b, center); c = finite(c, center);
          d = finite(d, center); f = finite(f, center);
          g = finite(g, center); h = finite(h, center); k = finite(k, center);
        }
        // MapLibre stores these in a texture, which limits them to ±4.
        var dx = clamp(((c + f + f + k) - (a + d + d + g)) * columnWeight / divisor, -4, 4) / scaleFactor;
        var dy = clamp(((g + h + h + k) - (a + b + b + c)) * rowWeight / divisor, -4, 4) / scaleFactor;
        var slope = Math.atan(0.625 * Math.sqrt(dx * dx + dy * dy));
        var aspect = dx !== 0 ? Math.atan2(dy, -dx) : Math.PI / 2 * (dy > 0 ? 1 : -1);
        var scaled = intensity !== 0.5 ? ((Math.pow(base, slope) - 1) / powerRange) * maxValue : slope;
        var accentWeight = (1 - Math.cos(scaled)) * strength;
        var lit = Math.abs((((aspect + azimuth) / Math.PI + 0.5) % 2 + 2) % 2 - 1);
        var weight = Math.sin(scaled) * strength;
        if (prepared) {
          var sample = mid + column;
          prepared.aspect[sample] = aspect;
          prepared.weight[sample] = weight;
          prepared.accentWeight[sample] = accentWeight;
        }
        var shadeAlpha = (shadow[3] + (highlight[3] - shadow[3]) * lit) * weight;
        var outA = accent[3] * accentWeight * (1 - shadeAlpha) + shadeAlpha;
        var o = 4 * (mid + column);
        if (outA <= 0) { data[o + 3] = 0; continue; }
        for (var channel = 0; channel < 3; channel++) {
          var shaded = (shadow[channel] * shadow[3] + (highlight[channel] * highlight[3] - shadow[channel] * shadow[3]) * lit) * weight;
          data[o + channel] = clamp((accent[channel] * accent[3] * accentWeight * (1 - shadeAlpha) + shaded) / outA, 0, 255);
        }
        data[o + 3] = clamp(outA * 255, 0, 255);
      }
    }
    if (prepared) prepared.ready = true;
    return data;
  }

  // Only illumination and colours change when a viewport-anchored light
  // turns. Float64 retains the original shader's arithmetic at byte-rounding
  // boundaries; Float32 changes a few visible colour values.
  function shadePreparedDEM(data, prepared, settings) {
    var azimuth = settings.direction * Math.PI / 180 + Math.PI;
    var shadow = settings.shadow;
    var highlight = settings.highlight;
    var accent = settings.accent;
    for (var i = 0; i < prepared.aspect.length; i++) {
      var aspect = prepared.aspect[i];
      if (!isFinite(aspect)) continue;
      var weight = prepared.weight[i];
      var accentWeight = prepared.accentWeight[i];
      var lit = Math.abs((((aspect + azimuth) / Math.PI + 0.5) % 2 + 2) % 2 - 1);
      var shadeAlpha = (shadow[3] + (highlight[3] - shadow[3]) * lit) * weight;
      var outA = accent[3] * accentWeight * (1 - shadeAlpha) + shadeAlpha;
      var o = 4 * i;
      if (outA <= 0) { data[o + 3] = 0; continue; }
      for (var channel = 0; channel < 3; channel++) {
        var shaded = (shadow[channel] * shadow[3] + (highlight[channel] * highlight[3] - shadow[channel] * shadow[3]) * lit) * weight;
        data[o + channel] = clamp((accent[channel] * accent[3] * accentWeight * (1 - shadeAlpha) + shaded) / outA, 0, 255);
      }
      data[o + 3] = clamp(outA * 255, 0, 255);
    }
    return data;
  }

  // color-relief-color as MapLibre samples it: the colours at the stops of
  // an `interpolate` over ['elevation'], blended linearly between them and
  // held beyond the ends; a `step` keeps its hard edges. Colours are
  // premultiplied [r, g, b, a] (0-255, alpha 0-1).
  function reliefStops(layer) {
    var node = layer.props['color-relief-color'];
    if (layer._relief && layer._reliefNode === node && layer._reliefVersion === layer.version) return layer._relief;
    var elevations = [];
    var curve = node && node.curve;
    if (curve && curve.input.props.indexOf('$elevation') >= 0) {
      for (var i = 0; i < curve.stops.length; i++) {
        if (curve.step) elevations.push(curve.stops[i] - 1e-3);
        elevations.push(curve.stops[i]);
      }
    } else if (node) elevations.push(0);
    var context = { zoom: 0, feature: null, elevation: 0 };
    var colors = [];
    for (var e = 0; e < elevations.length; e++) {
      context.elevation = elevations[e];
      var color = null;
      try { color = parseColor(node.fn(context)); } catch (error) {}
      color = color || [0, 0, 0, 0];
      colors.push(color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]);
    }
    // MapLibre draws nothing without colours.
    if (!elevations.length) { elevations.push(0); colors.push(0, 0, 0, 0); }
    var relief = { stops: elevations, colors: colors, key: elevations.join(',') + '|' + colors.join(',') };
    layer._relief = relief;
    layer._reliefNode = node;
    layer._reliefVersion = layer.version;
    return relief;
  }

  // Colours RGBA-encoded elevation in place by relief stops (see above).
  function reliefDEM(data, encoding, relief) {
    var stops = relief.stops;
    var colors = relief.colors;
    var last = stops.length - 1;
    for (var o = 0; o < data.length; o += 4) {
      if (data[o + 3] === 0) continue;
      var elevation = data[o] * encoding[0] + data[o + 1] * encoding[1] + data[o + 2] * encoding[2] - encoding[3];
      var low = 0;
      var high = 0;
      if (elevation >= stops[last]) low = high = last;
      else if (elevation > stops[0]) {
        high = last;
        while (high - low > 1) {
          var middle = (low + high) >> 1;
          if (stops[middle] <= elevation) low = middle;
          else high = middle;
        }
      }
      var t = high === low ? 0 : (elevation - stops[low]) / (stops[high] - stops[low]);
      var a = colors[4 * low + 3] + (colors[4 * high + 3] - colors[4 * low + 3]) * t;
      if (a <= 0) { data[o + 3] = 0; continue; }
      for (var channel = 0; channel < 3; channel++) {
        var premultiplied = colors[4 * low + channel] + (colors[4 * high + channel] - colors[4 * low + channel]) * t;
        data[o + channel] = clamp(premultiplied / a, 0, 255);
      }
      data[o + 3] = clamp(a * 255, 0, 255);
    }
    return data;
  }

  // MapLibre's default heatmap colour ramp.
  var DEFAULT_HEATMAP_COLOR = ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0, 0, 255, 0)', 0.1, 'royalblue', 0.3, 'cyan', 0.5, 'lime', 0.7, 'yellow', 1, 'red'];
  var defaultHeatmapNode = null;

  // heatmap-color as 256 RGBA entries by density, per layer version and zoom.
  function heatmapRamp(layer, zoom) {
    var node = layer.props['heatmap-color'] || defaultHeatmapNode ||
      (defaultHeatmapNode = compileExpression(DEFAULT_HEATMAP_COLOR, 0, Object.create(null)));
    var key = layer.version + '|' + (node.zoom ? Math.round(zoom * 10) : 0);
    if (layer._ramp && layer._rampKey === key && layer._rampNode === node) return layer._ramp;
    var ramp = new Uint8ClampedArray(1024);
    var context = { zoom: zoom, feature: null, heatmapDensity: 0 };
    for (var i = 0; i < 256; i++) {
      context.heatmapDensity = i / 255;
      var color = null;
      try { color = parseColor(node.fn(context)); } catch (error) {}
      color = color || [0, 0, 0, 0];
      ramp[4 * i] = color[0];
      ramp[4 * i + 1] = color[1];
      ramp[4 * i + 2] = color[2];
      ramp[4 * i + 3] = color[3] * 255;
    }
    layer._ramp = ramp;
    layer._rampKey = key;
    layer._rampNode = node;
    return ramp;
  }

  // One point of MapLibre's heatmap kernel as additive alpha:
  // weight x intensity x exp(-4.5 t^2) / sqrt(2 pi) at t = distance / radius.
  var kernelSprites = new Map();

  function kernelSprite(radius, strength) {
    var r = Math.max(1, Math.round(radius));
    var level = Math.round(strength * 100) / 100;
    var key = r + '|' + level;
    var sprite = kernelSprites.get(key);
    if (sprite) {
      kernelSprites.delete(key);
      kernelSprites.set(key, sprite);
      return sprite;
    }
    sprite = root.document.createElement('canvas');
    sprite.width = sprite.height = 2 * r + 1;
    var draw = sprite.getContext('2d', { willReadFrequently: true });
    if (draw && typeof draw.createRadialGradient === 'function') {
      var gradient = draw.createRadialGradient(r + 0.5, r + 0.5, 0, r + 0.5, r + 0.5, r);
      // The kernel ends at the radius: the last stop is fully transparent,
      // or the gradient's padding would fill the sprite's corners.
      for (var stop = 0; stop <= 10; stop++) {
        var t = stop / 10;
        var alpha = stop === 10 ? 0 : Math.min(1, level * 0.3989422804 * Math.exp(-4.5 * t * t));
        gradient.addColorStop(t, 'rgba(255,255,255,' + alpha.toFixed(4) + ')');
      }
      draw.fillStyle = gradient;
      draw.fillRect(0, 0, 2 * r + 1, 2 * r + 1);
    }
    kernelSprites.set(key, sprite);
    if (kernelSprites.size > 64) kernelSprites.delete(kernelSprites.keys().next().value);
    return sprite;
  }

  function vectorMap(map, options) {
    if (!map || typeof map.getContainer !== 'function' || typeof map.on !== 'function' || typeof map.off !== 'function') {
      throw new Error('microMap.vector: pass a microMap instance');
    }
    if (typeof microMap !== 'function') throw new Error('microMap.vector: load microMap.js before microMap.vector.js');
    options = options || {};
    // tiles: false renders a style without a base vector source, e.g. only
    // GeoJSON and raster sources (or vector sources added later).
    if (options.tiles !== false && (!options.tiles || (typeof options.tiles !== 'string' && typeof options.tiles !== 'function'))) {
      throw new Error('microMap.vector: options.tiles must be a vector-tile URL template or function (or false)');
    }
    if (typeof root.fetch !== 'function' && typeof options.fetch !== 'function') {
      throw new Error('microMap.vector: fetch is required to load vector tiles');
    }

    var container = map.getContainer();
    var canvas = root.document.createElement('canvas');
    var context = canvas.getContext && canvas.getContext('2d');
    if (!context) throw new Error('microMap.vector: Canvas 2D is required');
    var source = options.tiles || null;
    var sourceVersion = 0;
    var minZoom = clamp(Math.ceil(finite(options.minZoom, 0)), 0, 30);
    var maxZoom = clamp(Math.floor(finite(options.maxZoom, 22)), minZoom, 30);
    var tileBuffer = clamp(Math.ceil(finite(options.tileBuffer, 1)), 0, 8);
    var maxConcurrent = positiveInteger(options.maxConcurrent, 6, 32);
    var maxVisibleTiles = positiveInteger(options.maxVisibleTiles, 4096, 65536);
    var maxCacheBytes = positiveInteger(options.maxCacheBytes, 32 * 1024 * 1024, 512 * 1024 * 1024);
    var maxFallbackZoomDelta = nonNegativeInteger(options.maxFallbackZoomDelta, 2, 30);
    var retryDelay = positiveInteger(options.retryDelay, 5000, 600000);
    var subdomains = typeof options.subdomains === 'string' && options.subdomains ? options.subdomains : 'abc';
    var fetcher = options.fetch || root.fetch;
    var fetchOptions = options.fetchOptions || null;
    var style = normalizeStyle(options.style == null ? options.layers : options.style, options);
    var styleDocument = options.style && options.style.version === 8 ? cloneStyleValue(options.style, 0) : null;
    var primarySourceID = typeof style !== 'function' && style.report ? style.report.source : null;
    var sourceTms = (options.scheme != null ? options.scheme : styleDocument && styleDocument.sources && styleDocument.sources[primarySourceID] && styleDocument.sources[primarySourceID].scheme) === 'tms';
    var extraVectors = Object.create(null);
    var mvtClusterSettings = options.clusterMVT ? (options.clusterMVT === true ? {} : options.clusterMVT) : null;
    if (mvtClusterSettings) {
      if (typeof style === 'function') throw new Error('microMap.vector: clusterMVT requires a declarative style');
      if (!mvtClusterSettings || typeof mvtClusterSettings !== 'object' || Array.isArray(mvtClusterSettings)) throw new Error('microMap.vector: clusterMVT must be true or an options object');
      mvtClusterSettings = {
        clusterRadius: clamp(finite(mvtClusterSettings.radius, 50), 0, 512),
        clusterMaxZoom: clamp(Math.floor(finite(mvtClusterSettings.maxZoom, 14)), 0, 24),
        clusterMinPoints: clamp(Math.floor(finite(mvtClusterSettings.minPoints, 2)), 2, 100000),
        sourceLayers: Array.isArray(mvtClusterSettings.sourceLayers) ? mvtClusterSettings.sourceLayers.slice() : null
      };
    }
    var styleVersion = 0;
    // A DPR cap bounds fill-rate on 3x/4x phones (MapLibre-like crispness
    // up to 2x by default, as in microMap.webgl); maxDpr: 4 restores it.
    var maxDpr = clamp(finite(options.maxDpr, 2), 1, 4);
    var frameStart = 0;
    var pathBuilds = 0;
    var pathStale = false;
    var queueDirty = false;
    // worker: true (default) uses the standalone script's own URL when it
    // is known; a string names the vector script URL; false decodes inline.
    var customDecoder = typeof options.decodeTile === 'function' ? options.decodeTile : null;
    var workerURL = customDecoder || options.worker === false || typeof root.Worker !== 'function' ? null
      : typeof options.worker === 'string' ? options.worker : scriptURL;
    var decoder = workerURL ? decoderPool(workerURL) : null;
    var cache = Object.create(null);
    var cacheBytes = 0;
    var errors = Object.create(null);
    var inFlight = Object.create(null);
    var queue = [];
    var queued = Object.create(null);
    var active = 0;
    var frame = 0;
    var retryTimer = 0;
    var retryAt = 0;
    var destroyed = false;
    var width = 0;
    var height = 0;
    var dpr = 1;
    var useCounter = 0;
    var entrySerial = 0;
    var imageVersion = 0;
    var rasterVersion = 0;
    var needed = Object.create(null);
    // Speculative work is separate from the per-frame visible tile set, so a
    // fast pan can drop stale preloads without dropping the current view.
    var preloadWanted = Object.create(null);
    var preloadTimer = 0;
    var preloadConfig = options.preload == null || options.preload === false ? null : normalizePreload(options.preload);
    var navigation = normalizeNavigation(options.navigation, null);
    var navigationSet = options.navigation != null;
    var initialNavigation = readMapNavigation();
    if (initialNavigation) {
      navigation = normalizeNavigation(initialNavigation, navigation);
      navigationSet = true;
    }
    var listeners = Object.create(null);
    var tileJSON = options.tileJSON || null;
    // Keep the precise plans that produced the last visible Canvas frame.
    // Feature queries must describe pixels that are on screen now, rather
    // than a newer camera state which may merely be scheduled for rendering.
    var rendered = null;

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:' +
      clamp(Math.floor(finite(options.zIndex, 1)), -100, 100) + ';pointer-events:none';
    container.appendChild(canvas);

    function emit(type, extra) {
      var list = listeners[type];
      if (!list || !list.length) return;
      var event = { type: type, target: api, map: map };
      var key;
      if (extra) for (key in extra) event[key] = extra[key];
      list = list.slice();
      for (var i = 0; i < list.length; i++) list[i](event);
    }

    function defaultPreloadConfig(enabled) {
      return { around: enabled ? 1 : 0, zoom: enabled ? [1] : [], direction: null, maxTiles: 48, delay: 120 };
    }

    function cloneDirection(direction) {
      if (!direction) return null;
      var result = {};
      if (direction.bearing != null) result.bearing = direction.bearing;
      if (direction.distance != null) result.distance = direction.distance;
      if (direction.width != null) result.width = direction.width;
      return result;
    }

    function normalizePreloadDirection(value, fallback) {
      if (value === false || value === null) return null;
      if (value === undefined) return cloneDirection(fallback);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('microMap.vector: preload.direction must be an object, null, or false');
      }
      var result = {};
      var number;
      number = +value.bearing;
      if (!isFinite(number)) throw new Error('microMap.vector: preload.direction requires a finite bearing');
      result.bearing = ((number % 360) + 360) % 360;
      if (value.distance != null && !isFinite(+value.distance)) throw new Error('microMap.vector: preload.direction.distance must be finite');
      if (value.width != null && !isFinite(+value.width)) throw new Error('microMap.vector: preload.direction.width must be finite');
      result.distance = clamp(finite(value.distance, 2), 0, 16);
      result.width = clamp(Math.floor(finite(value.width, 1)), 0, 4);
      return result;
    }

    function normalizePreloadZooms(value, fallback) {
      if (value == null) return fallback.slice();
      var values = Array.isArray(value) ? value : [value];
      var result = [];
      var seen = Object.create(null);
      for (var i = 0; i < values.length && result.length < 4; i++) {
        var number = +values[i];
        if (!isFinite(number)) throw new Error('microMap.vector: preload.zoom must contain finite relative zoom levels');
        number = clamp(Math.round(number), -4, 4);
        if (number && !seen[number]) {
          seen[number] = true;
          result.push(number);
        }
      }
      return result;
    }

    function clonePreloadConfig(config) {
      if (!config) return null;
      return {
        around: config.around,
        zoom: config.zoom.slice(),
        direction: cloneDirection(config.direction),
        maxTiles: config.maxTiles,
        delay: config.delay
      };
    }

    function normalizePreload(value, fallback) {
      if (value === false || value === null) return null;
      if (value === undefined) return null;
      var defaults = value === true;
      if (defaults) value = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('microMap.vector: preload must be false, true, or an object');
      }
      var base = fallback || defaultPreloadConfig(defaults);
      return {
        around: nonNegativeInteger(value.around, base.around, 8),
        // These are offsets from the current vector tile zoom. Keeping the
        // input relative makes a navigation profile portable across zooms.
        zoom: normalizePreloadZooms(value.zoom, base.zoom),
        direction: normalizePreloadDirection(value.direction, base.direction),
        maxTiles: nonNegativeInteger(value.maxTiles, base.maxTiles, 256),
        delay: nonNegativeInteger(value.delay, base.delay, 5000)
      };
    }

    function defaultNavigation() {
      return { position: null, heading: null, speed: 0, lookAhead: 15, follow: false };
    }

    function normalizePosition(value) {
      if (value == null) return null;
      var longitude;
      var latitude;
      if (Array.isArray(value)) {
        longitude = +value[0];
        latitude = +value[1];
      } else if (typeof value === 'object') {
        longitude = +(value.lng != null ? value.lng : (value.lon != null ? value.lon : value.longitude));
        latitude = +value.lat;
      }
      if (!isFinite(longitude) || !isFinite(latitude)) return null;
      longitude = ((longitude + 180) % 360 + 360) % 360 - 180;
      return [longitude, clamp(latitude, -85.05112878, 85.05112878)];
    }

    function cloneNavigation(value) {
      value = value || defaultNavigation();
      return {
        position: value.position ? value.position.slice() : null,
        heading: value.heading,
        speed: value.speed,
        lookAhead: value.lookAhead,
        follow: !!value.follow
      };
    }

    function normalizeNavigation(value, fallback) {
      var result = cloneNavigation(fallback || defaultNavigation());
      if (value === null) return defaultNavigation();
      if (value === undefined) return result;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('microMap.vector: navigation must be an object or null');
      }
      var number;
      if (own(value, 'position')) result.position = normalizePosition(value.position);
      if (own(value, 'heading')) {
        if (value.heading == null) result.heading = null;
        else {
          number = +value.heading;
          if (!isFinite(number)) throw new Error('microMap.vector: navigation.heading must be finite');
          result.heading = ((number % 360) + 360) % 360;
        }
      }
      if (own(value, 'speed')) {
        number = +value.speed;
        if (!isFinite(number)) throw new Error('microMap.vector: navigation.speed must be finite');
        result.speed = clamp(number, 0, 1000);
      }
      if (own(value, 'lookAhead')) {
        number = +value.lookAhead;
        if (!isFinite(number)) throw new Error('microMap.vector: navigation.lookAhead must be finite');
        result.lookAhead = clamp(number, 0, 120);
      }
      if (own(value, 'follow')) result.follow = !!value.follow;
      return result;
    }

    function readMapNavigation() {
      if (typeof map.getNavigation !== 'function') return null;
      try {
        var value = map.getNavigation();
        return value && typeof value === 'object' ? value : null;
      } catch (error) {
        return null;
      }
    }

    function navigationFromEvent(event) {
      if (event && own(event, 'navigation')) return event.navigation;
      var value = event && (event.state || event.value);
      return value && typeof value === 'object' ? value : readMapNavigation();
    }

    function canonicalKey(z, x, y) {
      var count = Math.pow(2, z);
      return z + '/' + (((x % count) + count) % count) + '/' + y;
    }

    function sourceKey(id, z, x, y) {
      var key = canonicalKey(z, x, y);
      return id == null || id === primarySourceID ? key : id + '\u0000' + key;
    }

    function sourceTileZoom(specification, metrics) {
      var zoom = tileZoomValue(metrics);
      return zoom < specification.minZoom ? null : Math.min(zoom, specification.maxZoom);
    }

    function sourceHasVisibleLayer(id, metrics) {
      if (typeof style === 'function') return false;
      for (var i = 0; i < style.length; i++) {
        var layer = style[i];
        if (layer.source === id && layerVisible(layer, zoomOf(layer, metrics))) return true;
      }
      return false;
    }

    function removeSourceTiles(id) {
      for (var key in cache) if (cache[key].sourceId === id) removeCache(key);
      for (key in errors) if (key.indexOf(id + '\u0000') === 0) delete errors[key];
      rendered = null;
    }

    function sourceCurrent(entry) {
      return entry.version === sourceVersion && (entry.sourceId === primarySourceID ||
        (entry.sourceToken && extraVectors[entry.sourceId] === entry.sourceToken));
    }

    function cancelSourceRequests(id) {
      var descriptor = extraVectors[id];
      if (descriptor && descriptor.retryTimer) root.clearTimeout(descriptor.retryTimer);
      for (var key in inFlight) {
        var request = inFlight[key];
        if (request.sourceId !== id) continue;
        if (request.controller) request.controller.abort();
        delete inFlight[key];
        active = Math.max(0, active - 1);
      }
      queue = queue.filter(function (entry) {
        if (entry.sourceId !== id) return true;
        delete queued[entry.key];
        return false;
      });
      for (key in errors) if (key.indexOf(id + '\u0000') === 0) delete errors[key];
      drain();
    }

    function cameraView(viewportWidth, viewportHeight, bearing, pitch) {
      var halfWidth = viewportWidth / 2;
      var halfHeight = viewportHeight / 2;
      var radians = bearing * Math.PI / 180;
      var cosine = Math.cos(radians);
      var sine = Math.sin(radians);
      var scale = Math.cos(pitch * Math.PI / 180);
      function raw(x, y) {
        var dx = x - halfWidth;
        var dy = (y - halfHeight) / scale;
        return [halfWidth + dx * cosine + dy * sine,
          halfHeight - dx * sine + dy * cosine];
      }
      var a = raw(0, 0);
      var b = raw(viewportWidth, 0);
      var c = raw(viewportWidth, viewportHeight);
      var d = raw(0, viewportHeight);
      return {
        x0: Math.min(a[0], b[0], c[0], d[0]),
        y0: Math.min(a[1], b[1], c[1], d[1]),
        x1: Math.max(a[0], b[0], c[0], d[0]),
        y1: Math.max(a[1], b[1], c[1], d[1])
      };
    }

    function mapMetrics() {
      // Modern microMap cores expose the exact raw world scale. Keep the
      // project()-based path for compatible older cores and map-like test
      // adapters, but do not infer a public camera contract when it exists.
      var camera = typeof map.getCameraState === 'function' ? map.getCameraState() : null;
      var center = camera && camera.center ? camera.center : map.getCenter();
      // metrics.bearing is the screen rotation of the map plane: the
      // negated MapLibre bearing (bearing 90 = east up = plane turned -90°).
      var bearing = -(camera ? finite(camera.bearing, 0) : (typeof map.getBearing === 'function' ? finite(map.getBearing(), 0) : 0));
      var pitch = camera ? finite(camera.pitch, 0) : (typeof map.getPitch === 'function' ? finite(map.getPitch(), 0) : 0);
      var radians = bearing * Math.PI / 180;
      var cosine = Math.cos(radians);
      var sine = Math.sin(radians);
      var pixelsPerWorld = camera ? finite(camera.worldSize, 0) : 0;
      if (!pixelsPerWorld) {
        var atCenter = map.project(center);
        var oneDegree = map.project([center[0] + 1, center[1]]);
        var deltaX = oneDegree[0] - atCenter[0];
        var deltaY = oneDegree[1] - atCenter[1];
        // `project()` already contains the map camera transform. Undo its
        // rotation to recover the raw world-pixel scale used for tile layout.
        pixelsPerWorld = Math.abs(deltaX * cosine + deltaY * sine / Math.max(0.05, Math.cos(pitch * Math.PI / 180))) * 360;
      }
      if (!isFinite(pixelsPerWorld) || pixelsPerWorld <= 0) pixelsPerWorld = 256 * Math.pow(2, map.getZoom());
      var viewportWidth = width || (camera ? Math.max(0, finite(camera.width, 0)) : Math.max(0, container.clientWidth || 0));
      var viewportHeight = height || (camera ? Math.max(0, finite(camera.height, 0)) : Math.max(0, container.clientHeight || 0));
      var pitchScale = Math.cos(pitch * Math.PI / 180);
      // fill-extrusion's per-meter screen offset for "straight up": zero
      // height (or zero pitch) collapses buildings back to an ordinary flat
      // fill. Foreshortened by sin(pitch) (the standard oblique-projection
      // convention -- looking straight down shows no height at all), then
      // counter-rotated and unsquished by 1/pitchScale so that,
      // after the render() pass's global scale+rotate for the whole canvas,
      // "up" always ends up pointing toward the top of the actual screen
      // regardless of the map's rotation -- matching how a real camera's
      // vertical axis is invariant to which way it's panned around to face.
      var metersPerPixel = EARTH_CIRCUMFERENCE * Math.cos(clamp(center[1], -85, 85) * Math.PI / 180) / Math.max(1, pixelsPerWorld);
      var riseFactor = Math.sin(pitch * Math.PI / 180) / Math.max(1e-6, metersPerPixel);
      // A perspective core (microMap >= 0.2) tilts with a real camera; the
      // tilted renderer then takes over from the affine Canvas pass.
      var perspective = pitch > 0 && options.perspective !== false && typeof map.getCamera === 'function' ? map.getCamera() : null;
      if (perspective && (perspective.width !== viewportWidth || perspective.height !== viewportHeight)) perspective = null;
      if (perspective) {
        var ground = perspective.groundBox();
        return {
          zoom: camera ? finite(camera.zoom, map.getZoom()) : map.getZoom(),
          styleZoom: Math.log(pixelsPerWorld / 512) / Math.LN2,
          centerX: worldX(center[0]),
          centerY: worldY(center[1]),
          pixelsPerWorld: pixelsPerWorld,
          bearing: bearing,
          cosine: cosine,
          sine: sine,
          pitch: pitch,
          pitchScale: Math.cos(pitch * Math.PI / 180),
          metersPerPixel: metersPerPixel,
          camera: perspective,
          extrudeDxPerMeter: 0,
          extrudeDyPerMeter: 0,
          view: { x0: viewportWidth / 2 + ground.x0, y0: viewportHeight / 2 + ground.y0, x1: viewportWidth / 2 + ground.x1, y1: viewportHeight / 2 + ground.y1 }
        };
      }
      return {
        zoom: camera ? finite(camera.zoom, map.getZoom()) : map.getZoom(),
        // MapLibre zoom levels are defined for a 512px world, whatever tile
        // size the core camera uses.
        styleZoom: Math.log(pixelsPerWorld / 512) / Math.LN2,
        centerX: worldX(center[0]),
        centerY: worldY(center[1]),
        pixelsPerWorld: pixelsPerWorld,
        bearing: bearing,
        cosine: cosine,
        sine: sine,
        pitch: pitch,
        pitchScale: pitchScale,
        extrudeDxPerMeter: -riseFactor * sine / Math.max(0.05, pitchScale),
        extrudeDyPerMeter: -riseFactor * cosine / Math.max(0.05, pitchScale),
        view: cameraView(viewportWidth, viewportHeight, bearing, pitch)
      };
    }

    function tileRange(z, buffer, metrics, viewportWidth, viewportHeight) {
      viewportWidth = viewportWidth == null ? width : viewportWidth;
      viewportHeight = viewportHeight == null ? height : viewportHeight;
      var view = viewportWidth === width && viewportHeight === height
        ? metrics.view : cameraView(viewportWidth, viewportHeight, metrics.bearing, metrics.pitch);
      var count = Math.pow(2, z);
      var tilePixels = metrics.pixelsPerWorld / count;
      var centerPixelX = metrics.centerX * count * tilePixels;
      var centerPixelY = metrics.centerY * count * tilePixels;
      var minX = Math.floor((centerPixelX + view.x0 - viewportWidth / 2) / tilePixels) - buffer;
      var maxX = Math.floor((centerPixelX + view.x1 - viewportWidth / 2) / tilePixels) + buffer;
      var minY = Math.max(0, Math.floor((centerPixelY + view.y0 - viewportHeight / 2) / tilePixels) - buffer);
      var maxY = Math.min(count - 1, Math.floor((centerPixelY + view.y1 - viewportHeight / 2) / tilePixels) + buffer);
      return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, count: count };
    }

    function visibleTiles(z, buffer, metrics) {
      var range = tileRange(z, buffer, metrics);
      var total = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
      // A valid camera level has a small visible tile set. This final guard
      // prevents accidental zoom-range mismatches or pathological container
      // sizes from allocating a giant request queue.
      if (!isFinite(total) || total > maxVisibleTiles) return [];
      var tiles = [];
      for (var y = range.minY; y <= range.maxY; y++) {
        for (var x = range.minX; x <= range.maxX; x++) tiles.push({ z: z, x: x, y: y });
      }
      return tiles;
    }

    // MapLibre styles use MapLibre's vector tile choice (floor of the 512px
    // zoom); compact styles keep the historical rounding of the camera zoom.
    function tileZoomValue(metrics) {
      return tileZoomMode() === 'floor' ? Math.floor(metrics.styleZoom + 1e-9) : Math.round(metrics.zoom);
    }

    function tileZoomMode() {
      if (options.tileZoom === 'floor' || options.tileZoom === 'round') return options.tileZoom;
      return typeof style !== 'function' && style.maplibre ? 'floor' : 'round';
    }

    function zoomOf(layer, metrics) {
      return layer.v8 ? metrics.styleZoom : metrics.zoom;
    }

    function currentTileZoom(metrics) {
      var cameraZoom = tileZoomValue(metrics);
      return cameraZoom < minZoom ? null : Math.min(cameraZoom, maxZoom);
    }

    function currentNavigation() {
      var value = readMapNavigation();
      if (value) {
        navigation = normalizeNavigation(value, navigation);
        navigationSet = true;
      } else if (typeof map.getNavigation === 'function') {
        navigation = defaultNavigation();
        navigationSet = false;
      }
      return navigation;
    }

    function preloadFocus(metrics, state) {
      if (state.position) {
        return {
          x: worldX(state.position[0]),
          y: worldY(state.position[1]),
          latitude: state.position[1]
        };
      }
      var center = map.getCenter();
      return { x: metrics.centerX, y: metrics.centerY, latitude: center && center[1] || 0 };
    }

    function preloadDirection(config, state, z, latitude) {
      var configured = config.direction;
      var bearing = state.heading != null ? state.heading : configured && configured.bearing;
      if (bearing == null || !isFinite(bearing)) return null;
      var distance;
      if (state.heading != null) {
        var metres = state.speed * state.lookAhead;
        var latitudeRadians = clamp(finite(latitude, 0), -85.05112878, 85.05112878) * Math.PI / 180;
        var metresPerTile = 40075016.68557849 * Math.max(0.01, Math.cos(latitudeRadians)) / Math.pow(2, z);
        distance = Math.max(configured ? configured.distance : 0, metresPerTile > 0 ? metres / metresPerTile : 0);
      } else distance = configured ? configured.distance : 0;
      distance = clamp(finite(distance, 0), 0, 16);
      var radians = bearing * Math.PI / 180;
      return {
        x: Math.sin(radians),
        y: -Math.cos(radians),
        distance: distance,
        width: configured && configured.width != null ? configured.width : 1
      };
    }

    function shiftPreloadRange(range, z, metrics, focus, direction) {
      var count = Math.pow(2, z);
      var shiftX = Math.round(focus.x * count - metrics.centerX * count);
      var shiftY = Math.round(focus.y * count - metrics.centerY * count);
      if (direction) {
        shiftX += Math.round(direction.x * direction.distance);
        shiftY += Math.round(direction.y * direction.distance);
      }
      range.minX += shiftX;
      range.maxX += shiftX;
      range.minY += shiftY;
      range.maxY += shiftY;
      if (direction && direction.width) {
        var sidewaysX = Math.ceil(Math.abs(direction.y) * direction.width);
        var sidewaysY = Math.ceil(Math.abs(direction.x) * direction.width);
        range.minX -= sidewaysX;
        range.maxX += sidewaysX;
        range.minY -= sidewaysY;
        range.maxY += sidewaysY;
      }
      // x wraps, but y does not. Shift the y range as a whole at the poles so
      // a navigation focus near a pole still has a useful, bounded area.
      if (range.maxY - range.minY >= count - 1) {
        range.minY = 0;
        range.maxY = count - 1;
      } else {
        if (range.minY < 0) {
          range.maxY -= range.minY;
          range.minY = 0;
        }
        if (range.maxY >= count) {
          range.minY -= range.maxY - count + 1;
          range.maxY = count - 1;
        }
        range.minY = Math.max(0, range.minY);
        range.maxY = Math.min(count - 1, range.maxY);
      }
      return range;
    }

    function sampleTilePositions(minimum, maximum, limit, anchor) {
      var length = maximum - minimum + 1;
      if (!isFinite(length) || !isFinite(minimum) || !isFinite(maximum) || length <= 0 || limit <= 0) return [];
      var amount = Math.min(length, Math.max(1, Math.floor(limit)));
      var result = [];
      var seen = Object.create(null);
      function add(value) {
        value = clamp(Math.round(value), minimum, maximum);
        if (!seen[value] && result.length < amount) {
          seen[value] = true;
          result.push(value);
        }
      }
      if (isFinite(anchor)) add(anchor - 0.5);
      add(minimum);
      add(maximum);
      for (var i = 1; result.length < amount && i <= amount * 2; i++) {
        add(minimum + (length - 1) * i / (amount + 1));
      }
      // Very short spans can make the first samples collapse after rounding.
      // Keep this repair pass bounded as well: a pathological longitude must
      // never turn cache preparation into a range-sized loop.
      for (var fill = 0; result.length < amount && fill < amount * 4; fill++) add(minimum + fill);
      return result;
    }

    function candidateScore(tile, meta) {
      var count = Math.pow(2, tile.z);
      var dx = tile.x + 0.5 - meta.focusX;
      dx -= Math.round(dx / count) * count;
      var dy = tile.y + 0.5 - meta.focusY;
      var score = dx * dx + dy * dy;
      if (meta.direction) {
        var forward = dx * meta.direction.x + dy * meta.direction.y;
        var sideways = Math.abs(-meta.direction.y * dx + meta.direction.x * dy);
        // The distance shift chooses the expected future viewport; this
        // secondary score makes the front edge of its ring win first.
        score += sideways * 2 - forward * 12;
      }
      return score;
    }

    function addPreloadCandidate(group, z, x, y, meta, allKeys) {
      if (group.candidates.length >= group.limit || y < 0 || y >= Math.pow(2, z)) return;
      var key = canonicalKey(z, x, y);
      if (allKeys[key] || cache[key] || inFlight[key] || queued[key] || needed[key] || preloadWanted[key]) return;
      var failed = errors[key];
      if (failed && (failed < 0 || failed > Date.now())) {
        return;
      }
      allKeys[key] = true;
      group.candidates.push({
        z: z,
        x: x,
        y: y,
        score: candidateScore({ z: z, x: x, y: y }, meta)
      });
    }

    function addRingCandidates(group, z, range, around, meta, allKeys) {
      if (!around) return;
      var perSide = Math.max(1, Math.floor(group.limit / (around * 4)));
      function horizontal(y, minX, maxX) {
        var values = sampleTilePositions(minX, maxX, perSide, meta.anchorX);
        for (var i = 0; i < values.length; i++) addPreloadCandidate(group, z, values[i], y, meta, allKeys);
      }
      function vertical(x, minY, maxY) {
        var values = sampleTilePositions(minY, maxY, perSide, meta.anchorY);
        for (var i = 0; i < values.length; i++) addPreloadCandidate(group, z, x, values[i], meta, allKeys);
      }
      for (var ring = 1; ring <= around; ring++) {
        var minX = range.minX - ring;
        var maxX = range.maxX + ring;
        var minY = range.minY - ring;
        var maxY = range.maxY + ring;
        horizontal(minY, minX, maxX);
        horizontal(maxY, minX, maxX);
        vertical(minX, minY + 1, maxY - 1);
        vertical(maxX, minY + 1, maxY - 1);
      }
    }

    function addGridCandidates(group, z, range, meta, allKeys) {
      var columnsAvailable = range.maxX - range.minX + 1;
      var rowsAvailable = range.maxY - range.minY + 1;
      if (columnsAvailable <= 0 || rowsAvailable <= 0) return;
      var limit = group.limit;
      var columns = Math.min(columnsAvailable, Math.max(1, Math.round(Math.sqrt(limit * columnsAvailable / rowsAvailable))));
      var rows = Math.min(rowsAvailable, Math.max(1, Math.floor(limit / columns)));
      while (columns * rows < limit && rows < rowsAvailable) rows++;
      var xs = sampleTilePositions(range.minX, range.maxX, columns, meta.anchorX);
      var ys = sampleTilePositions(range.minY, range.maxY, rows, meta.anchorY);
      for (var y = 0; y < ys.length; y++) {
        for (var x = 0; x < xs.length; x++) addPreloadCandidate(group, z, xs[x], ys[y], meta, allKeys);
      }
    }

    function clearQueuedPreloads() {
      preloadWanted = Object.create(null);
      if (!queue.length) return;
      var retained = [];
      var retainedQueued = Object.create(null);
      for (var i = 0; i < queue.length; i++) {
        var entry = queue[i];
        if (entry.preload) continue;
        retained.push(entry);
        retainedQueued[entry.key] = entry;
      }
      queue = retained;
      queued = retainedQueued;
    }

    function preparePreload(config) {
      if (destroyed || !config) return;
      var viewportWidth = Math.max(0, container.clientWidth || 0);
      var viewportHeight = Math.max(0, container.clientHeight || 0);
      if (!viewportWidth || !viewportHeight) {
        clearQueuedPreloads();
        return;
      }
      var metrics = mapMetrics();
      var currentZoom = currentTileZoom(metrics);
      clearQueuedPreloads();
      if (currentZoom == null || !config.maxTiles) return;
      var state = currentNavigation();
      var focus = preloadFocus(metrics, state);
      var allKeys = Object.create(null);
      var groups = [];
      var candidateLimit = Math.min(1024, Math.max(16, config.maxTiles * 4));
      var seenZooms = Object.create(null);

      function rangeAndMeta(z) {
        var direction = preloadDirection(config, state, z, focus.latitude);
        var range = shiftPreloadRange(tileRange(z, tileBuffer, metrics, viewportWidth, viewportHeight), z, metrics, focus, direction);
        var count = Math.pow(2, z);
        return {
          range: range,
          meta: {
            focusX: focus.x * count,
            focusY: focus.y * count,
            anchorX: focus.x * count + (direction ? direction.x * direction.distance : 0),
            anchorY: focus.y * count + (direction ? direction.y * direction.distance : 0),
            direction: direction
          }
        };
      }

      if (config.around) {
        var current = rangeAndMeta(currentZoom);
        var ringGroup = { candidates: [], limit: candidateLimit };
        addRingCandidates(ringGroup, currentZoom, current.range, config.around, current.meta, allKeys);
        if (ringGroup.candidates.length) groups.push(ringGroup);
      }

      for (var i = 0; i < config.zoom.length; i++) {
        var z = currentZoom + config.zoom[i];
        if (z < minZoom || z > maxZoom || seenZooms[z]) continue;
        seenZooms[z] = true;
        var target = rangeAndMeta(z);
        var zoomGroup = { candidates: [], limit: candidateLimit };
        addGridCandidates(zoomGroup, z, target.range, target.meta, allKeys);
        if (zoomGroup.candidates.length) groups.push(zoomGroup);
      }

      for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        groups[groupIndex].candidates.sort(function (a, b) { return a.score - b.score; });
      }
      var indexes = [];
      var selected = 0;
      while (selected < config.maxTiles) {
        var added = false;
        for (groupIndex = 0; groupIndex < groups.length && selected < config.maxTiles; groupIndex++) {
          var index = indexes[groupIndex] || 0;
          var candidate = groups[groupIndex].candidates[index];
          if (!candidate) continue;
          indexes[groupIndex] = index + 1;
          requestTile(candidate, metrics, true, 1000000 + candidate.score);
          selected++;
          added = true;
        }
        if (!added) break;
      }
      drain();
    }

    function schedulePreload(config) {
      if (destroyed || !config) return;
      if (preloadTimer) root.clearTimeout(preloadTimer);
      preloadTimer = root.setTimeout(function () {
        preloadTimer = 0;
        preparePreload(config);
      }, config.delay);
    }

    function scheduleConfiguredPreload() {
      if (preloadConfig) schedulePreload(preloadConfig);
    }

    // Render only cached tiles at a fallback zoom. In particular, do not
    // materialize every z=22 tile while the camera is at z=0 just to look for
    // a cached higher-resolution fallback.
    //
    // A fallback zoom is usually far coarser than the camera (a low z has few
    // real tiles), but horizontal world wrapping still repeats each cached
    // tile once per visible world copy. When the camera is zoomed out well
    // past this z, a single world copy can be only a few CSS pixels wide, so
    // the viewport spans dozens of copies -- multiplying that across a
    // session's worth of cached tiles at this z without a cap is exactly the
    // "far zoomed out" slowdown, so bail out the same way visibleTiles does.
    function cachedPlansAtZoom(z, metrics) {
      var range = tileRange(z, 0, metrics);
      var totalCells = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
      if (!isFinite(totalCells) || totalCells > maxVisibleTiles) return [];
      var plans = [];
      var key;
      for (key in cache) {
        var entry = cache[key];
        if (entry.sourceId !== primarySourceID) continue;
        if (entry.z !== z || entry.y < range.minY || entry.y > range.maxY) continue;
        var x = entry.x + Math.ceil((range.minX - entry.x) / range.count) * range.count;
        for (; x <= range.maxX; x += range.count) plans.push({ z: z, x: x, y: entry.y });
      }
      return plans;
    }

    function tileOrigin(tile, metrics) {
      var count = Math.pow(2, tile.z);
      var dx = tile.x / count - metrics.centerX;
      return [
        width / 2 + dx * metrics.pixelsPerWorld,
        height / 2 + (tile.y / count - metrics.centerY) * metrics.pixelsPerWorld,
        metrics.pixelsPerWorld / count
      ];
    }

    function screenPoint(x, y, metrics) {
      if (metrics.camera) {
        var projected = metrics.camera.project(x - width / 2, y - height / 2);
        return [projected[0], projected[1]];
      }
      var cosine = metrics.cosine;
      var sine = metrics.sine;
      var dx = x - width / 2;
      var dy = y - height / 2;
      return [width / 2 + dx * cosine - dy * sine,
        height / 2 + (dx * sine + dy * cosine) * metrics.pitchScale];
    }

    function projectLabels(labels, metrics) {
      if (metrics.camera) {
        projectTiltedLabels(labels, metrics);
        return;
      }
      var cosine = metrics.cosine;
      var sine = metrics.sine;
      var halfWidth = width / 2;
      var halfHeight = height / 2;
      var pitchScale = metrics.pitchScale;
      for (var i = 0; i < labels.length; i++) {
        var label = labels[i];
        var x = label.x - halfWidth;
        var y = label.y - halfHeight;
        label.x = halfWidth + x * cosine - y * sine;
        label.y = halfHeight + (x * sine + y * cosine) * pitchScale;
        if (label.icon) {
          x = label.ax - halfWidth;
          y = label.ay - halfHeight;
          label.ix = halfWidth + x * cosine - y * sine;
          label.iy = halfHeight + (x * sine + y * cosine) * pitchScale;
        }
        var angle = label.angle || 0;
        var dx = Math.cos(angle);
        var dy = Math.sin(angle);
        // Point labels stay upright on screen (MapLibre's viewport-aligned
        // text); only line labels follow their line through the camera.
        if (label.style.placement !== 'line') {
          label.angle = 0;
          continue;
        }
        label.angle = Math.atan2((dx * sine + dy * cosine) * pitchScale, dx * cosine - dy * sine);
        if (label.angle > Math.PI / 2 || label.angle <= -Math.PI / 2) label.angle += Math.PI;
        if (label.frame) labelPath(label, metrics, 1);
      }
    }

    // The screen polyline of a line label's line near its anchor (a window
    // a little longer than the text), and the anchor's distance along it,
    // for text that follows the line's curves.
    function labelPath(label, metrics, screenScale) {
      var candidate = label.candidate;
      var line = candidate.line;
      var frame = label.frame;
      if (!line || line.length < 4) return;
      var style = label.style;
      var textWidth = measuredText(context, label.text, style.measureFont).width * style.size / 100 + style.letterSpacing * label.text.length;
      var half = (textWidth * 0.6 + 16) / Math.max(1e-6, frame[2] * screenScale);
      var from = candidate.along - half;
      var to = candidate.along + half;
      var path = [];
      var at = -1;
      var walked = 0;
      var screen = 0;
      var last = null;
      function add(x, y) {
        var point = screenPoint(frame[0] + x * frame[2], frame[1] + y * frame[2], metrics);
        if (last) screen += Math.sqrt((point[0] - last[0]) * (point[0] - last[0]) + (point[1] - last[1]) * (point[1] - last[1]));
        path.push(point[0], point[1]);
        last = point;
      }
      for (var i = 2; i < line.length && walked <= to; i += 2) {
        var x0 = line[i - 2];
        var y0 = line[i - 1];
        var dx = line[i] - x0;
        var dy = line[i + 1] - y0;
        var length = Math.sqrt(dx * dx + dy * dy);
        if (!length) continue;
        var next = walked + length;
        if (next >= from) {
          if (!path.length) {
            var t0 = Math.max(0, (from - walked) / length);
            add(x0 + dx * t0, y0 + dy * t0);
          }
          if (at < 0 && next >= candidate.along) {
            var ta = (candidate.along - walked) / length;
            var before = screen;
            var point = screenPoint(frame[0] + (x0 + dx * ta) * frame[2], frame[1] + (y0 + dy * ta) * frame[2], metrics);
            at = before + Math.sqrt((point[0] - last[0]) * (point[0] - last[0]) + (point[1] - last[1]) * (point[1] - last[1]));
          }
          var t1 = Math.min(1, (to - walked) / length);
          add(x0 + dx * t1, y0 + dy * t1);
        }
        walked = next;
      }
      if (at < 0 || path.length < 4) return;
      label.path = path;
      label.pathAt = at;
    }

    // Anchors go through the perspective camera; offsets stay in screen
    // pixels. Labels on ground much smaller than at the centre, or beyond
    // the far row, are dropped: there the view is all fog and clutter.
    function projectTiltedLabels(labels, metrics) {
      var camera = metrics.camera;
      var halfWidth = width / 2;
      var halfHeight = height / 2;
      var limit = camera.horizonRow + 6;
      for (var i = 0; i < labels.length; i++) {
        var label = labels[i];
        var anchor = camera.project(label.ax - halfWidth, label.ay - halfHeight);
        if (anchor[1] < limit || anchor[2] < 0.3) {
          label.x = label.ix = -1e6;
          label.y = label.iy = -1e6;
          continue;
        }
        // MapLibre's perspective ratio for viewport-aligned symbols: half
        // of the ground's scale change applies to the label.
        label.scale = clamp(0.5 + 0.5 * anchor[2], 0.5, 1.5);
        label.x = anchor[0] + label.style.offsetX * label.scale;
        label.y = anchor[1] + label.style.offsetY * label.scale;
        label.ix = anchor[0];
        label.iy = anchor[1];
        if (label.style.placement !== 'line') {
          label.angle = 0;
          continue;
        }
        var angle = label.angle || 0;
        var ahead = camera.project(label.ax - halfWidth + Math.cos(angle) * 8, label.ay - halfHeight + Math.sin(angle) * 8);
        label.angle = Math.atan2(ahead[1] - anchor[1], ahead[0] - anchor[0]);
        if (label.angle > Math.PI / 2 || label.angle <= -Math.PI / 2) label.angle += Math.PI;
        if (label.frame) labelPath(label, metrics);
      }
    }

    // MapLibre's transformRequest(url, resourceType): a new URL, or
    // { url, headers, credentials } for requests made with fetch().
    function transformed(url, kind) {
      var result = typeof options.transformRequest === 'function' ? options.transformRequest(url, kind) : null;
      if (result == null) return { url: url };
      if (typeof result === 'string') return { url: result };
      return { url: result.url || url, headers: result.headers, credentials: result.credentials };
    }

    function requestOptionsFor(controller, extra) {
      var request = {};
      var key;
      if (fetchOptions) for (key in fetchOptions) request[key] = fetchOptions[key];
      if (extra && extra.headers) request.headers = extra.headers;
      if (extra && extra.credentials) request.credentials = extra.credentials;
      if (controller) request.signal = controller.signal;
      return request;
    }

    function removeCache(key) {
      var entry = cache[key];
      if (!entry) return;
      cacheBytes -= entry.bytes;
      delete cache[key];
    }

    function trimCache() {
      if (cacheBytes <= maxCacheBytes) return;
      var candidates = [];
      var key;
      for (key in cache) if (!needed[key]) candidates.push(cache[key]);
      candidates.sort(function (a, b) { return a.used - b.used; });
      for (var i = 0; i < candidates.length && cacheBytes > maxCacheBytes; i++) removeCache(candidates[i].key);
    }

    function scheduleRetry(until) {
      if (destroyed) return;
      if (retryTimer && retryAt <= until) return;
      if (retryTimer) root.clearTimeout(retryTimer);
      retryAt = until;
      retryTimer = root.setTimeout(function () {
        retryTimer = 0;
        retryAt = 0;
        schedule();
        scheduleConfiguredPreload();
      }, Math.max(1, until - Date.now()));
    }

    // Sparse vector sources commonly answer 404 for an empty tile. Retrying
    // those (or an invalid/authenticated request) forever turns an idle map
    // into needless provider traffic. Network failures and the HTTP statuses
    // that explicitly describe a temporary condition remain retryable.
    function fail(entry, error) {
      var status = error && +error.status;
      return errors[entry.key] = status >= 400 && status < 500 && status !== 408 && status !== 429 ? -1 : Date.now() + retryDelay;
    }

    function finishRequest(entry) {
      // A source change intentionally resets the concurrency budget. An old
      // custom fetch may ignore AbortSignal or never settle, so it must not
      // consume (or later decrement) the new source's request slots.
      if (!sourceCurrent(entry)) return;
      active = Math.max(0, active - 1);
      delete inFlight[entry.key];
      drain();
    }

    function fetchTile(entry) {
      active++;
      var controller = root.AbortController ? new root.AbortController() : null;
      entry.controller = controller;
      inFlight[entry.key] = entry;
      var url;
      try {
        var vectorSource = entry.sourceId === primarySourceID ? null : extraVectors[entry.sourceId];
        var tileSource = entry.sourceId === primarySourceID ? source : vectorSource && vectorSource.tiles;
        url = templateUrl(tileSource, entry.z, entry.x, entry.y, subdomains, vectorSource ? vectorSource.tms : sourceTms);
        if (typeof url !== 'string' || !url) throw new Error('microMap.vector: tile source returned no URL');
      } catch (error) {
        if (entry.preload) delete preloadWanted[entry.key];
        var until = fail(entry, error);
        emit('tileerror', { source: entry.sourceId, z: entry.z, x: entry.x, y: entry.y, error: error, preload: !!entry.preload });
        if (until > 0) scheduleRetry(until);
        finishRequest(entry);
        return;
      }
      var request = transformed(url, 'Tile');
      url = entry.url = request.url;
      var response;
      try {
        response = fetcher(url, requestOptionsFor(controller, request));
      } catch (error) {
        response = Promise.reject(error);
      }
      Promise.resolve(response).then(function (result) {
        if (!result || result.ok === false) {
          var s = result && +result.status;
          var error = new Error('microMap.vector: tile request failed' + (s ? ' (' + s + ')' : ''));
          error.status = s;
          throw error;
        }
        return result.arrayBuffer();
      }).then(function (buffer) {
        if (destroyed || !sourceCurrent(entry)) return;
        var byteLength = buffer && buffer.byteLength;
        if (!byteLength && byteLength !== 0) throw new Error('microMap.vector: tile response is not an ArrayBuffer');
        var decodedResult;
        if (customDecoder) {
          try {
            decodedResult = Promise.resolve(customDecoder(buffer, limitsFor(options))).then(function (tile) {
              return normalizeDecodedTile(tile, options);
            });
          } catch (decodeError) { decodedResult = Promise.reject(decodeError); }
        } else decodedResult = decodeWith(decoder, buffer, options);
        return decodedResult.then(function (decoded) {
          if (destroyed || !sourceCurrent(entry)) return;
          var cacheEntry = { key: entry.key, sourceId: entry.sourceId, z: entry.z, x: ((entry.x % Math.pow(2, entry.z)) + Math.pow(2, entry.z)) % Math.pow(2, entry.z), y: entry.y, data: decoded, bytes: byteLength, used: ++useCounter, serial: ++entrySerial };
          removeCache(entry.key);
          cache[entry.key] = cacheEntry;
          cacheBytes += byteLength;
          delete errors[entry.key];
          if (entry.preload) delete preloadWanted[entry.key];
          trimCache();
          if (entry.preload && cache[entry.key] === cacheEntry) queuePrisms(cacheEntry);
          emit('tileload', { source: entry.sourceId, z: entry.z, x: cacheEntry.x, y: entry.y, url: entry.url, preload: !!entry.preload });
          schedule();
        });
      }).then(function () {
        finishRequest(entry);
      }, function (error) {
        if (!destroyed && sourceCurrent(entry) && !(error && error.name === 'AbortError')) {
          if (entry.preload) delete preloadWanted[entry.key];
          var until = fail(entry, error);
          // A 404 is an empty tile for sparse sources: keep an empty entry so
          // the area is complete (no stale fallback) and GeoJSON still draws.
          if (error && +error.status === 404 && !cache[entry.key]) {
            cache[entry.key] = { key: entry.key, sourceId: entry.sourceId, z: entry.z, x: entry.x, y: entry.y, data: { layers: [] }, bytes: 0, used: ++useCounter, serial: ++entrySerial };
          }
          emit('tileerror', { source: entry.sourceId, z: entry.z, x: entry.x, y: entry.y, url: entry.url, error: error, preload: !!entry.preload });
          if (until > 0) scheduleRetry(until);
          schedule();
        }
        finishRequest(entry);
      });
    }

    function drain() {
      // Sort once per batch of requests rather than once per request.
      if (queueDirty) {
        queue.sort(function (a, b) { return a.priority - b.priority; });
        queueDirty = false;
      }
      while (!destroyed && active < maxConcurrent && queue.length) {
        var entry = queue.shift();
        if (queued[entry.key] === entry) delete queued[entry.key];
        // Drop stale views instead of fetching an unbounded backlog after a
        // quick pan. `needed` is recreated for every draw; speculative work
        // has its own bounded desired set.
        if (!sourceCurrent(entry) || (!needed[entry.key] && (!entry.preload || !preloadWanted[entry.key]))) continue;
        if (!cache[entry.key] && !inFlight[entry.key]) fetchTile(entry);
      }
    }

    function requestTile(tile, metrics, preload, priority, sourceId) {
      sourceId = sourceId == null ? primarySourceID : sourceId;
      var key = sourceKey(sourceId, tile.z, tile.x, tile.y);
      preload = !!preload;
      if (!source && sourceId === primarySourceID) {
        // No base source: an empty tile still carries GeoJSON virtual tiles.
        if (!cache[key] && !preload) {
          var count = Math.pow(2, tile.z);
          cache[key] = { key: key, sourceId: sourceId, z: tile.z, x: ((tile.x % count) + count) % count, y: tile.y, data: { layers: [] }, bytes: 0, used: ++useCounter, serial: ++entrySerial };
        }
        if (!preload) needed[key] = true;
        return;
      }
      if (preload) preloadWanted[key] = true;
      else {
        needed[key] = true;
        delete preloadWanted[key];
      }
      if (cache[key]) {
        if (preload) delete preloadWanted[key];
        return;
      }
      if (inFlight[key]) {
        // A camera move can promote a speculative request to a visible tile;
        // preserve that fact for lifecycle events and later queue decisions.
        if (!preload) inFlight[key].preload = false;
        return;
      }
      if (queued[key]) {
        if (!preload && queued[key].preload) {
          queued[key].preload = false;
          queued[key].priority = Math.min(queued[key].priority, priority == null ? 0 : priority);
          delete preloadWanted[key];
          queueDirty = true;
        }
        return;
      }
      var failed = errors[key];
      if (failed && (failed < 0 || failed > Date.now())) {
        if (preload) delete preloadWanted[key];
        return;
      }
      var count = Math.pow(2, tile.z);
      var centerX = metrics.centerX * count;
      var centerY = metrics.centerY * count;
      var dx = tile.x + 0.5 - centerX;
      dx -= Math.round(dx / count) * count;
      var dy = tile.y + 0.5 - centerY;
      var entry = {
        key: key,
        sourceId: sourceId,
        z: tile.z,
        x: ((tile.x % count) + count) % count,
        y: tile.y,
        priority: priority == null ? dx * dx + dy * dy : priority,
        preload: preload,
        version: sourceVersion,
        sourceToken: sourceId === primarySourceID ? null : extraVectors[sourceId]
      };
      queue.push(entry);
      queued[key] = entry;
      queueDirty = true;
    }

    // ---- Feature state -----------------------------------------------------
    // MapLibre's setFeatureState: per { source, sourceLayer, id }; paint
    // properties read it with ['feature-state', key]. A change regroups only
    // the buckets of layers that use feature-state.
    var featureStates = new Map();
    var featureStateVersion = 0;
    var sourceStateVersions = Object.create(null);

    function changedFeatureState(key) {
      sourceStateVersions[key.split('\u0000')[0]] = ++featureStateVersion;
    }

    function layerStateVersion(layer) {
      return sourceStateVersions[String(layer.geojson || layer.source || primarySourceID)] || 0;
    }

    function stateKey(sourceId, sourceLayer, id) {
      return String(sourceId) + '\u0000' + (sourceLayer || '') + '\u0000' + String(id);
    }

    function featureTarget(feature) {
      if (!feature || feature.id == null) throw new Error('microMap.vector: feature state needs { source, id }');
      var sourceId = feature.source || (typeof style !== 'function' && style.report ? style.report.source : null);
      return stateKey(sourceId, geojsonSources[sourceId] ? '' : feature.sourceLayer, feature.id);
    }

    function setFeatureState(feature, state) {
      var key = featureTarget(feature);
      var next = {};
      var current = featureStates.get(key);
      var name;
      if (current) for (name in current) next[name] = current[name];
      for (name in state) next[name] = cloneStyleValue(state[name], 0);
      if (sameStyleValue(current || {}, next)) return api;
      featureStates.set(key, next);
      changedFeatureState(key);
      schedule();
      return api;
    }

    function removeFeatureState(feature, name) {
      var changed = false;
      if (!feature) {
        if (!featureStates.size) return api;
        featureStates.clear();
        sourceStateVersions = Object.create(null);
        featureStateVersion++;
        changed = true;
      } else if (feature.id == null) {
        var sourceId = feature.source || (style.report && style.report.source);
        var prefix = String(sourceId) + '\u0000';
        if (!geojsonSources[sourceId] && feature.sourceLayer != null) prefix += feature.sourceLayer + '\u0000';
        featureStates.forEach(function (value, key) {
          if (key.indexOf(prefix) === 0) { featureStates.delete(key); changedFeatureState(key); changed = true; }
        });
      } else {
        var key = featureTarget(feature);
        if (name == null) changed = featureStates.delete(key);
        else if (featureStates.has(key) && own(featureStates.get(key), name)) { delete featureStates.get(key)[name]; changed = true; }
        if (changed) changedFeatureState(key);
      }
      if (!changed) return api;
      schedule();
      return api;
    }

    // ---- Images (icons, patterns, sprites) ------------------------------------
    // Like MapLibre's image manager: addImage() takes ImageData, a
    // { width, height, data } object or anything drawImage accepts, with an
    // optional pixelRatio and sdf flag. A missing image fires
    // styleimagemissing once; a listener may add it synchronously.
    var images = new Map();
    var missingImages = new Set();

    function imageEntry(image, imageOptions) {
      imageOptions = imageOptions || {};
      var ratio = Math.max(0.1, finite(imageOptions.pixelRatio, 1));
      var source = image;
      var sourceWidth = image && (image.naturalWidth || image.videoWidth || image.width);
      var sourceHeight = image && (image.naturalHeight || image.videoHeight || image.height);
      if (image && image.data && !image.getContext && !image.naturalWidth) {
        // ImageData or a raw RGBA object: paint it into a canvas once.
        source = root.document.createElement('canvas');
        source.width = image.width;
        source.height = image.height;
        var paint = source.getContext('2d');
        var pixels = typeof root.ImageData === 'function' && !(image instanceof root.ImageData)
          ? new root.ImageData(new Uint8ClampedArray(image.data), image.width, image.height) : image;
        paint.putImageData(pixels, 0, 0);
      }
      if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error('microMap.vector: image needs a width and height');
      return {
        source: source, sx: finite(imageOptions.x, 0), sy: finite(imageOptions.y, 0),
        sw: finite(imageOptions.sourceWidth, sourceWidth), sh: finite(imageOptions.sourceHeight, sourceHeight),
        width: finite(imageOptions.sourceWidth, sourceWidth) / ratio, height: finite(imageOptions.sourceHeight, sourceHeight) / ratio,
        pixelRatio: ratio, sdf: !!imageOptions.sdf, version: 0
      };
    }

    function addImage(id, image, imageOptions) {
      id = String(id);
      if (images.has(id)) throw new Error('microMap.vector: an image named "' + id + '" already exists');
      images.set(id, imageEntry(image, imageOptions));
      imageVersion++;
      missingImages.delete(id);
      schedule();
      return api;
    }

    function updateImage(id, image) {
      var current = images.get(String(id));
      if (!current) throw new Error('microMap.vector: no image named "' + id + '"');
      var next = imageEntry(image, { pixelRatio: current.pixelRatio, sdf: current.sdf });
      next.version = current.version + 1;
      images.set(String(id), next);
      imageVersion++;
      schedule();
      return api;
    }

    function resolveImage(id) {
      var image = images.get(id);
      if (!image && !missingImages.has(id)) {
        missingImages.add(id);
        emit('styleimagemissing', { id: id });
        image = images.get(id);
      }
      return image || null;
    }

    // MapLibre sprites: `url.json` plus `url.png` (with @2x on dense
    // screens), or a list of { id, url } whose images are named "id:name".
    function loadSprites(sprite) {
      var list = typeof sprite === 'string' ? [{ id: 'default', url: sprite }] : Array.isArray(sprite) ? sprite : [];
      var suffix = dpr > 1.5 ? '@2x' : '';
      list.forEach(function (entry) {
        if (!entry || typeof entry.url !== 'string' || /^mapbox:/.test(entry.url)) return;
        var base = entry.url;
        var prefix = entry.id && entry.id !== 'default' ? entry.id + ':' : '';
        var sheet = root.document.createElement('img');
        sheet.crossOrigin = rasterCrossOrigin == null ? 'anonymous' : rasterCrossOrigin;
        var loaded = new Promise(function (resolve, reject) { sheet.onload = resolve; sheet.onerror = reject; });
        sheet.src = transformed(base + suffix + '.png', 'SpriteImage').url;
        var indexRequest = transformed(base + suffix + '.json', 'SpriteJSON');
        Promise.all([Promise.resolve(fetcher(indexRequest.url, requestOptionsFor(null, indexRequest))).then(function (response) {
          if (!response || response.ok === false) throw new Error('microMap.vector: sprite request failed');
          return response.json();
        }), loaded]).then(function (results) {
          if (destroyed) return;
          var index = results[0] || {};
          for (var name in index) {
            var frame = index[name];
            if (!frame || images.has(prefix + name)) continue;
            images.set(prefix + name, imageEntry(sheet, {
              x: frame.x, y: frame.y, sourceWidth: frame.width, sourceHeight: frame.height, pixelRatio: frame.pixelRatio || (suffix ? 2 : 1), sdf: frame.sdf
            }));
            missingImages.delete(prefix + name);
          }
          imageVersion++;
          emit('spriteload', { id: entry.id || 'default' });
          schedule();
        }).catch(function (error) {
          if (!destroyed) emit('error', { error: error, sprite: entry.id || 'default' });
        });
      });
    }

    // ---- Raster sources ----------------------------------------------------
    // Raster layers draw at their style position inside this canvas, so a
    // satellite layer can sit above land fills and below roads and labels.
    var rasterSources = Object.create(null);
    var rasterSpecifications = Object.create(null);
    var rasterTiles = new Map();
    var rasterLoading = 0;
    var rasterUse = 0;
    var shadePending = false;
    var shadeSpent = 0;
    var renderDuration = 0;
    var groundDuration = 0, heatDuration = 0, labelDuration = 0, maxCellDuration = 0, renderFrames = 0;
    var rasterMissing = false;
    var maxRasterTiles = positiveInteger(options.maxRasterTiles, 256, 4096);
    var rasterCrossOrigin = options.rasterCrossOrigin;
    var maxRasterConcurrent = positiveInteger(options.maxRasterConcurrent, 12, 32);
    // While the camera zooms, each raster source keeps its tile zoom (like
    // MapLibre) and only switches once the zoom ends or it is 1 level off.
    var rasterZoom = Object.create(null);
    // Direction-independent hillshade samples and their original RGBA bytes.
    // Bound the extra CPU memory independently of the image/tile cache.
    var shadePreparations = new Map();
    var shadePreparationBytes = 0;
    var MAX_SHADE_PREPARATION_BYTES = 24 * 1024 * 1024;
    var zooming = false;
    // Extrusion layers render into a cached, margin-padded image. The camera
    // is orthographic, so panning and zooming only translate and scale that
    // image (building heights scale with the map); rotation, pitch, new
    // tiles or changed heights render it again.
    var extrusionCaches = new Map();
    var bucketSerial = 0;
    var extrusionBudget = 4;
    var prismQueue = [];
    var prismTimer = 0;

    // Speculative tiles prepare only matching building footprints. Limit both
    // queued tiles and work per turn; visible rendering always remains first.
    function queuePrisms(entry) {
      if (!preloadConfig || typeof style === 'function' || prismQueue.length >= 64) return;
      prismQueue.push({ entry: entry, layer: 0, feature: 0 });
      if (!prismTimer) prismTimer = root.setTimeout(preparePrisms, 16);
    }

    function hasPrismStyle(entry, source, metrics) {
      for (var s = 0; s < style.length; s++) {
        var layer = style[s];
        if (layer.type === 'fill-extrusion' && !layer.geojson &&
            (layerVisible(layer, entry.z) || layerVisible(layer, zoomOf(layer, metrics))) &&
            (layer.source || primarySourceID) === entry.sourceId && (!layer.sourceLayer || layer.sourceLayer === source.name)) return true;
      }
      return false;
    }

    function preparePrisms() {
      prismTimer = 0;
      if (destroyed) return;
      var deadline = now() + 2;
      var metrics = mapMetrics();
      var remaining = 64;
      while (prismQueue.length && remaining > 0 && now() < deadline) {
        var job = prismQueue[0];
        var entry = job.entry;
        if (cache[entry.key] !== entry || typeof style === 'function' || job.layer >= entry.data.layers.length) {
          prismQueue.shift();
          continue;
        }
        var source = entry.data.layers[job.layer];
        // Resolve styles once per source layer and slice, not per feature.
        // Recheck each slice so intervening visibility/style changes apply.
        if (hasPrismStyle(entry, source, metrics)) {
          while (job.feature < source.features.length && remaining > 0 && now() < deadline) {
            var feature = source.features[job.feature++];
            if (feature.type === 3) extrusionPrism(feature);
            remaining--;
          }
          if (job.feature < source.features.length) break;
        }
        job.layer++;
        job.feature = 0;
      }
      if (prismQueue.length) prismTimer = root.setTimeout(preparePrisms, 16);
    }

    function clearPrismWork() {
      if (prismTimer) root.clearTimeout(prismTimer);
      prismTimer = 0;
      prismQueue = [];
    }

    function removeRasterTiles(id) {
      rasterTiles.forEach(function (tile, key) {
        if (id != null && key.indexOf(id + '/') !== 0) return;
        tile.cancelled = true;
        if (!tile.loaded && !tile.failed) rasterLoading = Math.max(0, rasterLoading - 1);
        if (tile.image) tile.image.onload = tile.image.onerror = null;
        forgetDEMTile(tile);
        rasterTiles.delete(key);
      });
    }

    // MapLibre's raster-dem encodings: elevation = r·R + g·G + b·B - base.
    var DEM_ENCODINGS = {
      mapbox: [6553.6, 25.6, 0.1, 10000],
      terrarium: [256, 1, 1 / 256, 32768]
    };

    function demEncoding(spec) {
      if (spec.type !== 'raster-dem') return null;
      if (spec.encoding === 'custom') {
        return [finite(spec.redFactor, 1), finite(spec.greenFactor, 1), finite(spec.blueFactor, 1), -finite(spec.baseShift, 0)];
      }
      return DEM_ENCODINGS[spec.encoding] || DEM_ENCODINGS.mapbox;
    }

    function validTemplate(template) {
      return typeof template === 'string' && !!template && (template.indexOf('{bbox-epsg-3857}') >= 0 ||
        (template.indexOf('{z}') >= 0 && template.indexOf('{x}') >= 0 && (template.indexOf('{y}') >= 0 || template.indexOf('{-y}') >= 0)));
    }

    function registerRasterSource(id, specification) {
      var spec = cloneStyleValue(specification, 0);
      var template = Array.isArray(spec.tiles) ? spec.tiles[0] : spec.tiles;
      var viaTileJSON = template == null && typeof spec.url === 'string' && !!spec.url;
      if (!viaTileJSON && !validTemplate(template)) {
        throw styleError('raster source ' + id + ' needs an XYZ or WMS tile template or a TileJSON url');
      }
      if (spec.bounds != null && (!Array.isArray(spec.bounds) || spec.bounds.length !== 4 ||
          !spec.bounds.every(function (value) { return isFinite(+value); }) ||
          +spec.bounds[0] >= +spec.bounds[2] || +spec.bounds[1] >= +spec.bounds[3] ||
          +spec.bounds[0] < -180 || +spec.bounds[2] > 180 || +spec.bounds[1] < -85.051129 || +spec.bounds[3] > 85.051129)) {
        throw styleError('raster source ' + id + ' has invalid bounds');
      }
      var bounds = spec.bounds ? [worldX(spec.bounds[0]), worldY(spec.bounds[3]), worldX(spec.bounds[2]), worldY(spec.bounds[1])] : null;
      if (own(rasterSources, id)) removeRasterTiles(id);
      rasterSpecifications[id] = spec;
      var descriptor = rasterSources[id] = {
        template: viaTileJSON ? null : template, tileSize: clamp(finite(spec.tileSize, 512), 64, 1024),
        minzoom: clamp(Math.floor(finite(spec.minzoom, 0)), 0, 30), maxzoom: clamp(Math.floor(finite(spec.maxzoom, 22)), 0, 30),
        tms: spec.scheme === 'tms', bounds: bounds, dem: demEncoding(spec), loading: viaTileJSON
      };
      if (style.report && typeof spec.attribution === 'string' && spec.attribution) style.report.attributions[id] = spec.attribution;
      delete rasterZoom[id];
      if (!viaTileJSON) return;
      // A TileJSON source draws nothing until its metadata arrives.
      Promise.resolve().then(function () {
        var request = transformed(spec.url, 'Source');
        return fetcher(request.url, requestOptionsFor(null, request));
      }).then(function (response) {
        if (!response || response.ok === false) throw styleError('TileJSON request failed' + (response && response.status ? ' (' + response.status + ')' : ''));
        return response.json();
      }).then(function (tilejson) {
        if (destroyed || rasterSources[id] !== descriptor) return;
        var resolved = Array.isArray(tilejson.tiles) ? tilejson.tiles[0] : null;
        try {
          if (typeof root.URL === 'function') resolved = new root.URL(resolved, new root.URL(spec.url, root.location ? root.location.href : undefined).href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
        } catch (error) {}
        if (!validTemplate(resolved)) throw styleError('TileJSON of raster source ' + id + ' has no tile template');
        descriptor.template = resolved;
        if (spec.scheme == null) descriptor.tms = tilejson.scheme === 'tms';
        descriptor.loading = false;
        if (spec.minzoom == null && tilejson.minzoom != null) descriptor.minzoom = clamp(Math.floor(finite(tilejson.minzoom, 0)), 0, 30);
        if (spec.maxzoom == null && tilejson.maxzoom != null) descriptor.maxzoom = clamp(Math.floor(finite(tilejson.maxzoom, 22)), 0, 30);
        if (spec.encoding == null && tilejson.encoding && descriptor.dem) descriptor.dem = demEncoding({ type: 'raster-dem', encoding: tilejson.encoding });
        if (!spec.attribution && typeof tilejson.attribution === 'string' && tilejson.attribution && style.report) style.report.attributions[id] = tilejson.attribution;
        rasterVersion++;
        emit('sourcedata', { source: id, tileJSON: tilejson });
        schedule();
      }).catch(function (error) {
        if (destroyed || rasterSources[id] !== descriptor) return;
        descriptor.loading = false;
        rasterVersion++;
        emit('sourceerror', { source: id, error: error });
        schedule();
      });
    }

    function registerRasterSources() {
      removeRasterTiles();
      rasterZoom = Object.create(null);
      rasterSources = Object.create(null);
      rasterSpecifications = Object.create(null);
      if (typeof style === 'function' || !style.rasters) return;
      for (var id in style.rasters) {
        var spec = style.rasters[id];
        registerRasterSource(id, spec);
      }
    }

    function rasterURL(source, z, x, y) {
      var count = Math.pow(2, z);
      var url = templateUrl(source.template, z, x, y, subdomains, source.tms);
      if (url.indexOf('{bbox-epsg-3857}') >= 0) {
        var half = 20037508.342789244;
        var size = 2 * half / count;
        url = url.split('{bbox-epsg-3857}').join([x * size - half, half - (y + 1) * size, (x + 1) * size - half, half - y * size].join(','));
      }
      return url;
    }

    function rasterTile(id, source, z, x, y, load) {
      var key = id + '/' + z + '/' + x + '/' + y;
      var tile = rasterTiles.get(key);
      if (!tile && load && rasterLoading >= maxRasterConcurrent) rasterMissing = true;
      if (tile || !load || rasterLoading >= maxRasterConcurrent) return tile;
      var image = root.document.createElement('img');
      tile = { key: key, image: image, loaded: false, failed: false, used: ++rasterUse };
      rasterTiles.set(key, tile);
      rasterLoading++;
      image.decoding = 'async';
      if (source.dem) image.crossOrigin = rasterCrossOrigin == null ? 'anonymous' : rasterCrossOrigin;
      else if (rasterCrossOrigin != null) image.crossOrigin = rasterCrossOrigin;
      function ready() {
        if (tile.cancelled || tile.loaded) return;
        rasterLoading = Math.max(0, rasterLoading - 1);
        tile.loaded = true;
        rasterVersion++;
        emit('tileload', { source: id, z: z, x: x, y: y, raster: true });
        schedule();
      }
      // Decode off the main thread first: otherwise the first drawImage of a
      // fresh image decodes it synchronously inside a frame.
      // decode() never settles in a hidden page (and may stall elsewhere):
      // do not let it hold a request slot.
      image.onload = function () {
        image.onload = image.onerror = null;
        if (typeof image.decode === 'function' && !(root.document && root.document.hidden)) {
          image.decode().then(ready, ready);
          root.setTimeout(ready, 250);
        } else ready();
      };
      image.onerror = function () {
        if (tile.cancelled) return;
        image.onload = image.onerror = null;
        rasterLoading = Math.max(0, rasterLoading - 1);
        tile.failed = true;
        rasterVersion++;
        emit('tileerror', { source: id, z: z, x: x, y: y, raster: true });
        schedule();
      };
      image.src = transformed(rasterURL(source, z, x, y), 'Tile').url;
      return tile;
    }

    function trimRasterTiles(keep) {
      if (rasterTiles.size <= maxRasterTiles) return;
      var candidates = [];
      rasterTiles.forEach(function (tile) { if (!keep[tile.key] && (tile.loaded || tile.failed)) candidates.push(tile); });
      candidates.sort(function (a, b) { return a.used - b.used; });
      for (var i = 0; i < candidates.length && rasterTiles.size > maxRasterTiles; i++) {
        forgetDEMTile(candidates[i]);
        rasterTiles.delete(candidates[i].key);
      }
    }

    function dropShadePreparation(prepared) {
      if (!shadePreparations.delete(prepared)) return;
      shadePreparationBytes -= prepared.bytes;
      if (prepared.tile.shadePreparations[prepared.key] === prepared) delete prepared.tile.shadePreparations[prepared.key];
    }

    function forgetDEMTile(tile) {
      if (!tile.shadePreparations) return;
      for (var key in tile.shadePreparations) dropShadePreparation(tile.shadePreparations[key]);
      tile.shadePreparations = null;
    }

    function shadePreparation(tile, key, pixels, size) {
      var preparations = tile.shadePreparations || (tile.shadePreparations = Object.create(null));
      var prepared = preparations[key];
      if (prepared) {
        shadePreparations.delete(prepared);
        shadePreparations.set(prepared, true);
      } else if (pixels) {
        var count = size * size;
        prepared = {
          tile: tile, key: key, pixels: pixels.slice(),
          aspect: new Float64Array(count), weight: new Float64Array(count), accentWeight: new Float64Array(count),
          bytes: pixels.byteLength + count * 24, ready: false
        };
        prepared.aspect.fill(NaN);
        preparations[key] = prepared;
        shadePreparations.set(prepared, true);
        shadePreparationBytes += prepared.bytes;
        while (shadePreparations.size > 32 || shadePreparationBytes > MAX_SHADE_PREPARATION_BYTES) {
          dropShadePreparation(shadePreparations.keys().next().value);
        }
      }
      return prepared;
    }

    // A canvas derived from one DEM tile for one layer (hillshade, colour
    // relief): recomputed when `key` changes, at up to `maxSize` px, within
    // the frame's time budget. `process(data, size)` rewrites the decoded
    // RGBA elevation in place.
    function demTile(tile, layer, key, maxSize, process, originalPixels) {
      key = layer.type + '|' + key;
      var derived = tile.derived || (tile.derived = Object.create(null));
      var entry = derived[layer.id];
      if (entry && entry.key === key) return entry.canvas;
      // Different layers may use the same DEM paint (with independent
      // opacity/order). Share that work, but never repaint a shared canvas
      // when only one of those layers changes.
      var reusable = true;
      for (var id in derived) {
        if (id === layer.id) continue;
        var other = derived[id];
        if (other.key === key) {
          derived[layer.id] = other;
          return other.canvas;
        }
        if (entry && other.canvas === entry.canvas) reusable = false;
      }
      if (shadeSpent > 8) {
        shadePending = true;
        return entry ? entry.canvas : null;
      }
      var started = now();
      var image = tile.image;
      var natural = image.naturalWidth || image.width;
      if (!(natural > 0)) return null;
      var size = Math.min(maxSize, natural);
      var canvasElement = (reusable && entry && entry.canvas) || root.document.createElement('canvas');
      canvasElement.width = canvasElement.height = size;
      var shade = canvasElement.getContext('2d', { willReadFrequently: true });
      if (!shade || typeof shade.getImageData !== 'function') return null;
      var pixels;
      try {
        if (originalPixels && shade.createImageData) {
          pixels = shade.createImageData(size, size);
          pixels.data.set(originalPixels);
        } else {
          shade.clearRect(0, 0, size, size);
          // Averaging neighbouring pixels would mix their encoded bytes, not
          // their elevations.
          shade.imageSmoothingEnabled = false;
          shade.drawImage(image, 0, 0, size, size);
          pixels = shade.getImageData(0, 0, size, size);
        }
      } catch (error) {
        // A DEM without CORS permission cannot be read.
        return null;
      }
      process(pixels.data, size);
      // A one-pixel border repeats the edge, so smoothing at the tile edge
      // never blends with transparency (which would show as a light seam).
      var padded = shade.createImageData ? shade.createImageData(size + 2, size + 2) : null;
      if (padded) {
        var from = pixels.data;
        var to = padded.data;
        for (var py = 0; py < size + 2; py++) {
          var sy = Math.min(size - 1, Math.max(0, py - 1));
          var a = 4 * sy * size;
          var b = 4 * py * (size + 2);
          to.set(from.subarray(a, a + 4), b);
          to.set(from.subarray(a, a + 4 * size), b + 4);
          to.set(from.subarray(a + 4 * (size - 1), a + 4 * size), b + 4 * (size + 1));
        }
        canvasElement.width = canvasElement.height = size + 2;
        shade.putImageData(padded, 0, 0);
        canvasElement._inset = 1;
      } else shade.putImageData(pixels, 0, 0);
      derived[layer.id] = { key: key, canvas: canvasElement };
      shadeSpent += now() - started;
      return canvasElement;
    }

    // Hillshade of one DEM tile (MapLibre's standard method, see shadeDEM),
    // at up to 256 px.
    function shadedTile(tile, layer, source, instruction, z, y, bearing) {
      var direction = instruction.direction + (instruction.anchor === 'map' ? 0 : bearing);
      var key = [direction, instruction.exaggeration, instruction.shadow, instruction.highlight, instruction.accent].join('|');
      var size = Math.min(256, tile.image.naturalWidth || tile.image.width);
      var preparationKey = [size, z, y, source.dem, instruction.exaggeration].join('|');
      var prepared = shadePreparation(tile, preparationKey);
      return demTile(tile, layer, key, 256, function (data, size) {
        if (!prepared && instruction.exaggeration > 0) prepared = shadePreparation(tile, preparationKey, data, size);
        shadeDEM(data, size, z, y, source.dem, {
          direction: direction, exaggeration: instruction.exaggeration,
          shadow: instruction.shadow, highlight: instruction.highlight, accent: instruction.accent
        }, prepared);
      }, prepared && prepared.pixels);
    }

    function reliefTile(tile, layer, source) {
      var relief = reliefStops(layer);
      return demTile(tile, layer, relief.key, 512, function (data) { reliefDEM(data, source.dem, relief); });
    }

    // Draws the square part (fx, fy, fraction of the side) of a tile image
    // into a square on the canvas; padded elevation images skip their border.
    // Without rotation (`grid` is the canvas transform) neighbouring tiles
    // meet exactly at device pixel edges: an overlap would darken
    // translucent layers (hillshade, colour relief, raster-opacity) along
    // the seams. Rotated tiles overlap by half a pixel instead, hiding the
    // gaps antialiasing leaves.
    function blit(ctx, picture, fx, fy, fraction, x, y, size, grid) {
      var inset = picture._inset || 0;
      var side = (picture.naturalWidth || picture.width) - 2 * inset;
      var width = size;
      var height = size;
      if (grid) {
        var left = Math.round(grid.a * x + grid.e);
        var top = Math.round(grid.d * y + grid.f);
        width = (Math.round(grid.a * (x + size) + grid.e) - left) / grid.a;
        height = (Math.round(grid.d * (y + size) + grid.f) - top) / grid.d;
        x = (left - grid.e) / grid.a;
        y = (top - grid.f) / grid.d;
      } else {
        x -= 0.5;
        y -= 0.5;
        width = height = size + 1;
      }
      ctx.drawImage(picture, inset + fx * side, inset + fy * side, fraction * side, fraction * side, x, y, width, height);
    }

    function rasterImage(layer, tile, source, instruction, z, y, metrics) {
      if (!tile || !tile.loaded) return null;
      if (layer.type === 'hillshade') return shadedTile(tile, layer, source, instruction, z, y, -metrics.bearing);
      if (layer.type === 'color-relief') return reliefTile(tile, layer, source);
      return tile.image;
    }

    // `cell` (tilted view) limits drawing to one cover cell, at that cell's
    // level of detail instead of the camera's.
    function drawRaster(ctx, layer, metrics, cell) {
      var source = rasterSources[layer.raster];
      if (!source || !source.template) {
        if (source && source.loading) rasterMissing = true;
        return;
      }
      var instruction = layerInstruction(layer, zoomOf(layer, metrics), null);
      if (!(instruction.opacity > 0)) return;
      var ideal = Math.round(Math.log(metrics.pixelsPerWorld / source.tileSize) / Math.LN2);
      var range;
      var z;
      if (cell) {
        // The world's size in the cell texture's CSS pixels picks the level.
        ideal = Math.round(Math.log(Math.pow(2, cell.z) * cell.wantPixels / Math.min(dpr, 2) / source.tileSize) / Math.LN2);
        if (ideal < source.minzoom) return;
        z = Math.min(ideal, source.maxzoom);
        var factor = Math.pow(2, z - cell.z);
        // One tile more on each side fills the cell's overlapping edge, which
        // would otherwise cover the neighbouring cell with background only.
        range = { minX: Math.floor(cell.x * factor) - 1, maxX: Math.ceil((cell.x + 1) * factor), minY: Math.max(0, Math.floor(cell.y * factor) - 1),
          maxY: Math.min(Math.pow(2, z) - 1, Math.ceil((cell.y + 1) * factor)), count: Math.pow(2, z) };
      } else {
        var held = rasterZoom[layer.raster];
        if (zooming && held != null && Math.abs(held - ideal) < 1.5) ideal = held;
        rasterZoom[layer.raster] = ideal;
        if (ideal < source.minzoom) return;
        z = Math.min(ideal, source.maxzoom);
        range = tileRange(z, 0, metrics);
      }
      if ((range.maxX - range.minX + 1) * (range.maxY - range.minY + 1) > 256) return;
      var keep = Object.create(null);
      ctx.save();
      ctx.globalAlpha = instruction.opacity;
      if (instruction.filter !== 'none' && 'filter' in ctx) ctx.filter = instruction.filter;
      ctx.imageSmoothingEnabled = instruction.smooth;
      var grid = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
      if (grid && (grid.b || grid.c || !(grid.a > 0) || !(grid.d > 0))) grid = null;
      for (var y = range.minY; y <= range.maxY; y++) {
        for (var x = range.minX; x <= range.maxX; x++) {
          var wrapped = ((x % range.count) + range.count) % range.count;
          if (source.bounds && ((wrapped + 1) / range.count <= source.bounds[0] || wrapped / range.count >= source.bounds[2] ||
            (y + 1) / range.count <= source.bounds[1] || y / range.count >= source.bounds[3])) continue;
          var origin = tileOrigin({ z: z, x: x, y: y }, metrics);
          var tile = rasterTile(layer.raster, source, z, wrapped, y, true);
          keep[layer.raster + '/' + z + '/' + wrapped + '/' + y] = true;
          var picture = rasterImage(layer, tile, source, instruction, z, y, metrics);
          if (picture) {
            tile.used = ++rasterUse;
            blit(ctx, picture, 0, 0, 1, origin[0], origin[1], origin[2], grid);
            continue;
          }
          // While a tile loads, show loaded children (after zooming out),
          // otherwise the nearest loaded parent's quadrant.
          if (z < source.maxzoom) {
            var children = [];
            for (var c = 0; c < 4; c++) {
              var child = rasterTile(layer.raster, source, z + 1, wrapped * 2 + (c & 1), y * 2 + (c >> 1), false);
              var childPicture = rasterImage(layer, child, source, instruction, z + 1, y * 2 + (c >> 1), metrics);
              if (childPicture) children.push([child, childPicture]);
            }
            if (children.length === 4) {
              for (c = 0; c < 4; c++) {
                children[c][0].used = ++rasterUse;
                keep[children[c][0].key] = true;
                var half = origin[2] / 2;
                blit(ctx, children[c][1], 0, 0, 1, origin[0] + (c & 1) * half, origin[1] + (c >> 1) * half, half, grid);
              }
              continue;
            }
          }
          if (!tile || !tile.failed) rasterMissing = true;
          // A failed tile (often a 404 beyond the data's coverage) is replaced
          // by its nearest parent with data, loaded level by level as in
          // MapLibre; a loading tile only borrows cached parents.
          var request = !!(tile && tile.failed);
          if (request) tile.used = ++rasterUse;
          for (var up = 1; up <= 5 && z - up >= source.minzoom; up++) {
            var factor = Math.pow(2, up);
            var parent = rasterTile(layer.raster, source, z - up, Math.floor(wrapped / factor), Math.floor(y / factor), request);
            var parentPicture = rasterImage(layer, parent, source, instruction, z - up, Math.floor(y / factor), metrics);
            if (parent && request) {
              parent.used = ++rasterUse;
              keep[parent.key] = true;
              if (!parent.loaded && !parent.failed) rasterMissing = true;
            }
            request = !!(parent && parent.failed);
            if (!parentPicture) continue;
            parent.used = ++rasterUse;
            keep[parent.key] = true;
            blit(ctx, parentPicture, (wrapped % factor) / factor, (y % factor) / factor, 1 / factor, origin[0], origin[1], origin[2], grid);
            break;
          }
        }
      }
      ctx.restore();
      // Cells of a tilted view share the raster cache; it is trimmed once
      // per frame there (see drawTilted) instead of per cell.
      if (!cell) trimRasterTiles(keep);
      if (shadePending) {
        // Shading continues in the next frame; incomplete cells repaint.
        shadePending = false;
        rasterMissing = true;
        rasterVersion++;
        schedule();
      }
    }

    // ---- GeoJSON sources ---------------------------------------------------
    // Features are projected to world coordinates once per setData(); each
    // drawn tile then gets a virtual layer of the features touching it, in
    // fractional tile units, so GeoJSON uses the same buckets, cached paths,
    // style engine and label placement as the vector tiles (like MapLibre's
    // geojson-vt, but without clipping: Canvas clips at the tile edge).
    var geojsonSources = Object.create(null);
    var maxGeoJSONFeatures = positiveInteger(options.maxGeoJSONFeatures, 50000, 500000);
    var maxGeoJSONCoordinates = positiveInteger(options.maxGeoJSONCoordinates, 1000000, 10000000);

    function projectGeoJSON(data) {
      var features = [];
      var budget = { coordinates: 0 };
      function add(geometry, id, properties) {
        if (!geometry || typeof geometry !== 'object') return;
        var type = geometry.type;
        var coordinates = geometry.coordinates;
        var parts = [];
        var kind = 0;
        function part(positions, close) {
          if (!Array.isArray(positions)) throw styleError('GeoJSON coordinates must be arrays');
          var count = positions.length;
          if (close && count > 1 && positions[0][0] === positions[count - 1][0] && positions[0][1] === positions[count - 1][1]) count--;
          if ((budget.coordinates += count) > maxGeoJSONCoordinates) throw styleError('GeoJSON source has too many coordinates');
          var flat = new Float64Array(count * 2);
          for (var i = 0; i < count; i++) {
            var position = positions[i];
            if (!position || !isFinite(+position[0]) || !isFinite(+position[1])) throw styleError('GeoJSON positions need finite coordinates');
            flat[2 * i] = worldX(position[0]);
            flat[2 * i + 1] = worldY(position[1]);
          }
          if (count) parts.push(flat);
        }
        var i;
        if (type === 'Point') { kind = 1; part([coordinates]); }
        else if (type === 'MultiPoint') { kind = 1; for (i = 0; i < coordinates.length; i++) part([coordinates[i]]); }
        else if (type === 'LineString') { kind = 2; part(coordinates); }
        else if (type === 'MultiLineString') { kind = 2; for (i = 0; i < coordinates.length; i++) part(coordinates[i]); }
        else if (type === 'Polygon') { kind = 3; for (i = 0; i < coordinates.length; i++) part(coordinates[i], true); }
        else if (type === 'MultiPolygon') { kind = 3; for (i = 0; i < coordinates.length; i++) for (var r = 0; r < coordinates[i].length; r++) part(coordinates[i][r], true); }
        else if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
          for (i = 0; i < geometry.geometries.length; i++) add(geometry.geometries[i], id, properties);
          return;
        } else throw styleError('unsupported GeoJSON geometry ' + String(type));
        if (!parts.length) return;
        if (features.length >= maxGeoJSONFeatures) throw styleError('GeoJSON source has too many features');
        var bbox = [Infinity, Infinity, -Infinity, -Infinity];
        for (i = 0; i < parts.length; i++) {
          for (var c = 0; c < parts[i].length; c += 2) {
            bbox[0] = Math.min(bbox[0], parts[i][c]);
            bbox[1] = Math.min(bbox[1], parts[i][c + 1]);
            bbox[2] = Math.max(bbox[2], parts[i][c]);
            bbox[3] = Math.max(bbox[3], parts[i][c + 1]);
          }
        }
        features.push({ id: id, type: kind, properties: properties, parts: parts, bbox: bbox });
      }
      function feature(value) {
        var properties = Object.create(null);
        var source = value.properties && typeof value.properties === 'object' ? cloneStyleValue(value.properties, 0) : {};
        for (var key in source) properties[key] = source[key];
        var before = features.length;
        add(value.geometry, value.id == null ? null : value.id, properties);
        for (var added = before; added < features.length; added++) features[added].original = value;
      }
      if (!data || typeof data !== 'object') throw styleError('GeoJSON source data must be an object');
      if (data.type === 'FeatureCollection') {
        if (!Array.isArray(data.features)) throw styleError('FeatureCollection.features must be an array');
        for (var f = 0; f < data.features.length; f++) if (data.features[f]) feature(data.features[f]);
      } else if (data.type === 'Feature') feature(data);
      else add(data, null, Object.create(null));
      return features;
    }

    // `data` may be a URL, as in MapLibre: the source starts empty and fills
    // once the document arrives (a newer setData() wins over a late response).
    function setSourceData(id, data, specification) {
      var url = typeof data === 'string' ? data : null;
      if (url) data = null;
      var features = projectGeoJSON(data == null ? { type: 'FeatureCollection', features: [] } : data);
      var previous = geojsonSources[id];
      var settings = specification || (previous && previous.settings) || {};
      var entry = geojsonSources[id] = {
        version: (previous ? previous.version : 0) + 1, features: features, settings: settings,
        clusters: settings.cluster ? clusterSource(features, settings) : null,
        data: cloneStyleValue(data == null ? { type: 'FeatureCollection', features: [] } : data, 0),
        url: url, loading: !!url
      };
      rendered = null;
      schedule();
      if (!url) return;
      Promise.resolve().then(function () {
        var request = transformed(url, 'Source');
        return fetcher(request.url, requestOptionsFor(null, request));
      }).then(function (response) {
        if (!response || response.ok === false) throw styleError('GeoJSON request failed' + (response && response.status ? ' (' + response.status + ')' : ''));
        return response.json();
      }).then(function (json) {
        if (destroyed || geojsonSources[id] !== entry) return;
        setSourceData(id, json, settings);
        geojsonSources[id].url = url;
        emit('sourcedata', { source: id, dataType: 'source' });
      }).catch(function (error) {
        if (destroyed || geojsonSources[id] !== entry) return;
        entry.loading = false;
        emit('sourceerror', { source: id, error: error });
        schedule();
      });
    }

    // ---- Point clustering ----------------------------------------------------
    // Like supercluster (MapLibre's GeoJSON clustering): from clusterMaxZoom
    // down to zoom 0, each level greedily merges the points of the level
    // above that lie within clusterRadius (in 512px-tile pixels) into a
    // weighted centroid. Tiles show the level of their zoom.
    var CLUSTER_REDUCERS = {
      '+': function (a, b) { return a + b; }, '*': function (a, b) { return a * b; },
      max: function (a, b) { return Math.max(a, b); }, min: function (a, b) { return Math.min(a, b); },
      all: function (a, b) { return !!a && !!b; }, any: function (a, b) { return !!a || !!b; }
    };

    function abbreviate(count) {
      return count >= 10000 ? Math.round(count / 1000) + 'k' : count >= 1000 ? Math.round(count / 100) / 10 + 'k' : String(count);
    }

    // GeoJSON keeps every zoom level for cluster queries. A decoded MVT tile
    // needs only its own level, so stop there after building finer levels.
    function clusterSource(features, settings, minZoom) {
      var maxZoom = clamp(Math.floor(finite(settings.clusterMaxZoom, 14)), 0, 24);
      var radius = Math.max(0, finite(settings.clusterRadius, 50));
      var minPoints = Math.max(2, Math.floor(finite(settings.clusterMinPoints, 2)));
      var reducers = [];
      var definitions = settings.clusterProperties || {};
      for (var name in definitions) {
        var definition = definitions[name];
        if (!Array.isArray(definition) || definition.length < 2) continue;
        var operator = Array.isArray(definition[0]) ? definition[0][0] : definition[0];
        var reduce = CLUSTER_REDUCERS[operator];
        if (!reduce) throw styleError('unsupported clusterProperties operator ' + String(operator));
        reducers.push({ name: name, reduce: reduce, map: compileExpression(definition[1], 0, null) });
      }
      var others = [];
      var points = [];
      for (var f = 0; f < features.length; f++) {
        var item = features[f];
        if (item.type !== 1 || item.parts.length !== 1 || item.parts[0].length !== 2) { others.push(item); continue; }
        var values = {};
        for (var r = 0; r < reducers.length; r++) {
          evalContext.zoom = 0;
          evalContext.feature = { type: 1, id: item.id, properties: item.properties, _properties: item.properties };
          try { values[reducers[r].name] = reducers[r].map.fn(evalContext); } catch (error) { values[reducers[r].name] = null; }
        }
        points.push({ x: item.parts[0][0], y: item.parts[0][1], count: 1, item: item, values: values, children: null, zoom: Infinity });
      }
      var clusters = new Map();
      var nextId = 1;
      var levels = [];
      levels[maxZoom + 1] = points;
      for (var z = maxZoom; z >= (minZoom || 0); z--) {
        var input = levels[z + 1];
        var reach = radius / (512 * Math.pow(2, z));
        var grid = new Map();
        var cell = reach || 1;
        var i;
        for (i = 0; i < input.length; i++) {
          var key = Math.floor(input[i].x / cell) + ',' + Math.floor(input[i].y / cell);
          (grid.get(key) || grid.set(key, []).get(key)).push(i);
        }
        var used = new Uint8Array(input.length);
        var output = [];
        for (i = 0; i < input.length; i++) {
          if (used[i]) continue;
          var point = input[i];
          used[i] = 1;
          var near = [];
          var gx = Math.floor(point.x / cell);
          var gy = Math.floor(point.y / cell);
          for (var dx = -1; dx <= 1 && reach; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
              var list = grid.get((gx + dx) + ',' + (gy + dy));
              if (!list) continue;
              for (var n = 0; n < list.length; n++) {
                var other = input[list[n]];
                if (used[list[n]]) continue;
                if ((other.x - point.x) * (other.x - point.x) + (other.y - point.y) * (other.y - point.y) <= reach * reach) near.push(list[n]);
              }
            }
          }
          var total = point.count;
          for (n = 0; n < near.length; n++) total += input[near[n]].count;
          if (total < minPoints || !near.length) { output.push(point); continue; }
          var cluster = { x: point.x * point.count, y: point.y * point.count, count: total, item: null, values: {}, children: [point], zoom: z, id: nextId++ };
          for (r = 0; r < reducers.length; r++) cluster.values[reducers[r].name] = point.values[reducers[r].name];
          for (n = 0; n < near.length; n++) {
            var member = input[near[n]];
            used[near[n]] = 1;
            cluster.x += member.x * member.count;
            cluster.y += member.y * member.count;
            cluster.children.push(member);
            for (r = 0; r < reducers.length; r++) cluster.values[reducers[r].name] = reducers[r].reduce(cluster.values[reducers[r].name], member.values[reducers[r].name]);
          }
          cluster.x /= total;
          cluster.y /= total;
          var properties = Object.create(null);
          for (var v in cluster.values) properties[v] = cluster.values[v];
          properties.cluster = true;
          properties.cluster_id = cluster.id;
          properties.point_count = total;
          properties.point_count_abbreviated = abbreviate(total);
          cluster.item = { id: cluster.id, type: 1, properties: properties, parts: [new Float64Array([cluster.x, cluster.y])], bbox: [cluster.x, cluster.y, cluster.x, cluster.y], cluster: cluster };
          clusters.set(cluster.id, cluster);
          output.push(cluster);
        }
        levels[z] = output;
      }
      return { maxZoom: maxZoom, others: others, clusters: clusters, levels: levels.map(function (level) {
        return level.map(function (entry) { return entry.item; }).concat(others);
      }) };
    }

    // MVT points are clustered per decoded tile. This keeps work bounded and
    // lets the existing style/filter/query pipeline consume ordinary features.
    function clusterTileLayer(entry, sourceLayer) {
      if (!mvtClusterSettings || (mvtClusterSettings.sourceLayers && mvtClusterSettings.sourceLayers.indexOf(sourceLayer.name) < 0) || entry.z > mvtClusterSettings.clusterMaxZoom) return sourceLayer;
      var cacheKey = sourceLayer.name;
      var cached = entry.mvtClusters && entry.mvtClusters[cacheKey];
      if (cached) return cached;
      var count = 1 << entry.z;
      var extent = sourceLayer.extent;
      var points = [];
      var other = [];
      for (var f = 0; f < sourceLayer.features.length; f++) {
        var feature = sourceLayer.features[f];
        var coordinateCount = sourceLayer.parts[feature._partEnd] - sourceLayer.parts[feature._partStart];
        if (feature.type !== 1 || feature._partEnd - feature._partStart !== 1 || coordinateCount !== 1) { other.push(feature); continue; }
        var at = sourceLayer.parts[feature._partStart] * 2;
        var x = (entry.x + sourceLayer.coords[at] / extent) / count;
        var y = (entry.y + sourceLayer.coords[at + 1] / extent) / count;
        points.push({ id: feature.id, type: 1, properties: feature.properties, parts: [[x, y]] });
      }
      var run = clusterSource(points, mvtClusterSettings, entry.z);
      var clustered = run.levels[Math.min(entry.z, run.maxZoom + 1)] || [];
      var layer = newLayer(sourceLayer.name, extent, sourceLayer.version, sourceLayer.keys, sourceLayer.values);
      layer.tags = new Uint32Array(0);
      var parts = [];
      var coords = [];
      var features = other;
      for (var c = 0; c < clustered.length; c++) {
        var item = clustered[c];
        var world = item.parts[0];
        if (!world || world.length < 2) continue;
        var localX = (world[0] * count - entry.x) * extent;
        var localY = (world[1] * count - entry.y) * extent;
        var partStart = parts.length;
        parts.push(coords.length / 2);
        coords.push(localX, localY);
        var id = item.cluster ? 'mvt-' + entry.z + '-' + entry.x + '-' + entry.y + '-' + item.id : item.id;
        var output = new VectorFeature(layer, id, 1, 0, 0, partStart, parts.length);
        output._properties = item.properties;
        features.push(output);
      }
      parts.push(coords.length / 2);
      layer.parts = new Uint32Array(parts);
      layer.coords = new Float64Array(coords);
      layer.features = features;
      (entry.mvtClusters || (entry.mvtClusters = Object.create(null)))[cacheKey] = layer;
      return layer;
    }

    function lonLatOfWorld(x, y) {
      return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
    }

    function clusterFeature(entry) {
      if (!entry.children) return cloneStyleValue(entry.item.original, 0);
      var properties = {};
      for (var key in entry.item.properties) properties[key] = entry.item.properties[key];
      return { type: 'Feature', id: entry.id, properties: properties, geometry: { type: 'Point', coordinates: lonLatOfWorld(entry.x, entry.y) } };
    }

    function clusterLeaves(entry, out) {
      if (!entry.children) out.push(entry);
      else for (var i = 0; i < entry.children.length; i++) clusterLeaves(entry.children[i], out);
      return out;
    }

    // Promise results, with MapLibre's older (error, value) callback too.
    function clusterAnswer(id, compute, callback) {
      var promise = new Promise(function (resolve, reject) {
        var source = geojsonSources[id];
        var run = source && source.clusters;
        if (!run) { reject(new Error('microMap.vector: source ' + id + ' is not clustered')); return; }
        resolve(compute(run));
      });
      if (typeof callback === 'function') promise.then(function (value) { callback(null, value); }, function (error) { callback(error); });
      return promise;
    }

    function clusterById(run, clusterId) {
      var cluster = run.clusters.get(+clusterId);
      if (!cluster) throw new Error('microMap.vector: no cluster with id ' + clusterId);
      return cluster;
    }

    // GeoJSON clustering follows its own 512px zoom levels, even while the
    // basemap is overzoomed beyond the last available vector tile.
    function geojsonClusterZoom(source, metrics) {
      var zoom;
      if (metrics) zoom = metrics.styleZoom;
      else {
        var camera = typeof map.getCameraState === 'function' ? map.getCameraState() : null;
        zoom = camera && camera.worldSize > 0 ? Math.log(camera.worldSize / 512) / Math.LN2 : mapMetrics().styleZoom;
      }
      return Math.max(0, Math.min(Math.floor(zoom + 1e-9), source.clusters.maxZoom + 1));
    }

    function virtualLayer(entry, id, clusterZoom) {
      var source = geojsonSources[id];
      var cached = entry.virtual && entry.virtual[id];
      if (cached && cached.version === source.version && cached.clusterZoom === clusterZoom) return cached.layer;
      var count = Math.pow(2, entry.z);
      var items = source.clusters ? source.clusters.levels[clusterZoom] : source.features;
      var extent = 4096;
      var x0 = entry.x / count;
      var y0 = entry.y / count;
      var size = 1 / count;
      var pad = size / 8;
      var layer = newLayer(id, extent, 2, [], []);
      var coords = [];
      var parts = [];
      for (var f = 0; f < items.length; f++) {
        var item = items[f];
        if (item.bbox[2] < x0 - pad || item.bbox[0] > x0 + size + pad || item.bbox[3] < y0 - pad || item.bbox[1] > y0 + size + pad) continue;
        var partStart = parts.length;
        for (var p = 0; p < item.parts.length; p++) {
          var flat = item.parts[p];
          parts.push(coords.length / 2);
          for (var i = 0; i < flat.length; i += 2) coords.push((flat[i] - x0) * count * extent, (flat[i + 1] - y0) * count * extent);
        }
        var feature = new VectorFeature(layer, item.id, item.type, 0, 0, partStart, parts.length);
        feature._properties = item.properties;
        layer.features.push(feature);
      }
      parts.push(coords.length / 2);
      layer.coords = new Float64Array(coords);
      layer.parts = new Uint32Array(parts);
      layer.tags = new Uint32Array(0);
      (entry.virtual || (entry.virtual = Object.create(null)))[id] = { version: source.version, clusterZoom: clusterZoom, layer: layer };
      return layer;
    }

    function registerStyleSources() {
      geojsonSources = Object.create(null);
      if (typeof style === 'function' || !style.geojson) return;
      for (var id in style.geojson) setSourceData(id, style.geojson[id].data, style.geojson[id]);
    }

    // Like MapLibre's buckets, a tile resolves each declarative style layer
    // once per layer version: filters (at the tile's zoom), type checks and
    // label text. Features whose style inputs are equal share a group, so
    // one cached path and one per-frame evaluation serve all of them. A
    // bucket also keeps groups per MVT layer, because extents may differ.
    function bucketFor(entry, layer) {
      if (entry.style !== styleVersion || !entry.buckets) {
        entry.style = styleVersion;
        entry.buckets = Object.create(null);
      }
      var sourceState = layer.geojson ? geojsonSources[layer.geojson] : null;
      var dataVersion = sourceState ? sourceState.version : 0;
      var clusterZoom = sourceState && sourceState.clusters ? geojsonClusterZoom(sourceState) : -1;
      var bucket = entry.buckets[layer.uid];
      var stateVersion = layer.stateDependent ? layerStateVersion(layer) : 0;
      if (bucket && bucket.version === layer.version && bucket.dataVersion === dataVersion && bucket.clusterZoom === clusterZoom && bucket.stateVersion === stateVersion) return bucket;
      bucket = entry.buckets[layer.uid] = [];
      bucket.serial = ++bucketSerial;
      bucket.version = layer.version;
      bucket.dataVersion = dataVersion;
      bucket.clusterZoom = clusterZoom;
      bucket.stateVersion = stateVersion;
      var stateSource = layer.geojson || layer.source || primarySourceID;
      var type = layer.type;
      var zoom = entry.z;
      var matchesSource = layer.geojson ? entry.sourceId === primarySourceID :
        (layer.source == null ? entry.sourceId === primarySourceID : layer.source === entry.sourceId);
      var sources = !matchesSource ? [] : layer.geojson ? (sourceState ? [virtualLayer(entry, layer.geojson, clusterZoom)] : []) : entry.data.layers;
      for (var l = 0; l < sources.length; l++) {
        var source = sources[l];
        if (!layer.geojson && layer.sourceLayer && source.name !== layer.sourceLayer) continue;
        if (!layer.geojson && mvtClusterSettings && (type === 'symbol' || type === 'circle')) source = clusterTileLayer(entry, source);
        var groups = new Map();
        for (var f = 0; f < source.features.length; f++) {
          var feature = source.features[f];
          if (!typeMatches(type, feature.type) || !passesFilter(layer, zoom, feature)) continue;
          if (layer.stateDependent) feature._state = featureStates.get(stateKey(stateSource, layer.geojson ? '' : source.name, feature.id)) || null;
          var key = groupKey(layer, feature);
          var group = groups.get(key);
          if (!group) {
            group = { layer: source, representative: feature, features: [], labels: type === 'symbol' ? [] : null, instruction: null, instructionZoom: null, path: null, lod: null, circleScale: 0 };
            groups.set(key, group);
          }
          if (!group.labels) {
            group.features.push(feature);
            continue;
          }
          var text = layer.props['text-field'] ? layerText(layer, zoom, feature) : '';
          var icon = layer.props['icon-image'] ? cleanLabelText(evaluate(layer, 'icon-image', zoom, feature)) : '';
          if (!text && !icon) continue;
          var sortKey = numberOr(evaluate(layer, 'symbol-sort-key', zoom, feature), 0);
          // Anchors are kept in tile units; a frame only scales them.
          var placement = evaluate(layer, 'symbol-placement', zoom, feature);
          if ((placement === 'line' || placement === 'line-center') && feature.type === 2) {
            // Line labels are placed after merging same-text lines.
            var lineKey = key + '\u0001' + text + '\u0001' + icon;
            var pending = group.lines || (group.lines = new Map());
            var entryLines = pending.get(lineKey);
            if (!entryLines) pending.set(lineKey, entryLines = { feature: feature, text: text, icon: icon, sortKey: sortKey, center: placement === 'line-center', parts: [] });
            linePartsOf(feature, entryLines.parts);
            continue;
          }
          var anchor = symbolAnchor(feature, { placement: 'point' }, 0, 0, 1);
          if (anchor) {
            group.labels.push({ feature: feature, text: text, icon: icon, x: anchor.x, y: anchor.y, angle: 0, length: 0, layout: null, sortKey: sortKey });
          }
        }
        groups.forEach(function (value) {
          if (value.lines) {
            var spacing = numberOr(evaluate(layer, 'symbol-spacing', zoom, value.representative), 250) * source.extent / (layer.v8 ? 512 : 256);
            value.lines.forEach(function (line) {
              var merged = mergeLines(line.parts);
              for (var m = 0; m < merged.length; m++) {
                var anchors = lineAnchors(merged[m], line.center ? 0 : spacing);
                for (var a = 0; a < anchors.length; a++) {
                  value.labels.push({
                    feature: line.feature, text: line.text, icon: line.icon, x: anchors[a].x, y: anchors[a].y, angle: anchors[a].angle,
                    length: anchors[a].length, layout: null, sortKey: line.sortKey, line: anchors[a].line, along: anchors[a].along
                  });
                }
              }
            });
            value.lines = null;
          }
          if (value.features.length || (value.labels && value.labels.length)) bucket.push(value);
        });
      }
      return bucket;
    }

    function groupKey(layer, feature) {
      var props = layer.groupProps;
      var key = '';
      for (var i = 0; i < props.length; i++) {
        var value = props[i] === '$type' ? feature.type : props[i] === '$id' ? feature.id :
          props[i] === '$state' ? JSON.stringify(feature._state || null) : prop(feature, props[i]);
        key += (typeof value).charAt(0) + String(value) + '\u0000';
      }
      return key;
    }

    // Camera-dependent values are evaluated once per group and frame.
    function groupInstruction(group, layer, zoom) {
      if (!group.instruction || (layer.zoomDependent && group.instructionZoom !== zoom)) {
        group.instruction = layerInstruction(layer, zoom, group.representative);
        group.instructionZoom = zoom;
        group.circleScale = 0;
      }
      return group.instruction;
    }

    // Path2D geometry stays in tile units and is reused across frames. Its
    // simplification level changes only every half zoom octave; when several
    // tiles cross that boundary at once, the rebuild work is spread over a
    // few frames by reusing the slightly finer path meanwhile.
    function groupPath(group, instruction, scale, zoom) {
      var path;
      var i;
      if (instruction.type === 'circle') {
        // A circle radius is in screen pixels, so the path depends on scale.
        if (group.path && group.circleScale === scale) return group.path;
        path = new root.Path2D();
        for (i = 0; i < group.features.length; i++) emitCircles(path, group.features[i], 0, 0, 1, instruction.radius / scale);
        group.circleScale = scale;
      } else {
        var lod = lodFor(scale, zoom);
        if (group.path && group.lod === lod) return group.path;
        if (group.path && pathBuilds && now() - frameStart > PATH_BUDGET_MS) {
          pathStale = true;
          return group.path;
        }
        path = new root.Path2D();
        var tolerance = lodTolerance(lod);
        for (i = 0; i < group.features.length; i++) emitPath(path, group.features[i], 0, 0, 1, instruction.type === 'fill', tolerance);
        group.lod = lod;
      }
      pathBuilds++;
      group.path = path;
      return path;
    }

    // The pattern tile of an image (sprite frames are cropped once).
    function patternTile(image) {
      if (image.tile) return image.tile;
      var tile = image.source;
      if (image.sx || image.sy || image.sw !== (image.source.naturalWidth || image.source.width) || image.sh !== (image.source.naturalHeight || image.source.height)) {
        tile = root.document.createElement('canvas');
        tile.width = image.sw;
        tile.height = image.sh;
        tile.getContext('2d').drawImage(image.source, image.sx, image.sy, image.sw, image.sh, 0, 0, image.sw, image.sh);
      }
      return (image.tile = tile);
    }

    // fill-pattern keeps its CSS pixel size and is anchored to the world,
    // so neighbouring tiles continue it without a seam. The path is drawn
    // in tile units (translated to the tile and scaled by `scale`).
    function fillPatternFor(ctx, image, origin, scale, metrics) {
      if (typeof ctx.createPattern !== 'function') return null;
      var pattern = ctx.createPattern(patternTile(image), 'repeat');
      if (!pattern) return null;
      if (typeof pattern.setTransform === 'function' && typeof root.DOMMatrix === 'function') {
        var worldX = origin[0] - width / 2 + metrics.centerX * metrics.pixelsPerWorld;
        var worldY = origin[1] - height / 2 + metrics.centerY * metrics.pixelsPerWorld;
        var shiftX = ((worldX % image.width) + image.width) % image.width;
        var shiftY = ((worldY % image.height) + image.height) % image.height;
        var unit = 1 / (image.pixelRatio * scale);
        pattern.setTransform(new root.DOMMatrix([unit, 0, 0, unit, -shiftX / scale, -shiftY / scale]));
      }
      return pattern;
    }

    // Lines with line-offset and/or line-pattern, per frame in raw pixels.
    // The offset is perpendicular (positive: to the right of the line's
    // direction) with mitred corners; a pattern repeats along the line with
    // its height stretched to the line width, as in MapLibre.
    function drawSpecialLines(ctx, group, instruction, origin, scale, tolerance, image) {
      var lineWidth = instruction.width;
      if (!(lineWidth > 0)) return;
      var pattern = image && typeof ctx.createPattern === 'function' ? ctx.createPattern(patternTile(image), 'repeat') : null;
      if (image && !pattern) return;
      ctx.save();
      ctx.globalAlpha = instruction.opacity;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = pattern ? 'butt' : instruction.lineCap;
      ctx.lineJoin = instruction.lineJoin;
      ctx.strokeStyle = instruction.color;
      if (!pattern && ctx.setLineDash) ctx.setLineDash(instruction.dash ? instruction.dash.map(function (part) { return part * lineWidth; }) : NO_DASH);
      var points = [];
      for (var f = 0; f < group.features.length; f++) {
        var feature = group.features[f];
        var layer = feature._layer;
        var coords = layer.coords;
        var closed = feature.type === 3;
        for (var p = feature._partStart; p < feature._partEnd; p++) {
          var start = layer.parts[p];
          var end = layer.parts[p + 1];
          points.length = 0;
          var keep = tolerance ? simplifyMask(coords, start, end, tolerance / scale, closed) : null;
          for (var i = start; i < end; i++) {
            if (keep && !keep[i - start]) continue;
            points.push(origin[0] + coords[2 * i] * scale, origin[1] + coords[2 * i + 1] * scale);
          }
          if (closed && points.length > 2) points.push(points[0], points[1]);
          if (points.length < 4) continue;
          // line-gap-width: two lines either side of the gap (casings).
          if (instruction.gap && !pattern) {
            var side = (instruction.gap + lineWidth) / 2;
            for (var g = -1; g <= 1; g += 2) {
              var copy = offsetLine(points.slice(), instruction.offset + g * side);
              ctx.beginPath();
              ctx.moveTo(copy[0], copy[1]);
              for (i = 2; i < copy.length; i += 2) ctx.lineTo(copy[i], copy[i + 1]);
              ctx.stroke();
            }
            continue;
          }
          if (instruction.offset) offsetLine(points, instruction.offset);
          if (!pattern) {
            ctx.beginPath();
            ctx.moveTo(points[0], points[1]);
            for (i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
            ctx.stroke();
            continue;
          }
          var along = 0;
          // `sh` is in source pixels; convert the requested CSS-pixel line
          // width back to source pixels before creating the pattern matrix.
          var stretch = lineWidth * image.pixelRatio / image.sh;
          for (i = 2; i < points.length; i += 2) {
            var x1 = points[i - 2];
            var y1 = points[i - 1];
            var dx = points[i] - x1;
            var dy = points[i + 1] - y1;
            var length = Math.sqrt(dx * dx + dy * dy);
            if (!length) continue;
            if (typeof pattern.setTransform === 'function' && typeof root.DOMMatrix === 'function') {
              var cos = dx / length;
              var sin = dy / length;
              // pattern px -> along the segment, centred across the line
              pattern.setTransform(new root.DOMMatrix([cos * stretch, sin * stretch, -sin * stretch, cos * stretch,
                x1 - cos * along + sin * lineWidth / 2, y1 - sin * along - cos * lineWidth / 2]));
            }
            ctx.strokeStyle = pattern;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(points[i], points[i + 1]);
            ctx.stroke();
            along += length;
          }
        }
      }
      ctx.restore();
    }

    // *-translate shifts the geometry by pixels; the anchor is approximated
    // as the map plane.
    function drawGroup(ctx, group, layer, origin, metrics, isolate) {
      var instruction = groupInstruction(group, layer, zoomOf(layer, metrics));
      if (instruction.translate) {
        ctx.save();
        ctx.translate(instruction.translate[0], instruction.translate[1]);
        drawGroupAt(ctx, group, layer, origin, metrics, isolate);
        ctx.restore();
      } else drawGroupAt(ctx, group, layer, origin, metrics, isolate);
    }

    function drawGroupAt(ctx, group, layer, origin, metrics, isolate) {
      var scale = origin[2] / group.layer.extent;
      var tolerance = lodTolerance(lodFor(scale, metrics.zoom));
      var instruction = groupInstruction(group, layer, zoomOf(layer, metrics));
      var i;
      if (!instructionPainted(instruction)) return;
      if (instruction.pattern) {
        // MapLibre draws nothing for a missing pattern image.
        var image = resolveImage(instruction.pattern);
        if (!image) return;
        if (instruction.type === 'line') {
          drawSpecialLines(ctx, group, instruction, origin, scale, tolerance, image);
          return;
        }
        var pattern = fillPatternFor(ctx, image, origin, scale, metrics);
        if (!pattern) return;
        instruction = { type: 'fill', opacity: instruction.opacity, color: pattern, outlineColor: null, outlineWidth: 0 };
      } else if (instruction.type === 'line' && (instruction.offset || instruction.gap)) {
        drawSpecialLines(ctx, group, instruction, origin, scale, tolerance, null);
        return;
      }
      if (typeof root.Path2D === 'function') {
        var path = groupPath(group, instruction, scale, metrics.zoom);
        if (isolate) ctx.save();
        ctx.translate(origin[0], origin[1]);
        ctx.scale(scale, scale);
        paintInstruction(ctx, instruction, 1 / scale, path);
        if (isolate) ctx.restore();
        return;
      }
      // Without Path2D, emit the merged group path for this frame only.
      ctx.beginPath();
      for (i = 0; i < group.features.length; i++) {
        if (instruction.type === 'circle') emitCircles(ctx, group.features[i], origin[0], origin[1], scale, instruction.radius);
        else emitPath(ctx, group.features[i], origin[0], origin[1], scale, instruction.type === 'fill', tolerance);
      }
      paintInstruction(ctx, instruction, 1);
    }

    function clipTile(ctx, origin) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(origin[0] - 3, origin[1] - 3, origin[2] + 6, origin[2] + 6);
      ctx.clip();
    }

    function symbolOrder() {
      if (!style.symbolOrder) {
        var order = [];
        for (var i = 0; i < style.length; i++) if (style[i].type === 'symbol') order.push(i);
        style.symbolOrder = order.sort(function (a, b) { return style[b].priority - style[a].priority || a - b; });
      }
      return style.symbolOrder;
    }

    function layerVisible(layer, zoom) {
      return layer.visible && !layer.unpainted && styleZoomVisible(layer, zoom);
    }

    // Background layers cover the viewport before any tile is drawn.
    function renderBackground(ctx, metrics) {
      if (typeof style === 'function') return;
      for (var s = 0; s < style.length; s++) {
        if (style[s].type !== 'background' || !layerVisible(style[s], zoomOf(style[s], metrics))) continue;
        var instruction = layerInstruction(style[s], zoomOf(style[s], metrics), null);
        ctx.globalAlpha = instruction.opacity;
        ctx.fillStyle = instruction.color;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.globalAlpha = 1;
    }

    // Renders an extrusion image for the current camera into a canvas with
    // a margin; progressive when `budget` (ms per frame) is given.
    function extrusionJob(key, pieces, metrics, matrix, margin, canvasElement) {
      var rawMargin = margin / Math.max(0.05, metrics.pitchScale);
      var view = metrics.view;
      var cacheWidth = Math.ceil((width + 2 * margin) * dpr);
      var cacheHeight = Math.ceil((height + 2 * margin) * dpr);
      canvasElement = canvasElement || root.document.createElement('canvas');
      if (canvasElement.width !== cacheWidth || canvasElement.height !== cacheHeight) {
        canvasElement.width = cacheWidth;
        canvasElement.height = cacheHeight;
      }
      var target = canvasElement.getContext('2d');
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, cacheWidth, cacheHeight);
      target.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e + margin * dpr, matrix.f + margin * dpr);
      return {
        prepared: false, index: 0, deadline: 0, target: target, pieces: pieces, metrics: metrics,
        cull: { x0: view.x0 - rawMargin, y0: view.y0 - rawMargin, x1: view.x1 + rawMargin, y1: view.y1 + rawMargin },
        result: {
          canvas: canvasElement, key: key, margin: margin * dpr, pixelsPerWorld: metrics.pixelsPerWorld,
          centerX: metrics.centerX, centerY: metrics.centerY, bearing: metrics.bearing, pitch: metrics.pitch,
          // cache pixel -> raw point of the rendered frame
          inverse: typeof root.DOMMatrix === 'function' ? target.getTransform().inverse() : null
        }
      };
    }

    // Canvas 2D rasterises later, off the measured time, so a background
    // slice keeps its own draw-call time small (4 ms measured best).
    function runExtrusionJob(job, budget) {
      job.deadline = budget == null ? Infinity : now() + budget;
      return drawExtrusions(job.target, job.pieces, job.metrics, job.cull, true, job);
    }

    // cache pixel -> cached raw -> current raw -> current device pixel. Pan
    // and zoom are a uniform scale plus a shift of the raw plane.
    function extrusionTransform(cached, metrics, matrix) {
      var scale = metrics.pixelsPerWorld / cached.pixelsPerWorld;
      var shiftX = width / 2 * (1 - scale) + (cached.centerX - metrics.centerX) * metrics.pixelsPerWorld;
      var shiftY = height / 2 * (1 - scale) + (cached.centerY - metrics.centerY) * metrics.pixelsPerWorld;
      var DOMMatrixType = root.DOMMatrix;
      var transform = new DOMMatrixType([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])
        .multiply(new DOMMatrixType([scale, 0, 0, scale, shiftX, shiftY]))
        .multiply(cached.inverse);
      // The viewport's corners must lie inside the cached image.
      var back = transform.inverse();
      var nearEdge = false;
      var corners = [0, 0, width * dpr, 0, 0, height * dpr, width * dpr, height * dpr];
      for (var c = 0; c < 8; c += 2) {
        var x = back.a * corners[c] + back.c * corners[c + 1] + back.e;
        var y = back.b * corners[c] + back.d * corners[c + 1] + back.f;
        if (x < 0 || y < 0 || x > cached.canvas.width || y > cached.canvas.height) return null;
        if (x < 32 * dpr || y < 32 * dpr || x > cached.canvas.width - 32 * dpr || y > cached.canvas.height - 32 * dpr) nearEdge = true;
      }
      return { transform: transform, nearEdge: nearEdge };
    }

    // The displayed image and a pending replacement obey the same camera
    // tolerances. Check jobs before spending any more time rasterising them.
    function extrusionView(cached, key, metrics, matrix) {
      if (!cached || cached.key !== key || !cached.inverse || typeof root.DOMMatrix !== 'function') return null;
      var turn = Math.abs(((metrics.bearing - cached.bearing) % 360 + 540) % 360 - 180);
      var tilt = Math.abs(metrics.pitch - cached.pitch);
      var scale = metrics.pixelsPerWorld / cached.pixelsPerWorld;
      if (turn > 10 || tilt > 8 || scale <= 0.5 || scale >= 2) return null;
      var view = extrusionTransform(cached, metrics, matrix);
      if (view) view.exact = turn < 1e-9 && tilt < 1e-9 && Math.abs(scale - 1) < 1e-9;
      return view;
    }

    // Extrusion layers render into a cached image with a margin. The camera
    // is orthographic, so a pan or zoom only moves and scales that image
    // (heights scale with the map), and a turn or tilt of a few degrees is
    // close. Whenever the shown image is not exact, a new one renders in
    // the background, a few ms per frame, and replaces it when complete.
    function drawExtrusionLayer(ctx, layer, tiles, metrics) {
      // Stable bucket identities include tile, style, GeoJSON and feature-state
      // revisions. Unrelated tile loads/evictions cannot invalidate this image.
      var dependencies = [layer.uid, layer.version, styleVersion, width, height, dpr];
      if (layer.zoomDependent) dependencies.push(zoomOf(layer, metrics));
      var batches = [];
      for (var t = 0; t < tiles.length; t++) {
        var item = tiles[t];
        var groups = bucketFor(item.entry, layer);
        if (!groups.length) continue;
        dependencies.push(groups.serial, item.tileX, item.tileY);
        for (var e = 0; e < groups.length; e++) {
          var instruction = groupInstruction(groups[e], layer, zoomOf(layer, metrics));
          if (instruction.opacity > 0 && groups[e].features.length) batches.push({ group: groups[e], origin: item.origin, instruction: instruction });
        }
      }
      if (!batches.length) return;
      function piecesForFrame() {
        var pieces = [];
        for (var b = 0; b < batches.length; b++) {
          var batch = batches[b];
          var group = batch.group;
          for (var f = 0; f < group.features.length; f++) pieces.push({
            prism: extrusionPrism(group.features[f]), x: batch.origin[0], y: batch.origin[1],
            scale: batch.origin[2] / group.layer.extent, instruction: batch.instruction
          });
        }
        return pieces;
      }
      var matrix = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
      if (!matrix || !isFinite(matrix.a)) {
        drawExtrusions(ctx, piecesForFrame(), metrics);
        return;
      }
      var opacity = batches[0].instruction.opacity;
      var key = dependencies.join('|');
      var state = extrusionCaches.get(layer.uid) || {};
      extrusionCaches.set(layer.uid, state);
      var progressive = typeof root.DOMMatrix === 'function';
      var cached = state.cached && state.cached.key === key ? state.cached : null;
      var job = state.job;
      var jobView = job && extrusionView(job.result, key, metrics, matrix);
      if (job && !jobView) {
        state.spare = job.result.canvas;
        state.job = job = null;
      }
      if (job && extrusionBudget > 0) {
        var started = now();
        var completed = runExtrusionJob(job, extrusionBudget);
        extrusionBudget = Math.max(0, extrusionBudget - (now() - started));
        if (completed) {
          state.spare = state.cached ? state.cached.canvas : state.spare;
          state.cached = cached = job.result;
          state.job = job = null;
        }
      }
      var view = extrusionView(cached, key, metrics, matrix);
      var transform = view && view.transform;
      if (!transform) {
        // Nothing usable to show: render now, completely.
        state.job = job = null;
        var fresh = extrusionJob(key, piecesForFrame(), metrics, matrix, progressive ? 96 : 0, state.cached ? state.cached.canvas : null);
        runExtrusionJob(fresh);
        state.cached = cached = fresh.result;
        transform = null;
      } else if ((!view.exact || view.nearEdge) && !job) {
        state.job = extrusionJob(key, piecesForFrame(), metrics, matrix, 96, state.spare);
        state.spare = null;
      }
      if (state.job) schedule();
      ctx.save();
      if (transform) ctx.setTransform(transform);
      else ctx.setTransform(1, 0, 0, 1, -cached.margin, -cached.margin);
      ctx.globalAlpha = opacity;
      ctx.drawImage(cached.canvas, 0, 0);
      ctx.restore();
    }

    // Function styles own their draw order, so their geometry can remain
    // tile-major and is evaluated per frame (a callback may depend on zoom).
    // Declarative styles must instead be layer-major across all tiles: at a
    // tile edge, a neighbouring land fill or road casing must never paint
    // over an already-drawn road core in the buffer overlap.
    function renderGeometry(ctx, tiles, metrics, last) {
      var t;
      var item;
      if (typeof style === 'function') {
        for (t = 0; t < tiles.length; t++) {
          item = tiles[t];
          clipTile(ctx, item.origin);
          var layers = item.entry.data.layers;
          for (var l = 0; l < layers.length; l++) paintFunctionLayer(ctx, layers[l], item.origin, metrics);
          ctx.restore();
        }
        return;
      }
      for (var s = 0; s < style.length; s++) {
        var layer = style[s];
        if (layer.type === 'symbol' || layer.type === 'background' || !layerVisible(layer, zoomOf(layer, metrics))) continue;
        // Raster tiles cover the viewport independently of vector tiles,
        // so they are drawn once, in the final (target zoom) pass.
        if (rasterLayer(layer.type)) {
          if (last) drawRaster(ctx, layer, metrics);
          continue;
        }
        // Buildings are depth-sorted across all tiles and drawn unclipped,
        // since a roof rises above its tile. Only the final zoom has them.
        if (layer.type === 'fill-extrusion') {
          if (last) drawExtrusionLayer(ctx, layer, tiles, metrics);
          continue;
        }
        if (layer.type === 'heatmap') {
          if (last) drawHeatmap(ctx, layer, tiles, metrics);
          continue;
        }
        for (t = 0; t < tiles.length; t++) {
          item = tiles[t];
          var bucket = bucketFor(item.entry, layer);
          if (!bucket.length) continue;
          clipTile(ctx, item.origin);
          for (var g = 0; g < bucket.length; g++) drawGroup(ctx, bucket[g], layer, item.origin, metrics, bucket.length > 1);
          ctx.restore();
        }
      }
    }

    function paintFunctionLayer(ctx, layer, origin, metrics) {
      var scale = origin[2] / layer.extent;
      var tolerance = lodTolerance(lodFor(scale, metrics.zoom));
      for (var f = 0; f < layer.features.length; f++) {
        var feature = layer.features[f];
        var instructions = callbackInstructions(style(layer.name, feature, metrics.zoom), feature, metrics.zoom);
        for (var i = 0; i < instructions.length; i++) {
          var instruction = instructions[i];
          if (instruction.type === 'fill-extrusion') drawExtrusions(ctx, [{ prism: extrusionPrism(feature), x: origin[0], y: origin[1], scale: scale, instruction: instruction }], metrics);
          else if (instruction.type !== 'symbol') drawFeature(ctx, feature, instruction, origin[0], origin[1], scale, tolerance);
        }
      }
    }

    // Symbols are collected only from currently visible target tiles, after
    // all geometry has painted. Candidates are culled to the (raw) viewport
    // before the label cap, so off-screen text cannot crowd out visible text.
    function collectLabels(tiles, metrics, labels) {
      var view = metrics.view;
      var margin = 256;
      var t;
      var item;
      var scale;
      if (typeof style === 'function') {
        for (t = 0; t < tiles.length; t++) {
          item = tiles[t];
          for (var l = 0; l < item.entry.data.layers.length; l++) {
            var source = item.entry.data.layers[l];
            scale = item.origin[2] / source.extent;
            for (var f = 0; f < source.features.length; f++) {
              var instructions = callbackInstructions(style(source.name, source.features[f], metrics.zoom), source.features[f], metrics.zoom);
              for (var i = 0; i < instructions.length; i++) {
                if (instructions[i].type === 'symbol') collectSymbol(labels, source.features[f], instructions[i], item.origin[0], item.origin[1], scale);
              }
            }
          }
        }
        return;
      }
      // Collect in placement order (highest priority first), so the label
      // cap drops the least important layers rather than the last ones.
      var order = symbolOrder();
      for (var o = 0; o < order.length && labels.length < MAX_LABELS; o++) {
        var s = order[o];
        var layer = style[s];
        if (!layerVisible(layer, zoomOf(layer, metrics))) continue;
        for (t = 0; t < tiles.length; t++) {
          item = tiles[t];
          var bucket = bucketFor(item.entry, layer);
          for (var g = 0; g < bucket.length; g++) {
            var group = bucket[g];
            var textStyle = groupInstruction(group, layer, zoomOf(layer, metrics));
            if (!(textStyle.opacity > 0) && !(textStyle.icon && textStyle.icon.opacity > 0)) continue;
            scale = item.origin[2] / group.layer.extent;
            var line = textStyle.placement === 'line';
            for (var c = 0; c < group.labels.length; c++) {
              var candidate = group.labels[c];
              var x = item.origin[0] + candidate.x * scale;
              var y = item.origin[1] + candidate.y * scale;
              if (x < view.x0 - margin || x > view.x1 + margin || y < view.y0 - margin || y > view.y1 + margin) continue;
              if (item.clip && !insideRects(item.clip, x, y)) continue;
              // Like MapLibre, a line label needs a line at least as long as its text.
              if (line && candidate.text && candidate.length * scale < measuredText(context, candidate.text, textStyle.measureFont).width * textStyle.size / 100) continue;
              var before = labels.length;
              pushLabel(labels, textStyle, candidate.text, x, y, textStyle.placement === 'line' ? candidate.angle : 0, candidate, candidate.sortKey);
              if (line && candidate.line && labels.length > before) labels[before].frame = [item.origin[0], item.origin[1], scale];
            }
          }
        }
      }
    }

    function insideRects(rects, x, y) {
      for (var r = 0; r < rects.length; r++) {
        var rect = rects[r];
        if (x >= rect.x && y >= rect.y && x < rect.x + rect.size && y < rect.y + rect.size) return true;
      }
      return false;
    }

    // Resolve a level's tile plans to cached entries and screen origins once
    // per frame, instead of once per style layer.
    function resolvePlans(plans, metrics) {
      var view = metrics.view;
      var result = [];
      for (var p = 0; p < plans.length; p++) {
        var entry = cache[sourceKey(plans[p].sourceId, plans[p].z, plans[p].x, plans[p].y)];
        if (!entry) continue;
        entry.used = ++useCounter;
        var origin = tileOrigin(plans[p], metrics);
        if (origin[0] > view.x1 || origin[1] > view.y1 || origin[0] + origin[2] < view.x0 || origin[1] + origin[2] < view.y0) continue;
        result.push({ entry: entry, origin: origin, tileX: plans[p].x, tileY: plans[p].y });
      }
      return result;
    }

    function render(metrics, currentZoom) {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      renderBackground(context, metrics);
      var levels = [];
      function retain(plans) {
        for (var retainIndex = 0; retainIndex < plans.length; retainIndex++) {
          needed[canonicalKey(plans[retainIndex].z, plans[retainIndex].x, plans[retainIndex].y)] = true;
        }
      }
      var currentPlans = currentZoom == null ? [] : visibleTiles(currentZoom, 0, metrics);
      var currentComplete = currentZoom != null && currentPlans.length > 0;
      for (var current = 0; current < currentPlans.length; current++) {
        if (!cache[canonicalKey(currentZoom, currentPlans[current].x, currentPlans[current].y)]) {
          currentComplete = false;
          break;
        }
      }
      // Draw lower zooms first, then a nearby cached higher zoom when a
      // zoom-out target is incomplete, and finally the target itself. The
      // target therefore always wins where it is present, while either side
      // of a zoom change can still cover a slow or failed request. The higher
      // fallback is capped below so a rapid overview jump does not redraw a
      // much denser old tile. Once the target is already complete, those lower
      // zooms would only end up fully painted over -- skip scanning and
      // drawing them, since that (not a pending zoom transition) is the steady
      // state for most of a pan/zoom session and cachedPlansAtZoom scans the
      // whole tile cache.
      var z;
      var plans;
      if (currentZoom != null && !currentComplete) for (z = minZoom; z < currentZoom; z++) {
        plans = cachedPlansAtZoom(z, metrics);
        if (!plans.length) continue;
        retain(plans);
        levels.push(plans);
        // A session that gradually zoomed in through many levels caches a
        // tile at each of them. Once one of those coarser zooms already
        // covers the whole viewport with no gaps, any zoom drawn under the
        // target from here up would only add detail beneath a layer nobody
        // sees through -- stop instead of repainting every visited zoom on
        // every frame of a zoom-out transition (cachedPlansAtZoom scans the
        // whole tile cache per level).
        var levelRange = tileRange(z, 0, metrics);
        if (plans.length >= (levelRange.maxX - levelRange.minX + 1) * (levelRange.maxY - levelRange.minY + 1)) break;
      }
      if (!currentComplete) {
        // Below a source's minzoom there is no target tile to request. Use
        // the camera level as the fallback reference there too, so an old
        // detailed tile cannot defeat the same zoom-out detail cap.
        var fallbackReference = currentZoom == null ? tileZoomValue(metrics) : currentZoom;
        var firstFallback = currentZoom == null ? minZoom : currentZoom + 1;
        var finalFallback = Math.min(maxZoom, fallbackReference + maxFallbackZoomDelta);
        for (z = firstFallback; z <= finalFallback; z++) {
          plans = cachedPlansAtZoom(z, metrics);
          if (plans.length) {
            retain(plans);
            levels.push(plans);
            break;
          }
        }
      }
      var finalPlans = currentPlans.slice();
      for (var vectorID in extraVectors) {
        var vector = extraVectors[vectorID];
        if (!vector.tiles || !sourceHasVisibleLayer(vectorID, metrics)) continue;
        var vectorZoom = sourceTileZoom(vector, metrics);
        if (vectorZoom == null) continue;
        var vectorPlans = visibleTiles(vectorZoom, 0, metrics);
        for (var vp = 0; vp < vectorPlans.length; vp++) {
          finalPlans.push({ sourceId: vectorID, z: vectorPlans[vp].z, x: vectorPlans[vp].x, y: vectorPlans[vp].y });
        }
      }
      if (finalPlans.length) levels.push(finalPlans);
      context.save();
      context.translate(width / 2, height / 2);
      context.scale(1, metrics.pitchScale);
      context.rotate(metrics.bearing * Math.PI / 180);
      context.translate(-width / 2, -height / 2);
      var visible = null;
      for (var level = 0; level < levels.length; level++) {
        visible = resolvePlans(levels[level], metrics);
        renderGeometry(context, visible, metrics, level === levels.length - 1);
      }
      if (!levels.length) renderGeometry(context, [], metrics, true);
      context.restore();
      // Cached fallback geometry is useful while a target zoom arrives, but
      // fallback labels would double every place name.
      if (finalPlans.length && visible) {
        var labels = [];
        collectLabels(visible, metrics, labels);
        projectLabels(labels, metrics);
        drawLabels(context, labels, width, height, resolveImage);
      }
      rendered = { metrics: metrics, levels: levels };
    }

    // ---- Tilted view ---------------------------------------------------------
    // With pitch the ground is no longer an affine image of the map plane.
    // Each cell of the core camera's level-of-detail cover is painted once
    // into its own canvas -- by the flat renderer's own code, in raw map
    // pixels -- and the browser compositor applies the camera's CSS
    // perspective to the panes holding them, as the core does for raster
    // tiles. The overlay canvas carries only what faces the viewer: 3D
    // buildings and labels. Cells are repainted when better data arrives or
    // the zoom has drifted, within a per-frame time budget.
    var tiltHost = null;
    var tiltPanes = Object.create(null);
    var tiltCells = new Map();
    var tiltSequence = '';
    var tiltComplete = false;
    // Screen-space heatmaps split the cached ground into ordered bands.
    // Otherwise every heatmap would cover roads/fills that follow it.
    var tiltBands = [];
    var tiltStyleVersion = 0;
    // Only one unpublished cell is retained. Its ground layers can span
    // frames without exposing a half-painted texture or multiplying memory
    // by the number of visible cells.
    var tiltJob = null;
    var TILT_BLEED = 1;
    var TILT_MAX_CELLS = 96;
    var TILT_BUDGET_MS = 12;
    var TILT_MAX_PIXELS = 2048;

    function setTiltStyle(element, css) {
      if (element._tiltCss !== css) element.style.cssText = element._tiltCss = css;
    }

    function tiltZoomRef(metrics) {
      return tileZoomMode() === 'floor' ? metrics.styleZoom : metrics.zoom;
    }

    function tiltPane(z, metrics) {
      var pane = tiltPanes[z];
      if (!pane) {
        pane = root.document.createElement('div');
        pane.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform';
        var count = Math.pow(2, z);
        pane._origin = [Math.floor(metrics.centerX * count), Math.floor(metrics.centerY * count)];
        tiltHost.appendChild(pane);
        tiltPanes[z] = pane;
      }
      return pane;
    }

    // Keep layout coordinates small (see the core's rebasePane()).
    function placeTiltPane(z, metrics, cellSize, zoomRef) {
      var pane = tiltPanes[z];
      var count = Math.pow(2, z);
      var ox = Math.floor(metrics.centerX * count);
      var oy = Math.floor(metrics.centerY * count);
      if (Math.abs(ox - pane._origin[0]) >= 64 || Math.abs(oy - pane._origin[1]) >= 64) {
        pane._origin = [ox, oy];
        tiltCells.forEach(function (cell) { if (cell.z === z) positionCell(cell); });
      }
      var scale = Math.pow(2, zoomRef - z);
      var pixelX = (metrics.centerX * count - pane._origin[0]) * cellSize;
      var pixelY = (metrics.centerY * count - pane._origin[1]) * cellSize;
      var transform = 'translate(' + (width / 2 - pixelX * scale) + 'px,' + (height / 2 - pixelY * scale) + 'px) scale(' + scale + ')';
      if (pane._transform !== transform) pane.style.transform = pane._transform = transform;
    }

    function positionCell(cell) {
      var pane = tiltPanes[cell.z];
      var size = cell.cssSize;
      cell.canvas.style.cssText = 'position:absolute;left:' + ((cell.x - pane._origin[0]) * size - TILT_BLEED) + 'px;top:' +
        ((cell.y - pane._origin[1]) * size - TILT_BLEED) + 'px;width:' + (size + 2 * TILT_BLEED) + 'px;height:' + (size + 2 * TILT_BLEED) + 'px';
      if (cell.bands) for (var b = 0; b < cell.bands.length; b++) {
        cell.bands[b].style.cssText = cell.canvas.style.cssText;
        cell.bands[b].style.clipPath = 'inset(' + TILT_BLEED + 'px)';
      }
    }

    function releaseCell(cell) {
      if (tiltJob && tiltJob.cell === cell) discardCellJob();
      if (cell.canvas.parentNode) cell.canvas.parentNode.removeChild(cell.canvas);
      cell.canvas.width = cell.canvas.height = 0;
      if (cell.bands) for (var b = 0; b < cell.bands.length; b++) {
        var band = cell.bands[b];
        if (band.parentNode) band.parentNode.removeChild(band);
        band.width = band.height = 0;
      }
      tiltCells.delete(cell.key);
    }

    function clearTiltBands() {
      for (var b = 0; b < tiltBands.length; b++) {
        var band = tiltBands[b];
        if (band.host.parentNode) band.host.parentNode.removeChild(band.host);
        if (band.heat.parentNode) band.heat.parentNode.removeChild(band.heat);
        band.heat.width = band.heat.height = 0;
      }
      tiltBands = [];
    }

    function prepareTiltBands(metrics) {
      var layers = [];
      var lastGround = -1;
      if (typeof style !== 'function') {
        for (var s = style.length - 1; s >= 0; s--) {
          var layer = style[s];
          if (!layerVisible(layer, zoomOf(layer, metrics))) continue;
          if (layer.type === 'heatmap') {
            if (lastGround > s) layers.unshift(layer);
          } else if (layer.type !== 'symbol' && layer.type !== 'fill-extrusion' && lastGround < 0) lastGround = s;
        }
      }
      if (layers.length === tiltBands.length && layers.every(function (layer, i) { return tiltBands[i].layer.uid === layer.uid; })) {
        for (var i = 0; i < layers.length; i++) tiltBands[i].layer = layers[i];
        return;
      }
      tiltCells.forEach(releaseCell);
      clearTiltBands();
      for (var b = 0; b < layers.length; b++) {
        var host = root.document.createElement('div');
        var heat = root.document.createElement('canvas');
        host.setAttribute('aria-hidden', 'true');
        heat.setAttribute('aria-hidden', 'true');
        heat.setAttribute('data-heatmap-layer', layers[b].id);
        var before = glCanvas && glCanvas.parentNode === container ? glCanvas : canvas;
        container.insertBefore(heat, before);
        container.insertBefore(host, before);
        tiltBands.push({ layer: layers[b], host: host, heat: heat, panes: Object.create(null) });
      }
    }

    function hideTilt() {
      if (!tiltHost) return;
      tiltCells.forEach(releaseCell);
      clearTiltBands();
      for (var z in tiltPanes) if (tiltPanes[z].parentNode) tiltPanes[z].parentNode.removeChild(tiltPanes[z]);
      tiltPanes = Object.create(null);
      tiltSequence = '';
      tiltHost.style.display = 'none';
      tiltHost._tiltCss = null;
    }

    // The data tile drawn for a cell: the cell's own tile within the source
    // range, an ancestor when overzoomed, or (while that one loads) the
    // nearest cached ancestor. Requests the wanted tile as a side effect.
    function cellData(sourceId, cell, metrics, sourceMin, sourceMax) {
      if (cell.z < sourceMin) return null;
      var z = Math.min(cell.z, sourceMax);
      var shift = cell.z - z;
      var x = Math.floor(cell.x / Math.pow(2, shift));
      var y = Math.floor(cell.y / Math.pow(2, shift));
      requestTile({ z: z, x: x, y: y }, metrics, false, null, sourceId);
      for (var up = 0; up <= 4 && z - up >= sourceMin; up++) {
        var factor = Math.pow(2, up);
        var tx = Math.floor(x / factor);
        var ty = Math.floor(y / factor);
        var entry = cache[sourceKey(sourceId, z - up, tx, ty)];
        if (entry) {
          entry.used = ++useCounter;
          return { entry: entry, sourceId: sourceId, z: z - up, x: tx, y: ty, exact: up === 0 };
        }
      }
      return null;
    }

    function cellSources(cell, metrics) {
      var result = Object.create(null);
      result[primarySourceID == null ? '' : primarySourceID] = cellData(primarySourceID, cell, metrics, minZoom, maxZoom);
      if (typeof style !== 'function') {
        for (var id in extraVectors) {
          var vector = extraVectors[id];
          if (vector.tiles && sourceHasVisibleLayer(id, metrics)) result[id] = cellData(id, cell, metrics, vector.minZoom, vector.maxZoom);
        }
      }
      return result;
    }

    function dataFor(sources, layer) {
      var id = layer.geojson || layer.source == null ? primarySourceID : layer.source;
      return sources[id == null ? '' : id] || null;
    }

    function cellSignature(cell, sources, groundSources, metrics, groundState) {
      var signature = styleVersion + '|' + tiltStyleVersion + '|' + groundState + '|' + imageVersion;
      for (var id in sources) signature += '|' + (sources[id] ? sources[id].entry.key + ':' + sources[id].entry.serial : '-');
      // Screen-space heatmaps, labels and buildings consume their own
      // source versions. Updating them must not invalidate cached roads
      // and land in every ground cell.
      for (id in groundSources) {
        var source = geojsonSources[id];
        signature += '|' + id + ':' + source.version + (source.clusters ? ':' + geojsonClusterZoom(source, metrics) : '');
      }
      return signature;
    }

    // Raw-pixel rectangle of a cell (absolute: the map centre is at the
    // middle of the viewport), including its bleed.
    function cellRect(cell, metrics) {
      var origin = tileOrigin(cell, metrics);
      var bleed = TILT_BLEED * origin[2] / cell.cssSize;
      return { x: origin[0] - bleed, y: origin[1] - bleed, size: origin[2] + 2 * bleed, raw: origin[2] };
    }

    function discardCellJob() {
      if (!tiltJob) return;
      for (var c = 0; c < tiltJob.canvases.length; c++) tiltJob.canvases[c].width = tiltJob.canvases[c].height = 0;
      tiltJob = null;
    }

    function cellJobMatches(job, metrics) {
      return job.signature === job.cell.wantSignature && job.pixels === job.cell.wantPixels &&
        job.zoom === metrics.zoom && job.styleZoom === metrics.styleZoom && job.width === width && job.height === height && job.dpr === dpr;
    }

    function beginCellJob(cell, metrics) {
      var rect = cellRect(cell, metrics);
      var pixels = cell.wantPixels;
      var unit = pixels / rect.size;
      var canvases = [];
      var contexts = [];
      for (var b = 0; b <= tiltBands.length; b++) {
        var element = root.document.createElement('canvas');
        element.width = element.height = pixels;
        var ctx = element.getContext('2d');
        ctx.setTransform(unit, 0, 0, unit, -rect.x * unit, -rect.y * unit);
        canvases.push(element);
        contexts.push(ctx);
      }
      tiltJob = { cell: cell, metrics: metrics, sources: cell.sources, rect: rect, pixels: pixels,
        signature: cell.wantSignature, zoom: metrics.zoom, styleZoom: metrics.styleZoom,
        width: width, height: height, dpr: dpr,
        rasterBefore: rasterVersion, incomplete: false, canvases: canvases, contexts: contexts,
        layer: 0, band: 0, bucket: null, group: 0, origin: null };
    }

    function finishCellJob(job) {
      var cell = job.cell;
      var previous = [cell.canvas].concat(cell.bands || []);
      for (var c = 0; c < previous.length; c++) {
        var parent = previous[c].parentNode;
        if (parent) {
          if (parent.insertBefore) parent.insertBefore(job.canvases[c], previous[c]);
          else parent.appendChild(job.canvases[c]);
          parent.removeChild(previous[c]);
        }
        previous[c].width = previous[c].height = 0;
      }
      cell.canvas = job.canvases[0];
      cell.ctx = job.contexts[0];
      cell.bands = job.canvases.slice(1);
      positionCell(cell);
      cell.painted = true;
      cell.pixels = job.pixels;
      cell.paintZoom = job.zoom;
      cell.signature = job.signature;
      cell.incomplete = job.incomplete;
      cell.rasterSeen = job.rasterBefore;
      tiltJob = null;
      // A raster layer may have deferred shading several frames before
      // this job's last road group. Its original scheduled draw has then
      // already run; explicitly revisit that incomplete published cell.
      if (cell.incomplete && cell.rasterSeen !== rasterVersion) schedule();
    }

    // A group (or one raster layer) is the smallest atomic paint operation.
    // In particular, a dense cell must not draw all following roads once
    // a DEM paint has already consumed this frame's cooperative budget.
    function runCellJob(job, deadline) {
      var progressed = false;
      var metrics = job.metrics;
      while (true) {
        if (progressed && now() >= deadline) return false;
        var ctx = job.contexts[job.band];
        if (typeof style === 'function') {
          var own = job.sources[primarySourceID == null ? '' : primarySourceID];
          if (!own || job.layer >= own.entry.data.layers.length) break;
          paintFunctionLayer(ctx, own.entry.data.layers[job.layer++], tileOrigin(own, metrics), metrics);
          progressed = true;
          continue;
        }
        if (job.layer >= style.length) break;
        var layer = style[job.layer];
        if (job.bucket) {
          if (job.group < job.bucket.length) {
            drawGroup(ctx, job.bucket[job.group++], layer, job.origin, metrics, true);
            progressed = true;
            continue;
          }
          job.bucket = null;
          job.layer++;
          continue;
        }
        var zoom = zoomOf(layer, metrics);
        if (job.band < tiltBands.length && layer === tiltBands[job.band].layer) ctx = job.contexts[++job.band];
        if (layer.type === 'symbol' || layer.type === 'fill-extrusion' || layer.type === 'heatmap' || !layerVisible(layer, zoom)) { job.layer++; continue; }
        if (layer.type === 'background') {
          var instruction = layerInstruction(layer, zoom, null);
          ctx.globalAlpha = instruction.opacity;
          ctx.fillStyle = instruction.color;
          ctx.fillRect(job.rect.x, job.rect.y, job.rect.size, job.rect.size);
          ctx.globalAlpha = 1;
        } else if (rasterLayer(layer.type)) {
          rasterMissing = false;
          drawRaster(ctx, layer, metrics, job.cell);
          job.incomplete = job.incomplete || rasterMissing;
        } else {
          var data = dataFor(job.sources, layer);
          if (data) {
            job.bucket = bucketFor(data.entry, layer);
            job.group = 0;
            job.origin = tileOrigin(data, metrics);
            progressed = true;
            continue;
          }
        }
        job.layer++;
        progressed = true;
      }
      finishCellJob(job);
      return true;
    }

    // Largest on-screen scale of a cell: its texture resolution.
    function cellScreenSize(cell, metrics, camera) {
      var origin = tileOrigin(cell, metrics);
      var best = 0;
      for (var c = 0; c < 4; c++) {
        var point = camera.project(origin[0] + (c & 1) * origin[2] - width / 2, origin[1] + (c >> 1) * origin[2] - height / 2);
        best = Math.max(best, point[2]);
      }
      return origin[2] * best;
    }

    function drawTilted(metrics) {
      var camera = metrics.camera;
      // Cached ground textures contain the hillshade. Viewport-anchored
      // light changes with bearing even when the cell and zoom do not.
      var lighting = 0;
      var opaqueGround = false;
      var groundSources = Object.create(null);
      var groundState = typeof style === 'function' ? featureStateVersion : '';
      if (typeof style !== 'function') {
        for (var s = 0; s < style.length; s++) {
          var layer = style[s];
          var zoom = zoomOf(layer, metrics);
          if ((layer.geojson || layer.stateDependent) && layer.type !== 'heatmap' && layer.type !== 'symbol' && layer.type !== 'fill-extrusion' &&
            layerVisible(layer, zoom) && layerMayPaintGround(layer, zoom)) {
            if (layer.stateDependent) groundState += '|' + layer.uid + ':' + layerStateVersion(layer);
            if (layer.geojson) groundSources[layer.geojson] = true;
          }
          if (layer.type === 'background' && layerVisible(layer, zoom)) {
            var background = layerInstruction(layer, zoom, null);
            var color = parseColor(background.color);
            if (background.opacity === 1 && color && color[3] === 1) opaqueGround = true;
          }
          if (layer.type === 'hillshade' && layerVisible(layer, zoom) && layerInstruction(layer, zoom, null).anchor !== 'map') {
            lighting = metrics.bearing;
          }
        }
      }
      if (!tiltHost) {
        tiltHost = root.document.createElement('div');
        tiltHost.setAttribute('aria-hidden', 'true');
        container.insertBefore ? container.insertBefore(tiltHost, canvas) : container.appendChild(tiltHost);
      }
      setTiltStyle(tiltHost, 'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;pointer-events:none;z-index:' +
        clamp(Math.floor(finite(options.zIndex, 1)), -100, 100) + ';transform:' + camera.cssTransform());
      prepareTiltBands(metrics);
      for (var b = 0; b < tiltBands.length; b++) setTiltStyle(tiltBands[b].host, tiltHost.style.cssText);
      var zoomRef = tiltZoomRef(metrics);
      var cellSize = metrics.pixelsPerWorld / Math.pow(2, zoomRef);
      var cover = camera.cover({
        tileSize: cellSize, zoom: zoomRef, centerX: metrics.centerX, centerY: metrics.centerY,
        minZoom: 0, maxZoom: 24, buffer: tileBuffer ? 0.5 : 0, maxTiles: TILT_MAX_CELLS,
        lodBias: tileZoomMode() === 'floor' ? 0.5 : 0, underlay: false
      });
      needed = Object.create(null);
      var wanted = Object.create(null);
      var cells = [];
      var pixelRatio = Math.min(dpr, 2);
      var c;
      for (c = 0; c < cover.length; c++) {
        var tile = cover[c];
        var key = tile.z + '/' + tile.x + '/' + tile.y;
        wanted[key] = true;
        var cell = tiltCells.get(key);
        if (!cell) {
          var element = root.document.createElement('canvas');
          cell = { key: key, z: tile.z, x: tile.x, y: tile.y, canvas: element, ctx: element.getContext('2d'), cssSize: cellSize, painted: false, pixels: 0 };
          tiltCells.set(key, cell);
          tiltPane(tile.z, metrics);
          positionCell(cell);
        } else if (cell.cssSize !== cellSize) {
          cell.cssSize = cellSize;
          positionCell(cell);
        }
        if (cell.canvas.parentNode !== tiltPanes[cell.z]) tiltPane(cell.z, metrics).appendChild(cell.canvas);
        cell.bands = cell.bands || [];
        for (var b = 0; b < tiltBands.length; b++) {
          var band = tiltBands[b];
          var pane = band.panes[cell.z];
          if (!pane) {
            pane = band.panes[cell.z] = root.document.createElement('div');
            band.host.appendChild(pane);
          }
          if (!cell.bands[b]) {
            var bandCanvas = cell.bands[b] = root.document.createElement('canvas');
            bandCanvas.style.cssText = cell.canvas.style.cssText;
            bandCanvas.style.clipPath = 'inset(' + TILT_BLEED + 'px)';
            pane.appendChild(bandCanvas);
          }
        }
        cell.sources = cellSources(cell, metrics);
        for (var used in cell.sources) if (cell.sources[used]) needed[cell.sources[used].entry.key] = true;
        cell.wantSignature = cellSignature(cell, cell.sources, groundSources, metrics, groundState) + '|' + lighting;
        var screenSize = cellScreenSize(cell, metrics, camera) * (1 + 2 * TILT_BLEED / cellSize);
        cell.wantPixels = clamp(Math.ceil(screenSize * pixelRatio / 32) * 32, 32, TILT_MAX_PIXELS);
        cell.distance = Math.abs(tile.x + 0.5 - metrics.centerX * Math.pow(2, tile.z)) + Math.abs(tile.y + 0.5 - metrics.centerY * Math.pow(2, tile.z));
        cells.push(cell);
      }
      drain();
      if (tiltJob && (!wanted[tiltJob.cell.key] || !cellJobMatches(tiltJob, metrics))) discardCellJob();
      // Repaint order: never painted first, then stale data, then blur, then
      // a drifted zoom; nearer cells first within each class.
      var work = [];
      var complete = true;
      for (c = 0; c < cells.length; c++) {
        cell = cells[c];
        var urgency = !cell.painted ? 0 : cell.signature !== cell.wantSignature ? 1 :
          cell.incomplete && cell.rasterSeen !== rasterVersion ? 2 :
          cell.wantPixels > cell.pixels * 1.3 ? 3 : Math.abs(cell.paintZoom - metrics.zoom) > 0.2 && !zooming ? 4 : -1;
        var hasData = false;
        for (var id in cell.sources) if (cell.sources[id]) hasData = true;
        if (!hasData && typeof style === 'function') urgency = -1;
        for (id in cell.sources) if (cell.sources[id] && !cell.sources[id].exact) complete = false;
        if (tiltJob && tiltJob.cell === cell) urgency = -2;
        if (urgency >= 0 || urgency === -2) work.push({ cell: cell, urgency: urgency });
      }
      work.sort(function (a, b) { return a.urgency - b.urgency || a.cell.distance - b.cell.distance; });
      var deadline = frameStart + TILT_BUDGET_MS;
      var worked = false;
      for (var w = 0; w < work.length; w++) {
        if (w && now() >= deadline) break;
        var cellStarted = now();
        if (!tiltJob) beginCellJob(work[w].cell, metrics);
        worked = true;
        var finished = runCellJob(tiltJob, deadline);
        maxCellDuration = Math.max(maxCellDuration, now() - cellStarted);
        if (!finished) break;
      }
      if (tiltJob || w < work.length) {
        complete = false;
        schedule();
      }
      if (worked) trimRasterTiles(Object.create(null));
      // Opaque cells of an earlier cover stay below the new ones until
      // every new cell has been painted once. Translucent cells cannot be
      // stacked this way without applying their opacity twice.
      var allPainted = true;
      for (c = 0; c < cells.length; c++) if (!cells[c].painted) { allPainted = false; break; }
      var stale = [];
      tiltCells.forEach(function (old) {
        if (wanted[old.key]) return;
        if (!opaqueGround || tiltBands.length || allPainted || !old.painted) releaseCell(old);
        else stale.push(old);
      });
      var order = [];
      var z;
      var staleZooms = Object.create(null);
      for (c = 0; c < stale.length; c++) staleZooms[stale[c].z] = true;
      var liveZooms = Object.create(null);
      for (c = 0; c < cells.length; c++) liveZooms[cells[c].z] = true;
      for (z in tiltPanes) {
        if (!staleZooms[z] && !liveZooms[z]) {
          if (tiltPanes[z].parentNode) tiltPanes[z].parentNode.removeChild(tiltPanes[z]);
          delete tiltPanes[z];
          for (b = 0; b < tiltBands.length; b++) {
            var oldPane = tiltBands[b].panes[z];
            if (oldPane && oldPane.parentNode) oldPane.parentNode.removeChild(oldPane);
            delete tiltBands[b].panes[z];
          }
        }
      }
      // A pane holds both kinds at one level, so order panes by level, with
      // levels that only hold stale cells first.
      for (z in tiltPanes) order.push(+z);
      order.sort(function (a, b) { return (liveZooms[a] ? 1 : 0) - (liveZooms[b] ? 1 : 0) || a - b; });
      var sequence = order.join();
      if (sequence !== tiltSequence) {
        tiltSequence = sequence;
        for (c = 0; c < order.length; c++) tiltHost.appendChild(tiltPanes[order[c]]);
      }
      for (z in tiltPanes) placeTiltPane(+z, metrics, cellSize, zoomRef);
      for (b = 0; b < tiltBands.length; b++) {
        for (c = 0; c < order.length; c++) {
          var bandPane = tiltBands[b].panes[order[c]];
          if (!bandPane) continue;
          setTiltStyle(bandPane, tiltPanes[order[c]].style.cssText);
          if (sequence !== tiltBands[b].sequence) tiltBands[b].host.appendChild(bandPane);
        }
        tiltBands[b].sequence = sequence;
      }
      // Bleed hides antialiasing gaps on opaque ground, but doubles alpha
      // along translucent cell edges. Keep the padded texture for sampling
      // and clip its displayed extent to the cell when no background hides it.
      tiltCells.forEach(function (cell) {
        var clip = opaqueGround ? '' : 'inset(' + TILT_BLEED + 'px)';
        if (cell.canvas.style.clipPath !== clip) cell.canvas.style.clipPath = clip;
      });
      // Painting may have left cells waiting for raster parts.
      for (c = 0; c < cells.length && complete; c++) if (cells[c].incomplete) complete = false;
      tiltComplete = complete && allPainted;

      // The overlay: buildings, then labels, both projected per frame.
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      // Data tiles of the cells, once each. A fallback ancestor drawn while
      // a cell's own tile loads also spans neighbouring cells: its labels are
      // kept to the cells that use it, and it adds no buildings.
      var data = [];
      var seenData = Object.create(null);
      for (c = 0; c < cells.length; c++) {
        var rect = cellRect(cells[c], metrics);
        for (id in cells[c].sources) {
          var item = cells[c].sources[id];
          if (!item) continue;
          var dataKey = item.sourceId + '\u0000' + item.z + '/' + item.x + '/' + item.y;
          var known = seenData[dataKey];
          if (!known) {
            known = seenData[dataKey] = { entry: item.entry, origin: tileOrigin(item, metrics), tileX: item.x, tileY: item.y, exact: item.exact, clip: [],
              plan: { sourceId: item.sourceId, z: item.z, x: item.x, y: item.y } };
            data.push(known);
          }
          known.exact = known.exact || item.exact;
          known.clip.push(rect);
        }
      }
      var exactData = data.filter(function (entry) { return entry.exact; });
      var buildingLayers = [];
      groundDuration = now() - frameStart;
      var heatStarted = now();
      if (typeof style !== 'function') {
        for (b = 0; b < tiltBands.length; b++) {
          var heat = tiltBands[b].heat;
          if (heat.width !== canvas.width) heat.width = canvas.width;
          if (heat.height !== canvas.height) heat.height = canvas.height;
          setTiltStyle(heat, canvas.style.cssText);
          var heatContext = heat.getContext('2d');
          heatContext.setTransform(1, 0, 0, 1, 0, 0);
          heatContext.clearRect(0, 0, heat.width, heat.height);
          drawHeatmap(heatContext, tiltBands[b].layer, exactData, metrics);
        }
        for (var h = 0; h < style.length; h++) {
          if (style[h].type === 'heatmap' && !tiltBands.some(function (band) { return band.layer === style[h]; }) && layerVisible(style[h], zoomOf(style[h], metrics))) drawHeatmap(context, style[h], exactData, metrics);
        }
        for (var s = 0; s < style.length; s++) {
          if (style[s].type === 'fill-extrusion' && layerVisible(style[s], zoomOf(style[s], metrics))) buildingLayers.push(style[s]);
        }
      }
      heatDuration = now() - heatStarted;
      if (!buildingLayers.length || !drawExtrusionsGL(buildingLayers, exactData, metrics)) {
        hideGL();
        for (var b = 0; b < buildingLayers.length; b++) drawExtrusions3D(context, buildingLayers[b], exactData, metrics);
      }
      var labels = [];
      var labelStarted = now();
      collectLabels(data, metrics, labels);
      projectLabels(labels, metrics);
      drawLabels(context, labels, width, height, resolveImage);
      labelDuration = now() - labelStarted;
      rendered = { metrics: metrics, levels: [data.map(function (item) { return item.plan; })] };
    }

    // Buildings of the tilted view go to WebGL when it is available: each
    // data tile's prisms become one cached mesh, drawn with a depth buffer
    // through the same camera as the CSS ground. Per frame only matrices
    // change. Without WebGL, drawExtrusions3D() paints them with Canvas 2D.
    var glCanvas = null;
    var glState = null;
    var glFailed = options.webgl === false;
    var meshes = new Map();
    var meshBudgetUntil = 0;
    var glMatrix = new Float32Array(16);

    function extrusionGL() {
      if (glFailed) return null;
      if (glState) return glState;
      try {
        glCanvas = root.document.createElement('canvas');
        var gl = glCanvas.getContext && (glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true }) ||
          glCanvas.getContext('experimental-webgl'));
        var program = gl && typeof gl.createShader === 'function' ? extrusionProgram(gl) : null;
        if (!program) throw new Error('no WebGL');
        glState = { gl: gl, program: program, lost: false };
        glCanvas.setAttribute('aria-hidden', 'true');
        glCanvas.addEventListener('webglcontextlost', function (event) {
          event.preventDefault();
          if (glState) glState.lost = true;
          meshes.clear();
        });
        glCanvas.addEventListener('webglcontextrestored', function () {
          var restored = extrusionProgram(gl);
          if (restored && glState) { glState.program = restored; glState.lost = false; }
          schedule();
        });
        if (container.insertBefore) container.insertBefore(glCanvas, canvas);
        else container.appendChild(glCanvas);
      } catch (error) {
        glFailed = true;
        glCanvas = null;
        glState = null;
      }
      return glState;
    }

    function hideGL() {
      if (glCanvas) glCanvas.style.display = 'none';
    }

    function releaseMeshes(keep) {
      meshes.forEach(function (mesh, key) {
        if (keep && keep[key]) return;
        if (glState && !glState.lost) glState.gl.deleteBuffer(mesh.buffer);
        meshes.delete(key);
      });
    }

    // Interleaved vertices of 24 bytes: position (3 x float32), wall normal
    // (2 x int8), padding, colour with luminance in alpha (4 x uint8),
    // gradient shade and roof flag (2 x uint8), padding.
    function buildMesh(entry, layer, metrics) {
      var groups = bucketFor(entry, layer);
      var floats = [];
      var vertices = 0;
      var parts = [];
      for (var g = 0; g < groups.length; g++) {
        var instruction = groupInstruction(groups[g], layer, zoomOf(layer, metrics));
        if (!(instruction.opacity > 0) || !groups[g].features.length) continue;
        var rgb = parseColor(instruction.color) || [0, 0, 0, 1];
        var roofRgb = parseColor(instruction.roofColor || instruction.color) || rgb;
        var height = instruction.height;
        var base = Math.min(height, instruction.base);
        var gradient = instruction.verticalGradient === false ? 0 : Math.sqrt(height / 150);
        var bottom = gradient ? clamp(base * gradient, 0.84, 1) : 1;
        var top = gradient ? clamp((1 + base) * gradient, 0.84, 1) : 1;
        for (var f = 0; f < groups[g].features.length; f++) {
          var prism = extrusionPrism(groups[g].features[f]);
          if (!prism.rings.length) continue;
          var roof = triangulate(prism.rings, []);
          var walls = prism.walls;
          parts.push({ roof: roof, walls: walls, rgb: rgb, roofRgb: roofRgb, height: height, base: base, bottom: bottom, top: top });
          vertices += roof.length / 2 + (height > base ? walls.length : 0);
        }
      }
      if (!vertices) return { buffer: null, count: 0 };
      var bytes = new ArrayBuffer(vertices * 24);
      var f32 = new Float32Array(bytes);
      var i8 = new Int8Array(bytes);
      var u8 = new Uint8Array(bytes);
      var v = 0;
      function vertex(x, y, z, nx, ny, color, shade, isRoof) {
        var o = v * 24;
        f32[o / 4] = x;
        f32[o / 4 + 1] = y;
        f32[o / 4 + 2] = z;
        i8[o + 12] = Math.round(nx * 127);
        i8[o + 13] = Math.round(ny * 127);
        u8[o + 16] = color[0];
        u8[o + 17] = color[1];
        u8[o + 18] = color[2];
        u8[o + 19] = Math.round((color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722));
        u8[o + 20] = Math.round(shade * 255);
        u8[o + 21] = isRoof ? 255 : 0;
        v++;
      }
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        for (var r = 0; r < part.roof.length; r += 2) vertex(part.roof[r], part.roof[r + 1], part.height, 0, 0, part.roofRgb, 1, true);
        if (!(part.height > part.base)) continue;
        for (var w = 0; w < part.walls.length; w += 6) {
          var x1 = part.walls[w], y1 = part.walls[w + 1], x2 = part.walls[w + 2], y2 = part.walls[w + 3];
          var nx = part.walls[w + 4], ny = part.walls[w + 5];
          vertex(x1, y1, part.base, nx, ny, part.rgb, part.bottom, false);
          vertex(x2, y2, part.base, nx, ny, part.rgb, part.bottom, false);
          vertex(x2, y2, part.height, nx, ny, part.rgb, part.top, false);
          vertex(x1, y1, part.base, nx, ny, part.rgb, part.bottom, false);
          vertex(x2, y2, part.height, nx, ny, part.rgb, part.top, false);
          vertex(x1, y1, part.height, nx, ny, part.rgb, part.top, false);
        }
      }
      var gl = glState.gl;
      var buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
      return { buffer: buffer, count: v };
    }

    // Returns false when WebGL is unavailable (the caller then paints with
    // Canvas 2D).
    function drawExtrusionsGL(layers, data, metrics) {
      var state = extrusionGL();
      if (!state || state.lost) return false;
      var gl = state.gl;
      var program = state.program;
      var pixelWidth = Math.round(width * dpr);
      var pixelHeight = Math.round(height * dpr);
      if (glCanvas.width !== pixelWidth) glCanvas.width = pixelWidth;
      if (glCanvas.height !== pixelHeight) glCanvas.height = pixelHeight;
      var opacity = 1;
      var camera = metrics.camera;
      var perMeter = 1 / Math.max(1e-9, metrics.metersPerPixel);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.useProgram(program.program);
      var viewX = metrics.sine;
      var viewY = metrics.cosine;
      gl.uniform2f(program.light, -viewY * LIGHT_X - viewX * LIGHT_Y, viewX * LIGHT_X - viewY * LIGHT_Y);
      gl.enableVertexAttribArray(program.pos);
      gl.enableVertexAttribArray(program.normal);
      gl.enableVertexAttribArray(program.color);
      gl.enableVertexAttribArray(program.shade);
      var keep = Object.create(null);
      var drawn = 0;
      var building = now();
      var pending = false;
      for (var l = 0; l < layers.length; l++) {
        var layer = layers[l];
        var zoom = zoomOf(layer, metrics);
        for (var d = 0; d < data.length; d++) {
          var groups = bucketFor(data[d].entry, layer);
          if (!groups.length) continue;
          var key = data[d].entry.key + '\u0000' + layer.uid;
          var signature = layer.version + '|' + styleVersion + '|' + groups.serial + '|' + (layer.zoomDependent ? Math.round(zoom * 20) : 0);
          var mesh = meshes.get(key);
          if (!mesh || mesh.signature !== signature) {
            // Building meshes is bounded per frame; an older mesh of the
            // same tile keeps showing meanwhile.
            if (now() - building > 8 && mesh) pending = true;
            else if (now() - building > 16) { pending = true; continue; }
            else {
              if (mesh && mesh.buffer) gl.deleteBuffer(mesh.buffer);
              mesh = buildMesh(data[d].entry, layer, metrics);
              mesh.signature = signature;
              meshes.set(key, mesh);
            }
          }
          keep[key] = true;
          if (!mesh.buffer || !mesh.count) continue;
          for (var g = 0; g < groups.length; g++) {
            var instruction = groupInstruction(groups[g], layer, zoom);
            if (instruction.opacity > 0) { opacity = instruction.opacity; break; }
          }
          var origin = data[d].origin;
          extrusionMatrix(camera, origin[0] - width / 2, origin[1] - height / 2, origin[2] / groups[0].layer.extent, perMeter, glMatrix);
          gl.uniformMatrix4fv(program.matrix, false, glMatrix);
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
          gl.vertexAttribPointer(program.pos, 3, gl.FLOAT, false, 24, 0);
          gl.vertexAttribPointer(program.normal, 2, gl.BYTE, true, 24, 12);
          gl.vertexAttribPointer(program.color, 4, gl.UNSIGNED_BYTE, true, 24, 16);
          gl.vertexAttribPointer(program.shade, 2, gl.UNSIGNED_BYTE, true, 24, 20);
          gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
          drawn++;
        }
      }
      // Meshes of tiles that are gone are freed; a few spare ones are kept
      // only while still in the decoded cache.
      meshes.forEach(function (mesh, key) {
        if (keep[key]) return;
        if (!cache[key.split('\u0000')[0]] || meshes.size > 160) {
          if (mesh.buffer) gl.deleteBuffer(mesh.buffer);
          meshes.delete(key);
        }
      });
      glCanvas.style.cssText = 'position:absolute;left:0;top:0;width:' + width + 'px;height:' + height + 'px;pointer-events:none;z-index:' +
        clamp(Math.floor(finite(options.zIndex, 1)), -100, 100) + ';opacity:' + opacity + (drawn ? '' : ';display:none');
      if (pending) schedule();
      return true;
    }

    // Heatmap layers: kernel density at half resolution, accumulated
    // additively in the alpha channel, then coloured by heatmap-color. Each
    // point counts in the tile that owns it, never in a neighbour's buffer.
    var heatFrames = new Map();

    function paintHeatmap(ctx, heatCanvas, opacity) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(heatCanvas, 0, 0, heatCanvas.width, heatCanvas.height, 0, 0, width, height);
      ctx.restore();
    }

    function drawHeatmap(ctx, layer, items, metrics) {
      var zoom = zoomOf(layer, metrics);
      var base = layerInstruction(layer, zoom, null);
      if (!(base.opacity > 0)) return;
      var quality = 0.5;
      var heatWidth = Math.max(1, Math.ceil(width * quality));
      var heatHeight = Math.max(1, Math.ceil(height * quality));
      // DEM loading can request many identical frames. Bucket serials
      // change with source data, layer paints/filters and feature state;
      // the actual item origins also distinguish wrapped/exact tile sets.
      var dependencies = [styleVersion, layer.version, zoom, width, height, dpr,
        metrics.centerX, metrics.centerY, metrics.pixelsPerWorld, metrics.bearing, metrics.pitch,
        !!metrics.camera, metrics.camera && metrics.camera.distance, metrics.camera && metrics.camera.horizonRow];
      var batches = [];
      for (var t = 0; t < items.length; t++) {
        var groups = bucketFor(items[t].entry, layer);
        if (!groups.length) continue;
        var origin = items[t].origin;
        dependencies.push(items[t].entry.key, items[t].entry.serial, groups.serial, origin[0], origin[1], origin[2]);
        batches.push({ origin: origin, groups: groups });
      }
      var key = dependencies.join('|');
      var cached = heatFrames.get(layer.uid);
      if (cached && cached.key === key) {
        heatFrames.delete(layer.uid);
        heatFrames.set(layer.uid, cached);
        if (cached.drawn) paintHeatmap(ctx, cached.canvas, base.opacity);
        return;
      }
      var heatCanvas = cached ? cached.canvas : root.document.createElement('canvas');
      if (heatCanvas.width !== heatWidth) heatCanvas.width = heatWidth;
      if (heatCanvas.height !== heatHeight) heatCanvas.height = heatHeight;
      // Every density frame is read back for colour mapping. Keep it on the
      // CPU, including its kernel sprites, to avoid GPU readback stalls.
      var density = heatCanvas.getContext('2d', { willReadFrequently: true });
      if (!density || typeof density.getImageData !== 'function') return;
      density.setTransform(1, 0, 0, 1, 0, 0);
      density.globalCompositeOperation = 'source-over';
      density.clearRect(0, 0, heatWidth, heatHeight);
      density.globalCompositeOperation = 'lighter';
      var horizon = metrics.camera ? metrics.camera.horizonRow : -Infinity;
      var drawn = 0;
      var x0 = heatWidth, y0 = heatHeight, x1 = 0, y1 = 0;
      for (t = 0; t < batches.length; t++) {
        origin = batches[t].origin;
        groups = batches[t].groups;
        for (var g = 0; g < groups.length; g++) {
          var instruction = groupInstruction(groups[g], layer, zoom);
          var strength = instruction.weight * instruction.intensity;
          if (!(strength > 0) || !(instruction.radius > 0)) continue;
          var sprite = null;
          var reach = Math.max(1, Math.round(instruction.radius * quality));
          var extent = groups[g].layer.extent;
          var scale = origin[2] / extent;
          for (var f = 0; f < groups[g].features.length; f++) {
            var feature = groups[g].features[f];
            var coords = feature._layer.coords;
            var parts = feature._layer.parts;
            for (var i = parts[feature._partStart]; i < parts[feature._partEnd]; i++) {
              var x = coords[2 * i];
              var y = coords[2 * i + 1];
              if (x < 0 || y < 0 || x >= extent || y >= extent) continue;
              var point = screenPoint(origin[0] + x * scale, origin[1] + y * scale, metrics);
              if (point[1] < horizon) continue;
              var sx = point[0] * quality;
              var sy = point[1] * quality;
              if (sx < -reach || sy < -reach || sx > heatWidth + reach || sy > heatHeight + reach) continue;
              if (!sprite) sprite = kernelSprite(instruction.radius * quality, strength);
              density.drawImage(sprite, sx - reach - 0.5, sy - reach - 0.5);
              // Round the union once, rather than every point's rectangle.
              if (sx - reach < x0) x0 = sx - reach;
              if (sy - reach < y0) y0 = sy - reach;
              if (sx + reach > x1) x1 = sx + reach;
              if (sy + reach > y1) y1 = sy + reach;
              drawn++;
            }
          }
        }
      }
      density.globalCompositeOperation = 'source-over';
      heatFrames.delete(layer.uid);
      heatFrames.set(layer.uid, { key: key, canvas: heatCanvas, drawn: drawn });
      if (heatFrames.size > 8) heatFrames.delete(heatFrames.keys().next().value);
      if (!drawn) return;
      var ramp = heatmapRamp(layer, zoom);
      // Sparse overlays need only a small readback and colour pass. A ramp
      // with visible zero density deliberately colours the whole viewport.
      if (ramp[3]) { x0 = y0 = 0; x1 = heatWidth; y1 = heatHeight; }
      else {
        // Include fractional sprite edges and their filtered pixels.
        x0 = Math.max(0, Math.floor(x0 - 1)); y0 = Math.max(0, Math.floor(y0 - 1));
        x1 = Math.min(heatWidth, Math.ceil(x1 + 1)); y1 = Math.min(heatHeight, Math.ceil(y1 + 1));
      }
      var image = density.getImageData(x0, y0, x1 - x0, y1 - y0);
      var data = image.data;
      // Copy complete RGBA pixels. Both views use native byte order, while
      // density still comes from the alpha byte on either endianness.
      var colors = new Uint32Array(ramp.buffer);
      var pixels = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
      for (var p = 0; p < pixels.length; p++) pixels[p] = colors[data[4 * p + 3]];
      density.putImageData(image, x0, y0);
      paintHeatmap(ctx, heatCanvas, base.opacity);
    }

    // fill-extrusion under the perspective camera: prisms are projected
    // vertex by vertex and painted back to front, walls facing the camera
    // before their roof, with the same light and shading as the flat pass.
    function drawExtrusions3D(ctx, layer, data, metrics) {
      var camera = metrics.camera;
      var halfWidth = width / 2;
      var halfHeight = height / 2;
      var perMeter = 1 / Math.max(1e-9, metrics.metersPerPixel);
      // The camera's ground position in raw offsets (not rotated).
      var back = camera.distance * camera.sinPitch;
      var eyeX = back * camera.sinBearing;
      var eyeY = back * camera.cosBearing;
      var viewX = metrics.sine;
      var viewY = metrics.cosine;
      var lightX = -viewY * LIGHT_X - viewX * LIGHT_Y;
      var lightY = viewX * LIGHT_X - viewY * LIGHT_Y;
      var horizon = camera.horizonRow;
      var pieces = [];
      for (var d = 0; d < data.length; d++) {
        var groups = bucketFor(data[d].entry, layer);
        var origin = data[d].origin;
        for (var g = 0; g < groups.length; g++) {
          var instruction = groupInstruction(groups[g], layer, zoomOf(layer, metrics));
          if (!(instruction.opacity > 0)) continue;
          var scale = origin[2] / groups[g].layer.extent;
          for (var f = 0; f < groups[g].features.length; f++) {
            var prism = extrusionPrism(groups[g].features[f]);
            if (!prism.rings.length) continue;
            var cx = origin[0] + prism.x * scale - halfWidth;
            var cy = origin[1] + prism.y * scale - halfHeight;
            var centre = camera.project(cx, cy, 0);
            var reach = Math.max(prism.box[2] - prism.box[0], prism.box[3] - prism.box[1]) * scale * centre[2];
            if (centre[1] < horizon || centre[0] < -reach - 64 || centre[0] > width + reach + 64 || centre[1] > height + reach + 256) continue;
            pieces.push({ prism: prism, ox: origin[0] - halfWidth, oy: origin[1] - halfHeight, scale: scale, instruction: instruction,
              depth: (cx - eyeX) * (cx - eyeX) + (cy - eyeY) * (cy - eyeY) });
          }
        }
      }
      if (!pieces.length) return;
      pieces.sort(function (a, b) { return b.depth - a.depth; });
      var opacity = pieces[0].instruction.opacity;
      var target = ctx;
      if (opacity < 1 && ctx.canvas && typeof ctx.getTransform === 'function') {
        extrusionCanvas = extrusionCanvas || root.document.createElement('canvas');
        if (extrusionCanvas.width !== ctx.canvas.width || extrusionCanvas.height !== ctx.canvas.height) {
          extrusionCanvas.width = ctx.canvas.width;
          extrusionCanvas.height = ctx.canvas.height;
        }
        target = extrusionCanvas.getContext('2d');
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.clearRect(0, 0, extrusionCanvas.width, extrusionCanvas.height);
        target.setTransform(ctx.getTransform());
      }
      target.globalAlpha = target === ctx ? opacity : 1;
      var visible = [];
      for (var p = 0; p < pieces.length; p++) {
        var piece = pieces[p];
        instruction = piece.instruction;
        prism = piece.prism;
        scale = piece.scale;
        var top = instruction.height * perMeter;
        var base = Math.min(instruction.height, instruction.base) * perMeter;
        var walls = prism.walls;
        if (top > base) {
          var gradient = instruction.verticalGradient === false ? 0 : Math.sqrt(instruction.height / 150);
          var bottomShade = gradient ? clamp(instruction.base * gradient, 0.84, 1) : 1;
          var topShade = gradient ? clamp((1 + instruction.base) * gradient, 0.84, 1) : 1;
          visible.length = 0;
          for (var w = 0; w < walls.length; w += 6) {
            var mx = piece.ox + (walls[w] + walls[w + 2]) / 2 * scale;
            var my = piece.oy + (walls[w + 1] + walls[w + 3]) / 2 * scale;
            var facing = walls[w + 4] * (eyeX - mx) + walls[w + 5] * (eyeY - my);
            if (facing > 0) visible.push({ index: w, depth: (mx - eyeX) * (mx - eyeX) + (my - eyeY) * (my - eyeY) });
          }
          visible.sort(function (a, b) { return b.depth - a.depth; });
          for (var v = 0; v < visible.length; v++) {
            w = visible[v].index;
            var light = walls[w + 4] * lightX + walls[w + 5] * lightY;
            var x1 = piece.ox + walls[w] * scale;
            var y1 = piece.oy + walls[w + 1] * scale;
            var x2 = piece.ox + walls[w + 2] * scale;
            var y2 = piece.oy + walls[w + 3] * scale;
            var a = camera.project(x1, y1, base);
            var b = camera.project(x2, y2, base);
            var c2 = camera.project(x2, y2, top);
            var d2 = camera.project(x1, y1, top);
            if (bottomShade === topShade) target.fillStyle = shadeOf(instruction, light, bottomShade);
            else {
              var fill = target.createLinearGradient(a[0], a[1], d2[0], d2[1]);
              fill.addColorStop(0, shadeOf(instruction, light, bottomShade));
              fill.addColorStop(1, shadeOf(instruction, light, topShade));
              target.fillStyle = fill;
            }
            target.beginPath();
            target.moveTo(a[0], a[1]);
            target.lineTo(b[0], b[1]);
            target.lineTo(c2[0], c2[1]);
            target.lineTo(d2[0], d2[1]);
            target.closePath();
            target.fill();
          }
        }
        target.beginPath();
        for (var r = 0; r < prism.rings.length; r++) {
          var ring = prism.rings[r];
          for (var i = 0; i < ring.length; i += 2) {
            var point = camera.project(piece.ox + ring[i] * scale, piece.oy + ring[i + 1] * scale, top);
            if (i) target.lineTo(point[0], point[1]);
            else target.moveTo(point[0], point[1]);
          }
          target.closePath();
        }
        target.fillStyle = shadeOf(instruction, LIGHT_Z, 1, true);
        target.fill('nonzero');
      }
      if (target !== ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = opacity;
        ctx.drawImage(extrusionCanvas, 0, 0);
        ctx.restore();
      }
    }

    function queryPoint(value) {
      if (Array.isArray(value)) value = { x: value[0], y: value[1] };
      if (!value || !isFinite(+value.x) || !isFinite(+value.y)) return null;
      return [+value.x, +value.y];
    }

    function queryOptions(value) {
      value = value || {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('microMap.vector: query options must be an object');
      }
      var layers = null;
      if (value.layers != null) {
        if (!Array.isArray(value.layers) || !value.layers.every(function (id) { return typeof id === 'string'; })) {
          throw new Error('microMap.vector: query layers must be an array of style-layer ids');
        }
        layers = Object.create(null);
        for (var i = 0; i < value.layers.length; i++) layers[value.layers[i]] = true;
      }
      var filter = null;
      if (value.filter != null) {
        try {
          filter = { filter: compileCondition(value.filter, 0, Object.create(null)) };
        } catch (error) {
          throw new Error('microMap.vector: query filter: ' + error.message.replace('microMap.vector: ', ''));
        }
      }
      return { layers: layers, radius: clamp(finite(value.radius, 3), 0, 32), filter: filter };
    }

    // The Canvas geometry pass applies rotation and pitch as one affine
    // transform. Invert it once for fill containment; for distance tests,
    // the screen vertical coordinate is unsquished before undoing rotation.
    function rawQueryPoint(point, metrics) {
      if (metrics.camera) {
        var ground = metrics.camera.unproject(point[0], point[1]);
        return [width / 2 + ground[0], height / 2 + ground[1]];
      }
      var cosine = metrics.cosine;
      var sine = metrics.sine;
      var dx = point[0] - width / 2;
      var dy = (point[1] - height / 2) / Math.max(0.05, metrics.pitchScale);
      return [width / 2 + dx * cosine + dy * sine,
        height / 2 - dx * sine + dy * cosine];
    }

    function onSegment(x, y, x1, y1, x2, y2) {
      return Math.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) < 1e-7 &&
        x >= Math.min(x1, x2) - 1e-7 && x <= Math.max(x1, x2) + 1e-7 &&
        y >= Math.min(y1, y2) - 1e-7 && y <= Math.max(y1, y2) + 1e-7;
    }

    // Canvas fills use the non-zero winding rule. Keep picking in exactly the
    // same coordinate space and rule, including holes and nested rings.
    function containsPolygon(feature, x, y, origin, scale) {
      var layer = feature._layer;
      var coords = layer.coords;
      var winding = 0;
      for (var p = feature._partStart; p < feature._partEnd; p++) {
        var start = layer.parts[p];
        var length = layer.parts[p + 1] - start;
        for (var i = 0; i < length; i++) {
          var a = start + i;
          var b = start + (i + 1) % length;
          var x1 = origin[0] + coords[2 * a] * scale;
          var y1 = origin[1] + coords[2 * a + 1] * scale;
          var x2 = origin[0] + coords[2 * b] * scale;
          var y2 = origin[1] + coords[2 * b + 1] * scale;
          if (onSegment(x, y, x1, y1, x2, y2)) return true;
          if (y1 <= y) {
            if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
          } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) winding--;
        }
      }
      return winding !== 0;
    }

    function symbolHit(x, y, instruction, raw, radius, metrics) {
      if (metrics.camera) {
        var anchor = screenPoint(x, y, metrics);
        var query = screenPoint(raw[0], raw[1], metrics);
        var sx = query[0] - (anchor[0] + instruction.offsetX);
        var sy = query[1] - (anchor[1] + instruction.offsetY);
        var reach = Math.max(6, instruction.size / 2) + radius;
        return sx * sx + sy * sy <= reach * reach;
      }
      var dx = raw[0] - (x + instruction.offsetX);
      var dy = (raw[1] - (y + instruction.offsetY)) * metrics.pitchScale;
      var limit = Math.max(6, instruction.size / 2) + radius;
      return dx * dx + dy * dy <= limit * limit;
    }

    function featureHit(feature, instruction, raw, radius, origin, scale, metrics) {
      if (!instructionPainted(instruction)) return false;
      var type = instruction.type;
      if (type === 'fill') return containsPolygon(feature, raw[0], raw[1], origin, scale);
      if (type === 'fill-extrusion') {
        if (metrics.camera) {
          // Walk the view ray from the roof down to the base.
          var screen = screenPoint(raw[0], raw[1], metrics);
          var perMeter = 1 / Math.max(1e-9, metrics.metersPerPixel);
          for (var step = 0; step <= 8; step++) {
            var lift = (instruction.base + (instruction.height - instruction.base) * (1 - step / 8)) * perMeter;
            var ground = metrics.camera.unprojectAt(screen[0], screen[1], lift);
            if (ground && containsPolygon(feature, width / 2 + ground[0], height / 2 + ground[1], origin, scale)) return true;
          }
          return false;
        }
        // A pitched building covers its footprint swept up to the roof.
        var steps = metrics.pitch && instruction.height > 0 ? 8 : 0;
        for (var k = 0; k <= steps; k++) {
          var rise = instruction.base + (instruction.height - instruction.base) * (steps ? 1 - k / steps : 0);
          if (containsPolygon(feature, raw[0] - metrics.extrudeDxPerMeter * rise, raw[1] - metrics.extrudeDyPerMeter * rise, origin, scale)) return true;
        }
        return false;
      }
      if (type === 'symbol') {
        var anchor = symbolAnchor(feature, instruction, origin[0], origin[1], scale);
        return !!anchor && symbolHit(anchor.x, anchor.y, instruction, raw, radius, metrics);
      }
      var limit = type === 'line' ? instruction.width / 2 + radius : instruction.radius + instruction.strokeWidth / 2 + radius;
      if ((type !== 'line' && type !== 'circle') || !(limit > 0)) return false;
      var layer = feature._layer;
      var coords = layer.coords;
      var screen = screenPoint(raw[0], raw[1], metrics);
      for (var p = feature._partStart; p < feature._partEnd; p++) {
        for (var i = layer.parts[p]; i < layer.parts[p + 1]; i++) {
          var point = screenPoint(origin[0] + coords[2 * i] * scale, origin[1] + coords[2 * i + 1] * scale, metrics);
          if (type === 'circle') {
            if ((screen[0] - point[0]) * (screen[0] - point[0]) + (screen[1] - point[1]) * (screen[1] - point[1]) <= limit * limit) return true;
          } else if (i > layer.parts[p]) {
            var previous = screenPoint(origin[0] + coords[2 * i - 2] * scale, origin[1] + coords[2 * i - 1] * scale, metrics);
            if (pointSegmentDistanceSquared(screen[0], screen[1], previous[0], previous[1], point[0], point[1]) <= limit * limit) return true;
          }
        }
      }
      return false;
    }

    function cloneProperties(properties) {
      var result = {};
      for (var key in properties) result[key] = properties[key];
      return result;
    }

    function projectedCoordinate(coords, index, origin, scale, metrics) {
      return map.unproject(screenPoint(origin[0] + coords[2 * index] * scale, origin[1] + coords[2 * index + 1] * scale, metrics));
    }

    function ringArea(coords, start, end) {
      var area = 0;
      for (var i = start; i < end; i++) {
        var j = i + 1 < end ? i + 1 : start;
        area += coords[2 * i] * coords[2 * j + 1] - coords[2 * j] * coords[2 * i + 1];
      }
      return area;
    }

    function featureGeometry(feature, origin, scale, metrics) {
      var layer = feature._layer;
      var coords = layer.coords;
      var parts = layer.parts;
      var result = [];
      var p;
      var i;
      if (feature.type === 1) {
        for (i = parts[feature._partStart]; i < parts[feature._partEnd]; i++) result.push(projectedCoordinate(coords, i, origin, scale, metrics));
        return result.length === 1 ? { type: 'Point', coordinates: result[0] } : { type: 'MultiPoint', coordinates: result };
      }
      if (feature.type === 2) {
        for (p = feature._partStart; p < feature._partEnd; p++) {
          var line = [];
          for (i = parts[p]; i < parts[p + 1]; i++) line.push(projectedCoordinate(coords, i, origin, scale, metrics));
          if (line.length) result.push(line);
        }
        return result.length === 1 ? { type: 'LineString', coordinates: result[0] } : { type: 'MultiLineString', coordinates: result };
      }
      var current = null;
      var outerSign = 0;
      for (p = feature._partStart; p < feature._partEnd; p++) {
        if (parts[p + 1] - parts[p] < 3) continue;
        var area = ringArea(coords, parts[p], parts[p + 1]);
        var sign = area < 0 ? -1 : 1;
        if (!outerSign && area) outerSign = sign;
        var ring = [];
        for (i = parts[p]; i < parts[p + 1]; i++) ring.push(projectedCoordinate(coords, i, origin, scale, metrics));
        ring.push(ring[0].slice());
        if (!current || sign === outerSign) {
          current = [ring];
          result.push(current);
        } else current.push(ring);
      }
      return result.length === 1 ? { type: 'Polygon', coordinates: result[0] } : { type: 'MultiPolygon', coordinates: result };
    }

    function queryResult(feature, sourceLayer, descriptor, instruction, origin, scale, metrics) {
      var layer = {
        id: descriptor && descriptor.id != null ? String(descriptor.id) : sourceLayer,
        type: descriptor && descriptor.type ? descriptor.type : instruction.type,
        'source-layer': sourceLayer
      };
      var geojson = descriptor && descriptor.geojson;
      if (geojson) delete layer['source-layer'];
      return {
        type: 'Feature',
        id: feature.id,
        properties: cloneProperties(feature.properties),
        geometry: featureGeometry(feature, origin, scale, metrics),
        source: geojson || (descriptor && descriptor.source) || (typeof style !== 'function' && style.report ? style.report.source : undefined),
        sourceLayer: geojson ? undefined : sourceLayer,
        layer: layer,
        state: feature.id == null ? {} : cloneStyleValue(featureStates.get(stateKey(geojson || (descriptor && descriptor.source) || primarySourceID, geojson ? '' : sourceLayer, feature.id)) || {}, 0)
      };
    }

    // MapLibre's querySourceFeatures(sourceId, { sourceLayer, filter }): the
    // features of a source's loaded tiles that the current view uses, as
    // GeoJSON in longitude/latitude. Features cut by tile edges appear once
    // per tile, as in MapLibre; ids are not merged.
    function querySourceFeatures(sourceId, settings) {
      settings = settings || {};
      if (destroyed) return [];
      var results = [];
      var filter = settings.filter != null ? { filter: compileCondition(settings.filter, 0, Object.create(null)) } : null;
      if (own(geojsonSources, sourceId)) {
        var source = geojsonSources[sourceId];
        var zoom = source.clusters ? geojsonClusterZoom(source) : Math.floor(mapMetrics().styleZoom + 1e-9);
        if (source.clusters) {
          var items = source.clusters.levels[zoom];
          for (var c = 0; c < items.length; c++) {
            var item = items[c];
            if (filter && !passesFilter(filter, zoom, item)) continue;
            if (item.cluster) results.push(clusterFeature(item.cluster));
            else if (item.original) results.push(cloneStyleValue(item.original, 0));
          }
          return results;
        }
        var data = source.data;
        var list = data && data.type === 'FeatureCollection' ? data.features : data && data.type === 'Feature' ? [data] : [];
        for (var g = 0; g < list.length; g++) {
          var feature = list[g];
          if (filter) {
            if (!feature) continue;
            var geometry = feature.geometry;
            var type = geometry ? GEOMETRY_TYPES.indexOf(geometry.type.replace(/^Multi/, '')) : 0;
            if (!passesFilter(filter, zoom, { type: type, id: feature.id, properties: feature.properties || {} })) continue;
          }
          results.push(cloneStyleValue(feature, 0));
        }
        return results;
      }
      var id = sourceId === primarySourceID ? primarySourceID : own(extraVectors, sourceId) ? sourceId : undefined;
      if (id === undefined) return [];
      for (var key in cache) {
        var entry = cache[key];
        if (entry.sourceId !== id || !needed[key]) continue;
        var count = Math.pow(2, entry.z);
        for (var l = 0; l < entry.data.layers.length; l++) {
          var layer = entry.data.layers[l];
          if (settings.sourceLayer != null && layer.name !== settings.sourceLayer) continue;
          for (var f = 0; f < layer.features.length; f++) {
            var feature = layer.features[f];
            if (filter && !passesFilter(filter, entry.z, feature)) continue;
            var origin = [entry.x / count, entry.y / count, 1 / count];
            results.push({
              type: 'Feature', id: feature.id, properties: cloneProperties(feature.properties),
              geometry: sourceGeometry(feature, origin, 1 / count / layer.extent),
              source: sourceId, sourceLayer: layer.name
            });
          }
        }
      }
      return results;
    }

    // Tile units to longitude/latitude for querySourceFeatures().
    function sourceGeometry(feature, origin, scale) {
      var layer = feature._layer;
      var coords = layer.coords;
      var parts = layer.parts;
      function at(i) { return lonLatOfWorld(origin[0] + coords[2 * i] * scale, origin[1] + coords[2 * i + 1] * scale); }
      var result = [];
      var p;
      var i;
      if (feature.type === 1) {
        for (i = parts[feature._partStart]; i < parts[feature._partEnd]; i++) result.push(at(i));
        return result.length === 1 ? { type: 'Point', coordinates: result[0] } : { type: 'MultiPoint', coordinates: result };
      }
      for (p = feature._partStart; p < feature._partEnd; p++) {
        var line = [];
        for (i = parts[p]; i < parts[p + 1]; i++) line.push(at(i));
        if (feature.type === 3 && line.length) line.push(line[0].slice());
        if (line.length) result.push(line);
      }
      if (feature.type === 2) return result.length === 1 ? { type: 'LineString', coordinates: result[0] } : { type: 'MultiLineString', coordinates: result };
      return { type: 'Polygon', coordinates: result };
    }

    // MapLibre's query geometry: nothing (the whole view), a point, or a box
    // given by two corner points. Returns the box or null for a point.
    function queryBox(geometry) {
      if (geometry === undefined) return { x0: 0, y0: 0, x1: width, y1: height };
      if (!Array.isArray(geometry) || geometry.length !== 2 || typeof geometry[0] !== 'object' || geometry[0] === null) return null;
      var a = queryPoint(geometry[0]);
      var b = queryPoint(geometry[1]);
      if (!a || !b) return null;
      return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    }

    // Liang-Barsky: does the segment touch the rectangle?
    function segmentInBox(ax, ay, bx, by, x0, y0, x1, y1) {
      var t0 = 0;
      var t1 = 1;
      var dx = bx - ax;
      var dy = by - ay;
      var p = [-dx, dx, -dy, dy];
      var q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
      for (var i = 0; i < 4; i++) {
        if (!p[i]) { if (q[i] < 0) return false; continue; }
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
      return true;
    }

    // A feature against a screen box: any vertex or edge inside it, or (for
    // areas) the box inside the area. Lines and circles count their width.
    function featureInBox(feature, instruction, box, radius, origin, scale, metrics) {
      if (!instructionPainted(instruction)) return false;
      var type = instruction.type;
      var reach = radius + (type === 'line' ? instruction.width / 2 : type === 'circle' ? instruction.radius + (instruction.strokeWidth || 0) / 2 : 0);
      var x0 = box.x0 - reach;
      var y0 = box.y0 - reach;
      var x1 = box.x1 + reach;
      var y1 = box.y1 + reach;
      var layer = feature._layer;
      var coords = layer.coords;
      var area = type === 'fill' || type === 'fill-extrusion';
      var edges = area || type === 'line';
      for (var p = feature._partStart; p < feature._partEnd; p++) {
        var start = layer.parts[p];
        var end = layer.parts[p + 1];
        var first = null;
        var previous = null;
        for (var i = start; i < end; i++) {
          var point = screenPoint(origin[0] + coords[2 * i] * scale, origin[1] + coords[2 * i + 1] * scale, metrics);
          if (point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1) return true;
          if (edges && previous && segmentInBox(previous[0], previous[1], point[0], point[1], x0, y0, x1, y1)) return true;
          if (!first) first = point;
          previous = point;
        }
        if (area && first && previous && segmentInBox(previous[0], previous[1], first[0], first[1], x0, y0, x1, y1)) return true;
      }
      if (area) {
        var centre = rawQueryPoint([(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2], metrics);
        return containsPolygon(feature, centre[0], centre[1], origin, scale);
      }
      return false;
    }

    // Returns fresh MapLibre-shaped feature snapshots for the geometry
    // painted into the last frame: queryRenderedFeatures(), (options),
    // (point, options) or ([corner, corner], options). It intentionally
    // exposes neither a full source registry nor tile cache internals.
    function queryRenderedFeatures(geometry, options) {
      if (geometry && typeof geometry === 'object' && !Array.isArray(geometry) && !isFinite(+geometry.x) && options === undefined) {
        options = geometry;
        geometry = undefined;
      }
      if (destroyed || !rendered) return [];
      var query = queryOptions(options);
      var metrics = rendered.metrics;
      var box = queryBox(geometry);
      var hits;
      var symbolHits;
      if (box) {
        hits = function (feature, instruction, origin, scale) { return featureInBox(feature, instruction, box, query.radius, origin, scale, metrics); };
        symbolHits = function (x, y, instruction) {
          var anchor = screenPoint(x, y, metrics);
          var reach = Math.max(6, instruction.size / 2) + query.radius;
          return anchor[0] + instruction.offsetX >= box.x0 - reach && anchor[0] + instruction.offsetX <= box.x1 + reach &&
            anchor[1] + instruction.offsetY >= box.y0 - reach && anchor[1] + instruction.offsetY <= box.y1 + reach;
        };
      } else {
        var point = queryPoint(geometry);
        if (!point) return [];
        var raw = rawQueryPoint(point, metrics);
        hits = function (feature, instruction, origin, scale) { return featureHit(feature, instruction, raw, query.radius, origin, scale, metrics); };
        symbolHits = function (x, y, instruction) { return symbolHit(x, y, instruction, raw, query.radius, metrics); };
      }
      function accepted(feature) {
        return !query.filter || passesFilter(query.filter, metrics.styleZoom, feature);
      }
      var results = [];
      var p;
      var entry;
      var origin;
      var scale;
      var f;
      for (var level = rendered.levels.length - 1; level >= 0; level--) {
        var plans = rendered.levels[level];
        if (typeof style === 'function') {
          for (p = plans.length - 1; p >= 0; p--) {
            entry = cache[sourceKey(plans[p].sourceId, plans[p].z, plans[p].x, plans[p].y)];
            if (!entry) continue;
            origin = tileOrigin(plans[p], metrics);
            for (var l = entry.data.layers.length - 1; l >= 0; l--) {
              var sourceLayer = entry.data.layers[l];
              // Function styles have no declarative id; expose their source
              // layer as the stable query id returned by queryResult().
              if (query.layers && !query.layers[sourceLayer.name]) continue;
              scale = origin[2] / sourceLayer.extent;
              for (f = sourceLayer.features.length - 1; f >= 0; f--) {
                var feature = sourceLayer.features[f];
                if (!accepted(feature)) continue;
                var instructions = callbackInstructions(style(sourceLayer.name, feature, metrics.zoom), feature, metrics.zoom);
                for (var i = instructions.length - 1; i >= 0; i--) {
                  if (hits(feature, instructions[i], origin, scale)) {
                    results.push(queryResult(feature, sourceLayer.name, null, instructions[i], origin, scale, metrics));
                    break;
                  }
                }
              }
            }
          }
          continue;
        }
        for (var s = style.length - 1; s >= 0; s--) {
          var layer = style[s];
          if (layer.type === 'background' || rasterLayer(layer.type) || layer.type === 'heatmap' || !layerVisible(layer, zoomOf(layer, metrics)) || (query.layers && !query.layers[layer.id])) continue;
          var seen = new Set();
          for (p = plans.length - 1; p >= 0; p--) {
            entry = cache[sourceKey(plans[p].sourceId, plans[p].z, plans[p].x, plans[p].y)];
            if (!entry) continue;
            origin = tileOrigin(plans[p], metrics);
            var bucket = bucketFor(entry, layer);
            for (var g = bucket.length - 1; g >= 0; g--) {
              var group = bucket[g];
              var name = group.layer.name;
              var instruction = groupInstruction(group, layer, zoomOf(layer, metrics));
              scale = origin[2] / group.layer.extent;
              if (group.labels) {
                for (f = group.labels.length - 1; f >= 0; f--) {
                  var candidate = group.labels[f];
                  if (layer.geojson && seen.has(candidate.feature._properties)) continue;
                  if (!accepted(candidate.feature)) continue;
                  if (instruction.opacity > 0 && symbolHits(origin[0] + candidate.x * scale, origin[1] + candidate.y * scale, instruction)) {
                    if (layer.geojson) seen.add(candidate.feature._properties);
                    results.push(queryResult(candidate.feature, name, layer, instruction, origin, scale, metrics));
                  }
                }
                continue;
              }
              for (f = group.features.length - 1; f >= 0; f--) {
                var hit = group.features[f];
                // Tile copies of one GeoJSON feature share its properties.
                if (layer.geojson && seen.has(hit._properties)) continue;
                if (!accepted(hit)) continue;
                if (hits(hit, instruction, origin, scale)) {
                  if (layer.geojson) seen.add(hit._properties);
                  results.push(queryResult(hit, name, layer, instruction, origin, scale, metrics));
                }
              }
            }
          }
        }
      }
      return results;
    }

    function resizeCanvas() {
      width = Math.max(0, container.clientWidth || 0);
      height = Math.max(0, container.clientHeight || 0);
      dpr = clamp(finite(root.devicePixelRatio, 1), 1, maxDpr);
      var pixelWidth = Math.round(width * dpr);
      var pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      // Avoid a style write (and possible invalidation) on every frame.
      if (canvas.style.width !== width + 'px') canvas.style.width = width + 'px';
      if (canvas.style.height !== height + 'px') canvas.style.height = height + 'px';
    }

    // Render state (buckets and Path2D) is kept for the tiles of the current
    // frame only; decoded tile data stays in the byte-bounded LRU cache.
    function releaseBuckets() {
      for (var key in cache) {
        if (!needed[key] && cache[key].buckets) {
          cache[key].buckets = null;
          cache[key].virtual = null;
          cache[key].style = -1;
        }
      }
    }

    function draw() {
      frame = 0;
      if (destroyed) return;
      frameStart = now();
      renderFrames++;
      shadeSpent = 0;
      groundDuration = heatDuration = labelDuration = maxCellDuration = 0;
      extrusionBudget = 4;
      pathBuilds = 0;
      pathStale = false;
      resizeCanvas();
      if (!width || !height) return;
      var metrics = mapMetrics();
      if (metrics.camera) {
        drawTilted(metrics);
        releaseBuckets();
        trimCache();
        renderDuration = now() - frameStart;
        return;
      }
      if (tiltHost) hideTilt();
      if (glCanvas) {
        hideGL();
        releaseMeshes(null);
      }
      // Requesting a source above its declared minzoom at a lower camera zoom
      // can mean millions of tiles. There is no useful vector fallback in
      // that direction, so stay empty (or render cached tiles) until the
      // camera reaches the source range. Overzooming above maxZoom is safe.
      var currentZoom = currentTileZoom(metrics);
      needed = Object.create(null);
      var requests = currentZoom == null ? [] : visibleTiles(currentZoom, tileBuffer, metrics);
      for (var i = 0; i < requests.length; i++) requestTile(requests[i], metrics);
      for (var vectorID in extraVectors) {
        var vector = extraVectors[vectorID];
        if (!vector.tiles || !sourceHasVisibleLayer(vectorID, metrics)) continue;
        var vectorZoom = sourceTileZoom(vector, metrics);
        if (vectorZoom == null) continue;
        var vectorRequests = visibleTiles(vectorZoom, tileBuffer, metrics);
        for (i = 0; i < vectorRequests.length; i++) requestTile(vectorRequests[i], metrics, false, null, vectorID);
      }
      drain();
      render(metrics, currentZoom);
      releaseBuckets();
      trimCache();
      // Paths reused past their detail level are finished in later frames.
      if (pathStale) schedule();
      renderDuration = now() - frameStart;
    }

    function schedule() {
      if (!frame && !destroyed) frame = requestFrame.call(root, draw);
    }

    function clearRequests() {
      clearPrismWork();
      extrusionCaches.clear();
      sourceVersion++;
      rendered = null;
      var key;
      for (key in inFlight) if (inFlight[key].controller) inFlight[key].controller.abort();
      active = 0;
      if (retryTimer) root.clearTimeout(retryTimer);
      retryTimer = 0;
      retryAt = 0;
      if (preloadTimer) root.clearTimeout(preloadTimer);
      preloadTimer = 0;
      preloadWanted = Object.create(null);
      queue = [];
      queued = Object.create(null);
      inFlight = Object.create(null);
      errors = Object.create(null);
    }

    function clearPreloadWork() {
      clearPrismWork();
      if (preloadTimer) root.clearTimeout(preloadTimer);
      preloadTimer = 0;
      clearQueuedPreloads();
    }

    function setPreload(next) {
      if (destroyed) return api;
      clearPreloadWork();
      preloadConfig = normalizePreload(next);
      if (preloadConfig) {
        schedule();
        scheduleConfiguredPreload();
      }
      emit('preloadchange', { preload: clonePreloadConfig(preloadConfig) });
      return api;
    }

    function preload(next) {
      if (destroyed) return api;
      if (arguments.length) return setPreload(next);
      if (!preloadConfig) return api;
      // Keep visible work in front even for an explicit zero-delay call.
      schedule();
      schedulePreload(preloadConfig);
      return api;
    }

    function getPreload() {
      return clonePreloadConfig(preloadConfig);
    }

    function getNavigation() {
      currentNavigation();
      return navigationSet ? cloneNavigation(navigation) : null;
    }

    function setNavigation(next) {
      if (destroyed) return api;
      var clearsNavigation = next == null;
      navigation = clearsNavigation ? defaultNavigation() : normalizeNavigation(next, navigation);
      navigationSet = !clearsNavigation;
      var delegatesToMap = typeof map.setNavigation === 'function';
      if (delegatesToMap) {
        map.setNavigation(clearsNavigation ? null : cloneNavigation(navigation));
        var mapState = readMapNavigation();
        if (mapState) {
          navigation = normalizeNavigation(mapState, navigation);
          navigationSet = true;
        } else navigationSet = false;
      } else if (navigation.follow && navigation.position && typeof map.setCenter === 'function') {
        map.setCenter(navigation.position);
      }
      if (!delegatesToMap) emit('navigationchange', { navigation: navigationSet ? cloneNavigation(navigation) : null });
      schedule();
      scheduleConfiguredPreload();
      return api;
    }

    function onMapChange(event) {
      if (event && event.type === 'zoom') zooming = true;
      schedule();
      scheduleConfiguredPreload();
    }

    function onZoomEnd() {
      zooming = false;
      schedule();
    }

    function onMapNavigation(event) {
      var state = navigationFromEvent(event);
      if (state === null) {
        navigation = defaultNavigation();
        navigationSet = false;
      } else if (state) {
        navigation = normalizeNavigation(state, navigation);
        navigationSet = true;
      }
      emit('navigationchange', { navigation: navigationSet ? cloneNavigation(navigation) : null });
      schedule();
      scheduleConfiguredPreload();
    }

    function setTiles(nextSource, nextOptions) {
      if (destroyed) return api;
      if (nextSource !== false && (!nextSource || (typeof nextSource !== 'string' && typeof nextSource !== 'function'))) {
        throw new Error('microMap.vector: tiles must be an MVT URL template or function (or false)');
      }
      nextSource = nextSource || null;
      nextOptions = nextOptions || {};
      if (nextOptions.subdomains != null && (typeof nextOptions.subdomains !== 'string' || !nextOptions.subdomains)) {
        throw new Error('microMap.vector: subdomains must be a non-empty string');
      }
      clearRequests();
      source = nextSource;
      sourceTms = nextOptions.scheme === 'tms';
      if (styleDocument && style.report && styleDocument.sources && own(styleDocument.sources, style.report.source) && typeof nextSource === 'string') {
        styleDocument.sources[style.report.source].tiles = [nextSource];
        if (sourceTms || styleDocument.sources[style.report.source].scheme != null) styleDocument.sources[style.report.source].scheme = sourceTms ? 'tms' : 'xyz';
      }
      if (nextOptions.subdomains != null) subdomains = nextOptions.subdomains;
      if (nextOptions.minZoom != null) minZoom = clamp(Math.ceil(finite(nextOptions.minZoom, 0)), 0, 30);
      if (nextOptions.maxZoom != null) maxZoom = clamp(Math.floor(finite(nextOptions.maxZoom, 22)), minZoom, 30);
      removeSourceTiles(primarySourceID);
      rendered = null;
      tileJSON = nextOptions.tileJSON || null;
      emit('tileschange', { tiles: source });
      schedule();
      scheduleConfiguredPreload();
      return api;
    }

    function setStyle(nextStyle, nextOptions) {
      if (destroyed) return api;
      var settings = {};
      for (var key in options) settings[key] = options[key];
      if (nextOptions) for (key in nextOptions) settings[key] = nextOptions[key];
      var normalized = normalizeStyle(nextStyle, settings);
      if (mvtClusterSettings && typeof normalized === 'function') throw new Error('microMap.vector: clusterMVT requires a declarative style');
      clearRequests();
      for (var vectorID in extraVectors) if (extraVectors[vectorID].retryTimer) root.clearTimeout(extraVectors[vectorID].retryTimer);
      cache = Object.create(null);
      cacheBytes = 0;
      extraVectors = Object.create(null);
      style = normalized;
      heatFrames.clear();
      styleDocument = nextStyle && nextStyle.version === 8 ? cloneStyleValue(nextStyle, 0) : null;
      primarySourceID = typeof style !== 'function' && style.report ? style.report.source : null;
      if (styleDocument) sourceTms = (nextOptions && nextOptions.scheme != null ? nextOptions.scheme :
        styleDocument.sources && styleDocument.sources[primarySourceID] && styleDocument.sources[primarySourceID].scheme) === 'tms';
      styleVersion++;
      registerStyleSources();
      registerRasterSources();
      registerStyleVectors();
      if (typeof style !== 'function' && style.sprite) loadSprites(style.sprite);
      rendered = null;
      emit('stylechange', { style: style });
      schedule();
      return api;
    }

    function layerIndex(id) {
      if (typeof style !== 'function') for (var i = 0; i < style.length; i++) if (style[i].id === id) return i;
      return -1;
    }

    // MapLibre-shaped layer access for declarative styles. getLayer returns
    // a copy; changes recompile just that layer and rebuild its buckets.
    function getLayer(id) {
      var index = layerIndex(id);
      return index < 0 ? undefined : cloneStyleValue(style[index].raw, 0);
    }

    function updateLayer(id, change) {
      if (destroyed) return api;
      var index = layerIndex(id);
      if (index < 0) throw styleError('unknown style layer ' + String(id));
      var current = style[index];
      var raw = cloneStyleValue(current.raw, 0);
      var visibilityOnly = change(raw);
      if (sameStyleValue(current.raw, raw)) return api;
      var next = compileLayer(raw, current.index, current.v8, options.strict !== false, style.report);
      next.uid = current.uid;
      next.geojson = current.geojson;
      next.raster = current.raster;
      // A visibility switch keeps the layer's buckets and cached paths.
      next.version = visibilityOnly ? current.version : current.version + 1;
      style[index] = next;
      if (current.type !== 'heatmap' && current.type !== 'symbol' && current.type !== 'fill-extrusion') tiltStyleVersion++;
      rendered = null;
      schedule();
      return api;
    }

    function renumber() {
      tiltStyleVersion++;
      for (var i = 0; i < style.length; i++) {
        style[i].index = i;
        if (style[i].v8) style[i].priority = i;
      }
      style.symbolOrder = null;
      rendered = null;
      schedule();
    }

    function declarative(name) {
      if (typeof style === 'function') throw styleError(name + ' needs a declarative style');
    }

    function registerVectorSource(id, specification) {
      var next = cloneStyleValue(specification, 0);
      if (next.tiles != null && (!Array.isArray(next.tiles) || !next.tiles.length)) throw styleError('vector source ' + id + ' needs a non-empty tiles array');
      var tiles = Array.isArray(next.tiles) && next.tiles.length ? next.tiles[0] : null;
      if (!tiles && (typeof next.url !== 'string' || !next.url)) throw styleError('vector source ' + id + ' needs tiles or a TileJSON url');
      if (tiles && (typeof tiles !== 'string' || tiles.indexOf('{z}') < 0 || tiles.indexOf('{x}') < 0 || (tiles.indexOf('{y}') < 0 && tiles.indexOf('{-y}') < 0))) {
        throw styleError('vector source ' + id + ' needs an XYZ tile template');
      }
      if (own(extraVectors, id)) {
        cancelSourceRequests(id);
        removeSourceTiles(id);
      }
      var descriptor = {
        specification: next,
        tiles: tiles,
        tms: next.scheme === 'tms',
        minZoom: clamp(Math.ceil(finite(next.minzoom, 0)), 0, 30),
        maxZoom: clamp(Math.floor(finite(next.maxzoom, 22)), 0, 30),
        retryTimer: 0
      };
      descriptor.maxZoom = Math.max(descriptor.minZoom, descriptor.maxZoom);
      extraVectors[id] = descriptor;
      if (style.report) delete style.report.attributions[id];
      if (style.report && typeof next.attribution === 'string' && next.attribution) style.report.attributions[id] = next.attribution;
      if (tiles) { schedule(); return; }
      function loadMetadata() {
        if (destroyed || extraVectors[id] !== descriptor) return;
        var response;
        var request = transformed(next.url, 'Source');
        try { response = fetcher(request.url, requestOptionsFor(null, request)); }
        catch (error) { response = Promise.reject(error); }
        Promise.resolve(response).then(function (result) {
          if (!result || result.ok === false) {
            var error = styleError('TileJSON request failed' + (result && result.status ? ' (' + result.status + ')' : ''));
            error.status = result && +result.status;
            throw error;
          }
          return result.json();
        }).then(function (tilejson) {
          var template = vectorTileJSONTemplate(tilejson, next.url);
          if (destroyed || extraVectors[id] !== descriptor) return;
          descriptor.tiles = template;
          if (next.scheme == null) descriptor.tms = tilejson.scheme === 'tms';
          if (next.minzoom == null && tilejson.minzoom != null) descriptor.minZoom = clamp(Math.ceil(finite(tilejson.minzoom, 0)), 0, 30);
          if (next.maxzoom == null && tilejson.maxzoom != null) descriptor.maxZoom = clamp(Math.floor(finite(tilejson.maxzoom, 22)), descriptor.minZoom, 30);
          if (!next.attribution && typeof tilejson.attribution === 'string' && tilejson.attribution && style.report) style.report.attributions[id] = tilejson.attribution;
          emit('sourcedata', { source: id, tileJSON: tilejson });
          schedule();
        }).catch(function (error) {
          if (destroyed || extraVectors[id] !== descriptor) return;
          emit('sourceerror', { source: id, error: error });
          var status = error && +error.status;
          if ((error && (error.permanent || error.name === 'SyntaxError')) ||
              (status >= 400 && status < 500 && status !== 408 && status !== 429)) return;
          descriptor.retryTimer = root.setTimeout(function () {
            descriptor.retryTimer = 0;
            loadMetadata();
          }, retryDelay);
        });
      }
      loadMetadata();
    }

    // Further vector sources of a MapLibre style, beside the base source.
    function registerStyleVectors() {
      if (typeof style === 'function' || !style.vectors) return;
      for (var id in style.vectors) {
        if (own(extraVectors, id)) continue;
        try {
          registerVectorSource(id, style.vectors[id]);
        } catch (error) {
          emit('sourceerror', { source: id, error: error });
        }
      }
    }

    // MapLibre-shaped sources share this ordered
    // style canvas with the base vector source.
    function addSource(id, specification) {
      if (destroyed) return api;
      declarative('addSource');
      if (typeof id !== 'string' || !id) throw styleError('a source needs a non-empty id');
      if (own(geojsonSources, id) || own(rasterSources, id) || own(extraVectors, id) || id === primarySourceID) throw styleError('source already exists: ' + id);
      if (!specification || (specification.type !== 'geojson' && specification.type !== 'raster' && specification.type !== 'raster-dem' && specification.type !== 'vector')) {
        throw styleError('addSource supports GeoJSON, raster, raster-dem and vector sources');
      }
      if (specification.type === 'vector') registerVectorSource(id, specification);
      else if (specification.type === 'raster' || specification.type === 'raster-dem') registerRasterSource(id, specification);
      else setSourceData(id, specification.data, specification);
      if (styleDocument) styleDocument.sources[id] = cloneStyleValue(specification, 0);
      return api;
    }

    function getSource(id) {
      if (own(extraVectors, id)) {
        var vectorSource = extraVectors[id];
        var result = cloneStyleValue(vectorSource.specification, 0);
        result.serialize = function () { return own(extraVectors, id) ? cloneStyleValue(extraVectors[id].specification, 0) : undefined; };
        result.setTiles = function (tiles) {
          if (!own(extraVectors, id) || destroyed) return result;
          if (!Array.isArray(tiles) || !tiles.length || typeof tiles[0] !== 'string') throw styleError('setTiles needs a non-empty tile array');
          var next = cloneStyleValue(extraVectors[id].specification, 0);
          next.tiles = tiles.slice();
          if (next.scheme == null && extraVectors[id].tms) next.scheme = 'tms';
          registerVectorSource(id, next);
          if (styleDocument) styleDocument.sources[id] = cloneStyleValue(next, 0);
          result.tiles = tiles.slice();
          return result;
        };
        return result;
      }
      if (typeof style !== 'function' && style.report && id === style.report.source) {
        var vector = styleDocument && styleDocument.sources && own(styleDocument.sources, id)
          ? cloneStyleValue(styleDocument.sources[id], 0) : { type: 'vector' };
        vector.type = 'vector';
        if (!Array.isArray(vector.tiles) && typeof source === 'string') vector.tiles = [source];
        vector.serialize = function () {
          var current = styleDocument && styleDocument.sources && own(styleDocument.sources, id)
            ? cloneStyleValue(styleDocument.sources[id], 0) : { type: 'vector' };
          if (typeof source === 'string') current.tiles = [source];
          return current;
        };
        vector.setTiles = function (tiles) {
          if (!Array.isArray(tiles) || !tiles.length || typeof tiles[0] !== 'string') throw styleError('setTiles needs a non-empty tile array');
          setTiles(tiles[0], { scheme: sourceTms ? 'tms' : 'xyz' });
          vector.tiles = tiles.slice();
          return vector;
        };
        return vector;
      }
      if (own(rasterSpecifications, id)) {
        var raster = cloneStyleValue(rasterSpecifications[id], 0);
        raster.serialize = function () { return own(rasterSpecifications, id) ? cloneStyleValue(rasterSpecifications[id], 0) : undefined; };
        raster.setTiles = function (tiles) {
          if (destroyed || !own(rasterSpecifications, id)) return raster;
          if (!Array.isArray(tiles) || !tiles.length || typeof tiles[0] !== 'string') throw styleError('setTiles needs a non-empty tile array');
          var next = cloneStyleValue(rasterSpecifications[id], 0);
          next.tiles = tiles.slice();
          if (next.scheme == null && rasterSources[id].tms) next.scheme = 'tms';
          registerRasterSource(id, next);
          raster.tiles = tiles.slice();
          if (styleDocument && styleDocument.sources && own(styleDocument.sources, id)) styleDocument.sources[id] = cloneStyleValue(next, 0);
          rendered = null;
          schedule();
          return raster;
        };
        return raster;
      }
      if (!own(geojsonSources, id)) return undefined;
      var source = {
        type: 'geojson',
        setData: function (data) {
          if (!destroyed && own(geojsonSources, id)) setSourceData(id, data);
          return source;
        },
        getData: function () { return own(geojsonSources, id) ? cloneStyleValue(geojsonSources[id].data, 0) : undefined; },
        // The zoom at which a cluster splits into more than one child.
        getClusterExpansionZoom: function (clusterId, callback) {
          return clusterAnswer(id, function (run) {
            var cluster = clusterById(run, clusterId);
            var zoom = cluster.zoom;
            while (cluster.children && cluster.children.length === 1 && cluster.children[0].children) { cluster = cluster.children[0]; zoom = cluster.zoom; }
            return Math.min(zoom + 1, run.maxZoom + 1);
          }, callback);
        },
        getClusterChildren: function (clusterId, callback) {
          return clusterAnswer(id, function (run) { return clusterById(run, clusterId).children.map(clusterFeature); }, callback);
        },
        getClusterLeaves: function (clusterId, limit, offset, callback) {
          return clusterAnswer(id, function (run) {
            var leaves = clusterLeaves(clusterById(run, clusterId), []);
            var start = Math.max(0, Math.floor(finite(offset, 0)));
            return leaves.slice(start, start + (limit == null ? 10 : Math.max(0, Math.floor(limit)))).map(clusterFeature);
          }, callback);
        }
      };
      return source;
    }

    function removeSource(id) {
      if (destroyed || (!own(geojsonSources, id) && !own(rasterSources, id) && !own(extraVectors, id))) return api;
      for (var i = 0; i < style.length; i++) if (style[i].geojson === id || style[i].raster === id || style[i].source === id) throw styleError('remove layers before their source: ' + id);
      if (own(extraVectors, id)) {
        cancelSourceRequests(id);
        removeSourceTiles(id);
        delete extraVectors[id];
        if (style.report) delete style.report.attributions[id];
      } else if (own(rasterSources, id)) {
        removeRasterTiles(id);
        delete rasterSources[id];
        delete rasterSpecifications[id];
        delete rasterZoom[id];
        if (style.report) delete style.report.attributions[id];
      } else delete geojsonSources[id];
      if (styleDocument && styleDocument.sources) delete styleDocument.sources[id];
      return api;
    }

    function addLayer(specification, beforeID) {
      if (destroyed) return api;
      declarative('addLayer');
      if (!specification || typeof specification.id !== 'string' || !specification.id) throw styleError('a layer needs a non-empty id');
      if (layerIndex(specification.id) >= 0) throw styleError('layer already exists: ' + specification.id);
      var at = beforeID == null ? style.length : layerIndex(beforeID);
      if (at < 0) throw styleError('before layer does not exist: ' + beforeID);
      var raw = cloneStyleValue(specification, 0);
      var geojson = raw.source != null && own(geojsonSources, raw.source);
      var raster = raw.source != null && own(rasterSources, raw.source);
      if (raw.type !== 'background' && raw.source != null && !geojson && !raster && !own(extraVectors, raw.source) && raw.source !== style.report.source) {
        throw styleError('layer ' + raw.id + ' uses an unknown source ' + String(raw.source));
      }
      var dem = raster && !!rasterSources[raw.source].dem;
      if (raster !== rasterLayer(raw.type) || (raster && dem !== demLayer(raw.type))) {
        throw styleError('layer ' + raw.id + ' needs a matching raster source and layer type');
      }
      var layer = compileLayer(raw, at, true, options.strict !== false, style.report);
      if (geojson) layer.geojson = raw.source;
      if (raster) layer.raster = raw.source;
      style.splice(at, 0, layer);
      renumber();
      return api;
    }

    function removeLayer(id) {
      if (destroyed) return api;
      var index = layerIndex(id);
      if (index >= 0) {
        extrusionCaches.delete(style[index].uid);
        heatFrames.delete(style[index].uid);
        style.splice(index, 1);
        renumber();
      }
      return api;
    }

    function moveLayer(id, beforeID) {
      if (destroyed) return api;
      var index = layerIndex(id);
      if (index < 0) throw styleError('unknown style layer ' + String(id));
      var layer = style.splice(index, 1)[0];
      var at = beforeID == null ? style.length : layerIndex(beforeID);
      if (at < 0) {
        style.splice(index, 0, layer);
        throw styleError('before layer does not exist: ' + beforeID);
      }
      style.splice(at, 0, layer);
      renumber();
      return api;
    }

    function setProperty(kind) {
      return function (id, name, value) {
        return updateLayer(id, function (raw) {
          var group = raw[kind];
          if (value === undefined) { if (group) delete group[name]; }
          else (group || (raw[kind] = {}))[name] = cloneStyleValue(value, 0);
          return name === 'visibility';
        });
      };
    }

    function setProperties(kind) {
      return function (id, patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw styleError(kind + ' patch must be an object');
        var names = Object.keys(patch);
        if (!names.length) return api;
        return updateLayer(id, function (raw) {
          var group = raw[kind];
          var visibilityOnly = kind === 'layout';
          for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (patch[name] === undefined) {
              if (group && own(group, name)) {
                if (name !== 'visibility') visibilityOnly = false;
                delete group[name];
              }
            }
            else {
              var value = cloneStyleValue(patch[name], 0);
              if ((!group || !own(group, name) || !sameStyleValue(group[name], value)) && name !== 'visibility') visibilityOnly = false;
              if (!group) group = raw[kind] = {};
              group[name] = value;
            }
          }
          return visibilityOnly;
        });
      };
    }

    function getProperty(kind) {
      return function (id, name) {
        var layer = getLayer(id);
        return layer && layer[kind] ? layer[kind][name] : undefined;
      };
    }

    function on(type, handler) {
      if (!destroyed && typeof handler === 'function') (listeners[type] || (listeners[type] = [])).push(handler);
      return api;
    }

    function off(type, handler) {
      var list = listeners[type];
      if (!list) return api;
      if (!handler) delete listeners[type];
      else {
        var index = list.indexOf(handler);
        if (index > -1) list.splice(index, 1);
      }
      return api;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      clearRequests();
      for (var vectorID in extraVectors) if (extraVectors[vectorID].retryTimer) root.clearTimeout(extraVectors[vectorID].retryTimer);
      releasePool(decoder);
      decoder = null;
      rasterTiles.forEach(function (tile) { if (tile.image) tile.image.onload = tile.image.onerror = null; });
      rasterTiles.clear();
      shadePreparations.clear();
      shadePreparationBytes = 0;
      heatFrames.clear();
      map.off('load', onMapChange).off('move', onMapChange).off('zoom', onMapChange).off('zoomend', onZoomEnd).off('rotate', onMapChange).off('pitch', onMapChange).off('resize', onMapChange).off('navigationchange', onMapNavigation).off('destroy', destroy);
      if (canvas.parentNode === container) container.removeChild(canvas);
      if (tiltHost) {
        hideTilt();
        if (tiltHost.parentNode === container) container.removeChild(tiltHost);
      }
      if (glCanvas) {
        releaseMeshes(null);
        if (glCanvas.parentNode === container) container.removeChild(glCanvas);
        var lose = glState && glState.gl.getExtension && glState.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        glCanvas = glState = null;
      }
      cache = Object.create(null);
      rendered = null;
      listeners = Object.create(null);
    }

    var api = {
      setTiles: setTiles,
      setStyle: setStyle,
      setPreload: setPreload,
      preload: preload,
      getPreload: getPreload,
      setNavigation: setNavigation,
      getNavigation: getNavigation,
      queryRenderedFeatures: queryRenderedFeatures,
      querySourceFeatures: querySourceFeatures,
      // Diagnostics of the renderer's current work, for tooling and tests.
      getRenderStats: function () {
        var stats = { mode: tiltHost && tiltHost.style.display !== 'none' && rendered && rendered.metrics.camera ? 'tilted' : 'flat',
          cells: 0, painted: 0, incomplete: 0, cachedTiles: 0, pendingTiles: queue.length + active, rasterTiles: rasterTiles.size, rasterLoading: rasterLoading, meshes: meshes.size,
          frames: renderFrames, renderMs: renderDuration, demMs: shadeSpent, groundMs: groundDuration, heatMs: heatDuration,
          labelMs: labelDuration, maxCellMs: maxCellDuration };
        tiltCells.forEach(function (cell) {
          stats.cells++;
          if (cell.painted) stats.painted++;
          if (cell.incomplete) stats.incomplete++;
        });
        for (var key in cache) stats.cachedTiles++;
        return stats;
      },
      redraw: function () { schedule(); scheduleConfiguredPreload(); return api; },
      on: on,
      off: off,
      destroy: destroy,
      getCanvas: function () { return canvas; },
      getTileJSON: function () { return tileJSON; },
      getLayer: getLayer,
      addSource: addSource,
      getSource: getSource,
      removeSource: removeSource,
      addLayer: addLayer,
      removeLayer: removeLayer,
      moveLayer: moveLayer,
      getLayers: function () {
        return typeof style === 'function' ? [] : style.map(function (layer) { return cloneStyleValue(layer.raw, 0); });
      },
      getStyle: function () {
        if (!styleDocument) return undefined;
        var snapshot = cloneStyleValue(styleDocument, 0);
        snapshot.layers = api.getLayers();
        for (var id in geojsonSources) {
          if (own(snapshot.sources, id)) snapshot.sources[id].data = geojsonSources[id].url || cloneStyleValue(geojsonSources[id].data, 0);
        }
        for (id in rasterSpecifications) {
          if (own(snapshot.sources, id)) snapshot.sources[id] = cloneStyleValue(rasterSpecifications[id], 0);
        }
        return snapshot;
      },
      areTilesLoaded: function () {
        if (destroyed || frame) return false;
        // Source documents precede tile requests; an empty source while its
        // GeoJSON or DEM TileJSON loads must not make the map appear idle.
        for (var sourceID in geojsonSources) if (geojsonSources[sourceID].loading) return false;
        for (sourceID in rasterSources) if (rasterSources[sourceID].loading) return false;
        if (tiltHost && tiltHost.style.display !== 'none' && rendered && rendered.metrics.camera) return tiltComplete && rasterLoading === 0;
        var metrics = mapMetrics();
        var zoom = currentTileZoom(metrics);
        if (zoom != null) {
          var tiles = visibleTiles(zoom, 0, metrics);
          for (var i = 0; i < tiles.length; i++) if (!cache[canonicalKey(tiles[i].z, tiles[i].x, tiles[i].y)]) return false;
        }
        for (var id in extraVectors) {
          var vector = extraVectors[id];
          if (!sourceHasVisibleLayer(id, metrics)) continue;
          var sourceZoom = sourceTileZoom(vector, metrics);
          if (sourceZoom == null) continue;
          if (!vector.tiles) return false;
          var sourceTiles = visibleTiles(sourceZoom, 0, metrics);
          for (var t = 0; t < sourceTiles.length; t++) {
            if (!cache[sourceKey(id, sourceTiles[t].z, sourceTiles[t].x, sourceTiles[t].y)]) return false;
          }
        }
        return rasterLoading === 0;
      },
      setPaintProperty: setProperty('paint'),
      setLayoutProperty: setProperty('layout'),
      setPaintProperties: setProperties('paint'),
      setLayoutProperties: setProperties('layout'),
      getPaintProperty: getProperty('paint'),
      getLayoutProperty: getProperty('layout'),
      setFilter: function (id, filter) {
        return updateLayer(id, function (raw) {
          if (filter == null) delete raw.filter;
          else raw.filter = cloneStyleValue(filter, 0);
        });
      },
      getFilter: function (id) { var layer = getLayer(id); return layer ? layer.filter : undefined; },
      setLayerZoomRange: function (id, minzoom, maxzoom) {
        return updateLayer(id, function (raw) {
          if (raw.minzoom === minzoom && raw.maxzoom === maxzoom) return true;
          raw.minzoom = minzoom;
          raw.maxzoom = maxzoom;
          return true;
        });
      },
      setFeatureState: setFeatureState,
      getFeatureState: function (feature) {
        var state = featureStates.get(featureTarget(feature));
        return state ? cloneStyleValue(state, 0) : {};
      },
      removeFeatureState: removeFeatureState,
      addImage: addImage,
      updateImage: updateImage,
      hasImage: function (id) { return images.has(String(id)); },
      removeImage: function (id) { images.delete(String(id)); imageVersion++; schedule(); return api; },
      listImages: function () { return Array.from(images.keys()); },
      getStyleReport: function () {
        var report = typeof style === 'function' ? null : style.report;
        return report ? cloneStyleValue(report, 0) : null;
      }
    };

    registerStyleSources();
    registerRasterSources();
    registerStyleVectors();
    if (typeof style !== 'function' && style.sprite) loadSprites(style.sprite);
    map.on('load', onMapChange).on('move', onMapChange).on('zoom', onMapChange).on('zoomend', onZoomEnd).on('rotate', onMapChange).on('pitch', onMapChange).on('resize', onMapChange).on('navigationchange', onMapNavigation).on('destroy', destroy);
    schedule();
    scheduleConfiguredPreload();
    return api;
  }

  // Evaluates a MapLibre expression (or legacy function) for one feature:
  // { properties, id, geometryType, state, zoom }. Useful for tooling and
  // for checking what a style will draw.
  vectorMap.evaluateExpression = function (expression, input) {
    input = input || {};
    // With `property`, the value compiles like that style property: legacy
    // functions and "{token}" strings included.
    var node = input.property ? compileProperty(String(input.property), expression)
      : isExpression(expression) ? compileExpression(expression, 0, Object.create(null)) : constantNode(expression);
    var types = { Point: 1, LineString: 2, Polygon: 3 };
    var feature = { properties: input.properties || {}, id: input.id == null ? null : input.id, type: types[input.geometryType] || 1, _state: input.state || null };
    return node.fn({ zoom: input.zoom == null ? 0 : +input.zoom, feature: feature });
  };
  vectorMap.shadeDEM = shadeDEM;
  vectorMap.reliefDEM = function (data, encoding, layer) {
    return reliefDEM(data, encoding, reliefStops(compileLayer(layer, 0, true, true, null)));
  };
  vectorMap.decodeMVT = decodeMVT;
  vectorMap.workerMessage = workerMessage;
  vectorMap.basicStyle = basicStyle;
  // Preserve the earlier name for existing integrations.
  vectorMap.tinyTilesStyle = basicStyle;
  vectorMap.fromTileJSON = function (map, url, options) {
    options = options || {};
    var fetcher = options.fetch || root.fetch;
    var tileJSONBase = url;
    try {
      if (typeof root.URL === 'function' && root.location && root.location.href) {
        tileJSONBase = new root.URL(url, root.location.href).href;
      }
    } catch (error) {}
    if (typeof fetcher !== 'function') return Promise.reject(new Error('microMap.vector: fetch is required to load TileJSON'));
    var request = { url: url };
    if (typeof options.transformRequest === 'function') {
      var changed = options.transformRequest(url, 'Source');
      if (typeof changed === 'string') request.url = changed;
      else if (changed) request = { url: changed.url || url, headers: changed.headers, credentials: changed.credentials };
    }
    var init = options.tileJSONFetchOptions || null;
    if (request.headers || request.credentials) {
      init = Object.assign({}, init || {});
      if (request.headers) init.headers = request.headers;
      if (request.credentials) init.credentials = request.credentials;
    }
    return Promise.resolve(fetcher(request.url, init)).then(function (response) {
      if (!response || response.ok === false) throw new Error('microMap.vector: TileJSON request failed' + (response && response.status ? ' (' + response.status + ')' : ''));
      return response.json();
    }).then(function (tilejson) {
      var resolvedTemplate = vectorTileJSONTemplate(tilejson, tileJSONBase);
      var settings = {};
      var key;
      for (key in options) if (key !== 'tileJSONFetchOptions') settings[key] = options[key];
      settings.tiles = resolvedTemplate;
      if (settings.scheme == null) settings.scheme = tilejson.scheme;
      if (settings.minZoom == null && tilejson.minzoom != null) settings.minZoom = tilejson.minzoom;
      if (settings.maxZoom == null && tilejson.maxzoom != null) settings.maxZoom = tilejson.maxzoom;
      settings.tileJSON = tilejson;
      return vectorMap(map, settings);
    });
  };

  // Renders a MapLibre style (version 8): its background, vector, GeoJSON
  // and raster/raster-dem sources. Layers of unsupported sources (image,
  // video, canvas) are listed in getStyleReport().skippedLayers. The first vector
  // source (or options.source) is the base source; a style without any
  // vector source renders its GeoJSON and raster sources alone.
  // `transformRequest(url, kind)` rewrites requests like MapLibre's hook.
  vectorMap.fromStyle = function (map, style, options) {
    options = options || {};
    if (!style || style.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
      return Promise.reject(styleError('fromStyle needs a MapLibre style (version 8)'));
    }
    var sourceID = options.source;
    for (var id in style.sources) {
      if (!sourceID && own(style.sources, id) && style.sources[id] && style.sources[id].type === 'vector') sourceID = id;
    }
    var source = sourceID && own(style.sources, sourceID) ? style.sources[sourceID] : null;
    if (sourceID && (!source || source.type !== 'vector')) return Promise.reject(styleError('style has no vector source ' + String(sourceID)));
    var settings = {};
    for (var key in options) settings[key] = options[key];
    settings.style = style;
    try {
      if (!source) {
        settings.tiles = false;
        return Promise.resolve(vectorMap(map, settings));
      }
      settings.source = sourceID;
      if (settings.scheme == null) settings.scheme = source.scheme;
      if (settings.minZoom == null && source.minzoom != null) settings.minZoom = source.minzoom;
      if (settings.maxZoom == null && source.maxzoom != null) settings.maxZoom = source.maxzoom;
      if (Array.isArray(source.tiles) && typeof source.tiles[0] === 'string') {
        settings.tiles = source.tiles[0];
        return Promise.resolve(vectorMap(map, settings));
      }
      if (typeof source.url !== 'string' || !source.url) throw styleError('vector source ' + sourceID + ' needs tiles or a TileJSON url');
      return vectorMap.fromTileJSON(map, source.url, settings);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  // Inside the decoder worker started above, answer decode requests.
  if (typeof root.importScripts === 'function' && typeof root.document === 'undefined' && root.name === WORKER_NAME && typeof root.postMessage === 'function') {
    root.onmessage = function (event) {
      var reply = workerMessage(event.data);
      root.postMessage(reply.message, reply.transfer);
    };
  }

  if (typeof microMap === 'function' && !microMap.vector) microMap.vector = vectorMap;
  return vectorMap;
});
