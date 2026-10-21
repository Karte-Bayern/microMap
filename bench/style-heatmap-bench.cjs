'use strict';

// node bench/style-heatmap-bench.cjs [vector-module-path]
// Measures JS density readback/colour work with a synthetic Canvas fixture.
// This does not measure browser rasterisation or compositing.
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fixture = require('./style-heatmap-fixture.cjs');
for (const [width, height] of [[1024, 768], [1600, 1200]]) {
  for (const count of [2, 3000]) {
    const view = fixture({ width, height, ...(process.argv[2] ? { source: path.resolve(process.argv[2]) } : {}) });
    const times = [], areas = [];
    try {
      for (let i = 0; i < 35; i++) {
        const points = count === 2 ? [[width / 2 + i % 3, height / 2 + .3], [width / 2 + 12.7, height / 2 - 8.4]] :
          Array.from({ length: count }, (_, n) => [(n % 60 + .5) * width / 60 + i % 3, (Math.floor(n / 60) + .5) * height / 50]);
        const start = performance.now();
        view.setPoints(points);
        if (i >= 5) {
          times.push(performance.now() - start);
          const read = view.reads.at(-1);
          areas.push(read.width * read.height);
        }
      }
      times.sort((a, b) => a - b);
      console.log(`${width}x${height}, ${count} points: median ${((times[14] + times[15]) / 2).toFixed(2)} ms; ${Math.round(areas.reduce((a, b) => a + b) / areas.length)} readback pixels (30 runs, 5 warmups)`);
    } finally { view.destroy(); }
  }
}
