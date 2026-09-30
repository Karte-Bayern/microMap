'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vector = require('../lib/microMap.vector.js');

function layer(style, id) {
  return style.find(entry => entry.id === id);
}

test('basicStyle offers distinct, independent map palettes', () => {
  const themes = ['light', 'dark', 'outdoor', 'contrast'];
  const styles = themes.map(theme => vector.basicStyle({ theme }));
  assert.equal(new Set(styles.map(style => layer(style, 'water').paint.color)).size, themes.length);
  assert.equal(new Set(styles.map(style => layer(style, 'roads-major').paint.color)).size, themes.length);
  assert.equal(layer(styles[2], 'outdoor-paths').minzoom, 15);
  assert.ok(!layer(styles[0], 'outdoor-paths'), 'the lightweight default does not draw dense paths');
  assert.ok(layer(styles[3], 'roads-major').paint.width > layer(styles[0], 'roads-major').paint.width);
  styles[0][0].paint.color = '#000000';
  assert.notEqual(layer(vector.basicStyle(), 'landcover').paint.color, '#000000', 'callers get fresh layers');
});

test('basicStyle permits palette overrides and rejects unknown themes', () => {
  const style = vector.basicStyle({ theme: 'outdoor', colors: { path: '#123456' } });
  assert.equal(layer(style, 'outdoor-paths').paint.color, '#123456');
  assert.throws(() => vector.basicStyle({ theme: 'unknown' }), /theme/);
  assert.throws(() => vector.basicStyle({ colors: { unsupported: '#000' } }), /color/);
});
