'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../bench/style-heatmap-fixture.cjs');

// Independent full-frame reference: the step ramp maps every positive
// density to opaque red, and empty density to transparent or opaque blue.
function matchesFullFrame(view, visibleZero = false, color = [255, 0, 0, 255]) {
  const read = view.reads.at(-1), output = view.output();
  assert.ok(read && output, 'density was read and composited');
  const expected = new Uint8ClampedArray(read.input.length);
  for (let at = 0; at < expected.length; at += 4) {
    if (read.input[at + 3]) expected.set(color, at);
    else if (visibleZero) { expected[at + 2] = expected[at + 3] = 255; }
  }
  assert.deepEqual(output.pixels(), expected, 'cropped colour conversion matches the full-frame reference');
  assert.deepEqual(view.writes.at(-1), { x: read.x, y: read.y, width: read.width, height: read.height });
}

for (const pitch of [0, 55]) {
  test('sparse heatmap limits readback at pitch ' + pitch, () => {
    const view = fixture({ verify: true, pitch });
    try {
      view.setPoints([[512.35, 384.65], [519.1, 390.2]]);
      matchesFullFrame(view);
      const read = view.reads.at(-1);
      assert.ok(read.width * read.height < 1024 * 768 / 4 / 50, 'small overlay reads under 2% of the density canvas');
      assert.ok(read.x > 0 && read.y > 0, 'the readback uses its actual nonzero origin');
      const reads = view.reads.length;
      view.layer.redraw(); view.flush();
      assert.equal(view.reads.length, reads, 'the cropped coloured frame is still cached');
      view.setPoints([[540.7, 365.3]]);
      matchesFullFrame(view);
      view.setPoints([]);
      assert.equal(view.reads.length, reads + 1, 'empty overlays need no readback');
    } finally { view.destroy(); }
  });
}

test('heatmap crop includes fractional sprite edges and viewport clipping', () => {
  const view = fixture({ width: 256, height: 192, verify: true });
  try {
    for (const point of [[-.3, -.7], [255.4, -.2], [255.8, 191.6], [-.4, 191.1], [-8.3, 98.6], [264.2, 93.7]]) {
      view.setPoints([point]);
      matchesFullFrame(view);
      const read = view.reads.at(-1);
      assert.ok(read.x >= 0 && read.y >= 0 && read.width > 0 && read.height > 0);
      assert.ok(read.x + read.width <= 128 && read.y + read.height <= 96, 'reads remain within the density canvas');
    }
  } finally { view.destroy(); }
});

test('heatmaps with visible zero density still colour the full viewport', () => {
  const view = fixture({ width: 256, height: 192, verify: true, paint: {
    'heatmap-color': ['step', ['heatmap-density'], '#0000ff', .001, '#ff0000']
  } });
  try {
    view.setPoints([[128.2, 96.4]]);
    matchesFullFrame(view, true);
    const read = view.reads.at(-1);
    assert.deepEqual([read.x, read.y, read.width, read.height], [0, 0, 128, 96]);
  } finally { view.destroy(); }
});

test('heatmap conversion preserves each RGBA channel including partial alpha', () => {
  const view = fixture({ width: 256, height: 192, verify: true, paint: {
    'heatmap-color': ['step', ['heatmap-density'], 'rgba(0,0,0,0)', .001, 'rgba(23,81,199,0.7)']
  } });
  try {
    view.setPoints([[128.3, 96.7]]);
    matchesFullFrame(view, false, [23, 81, 199, 178]);
  } finally { view.destroy(); }
});

test('spread-out heatmaps retain the complete colour pass', () => {
  const view = fixture({ width: 256, height: 192, verify: true });
  try {
    view.setPoints([[0, 0], [255, 191]]);
    matchesFullFrame(view);
    const read = view.reads.at(-1);
    assert.deepEqual([read.x, read.y, read.width, read.height], [0, 0, 128, 96]);
  } finally { view.destroy(); }
});

test('offscreen heatmap groups do not allocate kernel sprites', () => {
  const view = fixture({ width: 800, height: 600, verify: true });
  try {
    view.setPoints([[400, 300, 1], ...Array.from({ length: 40 }, (_, i) => [850, 300, 2 + i / 10])]);
    matchesFullFrame(view);
    assert.equal(view.sprites.length, 1, 'only the visible group creates a kernel');
  } finally { view.destroy(); }
});

test('heatmap kernel cache evicts old sprites while retaining recently used ones', () => {
  const view = fixture({ width: 256, height: 192 });
  try {
    const draw = weight => view.setPoints([[128, 96, weight]]);
    for (let i = 1; i <= 64; i++) draw(i / 100);
    assert.equal(view.sprites.length, 64);
    draw(.01); // Refresh the first sprite before overflowing the cache.
    draw(.65);
    assert.equal(view.sprites.length, 65);
    draw(.01);
    draw(.64);
    assert.equal(view.sprites.length, 65, 'recently used sprites survive an overflow');
    draw(.02);
    assert.equal(view.sprites.length, 66, 'the oldest unused sprite was evicted');
  } finally { view.destroy(); }
});
