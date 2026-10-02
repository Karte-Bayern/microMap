/*! microMap.mmt.js v0.3.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'), require('./microMap.vector.js'));
  else root.microMapMMT = factory(root, root.microMap, root.microMapVector);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap, vectorMap) {
  'use strict';

  var textDecoder = root.TextDecoder ? new root.TextDecoder('utf-8', { fatal: true }) : null;
  var MAX_SAFE = 9007199254740991;

  function fail(message) { throw new Error('microMap.mmt: ' + message); }
  function Reader(input, maximum) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
    this.end = this.bytes.length;
    this.maximum = maximum;
  }
  Reader.prototype.u8 = function () {
    if (this.pos >= this.end) fail('truncated tile');
    return this.bytes[this.pos++];
  };
  Reader.prototype.varint = function () {
    var value = 0;
    var multiplier = 1;
    for (var i = 0; i < 8; i++) {
      var byte = this.u8();
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) fail('integer exceeds the safe range');
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    fail('varint is too long');
  };
  Reader.prototype.signed = function () {
    var value = this.varint();
    value = value % 2 ? -(value + 1) / 2 : value / 2;
    if (Math.abs(value) > 4503599627370495) fail('signed integer exceeds the exact MMT range');
    return value;
  };
  Reader.prototype.f64 = function () {
    if (this.pos + 8 > this.end) fail('truncated float');
    var value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    if (!isFinite(value)) fail('non-finite numeric value');
    return value;
  };
  Reader.prototype.string = function () {
    var length = this.varint();
    if (length > this.maximum || this.pos + length > this.end) fail('invalid string length');
    var bytes = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    try {
      if (textDecoder) return textDecoder.decode(bytes);
      var encoded = '';
      for (var i = 0; i < bytes.length; i++) encoded += '%' + ('0' + bytes[i].toString(16)).slice(-2);
      return decodeURIComponent(encoded);
    } catch (error) { fail('invalid UTF-8 string'); }
  };
  Reader.prototype.bitmap = function (count) {
    var length = Math.ceil(count / 8);
    if (this.pos + length > this.end) fail('truncated null bitmap');
    var value = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  };
  Reader.prototype.present = function (bitmap, index) { return !!(bitmap[index >> 3] & (1 << (index & 7))); };

  function readColumn(reader, count) {
    var name = reader.string();
    if (!name) fail('property column name is empty');
    var type = reader.u8();
    if (type < 1 || type > 4) fail('unsupported property column type');
    var present = reader.bitmap(count);
    var dictionary = null;
    if (type === 4) {
      var dictionaryCount = reader.varint();
      if (dictionaryCount > count || dictionaryCount > reader.maximum) fail('string dictionary is too large');
      dictionary = new Array(dictionaryCount);
      for (var d = 0; d < dictionaryCount; d++) dictionary[d] = reader.string();
    }
    var values = new Array(count);
    for (var i = 0; i < count; i++) {
      if (!reader.present(present, i)) { values[i] = null; continue; }
      if (type === 1) {
        var boolean = reader.u8();
        if (boolean > 1) fail('invalid boolean value');
        values[i] = !!boolean;
      } else if (type === 2) values[i] = reader.signed();
      else if (type === 3) values[i] = reader.f64();
      else {
        var index = reader.varint();
        if (index >= dictionary.length) fail('string dictionary index is out of range');
        values[i] = dictionary[index];
      }
    }
    return { name: name, values: values };
  }

  function readLayer(reader, end, limits) {
    var outerEnd = reader.end;
    reader.end = end;
    var name = reader.string();
    if (!name) fail('layer name is empty');
    var extent = reader.varint();
    if (!extent || extent > 2147483647) fail('invalid layer extent');
    var count = reader.varint();
    if (count > limits.maxFeatures || limits.features + count > limits.maxFeatures) fail('tile has too many features');
    limits.features += count;
    var idType = reader.u8();
    if (idType > 3) fail('unsupported feature ID type');
    var ids = null;
    if (idType) {
      var idPresent = reader.bitmap(count);
      var idDictionary = null;
      if (idType === 3) {
        var idDictionaryCount = reader.varint();
        if (idDictionaryCount > count || idDictionaryCount > limits.maxStrings) fail('ID dictionary is too large');
        idDictionary = new Array(idDictionaryCount);
        for (var d = 0; d < idDictionaryCount; d++) idDictionary[d] = reader.string();
      }
      ids = new Array(count);
      for (var i = 0; i < count; i++) {
        if (!reader.present(idPresent, i)) { ids[i] = null; continue; }
        if (idType === 1) ids[i] = reader.signed();
        else if (idType === 2) ids[i] = reader.f64();
        else {
          var idIndex = reader.varint();
          if (idIndex >= idDictionary.length) fail('ID dictionary index is out of range');
          ids[i] = idDictionary[idIndex];
        }
      }
    }
    var columnCount = reader.varint();
    if (columnCount > limits.maxColumns) fail('layer has too many property columns');
    var columns = new Array(columnCount);
    var columnNames = Object.create(null);
    for (var c = 0; c < columnCount; c++) {
      columns[c] = readColumn(reader, count);
      if (columnNames[columns[c].name]) fail('duplicate property column');
      columnNames[columns[c].name] = true;
    }
    if (reader.pos + count > reader.end) fail('truncated geometry types');
    var types = reader.bytes.subarray(reader.pos, reader.pos + count);
    reader.pos += count;
    var features = new Array(count);
    for (var f = 0; f < count; f++) {
      var type = types[f];
      if (type < 1 || type > 3) fail('unsupported geometry type');
      var partCount = reader.varint();
      if (!partCount || partCount > limits.maxVertices) fail('invalid geometry part count');
      var parts = new Array(partCount);
      var x = 0; var y = 0;
      for (var p = 0; p < partCount; p++) {
        var vertexCount = reader.varint();
        if (vertexCount < (type === 1 ? 1 : type === 2 ? 2 : 3) || limits.vertices + vertexCount > limits.maxVertices) fail('invalid or oversized geometry part');
        limits.vertices += vertexCount;
        var positions = new Array(vertexCount);
        for (var v = 0; v < vertexCount; v++) {
          x += reader.signed(); y += reader.signed();
          if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < -2147483648 || x > 2147483647 || y < -2147483648 || y > 2147483647) fail('coordinate exceeds the supported integer range');
          positions[v] = [x, y];
        }
        parts[p] = positions;
      }
      var properties = Object.create(null);
      for (c = 0; c < columns.length; c++) if (columns[c].values[f] !== null) properties[columns[c].name] = columns[c].values[f];
      features[f] = { id: ids && ids[f], type: type, properties: properties, parts: parts };
    }
    if (reader.pos !== reader.end) fail('unexpected layer bytes');
    reader.end = outerEnd;
    return { name: name, extent: extent, features: features };
  }

  function decode(input, options) {
    options = options || {};
    var maximum = Math.min(67108864, Math.max(1024, +options.maxBytes || 4 * 1024 * 1024));
    var reader = new Reader(input, maximum);
    if (reader.bytes.length > maximum) fail('tile exceeds maxBytes');
    if (reader.bytes.length < 5 || reader.bytes[0] !== 77 || reader.bytes[1] !== 77 || reader.bytes[2] !== 84 || reader.bytes[3] !== 1) fail('invalid MMT v1 signature');
    reader.pos = 4;
    var layerCount = reader.varint();
    var maxLayers = Math.min(1024, Math.max(1, +options.maxLayers || 64));
    var limits = {
      maxFeatures: Math.min(500000, Math.max(1, +options.maxFeatures || 20000)),
      maxColumns: Math.min(4096, Math.max(1, +options.maxColumns || 256)),
      maxStrings: Math.min(1000000, Math.max(1, +options.maxStrings || 100000)),
      maxVertices: Math.min(2000000, Math.max(1, +options.maxVertices || 200000)),
      features: 0, vertices: 0
    };
    if (layerCount > maxLayers) fail('tile has too many layers');
    var layers = new Array(layerCount);
    for (var i = 0; i < layerCount; i++) {
      var length = reader.varint();
      if (length > maximum || reader.pos + length > reader.end) fail('invalid layer length');
      layers[i] = readLayer(reader, reader.pos + length, limits);
    }
    if (reader.pos !== reader.end) fail('unexpected bytes after tile');
    return { layers: layers };
  }

  function mmtMap(map, options) {
    if (typeof vectorMap !== 'function') throw new Error('microMap.mmt: load microMap.vector.js first');
    options = options || {};
    var settings = {};
    for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key)) settings[key] = options[key];
    settings.decodeTile = decode;
    return vectorMap(map, settings);
  }
  mmtMap.decode = decode;
  mmtMap.version = 1;
  if (typeof microMap === 'function' && !microMap.mmt) microMap.mmt = mmtMap;
  return mmtMap;
});
