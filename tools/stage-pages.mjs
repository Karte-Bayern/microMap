import { cp, mkdir, readdir, readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// An explicit allowlist keeps repository metadata, tests and local data private.
export async function stagePages(destination) {
  const output = resolve(destination);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Pages destination must be empty');
  async function copy(relative) {
    const target = resolve(output, relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(root, relative), target);
  }
  for (const file of ['index.html', 'LICENSE', 'README.md', 'bench/browser.html', 'styles/karte-bayern-blue.js']) await copy(file);
  for (const [directory, pattern] of [
    ['lib', /^microMap.*\.js$/], ['demo', /\.html$/], ['docs', /\.md$/]
  ]) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) await copy(directory + '/' + entry.name);
    }
  }
  // Check authored local references, excluding external URLs and fragment-only links.
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) continue;
    const pathname = decodeURIComponent(match[1].split(/[?#]/)[0]);
    if (pathname) await access(resolve(output, pathname));
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await stagePages(process.argv[2] || resolve(root, '_site')));
}
