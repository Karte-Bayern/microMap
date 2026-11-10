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

const osmData = elements => ({ version: 0.6, generator: 'Overpass API', elements });
const osmNode = (id, lon, lat, tags) => ({ type: 'node', id, lon, lat, ...(tags ? { tags } : {}) });
const osmWay = (id, nodes, tags) => ({ type: 'way', id, nodes, ...(tags ? { tags } : {}) });
const osmGeometry = coordinates => coordinates.map(([lon, lat]) => ({ lon, lat }));

test('OSM imports resolve ways independent of element order and keep type-scoped IDs and tags', () => {
  const data = osmData([
    osmWay(1, [1, 2], { highway: 'path', name: 'Isarweg' }),
    osmNode(1, 11.5, 48.1, { amenity: 'drinking_water', name: 'Brunnen' }), osmNode(2, 11.6, 48.2),
    osmNode(3, 12, 49)
  ]);
  const before = structuredClone(data), converted = formats.osm(data);
  assert.deepEqual(converted.features.map(value => value.id), ['way/1', 'node/1', 'node/3']);
  assert.deepEqual(converted.features[0].geometry, { type: 'LineString', coordinates: [[11.5, 48.1], [11.6, 48.2]] });
  assert.deepEqual(converted.features[0].properties, { highway: 'path', name: 'Isarweg' });
  assert.equal(formats.osm(data, { includeUntaggedNodes: true }).features.length, 4, 'helper node output can be requested');
  converted.features[0].properties.name = 'changed'; converted.features[0].geometry.coordinates[0][0] = 99;
  assert.deepEqual(data, before);
  assert.equal(converted.features[1].geometry.coordinates[0], 11.5, 'way vertices and node features are independent');
  assert.deepEqual(formats.parse(JSON.stringify(data)), formats.osm(data));
  assert.deepEqual(formats.parse(data, { format: 'osm' }), formats.osm(data));
});

test('OSM closed-way classification keeps roundabouts and area=no lines while filling buildings and land', () => {
  const coords = [[12, 48], [12.1, 48], [12.1, 48.1], [12, 48.1], [12, 48]];
  const tags = [{ building: 'yes' }, { landuse: 'forest' }, { natural: 'water' }, { area: 'yes', highway: 'pedestrian' },
    { highway: 'residential', junction: 'roundabout' }, { building: 'yes', area: 'no' }, { natural: 'coastline' }, { barrier: 'fence' }];
  const data = osmData(tags.map((tags, id) => ({ type: 'way', id, tags, geometry: osmGeometry(coords) })));
  const geometries = formats.osm(data).features.map(value => value.geometry);
  assert.deepEqual(geometries.map(value => value.type), ['Polygon', 'Polygon', 'Polygon', 'Polygon', 'LineString', 'LineString', 'LineString', 'LineString']);
  assert.deepEqual(geometries[0].coordinates, [coords]);
  assert.deepEqual(geometries[4].coordinates, coords);
});

test('OSM ways use endpoint node identity to determine closure when references are present', () => {
  const geometry = osmGeometry([[12, 48], [12.1, 48], [12, 48.1], [12, 48]]);
  const data = osmData([
    { type: 'way', id: 1, nodes: [1, 2, 3, 4], tags: { building: 'yes' }, geometry },
    { type: 'way', id: 2, nodes: [1, 2, 3, 1], tags: { building: 'yes' }, geometry },
    { type: 'way', id: 3, tags: { building: 'yes' }, geometry }
  ]);
  assert.deepEqual(formats.osm(data).features.map(feature => feature.geometry.type), ['LineString', 'Polygon', 'Polygon'],
    'coincident coordinates are insufficient when the endpoint node IDs differ');
});

test('OSM out geom rejects clipped or missing geometry instead of inventing center points', () => {
  for (const element of [
    { type: 'way', id: 1, tags: { building: 'yes' }, center: { lon: 12, lat: 48 } },
    { type: 'way', id: 2, nodes: [1, 2] },
    { type: 'way', id: 3, geometry: [{ lon: 12, lat: 48 }, null] },
    { type: 'node', id: 4, center: { lon: 12, lat: 48 } },
    { type: 'node', id: 5, lon: Infinity, lat: 48 },
    { type: 'node', id: 6, lon: 12, lat: 91 }
  ]) assert.throws(() => formats.osm(osmData([element])), /OSM element 1/);
});

test('OSM multipolygons stitch reversed fragments and assign holes without drawing helper ways', () => {
  const nodes = [osmNode(1, 10, 40), osmNode(2, 14, 40), osmNode(3, 14, 44), osmNode(4, 10, 44),
    osmNode(5, 11, 41), osmNode(6, 11, 42), osmNode(7, 12, 42), osmNode(8, 12, 41)];
  const ways = [osmWay(10, [1, 2, 3]), osmWay(11, [1, 4, 3]), osmWay(12, [5, 6, 7, 8, 5])];
  const relation = { type: 'relation', id: 10, tags: { type: 'multipolygon', landuse: 'forest' }, members: [
    { type: 'way', ref: 11, role: 'outer' }, { type: 'way', ref: 12, role: 'inner' }, { type: 'way', ref: 10, role: 'outer' }
  ] };
  const converted = formats.osm(osmData([relation, ...ways, ...nodes]));
  assert.equal(converted.features.length, 1);
  const area = converted.features[0];
  assert.equal(area.id, 'relation/10'); assert.equal(area.properties.landuse, 'forest');
  assert.equal(area.geometry.type, 'Polygon'); assert.equal(area.geometry.coordinates.length, 2);
  const signed = ring => ring.slice(1).reduce((sum, point, i) => sum + ring[i][0] * point[1] - point[0] * ring[i][1], 0);
  assert.ok(signed(area.geometry.coordinates[0]) > 0, 'outer winding is GeoJSON counter-clockwise');
  assert.ok(signed(area.geometry.coordinates[1]) < 0, 'inner winding is clockwise');
  assert.equal(area.geometry.coordinates[0].length, 5, 'fragment joins have no duplicate vertices');
});

test('OSM boundary out geom retains disjoint outers, inner rings and tagged member features', () => {
  const left = [[10, 40], [14, 40], [14, 44], [10, 44], [10, 40]], right = left.map(([x, y]) => [x + 10, y]);
  const hole = [[21, 41], [22, 41], [22, 42], [21, 42], [21, 41]];
  const data = osmData([{ type: 'relation', id: 1, tags: { type: 'boundary', boundary: 'administrative' }, members: [
    { type: 'way', ref: 10, role: 'outer', geometry: osmGeometry(left) },
    { type: 'way', ref: 11, role: 'outer', geometry: osmGeometry(right.slice().reverse()) },
    { type: 'way', ref: 12, role: 'inner', geometry: osmGeometry(hole) },
    { type: 'node', ref: 100, role: 'admin_centre' }
  ] }, { type: 'way', id: 10, tags: { barrier: 'fence' }, geometry: osmGeometry(left) }]);
  const converted = formats.osm(data);
  assert.equal(converted.features.length, 2);
  const polygons = converted.features[0].geometry.coordinates;
  assert.equal(converted.features[0].geometry.type, 'MultiPolygon');
  assert.equal(polygons[0].length, 1); assert.equal(polygons[1].length, 2, 'hole belongs to the second outer');
  assert.equal(converted.features[1].geometry.type, 'LineString', 'independently tagged member ways are preserved');
});

test('OSM relation failures are explicit and recovery is atomic', () => {
  const left = [[10, 40], [14, 40], [14, 44], [10, 44], [10, 40]];
  const bad = [
    { type: 'relation', id: 1, tags: { type: 'route' }, members: [] },
    { type: 'relation', id: 2, tags: { type: 'multipolygon' }, members: [{ type: 'way', ref: 90, role: 'outer' }] },
    { type: 'relation', id: 3, tags: { type: 'multipolygon' }, members: [
      { type: 'way', ref: 1, role: 'outer', geometry: osmGeometry(left.slice(0, 3)) }
    ] },
    { type: 'relation', id: 4, tags: { type: 'multipolygon' }, members: [
      { type: 'way', ref: 1, role: 'outer', geometry: osmGeometry(left) },
      { type: 'way', ref: 2, role: 'inner', geometry: osmGeometry(left.map(([x, y]) => [x + 20, y])) }
    ] }
  ];
  for (const element of bad) assert.throws(() => formats.osm(osmData([element])), /invalid OSM element 1/);
  const errors = [];
  const converted = formats.osm(osmData([...bad, osmNode(10, 12, 48)]), { maxFeatures: 1, onError(error, index) { errors.push([error.elementIndex, index]); } });
  assert.deepEqual(errors, [[1, 1], [2, 2], [3, 3], [4, 4]]);
  assert.deepEqual(converted.features.map(value => value.id), ['node/10']);
});

test('OSM recovery retains untagged members of failed relations in input order', () => {
  const geometry = osmGeometry([[12, 48], [12.1, 48], [12.1, 48.1]]);
  const data = osmData([
    { type: 'way', id: 1, geometry },
    { type: 'relation', id: 2, tags: { type: 'multipolygon' }, members: [{ type: 'way', ref: 1, role: 'outer' }] },
    osmNode(3, 13, 49, { name: 'Station' })
  ]);
  const errors = [];
  const converted = formats.osm(data, { onError(error, index) { errors.push(index); } });
  assert.deepEqual(errors, [2]);
  assert.deepEqual(converted.features.map(feature => feature.id), ['way/1', 'node/3']);
  assert.deepEqual(converted.features[0].geometry, { type: 'LineString', coordinates: [[12, 48], [12.1, 48], [12.1, 48.1]] });
  const closed = osmGeometry([[12, 48], [12.1, 48], [12.1, 48.1], [12, 48]]);
  data.elements[0].geometry = closed;
  assert.deepEqual(formats.osm(data, { maxFeatures: 2 }).features.map(feature => feature.id), ['relation/2', 'node/3'],
    'successful relation members remain suppressed without consuming the feature budget');
});

test('OSM conversion keeps output limits and reports server errors', () => {
  const points = osmData([osmNode(1, 12, 48), osmNode(2, 13, 49)]);
  assert.throws(() => formats.osm(points, { maxFeatures: 1, onError() {} }), /feature limit/);
  assert.throws(() => formats.osm(points, { maxCoordinates: 1, onError() {} }), /coordinate limit/);
  assert.throws(() => formats.osm({ elements: [], remark: 'runtime error: Query timed out' }), /Query timed out/);
  assert.throws(() => formats.osm({}), /elements array/);
  assert.throws(() => formats.osm(points, { includeUntaggedNodes: 'yes' }), /boolean/);
  assert.throws(() => formats.osm(points, { onError: true }), /function/);
  assert.throws(() => formats.osm(osmData([{ type: 'node', id: 9007199254740992, lon: 12, lat: 48 }])), /integer id/);
});

test('OSM duplicate out statements use the last version and preserve arbitrary tag keys', () => {
  const data = osmData([osmNode(1, 12, 48, { name: 'old' }), JSON.parse('{"type":"node","id":1,"lon":13,"lat":49,"tags":{"name":"new","__proto__":"tag","@id":"custom"}}')]);
  const converted = formats.osm(data);
  assert.equal(converted.features.length, 1); assert.equal(converted.features[0].id, 'node/1');
  assert.deepEqual(converted.features[0].geometry.coordinates, [13, 49]);
  assert.equal(converted.features[0].properties['@id'], 'custom');
  assert.equal(Object.hasOwn(converted.features[0].properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(converted.features[0].properties), Object.prototype);
});
