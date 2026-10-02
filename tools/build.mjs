import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Script } from 'node:vm';
import { build as bundle, transform } from 'esbuild';
import { mkdir } from 'node:fs/promises';

const packageUrl = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
const checkOnly = process.argv.includes('--check');
const builds = [
  {
    name: 'core',
    sourceUrl: new URL('../lib/microMap.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.min.js', import.meta.url),
    banner: '/*! microMap.js v' + packageJson.version + ' | MIT */',
    budget: 16384
  },
  {
    name: 'vector',
    sourceUrl: new URL('../lib/microMap.vector.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.vector.min.js', import.meta.url),
    banner: '/*! microMap.vector.js v' + packageJson.version + ' | MIT */',
    // MVT decoding, style evaluation, labels, the perspective (tilted)
    // renderer and WebGL buildings remain separate from the raster core.
    // Budget: 56 KiB minified + gzip.
    budget: 57344
  },
  {
    name: 'geojson',
    sourceUrl: new URL('../lib/microMap.geojson.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.geojson.min.js', import.meta.url),
    banner: '/*! microMap.geojson.js v' + packageJson.version + ' | MIT */',
    // Dynamic application overlays are an opt-in module. Keep their source
    // registry and hit testing separate from both the raster and MVT bundles.
    budget: 16384
  },
  {
    name: 'field',
    sourceUrl: new URL('../lib/microMap.field.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.field.min.js', import.meta.url),
    banner: '/*! microMap.field.js v' + packageJson.version + ' | MIT */',
    // Local annotations stay optional; the only runtime prerequisites are
    // the core and GeoJSON overlay already selected by the application.
    budget: 4096
  },
  {
    name: 'inspect',
    sourceUrl: new URL('../lib/microMap.inspect.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.inspect.min.js', import.meta.url),
    banner: '/*! microMap.inspect.js v' + packageJson.version + ' | MIT */',
    budget: 4096
  },
  {
    name: 'measure',
    sourceUrl: new URL('../lib/microMap.measure.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.measure.min.js', import.meta.url),
    banner: '/*! microMap.measure.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'export',
    sourceUrl: new URL('../lib/microMap.export.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.export.min.js', import.meta.url),
    banner: '/*! microMap.export.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'pmtiles',
    sourceUrl: new URL('../lib/microMap.pmtiles.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.pmtiles.min.js', import.meta.url),
    banner: '/*! microMap.pmtiles.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'mmt',
    sourceUrl: new URL('../lib/microMap.mmt.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.mmt.min.js', import.meta.url),
    banner: '/*! microMap.mmt.js v' + packageJson.version + ' | MIT */',
    budget: 12288
  },
  {
    name: 'mlt',
    sourceUrl: new URL('../lib/microMap.mlt.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.mlt.min.js', import.meta.url),
    banner: '/*! microMap.mlt.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'heatmap',
    sourceUrl: new URL('../lib/microMap.heatmap.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.heatmap.min.js', import.meta.url),
    banner: '/*! microMap.heatmap.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'graticule',
    sourceUrl: new URL('../lib/microMap.graticule.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.graticule.min.js', import.meta.url),
    banner: '/*! microMap.graticule.js v' + packageJson.version + ' | MIT */',
    budget: 4096
  },
  {
    name: 'scenario',
    sourceUrl: new URL('../lib/microMap.scenario.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.scenario.min.js', import.meta.url),
    banner: '/*! microMap.scenario.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'network',
    sourceUrl: new URL('../lib/microMap.network.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.network.min.js', import.meta.url),
    banner: '/*! microMap.network.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'camera',
    sourceUrl: new URL('../lib/microMap.camera.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.camera.min.js', import.meta.url),
    banner: '/*! microMap.camera.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'compose',
    sourceUrl: new URL('../lib/microMap.compose.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.compose.min.js', import.meta.url),
    banner: '/*! microMap.compose.js v' + packageJson.version + ' | MIT */',
    budget: 8192
  },
  {
    name: 'raster',
    sourceUrl: new URL('../lib/microMap.raster.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.raster.min.js', import.meta.url),
    banner: '/*! microMap.raster.js v' + packageJson.version + ' | MIT */',
    budget: 16384
  },
  {
    name: 'maplibre',
    sourceUrl: new URL('../lib/microMap.maplibre.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.maplibre.min.js', import.meta.url),
    banner: '/*! microMap.maplibre.js v' + packageJson.version + ' | MIT */',
    // Construction, style loading and MapLibre's event model only: the
    // rendering and UI stay in their own modules.
    budget: 8192
  },
  {
    name: 'ui',
    sourceUrl: new URL('../lib/microMap.ui.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.ui.min.js', import.meta.url),
    banner: '/*! microMap.ui.js v' + packageJson.version + ' | MIT */',
    // Markers, popups, tooltips, icons, layer groups, four controls, the
    // attribution sanitizer and their stylesheet (MapLibre and Leaflet
    // shaped), kept out of the renderer bundles so plain maps do not pay.
    budget: 16384
  },
  {
    name: 'webgl',
    sourceUrl: new URL('../lib/microMap.webgl.js', import.meta.url),
    outputUrl: new URL('../lib/microMap.webgl.min.js', import.meta.url),
    banner: '/*! microMap.webgl.js v' + packageJson.version + ' | MIT */',
    budget: 4096
  }
];

const report = {};
let failed = false;
for (const build of builds) {
  const source = await readFile(build.sourceUrl, 'utf8');
  const { code } = await transform(source, {
    minify: true,
    target: 'es2018',
    legalComments: 'none'
  });
  const minifiedCode = build.banner + code.trimEnd() + '\n';
  let currentOutput = null;
  if (checkOnly) {
    try {
      currentOutput = await readFile(build.outputUrl, 'utf8');
    } catch {
      // The normal stale-artifact diagnostic below also covers a missing file.
    }
  } else {
    await writeFile(build.outputUrl, minifiedCode);
  }

  report[build.name] = {
    raw: Buffer.byteLength(source),
    minified: Buffer.byteLength(minifiedCode),
    gzipped: gzipSync(minifiedCode, { level: 9 }).length,
    budget: build.budget
  };
  // Parse generated bundles as scripts and keep every optional module within
  // its own transfer budget.
  try {
    new Script(minifiedCode, { filename: build.outputUrl.pathname });
  } catch (error) {
    console.error(build.name + ' minified output does not parse: ' + error.message);
    failed = true;
  }
  if (report[build.name].minified > report[build.name].raw * 0.9) {
    console.error(build.name + ' barely shrank; check for quotes inside regex literals.');
    failed = true;
  }
  if (checkOnly && currentOutput !== minifiedCode) {
    console.error(build.outputUrl.pathname.split('/').pop() + ' is out of date; run npm run build.');
    failed = true;
  }
  if (report[build.name].gzipped >= build.budget) {
    console.error(build.name + ' bundle exceeds its minified+gzip budget.');
    failed = true;
  }
}

// All-in-one distributions of the general-purpose modules: a classic
// script exposing `microMap` and a native ES module with MapLibre-style
// named exports. Specialised add-ons stay separate.
const bundles = [
  {
    name: 'bundle',
    entry: new URL('./bundle/browser.cjs', import.meta.url),
    outputUrl: new URL('../dist/micromap.min.js', import.meta.url),
    format: 'iife',
    globalName: 'microMap',
    budget: 122880
  },
  {
    name: 'bundle-esm',
    entry: new URL('./bundle/module.mjs', import.meta.url),
    outputUrl: new URL('../dist/micromap.mjs', import.meta.url),
    format: 'esm',
    budget: 122880
  },
  {
    name: 'bundle-cjs',
    entry: new URL('./bundle/browser.cjs', import.meta.url),
    outputUrl: new URL('../dist/micromap.cjs', import.meta.url),
    format: 'cjs',
    budget: 122880
  }
];
if (!checkOnly) await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for (const item of bundles) {
  const result = await bundle({
    entryPoints: [item.entry.pathname],
    bundle: true,
    minify: true,
    format: item.format,
    globalName: item.globalName,
    target: 'es2018',
    platform: 'browser',
    legalComments: 'none',
    sourcemap: 'external',
    sourcesContent: false,
    outfile: item.outputUrl.pathname,
    write: false,
    banner: { js: '/*! microMap.js v' + packageJson.version + ' (all-in-one) | MIT */' },
    logLevel: 'silent'
  });
  const code = result.outputFiles.find(file => !file.path.endsWith('.map'));
  const map = result.outputFiles.find(file => file.path.endsWith('.map'));
  const text = code.text.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '\n//# sourceMappingURL=' + item.outputUrl.pathname.split('/').pop() + '.map\n');
  if (checkOnly) {
    let current = null;
    try { current = await readFile(item.outputUrl, 'utf8'); } catch {}
    if (current !== text) {
      console.error(item.outputUrl.pathname.split('/').pop() + ' is out of date; run npm run build.');
      failed = true;
    }
  } else {
    await writeFile(item.outputUrl, text);
    await writeFile(new URL(item.outputUrl.href + '.map'), map.text);
  }
  report[item.name] = { minified: Buffer.byteLength(text), gzipped: gzipSync(text, { level: 9 }).length, budget: item.budget };
  if (report[item.name].gzipped >= item.budget) {
    console.error(item.name + ' exceeds its minified+gzip budget.');
    failed = true;
  }
}

console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
