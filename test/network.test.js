'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

for (const file of ['microMap.network.js', 'microMap.network.min.js']) {
  const network = require('../lib/' + file);

  test(file + ': route geometry preserves direction, joins, duplicates and ownership', () => {
    const a = [11, 48], b = [12, 48], c = [13, 48], d = [14, 48];
    const graph = network({
      nodes: [a, b, c, d].map((coordinates, id) => ({ id, coordinates })),
      edges: [
        { id: 'ab', from: 0, to: 1, cost: 1, distance: 10, coordinates: [a, [11.5, 48], b] },
        { id: 'cb', from: 2, to: 1, cost: 2, distance: 20, coordinates: [c, c, [12.5, 48], b] },
        // Edge shapes need not meet at the graph node; preserve the gap.
        { id: 'cd', from: 2, to: 3, cost: 3, distance: 30, coordinates: [[13.1, 48], d] }
      ]
    });
    const before = graph.getGraph();
    const expected = [a, [11.5, 48], b, [12.5, 48], c, c, [13.1, 48], d];
    const forward = graph.route(0, 3);
    assert.deepEqual(forward.coordinates, expected);
    assert.deepEqual(forward.nodeIds, ['0', '1', '2', '3']);
    assert.deepEqual(forward.edgeIds, ['ab', 'cb', 'cd']);
    assert.equal(forward.cost, 6);
    assert.equal(forward.distance, 60);
    assert.deepEqual(graph.route(3, 0).coordinates, expected.slice().reverse());
    assert.deepEqual(graph.route(0, 0).coordinates, [a]);
    forward.coordinates[0][0] = 99;
    forward.coordinates[4][0] = 99;
    assert.deepEqual(graph.getGraph(), before);
    assert.deepEqual(graph.route(0, 3).coordinates, expected);
  });

  test(file + ': long routes retain every point in both directions', () => {
    const count = 10000;
    const nodes = Array.from({ length: count + 1 }, (_, id) => ({ id, coordinates: [id / 10000, 48] }));
    const edges = Array.from({ length: count }, (_, id) => ({ from: id, to: id + 1, cost: 1, distance: 1 }));
    const graph = network({ nodes, edges });
    const expected = nodes.map(node => node.coordinates);
    assert.deepEqual(graph.route(0, count).coordinates, expected);
    assert.deepEqual(graph.route(count, 0).coordinates, expected.slice().reverse());
    assert.equal(graph.route(0, count, { maxCost: count - 1 }), null);
  });
}
