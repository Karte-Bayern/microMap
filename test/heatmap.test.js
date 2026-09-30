'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../bench/heatmap-fixture.cjs');
const defaultPalette = ['#2563eb', '#06b6d4', '#84cc16', '#facc15', '#ef4444'];

// Original per-pixel interpolation, including Uint8ClampedArray rounding.
function expected(palette, opacity) {
  const colors = palette.map(hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)));
  const result = new Uint8ClampedArray(256 * 4);
  for (let alpha = 1; alpha < 256; alpha++) {
    const position = alpha / 255 * (colors.length - 1);
    const lower = Math.min(colors.length - 2, Math.floor(position));
    const fraction = position - lower;
    for (let c = 0; c < 3; c++) result[alpha * 4 + c] = colors[lower][c] * (1 - fraction) + colors[lower + 1][c] * fraction;
    result[alpha * 4 + 3] = Math.round(alpha * opacity);
  }
  return result;
}

for (const file of ['microMap.heatmap.js', 'microMap.heatmap.min.js']) {
  test(file + ': every density byte retains exact colors across paint updates', () => {
    const scene = fixture(require('../lib/' + file));
    try {
      assert.deepEqual(scene.draw(), expected(defaultPalette, 0.85));
      for (const palette of [
        ['#010203', '#fefdfc'],
        ['#000000', '#123456', '#ffffff'],
        Array.from({ length: 16 }, (_, i) => '#' + (i * 0x111111).toString(16).padStart(6, '0'))
      ]) {
        scene.layer.setPaint({ palette, opacity: 0.37 });
        assert.deepEqual(scene.draw(), expected(palette, 0.37));
        scene.layer.setPaint({ opacity: 1 });
        assert.deepEqual(scene.draw(), expected(palette, 1));
        scene.layer.setPaint({ radius: 42 });
        assert.deepEqual(scene.draw(), expected(palette, 1));
        assert.throws(() => scene.layer.setPaint({ palette: ['bad'] }));
        assert.deepEqual(scene.draw(), expected(palette, 1));
      }
      scene.layer.setPaint({ opacity: 0 });
      scene.draw();
      scene.layer.setPaint({ palette: defaultPalette, opacity: 0.85 });
      assert.deepEqual(scene.draw(), expected(defaultPalette, 0.85));
    } finally { scene.destroy(); }
  });
}
