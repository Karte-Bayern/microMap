'use strict';

// node bench/heatmap-bench.cjs [heatmap-module-path]
// Measures the JS draw pass with synthetic density pixels, not Canvas/GPU work.
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fixture = require('./heatmap-fixture.cjs');
const heatmap = require(process.argv[2] ? path.resolve(process.argv[2]) : '../lib/microMap.heatmap.js');
for (const [width, height] of [[1024, 768], [1600, 1200]]) {
  const scene = fixture(heatmap, width, height);
  const times = [];
  try {
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      scene.draw();
      if (i >= 5) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(`${width}x${height}: median ${((times[9] + times[10]) / 2).toFixed(2)} ms (20 runs, 5 warmups)`);
  } finally { scene.destroy(); }
}
