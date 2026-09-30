'use strict';

// Canvas fixture with deterministic density bytes; no browser rasterisation.
module.exports = function fixture(heatmap, width = 256, height = 1, paint = {}) {
  const originals = new Map(['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  let pending;
  let output;
  const input = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) input[i * 4 + 3] = i % 256;
  const container = {
    clientWidth: width, clientHeight: height,
    appendChild(child) { child.parentNode = this; },
    removeChild(child) { child.parentNode = null; }
  };
  global.document = { createElement() {
    const context = {
      clearRect() {}, fillRect() {}, drawImage() {},
      createRadialGradient() { return { addColorStop() {} }; },
      getImageData() { return { data: input.slice() }; },
      putImageData(image) { output = image.data; }
    };
    return { style: {}, setAttribute() {}, getContext() { return context; } };
  } };
  global.requestAnimationFrame = callback => { pending = callback; return 1; };
  global.cancelAnimationFrame = () => { pending = null; };
  const map = { getContainer: () => container, project: p => p, on() { return this; }, off() { return this; } };
  const layer = heatmap(map, { resolution: 1, data: [{ coordinates: [0, 0] }], ...paint });
  return {
    layer,
    draw() {
      layer.redraw();
      const callback = pending;
      pending = null;
      callback();
      return output;
    },
    destroy() {
      layer.destroy();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(global, key, descriptor);
        else delete global[key];
      }
    }
  };
};
