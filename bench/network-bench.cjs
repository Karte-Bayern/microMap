'use strict';

// Offline route benchmark: node bench/network-bench.cjs [network-module-path]
// Graph construction is excluded; timings include search and result assembly.
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const assert = require('node:assert/strict');
const network = require(process.argv[2] ? path.resolve(process.argv[2]) : '../lib/microMap.network.js');

for (const count of [1000, 5000, 20000]) {
  const nodes = Array.from({ length: count + 1 }, (_, id) => ({ id, coordinates: [id / 100000, 48] }));
  const edges = Array.from({ length: count }, (_, id) => ({
    id, from: id, to: id + 1, distance: 1, cost: 1,
    coordinates: [nodes[id].coordinates, [(id + 0.5) / 100000, 48], nodes[id + 1].coordinates]
  }));
  const graph = network({ nodes, edges });
  const times = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    const result = graph.route(0, count);
    const elapsed = performance.now() - start;
    assert.equal(result.coordinates.length, count * 2 + 1);
    assert.equal(result.cost, count);
    if (i >= 2) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  console.log(`${count} edges: median ${times[3].toFixed(2)} ms (7 runs, 2 warmups)`);
}
