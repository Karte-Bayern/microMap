const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, access, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('Pages staging includes linked docs and scripts but excludes development files', async () => {
  const { stagePages } = await import('../tools/stage-pages.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'micromap-pages-'));
  try {
    await stagePages(directory);
    for (const file of ['index.html', 'README.md', 'docs/reference.md', 'docs/modules.md', 'demo/vector.html', 'lib/microMap.vector.min.js', 'styles/karte-bayern-blue.js']) await access(join(directory, file));
    for (const file of ['.git', '.github', 'docs_alt', 'node_modules', 'test', 'tools', 'package.json']) await assert.rejects(access(join(directory, file)), { code: 'ENOENT' });
    const before = await readFile(join(directory, 'index.html'), 'utf8');
    await assert.rejects(stagePages(directory), /must be empty/);
    assert.equal(await readFile(join(directory, 'index.html'), 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
