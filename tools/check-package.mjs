import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Test an installed tarball so missing files cannot be supplied by the checkout.
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.name, pkg.name, 'Lockfile package name differs');
assert.equal(lock.version, pkg.version, 'Lockfile version differs');
assert.equal(lock.packages[''].name, pkg.name, 'Lockfile root package name differs');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version differs');
const temporary = await mkdtemp(join(tmpdir(), 'micromap-package-'));
function npm(args, cwd = root) {
  return execFileSync('npm', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
try {
  // Ignore lifecycle hooks here: this check also runs from prepublishOnly.
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const files = new Set(packed.files.map(file => file.path));
  for (const entry of pkg.files) {
    assert.ok([...files].some(file => file === entry || file.startsWith(entry + '/')),
      `Missing declared package content: ${entry}`);
  }
  for (const file of files) {
    assert.ok(file === 'package.json' || pkg.files.some(entry => file === entry || file.startsWith(entry + '/')),
      `Unexpected package file: ${file}`);
    assert.ok(!/(?:^|\/)(?:\.DS_Store|\.npmrc|\.env[^/]*|node_modules)(?:\/|$)/.test(file),
      `Local configuration in package: ${file}`);
  }
  for (const target of [pkg.main, pkg.browser, pkg.unpkg, pkg.jsdelivr, ...Object.values(pkg.exports)]) {
    assert.ok(files.has(target.replace(/^\.\//, '')), `Missing entry: ${target}`);
  }
  for (const file of ['README.md', 'LICENSE']) assert.ok(files.has(file), `Missing ${file}`);
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Unexpected runtime dependencies');

  await writeFile(join(temporary, 'package.json'), '{"private":true}\n');
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    join(temporary, packed.filename)], temporary);
  const assertions = Object.keys(pkg.exports).map(subpath => {
    const name = pkg.name + (subpath === '.' ? '' : subpath.slice(1));
    return `assert.ok(require(${JSON.stringify(name)}), ${JSON.stringify(name)});`;
  }).join('\n');
  execFileSync(process.execPath, ['-e', `const assert = require('node:assert/strict');\n${assertions}`], {
    cwd: temporary, stdio: 'pipe'
  });

  const entry = `import microMap from ${JSON.stringify(pkg.name)};
import vector from ${JSON.stringify(pkg.name + '/vector')};
import geojson from ${JSON.stringify(pkg.name + '/geojson')};
import ui from ${JSON.stringify(pkg.name + '/ui')};
import style from ${JSON.stringify(pkg.name + '/styles/karte-bayern-blue')};
if (typeof microMap !== 'function' || microMap.vector !== vector || microMap.geojson !== geojson || microMap.ui !== ui)
  throw new Error('Add-ons must share the imported core');
if (!Array.isArray(style().layers)) throw new Error('Style export is unusable');`;
  await writeFile(join(temporary, 'smoke.mjs'), entry);
  // Native ESM interop and the browser resolver must agree on one core instance.
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: temporary, stdio: 'pipe' });
  const bundle = join(temporary, 'browser-smoke.cjs');
  await build({ absWorkingDir: temporary, entryPoints: ['smoke.mjs'], outfile: bundle,
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2018', logLevel: 'silent' });
  execFileSync(process.execPath, [bundle], { cwd: temporary, stdio: 'pipe' });
  console.log(`${pkg.name}@${pkg.version}: ${files.size} files, ${packed.size} bytes packed; install, exports and browser bundle passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
