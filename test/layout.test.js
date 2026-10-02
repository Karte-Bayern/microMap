const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('package exports and browser script references resolve after relocation', () => {
  const packageJson = require('../package.json');
  // Targets are paths or condition objects ({ types, import, default }).
  const targets = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(targets);
  for (const target of Object.values(packageJson.exports).flatMap(targets)) {
    assert.ok(fs.existsSync(path.join(root, target)), `missing package export ${target}`);
  }
  const pages = [
    path.join(root, 'index.html'),
    ...['demo', 'test', 'bench'].flatMap((directory) =>
      fs.readdirSync(path.join(root, directory))
        .filter((file) => file.endsWith('.html'))
        .map((file) => path.join(root, directory, file))
    )
  ];
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const match of html.matchAll(/<script\s+src="([^"?#]+)(?:[?#][^"]*)?"/g)) {
      const src = match[1];
      if (/^(?:https?:)?\/\//.test(src) || src.startsWith('/') || src.includes("'")) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(page), src)), `${page}: missing ${src}`);
    }
  }
});
