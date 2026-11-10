'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const formats = require('../lib/microMap.formats.js');

const point = (coordinates = [12, 48]) => ({ type: 'Point', coordinates });
const feature = (id, geometry = point()) => ({ type: 'Feature', id, properties: { label: 'München\n中心' }, geometry });
const sequence = records => records.map(record => '\u001e' + JSON.stringify(record) + '\n').join('');
const topology = (objects, arcs = [], extra = {}) => ({ type: 'Topology', objects, arcs, ...extra });

test('TopoJSON transforms delta arcs, joins endpoints and reverses negative references', () => {
  const data = topology({
    forward: { type: 'LineString', id: 0, properties: { name: 'Route' }, arcs: [0, 1] },
    reverse: { type: 'LineString', arcs: [-2, -1] }
  }, [
    [[0, 0, 100], [10, 0, 101]],
    [[10, 0, 101], [0, 2, 102]]
  ], { transform: { scale: [.1, .5], translate: [10, 40] } });
  const original = structuredClone(data), converted = formats.topojson(data);
  const expected = [[10, 40, 100], [11, 40, 101], [11, 41, 102]];
  assert.deepEqual(converted.features[0], { type: 'Feature', id: 0, properties: { name: 'Route' }, geometry: { type: 'LineString', coordinates: expected } });
  assert.deepEqual(converted.features[1].geometry.coordinates, expected.slice().reverse());
  converted.features[0].geometry.coordinates[1][0] = 80;
  converted.features[0].properties.name = 'Changed';
  assert.deepEqual(data, original, 'input is not mutated by decoding or result edits');
  assert.equal(converted.features[1].geometry.coordinates[1][0], 11, 'shared arcs do not alias output coordinates');
});

test('unquantized TopoJSON arcs retain absolute coordinates', () => {
  const data = topology({ route: { type: 'LineString', arcs: [0] } }, [[[1, 1], [2, 3], [4, 7]]]);
  assert.deepEqual(formats.parse(JSON.stringify(data)).features[0].geometry.coordinates, [[1, 1], [2, 3], [4, 7]]);
});

test('TopoJSON Point and MultiPoint transforms never accumulate deltas or transform z', () => {
  const data = topology({
    points: { type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: [20, 2, 7] },
      { type: 'MultiPoint', coordinates: [[20, 2, 7], [20, 2, 9]] }
    ] }
  }, [], { transform: { scale: [.1, .5], translate: [10, 40] } });
  const converted = formats.topojson(data).features;
  assert.deepEqual(converted[0].geometry, point([12, 41, 7]));
  assert.deepEqual(converted[1].geometry.coordinates, [[12, 41, 7], [12, 41, 9]]);
});

test('TopoJSON joins polygon rings and preserves holes, multilines and multipolygons', () => {
  const arcs = [
    [[0, 0], [4, 0]], [[4, 0], [4, 4]], [[4, 4], [0, 4]], [[0, 4], [0, 0]],
    [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]
  ];
  const data = topology({
    area: { type: 'Polygon', arcs: [[0, 1, 2, 3], [4]] },
    areas: { type: 'MultiPolygon', arcs: [[[0, 1, 2, 3], [4]]] },
    lines: { type: 'MultiLineString', arcs: [[0, 1], [-4, -3]] }
  }, arcs);
  const converted = formats.topojson(data).features;
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  assert.deepEqual(converted[0].geometry.coordinates, [outer, arcs[4]]);
  assert.deepEqual(converted[1].geometry.coordinates, [[outer, arcs[4]]]);
  assert.deepEqual(converted[2].geometry.coordinates, [[[0, 0], [4, 0], [4, 4]], [[0, 0], [0, 4], [4, 4]]]);
});

test('TopoJSON selection preserves names, feature metadata and untransformed bounding boxes', () => {
  const data = topology({
    first: { type: 'Point', id: 'a', properties: null, coordinates: [0, 0], bbox: [10, 40, 10, 40] },
    second: { type: 'GeometryCollection', geometries: [
      { type: 'GeometryCollection', id: 'group', properties: { title: 'Stops' }, geometries: [point([10, 2])] }
    ] }
  }, [], { bbox: [10, 40, 11, 41], transform: { scale: [.1, .5], translate: [10, 40] } });
  const all = formats.topojson(data);
  assert.deepEqual(all.bbox, data.bbox);
  assert.deepEqual(all.features[0].bbox, [10, 40, 10, 40]);
  assert.deepEqual(all.features[0].geometry.bbox, [10, 40, 10, 40]);
  assert.equal(all.features[0].properties, null);
  assert.equal(all.features[1].id, 'group');
  assert.deepEqual(all.features[1].geometry, { type: 'GeometryCollection', geometries: [point([11, 41])] });
  assert.deepEqual(formats.topojson(data, { object: 'first' }).features, [all.features[0]]);
  assert.equal(formats.topojson(data, { object: 'first' }).bbox, undefined, 'a subset does not inherit the complete topology bounds');
  assert.deepEqual(formats.parse(data, { object: ['second', 'first'] }).features, all.features.slice().reverse());
  assert.throws(() => formats.topojson(data, { object: 'missing' }), /unknown TopoJSON object missing/);
});

test('TopoJSON rejects broken transforms, references and disconnected or open arcs', () => {
  const route = { route: { type: 'LineString', arcs: [0] } };
  for (const transform of [{}, { scale: [1], translate: [0, 0] }, { scale: [Infinity, 1], translate: [0, 0] }]) {
    assert.throws(() => formats.topojson(topology(route, [[[0, 0], [1, 1]]], { transform })), /transform/);
  }
  for (const index of [1, -2, 0.5, 2147483648]) {
    assert.throws(() => formats.topojson(topology({ route: { type: 'LineString', arcs: [index] } }, [[[0, 0], [1, 1]]])), /arc index/);
  }
  assert.throws(() => formats.topojson(topology({ route: { type: 'LineString', arcs: [0, 1] } }, [[[0, 0], [1, 1]], [[3, 3], [4, 4]]])), /share an endpoint/);
  assert.throws(() => formats.topojson(topology({ area: { type: 'Polygon', arcs: [[0]] } }, [[[0, 0], [1, 0], [1, 1], [0, 1]]])), /not closed/);
  assert.throws(() => formats.topojson(topology(route, [[[0, 0], [.5, 1]]], { transform: { scale: [1, 1], translate: [0, 0] } })), /integer/);
  assert.deepEqual(formats.topojson(topology({ empty: { type: null, id: 'empty' } })).features[0], {
    type: 'Feature', id: 'empty', properties: {}, geometry: null
  });
  assert.throws(() => formats.topojson(topology({ group: { type: 'GeometryCollection', geometries: [
    { type: 'GeometryCollection', geometries: [{ type: null }] }
  ] } })), /must be geometries/, 'null geometry is allowed on a Feature but not inside GeometryCollection.geometries');
});

test('GeoJSON sequences read mixed objects, pretty printing, Unicode and null geometry', () => {
  const original = feature('null', null);
  const input = '\u001e' + JSON.stringify(point(), null, 2) + '\n' + sequence([
    feature('first'), { type: 'FeatureCollection', features: [original] }, { type: 'GeometryCollection', geometries: [point([13, 49])] }
  ]);
  const converted = formats.geojsonSeq(input);
  assert.equal(converted.features.length, 4);
  assert.deepEqual(converted.features[0], { type: 'Feature', properties: {}, geometry: point() });
  assert.deepEqual(converted.features[1], feature('first'));
  assert.deepEqual(converted.features[2], original);
  assert.deepEqual(converted.features[3].geometry, { type: 'GeometryCollection', geometries: [point([13, 49])] });
  assert.deepEqual(formats.parse(input), converted, 'record separators enable automatic detection');
  assert.deepEqual(formats.parse(input, { format: 'geojson-seq' }), converted);
});

test('GeoJSON sequences report invalid records and recover only when requested', () => {
  const text = sequence([feature('first')]) + '\u001e{"type":\n' + sequence([feature('third')]);
  assert.throws(() => formats.geojsonSeq(text), /record 2/);
  const failures = [];
  const converted = formats.geojsonSeq(text, { onError(error, index) { failures.push({ error, index }); } });
  assert.deepEqual(converted.features.map(value => value.id), ['first', 'third']);
  assert.equal(failures.length, 1); assert.equal(failures[0].index, 2);
  assert.equal(failures[0].error.record, 2);
  assert.match(failures[0].error.message, /record 2/);
});

test('GeoJSON sequence recovery is atomic for malformed collections', () => {
  const invalid = { type: 'FeatureCollection', features: [feature('partial'), feature('bad', { type: 'Point', coordinates: ['x', 1] })] };
  const converted = formats.geojsonSeq(sequence([invalid, feature('complete')]), { maxFeatures: 2, maxCoordinates: 2, onError() {} });
  assert.deepEqual(converted.features.map(value => value.id), ['complete']);
});

test('GeoJSON sequences use RS boundaries and accept repeated separators or a missing final LF', () => {
  assert.deepEqual(formats.geojsonSeq(''), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(formats.geojsonSeq('\u001e\u001e' + JSON.stringify(feature(1))).features, [feature(1)]);
  assert.throws(() => formats.geojsonSeq(JSON.stringify(feature(1)) + '\n' + JSON.stringify(feature(2))), /record separator/);
  assert.throws(() => formats.geojsonSeq('\u001e23\n'), /GeoJSON object/);
  assert.throws(() => formats.geojsonSeq('\u001enull\n'), /GeoJSON object/);
  assert.throws(() => formats.geojsonSeq('\u001e{}\n'), /geometry type/);
});

test('ordinary GeoJSON is normalized to independent FeatureCollections', () => {
  const input = JSON.parse('{"type":"Feature","id":0,"properties":{"__proto__":{"polluted":true},"nested":{"value":1}},"geometry":{"type":"Point","coordinates":[12,48,500]},"custom":"value"}');
  const converted = formats.parse(input, { format: 'geojson' });
  assert.deepEqual(converted.features[0], input);
  assert.equal(Object.getPrototypeOf(converted.features[0].properties), Object.prototype);
  assert.equal(Object.hasOwn(converted.features[0].properties, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  converted.features[0].properties.nested.value = 7;
  converted.features[0].geometry.coordinates[0] = 70;
  assert.equal(input.properties.nested.value, 1); assert.equal(input.geometry.coordinates[0], 12);
  assert.deepEqual(formats.parse(JSON.stringify(input)).features, [input]);
});

test('format conversion enforces feature, coordinate and nesting limits', () => {
  assert.throws(() => formats.parse({ type: 'FeatureCollection', features: [feature(1), feature(2)] }, { maxFeatures: 1 }), /feature limit/);
  assert.throws(() => formats.parse({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, { maxCoordinates: 1 }), /coordinate limit/);
  assert.throws(() => formats.topojson(topology({ route: { type: 'LineString', arcs: [0, -1] } }, [[[0, 0], [1, 1]]]), { maxCoordinates: 2 }), /coordinate limit/);
  assert.throws(() => formats.geojsonSeq(sequence([feature(1), feature(2)]), { maxFeatures: 1, onError() {} }), /feature limit/, 'recovery does not bypass output limits');
  for (const maxFeatures of [0, -1, 1.2, '3', Infinity, 10000001]) assert.throws(() => formats.parse(point(), { maxFeatures }), /limits/);
  let nested = point();
  for (let i = 0; i < 34; i++) nested = { type: 'GeometryCollection', geometries: [nested] };
  assert.throws(() => formats.parse(nested), /nested too deeply/);
});

test('format parsers reject malformed GeoJSON and unsupported formats', () => {
  assert.throws(() => formats.parse('{'), /invalid JSON/);
  assert.throws(() => formats.parse(point(), { format: 'unknown' }), /unsupported format/);
  assert.throws(() => formats.topojson({ type: 'Topology', objects: {} }), /objects and arcs/);
  assert.throws(() => formats.parse({ type: 'Feature', properties: [] }), /geometry member/);
  assert.throws(() => formats.parse({ type: 'Feature', properties: [], geometry: null }), /properties/);
  assert.throws(() => formats.parse({ type: 'GeometryCollection', geometries: [null] }), /must be geometries/);
  assert.throws(() => formats.geojsonSeq({}, {}), /must be text/);
  assert.throws(() => formats.geojsonSeq('', { onError: true }), /must be a function/);
});

test('format helpers load without a renderer and attach to browser globals when available', () => {
  const source = fs.readFileSync(require.resolve('../lib/microMap.formats.js'), 'utf8');
  const standalone = {};
  vm.runInNewContext(source, standalone);
  assert.equal(typeof standalone.microMapFormats.parse, 'function');
  const attached = { microMap() {} };
  vm.runInNewContext(source, attached);
  assert.equal(attached.microMap.formats, attached.microMapFormats);
});
