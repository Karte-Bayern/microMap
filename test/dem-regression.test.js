'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vector = require('../lib/microMap.vector.js');

// Exercise the public source/layer path: the derived raster pixels reveal
// whether source encoding options survive registration and DEM decoding.
async function renderDEM(source, layers, inspect, pixel, imageSize = 4) {
  const saved = Object.getOwnPropertyDescriptor(global, 'document');
  const paints = [];
  let readbacks = 0;
  function canvasContext(element) {
    return new Proxy({
      getImageData(x, y, width, height) {
        readbacks++;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i += 4) data.set(pixel ? pixel((i / 4) % width, Math.floor(i / 4 / width)) : [100, 20, 30, 255], i);
        return { data, width, height };
      },
      createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
      putImageData(image) {
        element.pixels = image.data.slice();
        paints.push(element);
      }
    }, {
      get(target, name) { return name in target ? target[name] : () => {}; },
      set(target, name, value) { target[name] = value; return true; }
    });
  }
  const container = {
    clientWidth: 32, clientHeight: 32,
    appendChild(node) { node.parentNode = this; },
    removeChild(node) { node.parentNode = null; }
  };
  global.document = {
    createElement(tag) {
      const element = { style: {}, setAttribute() {}, naturalWidth: tag === 'img' ? imageSize : undefined };
      const context = canvasContext(element);
      element.getContext = () => context;
      if (tag === 'img') Object.defineProperty(element, 'src', {
        set() { queueMicrotask(() => { if (element.onload) element.onload(); }); }
      });
      return element;
    }
  };
  const map = {
    getContainer: () => container,
    on() { return this; }, off() { return this; },
    getZoom: () => 0,
    getCameraState: () => ({ center: [0, 0], zoom: 0, worldSize: 512, width: 32, height: 32 })
  };
  let layer;
  try {
    layer = vector(map, {
      tiles: false,
      style: {
        version: 8,
        sources: { dem: { type: 'raster-dem', tiles: ['/dem/{z}/{x}/{y}.png'], maxzoom: 0, ...source } },
        layers
      }
    });
    for (let i = 0; i < 100 && !paints.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(paints.length, 'a decoded DEM was rendered');
    return await inspect(layer, paints, () => readbacks);
  } finally {
    if (layer) layer.destroy();
    if (saved) Object.defineProperty(global, 'document', saved);
    else delete global.document;
  }
}

async function reliefPixel(source) {
  return renderDEM(source, [{ id: 'relief', type: 'color-relief', source: 'dem', paint: {
    'color-relief-color': ['step', ['elevation'], '#0000ff', 0, '#00ff00', 1, '#ff0000']
  } }], (layer, paints) => Array.from(paints[0].pixels.slice(0, 4)));
}

test('custom DEM encoding adds baseShift to the channel mix', async () => {
  const pixel = await reliefPixel({ encoding: 'custom', redFactor: 1, greenFactor: 0, blueFactor: 0, baseShift: -100 });
  assert.deepEqual(pixel, [0, 255, 0, 255], '100 + (-100) metres is zero elevation');
});

test('custom DEM encoding defaults every channel factor to one', async () => {
  const pixel = await reliefPixel({ encoding: 'custom', baseShift: -150 });
  assert.deepEqual(pixel, [0, 255, 0, 255], '100 + 20 + 30 - 150 metres is zero elevation');
});

test('hillshade reports only nonstandard methods as approximated', async () => {
  for (const method of ['standard', 'multidirectional']) {
    await renderDEM({ encoding: 'terrarium' }, [
      { id: 'shade', type: 'hillshade', source: 'dem', paint: { 'hillshade-method': method } }
    ], layer => {
      assert.equal(layer.getStyleReport().approximated.includes('shade hillshade-method'), method !== 'standard');
    });
  }
});

for (const type of ['hillshade', 'color-relief']) {
  test(type + ' shares identical DEM paints and isolates subsequent layer updates', async () => {
    const paint = type === 'hillshade' ? { 'hillshade-exaggeration': 0.5 } : { 'color-relief-color': '#00ff00' };
    const layers = ['first', 'second'].map(id => ({ id, type, source: 'dem', paint }));
    await renderDEM({ encoding: 'terrarium' }, layers, async (layer, paints, readbacks) => {
      // Let another scheduled frame render too: cache hits must not decode
      // the image again, even with two separately compiled style layers.
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(readbacks(), 1, 'identical DEM paints share one image readback');
      assert.equal(paints.length, 1, 'identical DEM paints share one derived canvas');
      const original = paints[0];
      const pixels = original.pixels.slice();
      assert.equal(original.width, 6, 'four DEM pixels receive a repeated one-pixel border');
      if (type === 'hillshade') layer.setPaintProperty('second', 'hillshade-illumination-direction', 90);
      else layer.setPaintProperty('second', 'color-relief-color', '#ff0000');
      for (let i = 0; i < 100 && paints.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(readbacks(), type === 'hillshade' ? 1 : 2, 'hillshade direction changes reuse the decoded DEM');
      assert.equal(paints.length, 2);
      assert.notEqual(paints[1], original, 'the update gets its own canvas');
      assert.deepEqual(original.pixels, pixels, 'the other layer retains its original pixels');
      if (type === 'color-relief') {
        for (let i = 0; i < paints[1].pixels.length; i += 4) {
          assert.deepEqual(Array.from(paints[1].pixels.slice(i, i + 4)), [255, 0, 0, 255], 'all edge and corner pixels repeat the DEM color');
        }
      }
    });
  });
}

test('derived DEM padding repeats each nearest edge pixel without shifting the raster', async () => {
  await renderDEM({ encoding: 'custom', redFactor: 1, greenFactor: 0, blueFactor: 0, baseShift: 0 }, [
    { id: 'relief', type: 'color-relief', source: 'dem', paint: {
      'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#000000', 15, '#ffffff']
    } }
  ], (layer, paints) => {
    const raster = paints[0];
    const values = [];
    for (let i = 0; i < raster.pixels.length; i += 4) values.push(raster.pixels[i] / 17);
    assert.deepEqual(values, [
      0, 0, 1, 2, 3, 3,
      0, 0, 1, 2, 3, 3,
      4, 4, 5, 6, 7, 7,
      8, 8, 9, 10, 11, 11,
      12, 12, 13, 14, 15, 15,
      12, 12, 13, 14, 15, 15
    ]);
  }, (x, y) => [4 * y + x, 0, 0, 255]);
});

test('zero hillshade exaggeration leaves valid and missing DEM pixels transparent', () => {
  const pixels = new Uint8ClampedArray([200, 40, 20, 255, 0, 0, 0, 0, 100, 80, 60, 255, 1, 2, 3, 255]);
  vector.shadeDEM(pixels, 2, 12, 1400, [256, 1, 1 / 256, 32768], {
    direction: 270, exaggeration: 0,
    shadow: [0, 0, 0, 1], highlight: [255, 255, 255, 1], accent: [0, 0, 0, 1]
  });
  for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 0);
});

test('hillshade preserves transparent DEM holes without shading their flat neighbours', () => {
  const size = 5;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([128, 100, 0, 255], i);
  // A transparent pixel has no elevation. Its zero RGB must not create a
  // 32-kilometre cliff in otherwise flat Terrarium data.
  const hole = 4 * (2 * size + 2);
  pixels.fill(0, hole, hole + 4);
  const output = vector.shadeDEM(pixels, size, 12, 1400, [256, 1, 1 / 256, 32768], {
    direction: 270, exaggeration: 0.5,
    shadow: [0, 0, 0, 1], highlight: [255, 255, 255, 1], accent: [0, 0, 0, 1]
  });
  assert.equal(output[hole + 3], 0, 'missing elevation stays transparent');
  for (let i = 3; i < output.length; i += 4) assert.equal(output[i], 0, 'flat valid pixels have no invented slope');
});

async function repaintDEM(layer, paints, update) {
  const before = paints.length;
  update();
  const deadline = Date.now() + 2000;
  while (paints.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(paints.length > before, 'the changed DEM paint finishes');
  return paints[paints.length - 1];
}

function unpadDEM(canvas, size) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = 4 * ((y + 1) * (size + 2) + 1);
    pixels.set(canvas.pixels.subarray(from, from + size * 4), y * size * 4);
  }
  return pixels;
}

test('cached hillshade matches raw shading byte for byte across lighting, exaggeration and NoData', async () => {
  const size = 4;
  const sample = (x, y) => [x * 67 + y * 9, y * 59 + x * 11, x * 31 + y * 13, x === 2 && y === 2 ? 0 : 255];
  const raw = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(sample(x, y), 4 * (y * size + x));
  await renderDEM({ encoding: 'mapbox' }, [{ id: 'shade', type: 'hillshade', source: 'dem' }], async (layer, paints, readbacks) => {
    for (const exaggeration of [0.15, 0.5, 0.83]) {
      for (const direction of [-405, 0, 37, 135, 361]) {
        for (const colors of [
          { shadow: [0, 0, 0, 1], highlight: [255, 255, 255, 1], accent: [0, 0, 0, 1] },
          { shadow: [22, 77, 144, 0.6], highlight: [241, 195, 103, 0.8], accent: [33, 55, 99, 0.4] }
        ]) {
          const color = c => 'rgba(' + c.join(',') + ')';
          const raster = await repaintDEM(layer, paints, () => layer.setPaintProperties('shade', {
            'hillshade-exaggeration': exaggeration,
            'hillshade-illumination-direction': direction,
            'hillshade-shadow-color': color(colors.shadow),
            'hillshade-highlight-color': color(colors.highlight),
            'hillshade-accent-color': color(colors.accent)
          }));
          const expected = vector.shadeDEM(raw.slice(), size, 0, 0, [6553.6, 25.6, 0.1, 10000], { direction, exaggeration, ...colors });
          assert.deepEqual(unpadDEM(raster, size), expected, 'raw shader and cached shader agree at ' + direction + ' degrees and ' + exaggeration + ' exaggeration');
        }
      }
    }
    assert.equal(readbacks(), 3, 'the three exaggerations each decode only once, including the initial default');
  }, sample);
});

test('hillshade preparation evicts old entries after 32 geometries', async () => {
  await renderDEM({ encoding: 'mapbox' }, [{ id: 'shade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.1 } }], async (layer, paints, readbacks) => {
    for (let i = 1; i < 33; i++) await repaintDEM(layer, paints, () => layer.setPaintProperty('shade', 'hillshade-exaggeration', 0.1 + i / 100));
    assert.equal(readbacks(), 33);
    await repaintDEM(layer, paints, () => layer.setPaintProperty('shade', 'hillshade-exaggeration', 0.1));
    assert.equal(readbacks(), 34, 'the least recently used geometry was released');
  });
});

test('hillshade preparation memory is bounded below 24 MiB independently of entry count', async () => {
  await renderDEM({ encoding: 'mapbox' }, [{ id: 'shade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.1 } }], async (layer, paints, readbacks) => {
    // Each 256px preparation retains 3 Float64 fields plus RGBA, 1.75 MiB.
    // Fourteen entries exceed the memory limit even though they fit the count.
    for (let i = 1; i < 14; i++) await repaintDEM(layer, paints, () => layer.setPaintProperty('shade', 'hillshade-exaggeration', 0.1 + i / 100));
    assert.equal(readbacks(), 14);
    await repaintDEM(layer, paints, () => layer.setPaintProperty('shade', 'hillshade-exaggeration', 0.1));
    assert.equal(readbacks(), 15, 'the byte limit evicts the oldest full-size geometry');
  }, undefined, 256);
});

test('replacing a DEM source releases preparation keyed to the previous encoding and image', async () => {
  const sample = (x, y) => [x * 60 + y * 5, y * 40 + x, x * 30, x === 1 && y === 2 ? 0 : 255];
  const layers = [{ id: 'shade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.6 } }];
  await renderDEM({ encoding: 'mapbox' }, layers, async (layer, paints, readbacks) => {
    const raster = await repaintDEM(layer, paints, () => layer.setStyle({
      version: 8,
      sources: { dem: { type: 'raster-dem', tiles: ['/replacement/{z}/{x}/{y}.png'], maxzoom: 0,
        encoding: 'custom', redFactor: 24000, greenFactor: 2, blueFactor: 0.1, baseShift: -20000 } },
      layers
    }));
    assert.equal(readbacks(), 2, 'the replacement image gets its own decoded samples');
    const raw = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) raw.set(sample(x, y), 4 * (y * 4 + x));
    const expected = vector.shadeDEM(raw, 4, 0, 0, [24000, 2, 0.1, 20000], {
      direction: 335, exaggeration: 0.6,
      shadow: [0, 0, 0, 1], highlight: [255, 255, 255, 1], accent: [0, 0, 0, 1]
    });
    assert.deepEqual(unpadDEM(raster, 4), expected);
  }, sample);
});
