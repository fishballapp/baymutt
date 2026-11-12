#!/usr/bin/env node
/**
 * Puts the landing page (@baymutt/site) and the dashboard (@baymutt/web) into dist/, the one
 * assets directory wrangler.jsonc serves. The landing's index.html is the page at /; the
 * dashboard's index.html becomes _shell.html, which src/index.ts answers every other page path
 * with. _headers, which applies to both, is this package's own.
 *
 * Both builds must exist: `pnpm -F @baymutt/worker-web build` makes them first. `--allow-missing`
 * (for `wrangler dev`, which only needs the directory) assembles whatever is built.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(packageDir, 'dist');
const isMissingAllowed = process.argv.includes('--allow-missing');

/** Each build that goes in, and the files it puts under another name. */
const sources: readonly {
  name: string;
  dir: string;
  rename: Readonly<Record<string, string>>;
}[] = [
  { name: '@baymutt/site', dir: path.resolve(packageDir, '../site/dist'), rename: {} },
  {
    name: '@baymutt/web',
    dir: path.resolve(packageDir, '../web/dist'),
    rename: { 'index.html': '_shell.html' },
  },
];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)));

const built = sources.filter(source => {
  if (existsSync(path.join(source.dir, 'index.html'))) return true;
  const message = `${source.name} is not built (no ${path.relative(packageDir, source.dir)}/index.html). Run \`pnpm -F ${source.name} build\`.`;
  if (!isMissingAllowed) throw new Error(message);
  console.warn(`Skipping: ${message}`);
  return false;
});

const placed = new Map<string, string>([['_headers', 'apps/worker-web/_headers']]);
const copies = built.flatMap(({ name, dir, rename }) =>
  filesUnder(dir).map(file => {
    const target = rename[file] ?? file;
    const earlier = placed.get(target);
    if (earlier !== undefined) {
      throw new Error(`${name} and ${earlier} both have ${target}; one of them must rename it.`);
    }
    placed.set(target, name);
    return { from: path.join(dir, file), to: path.join(out, target) };
  }),
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(path.join(packageDir, '_headers'), path.join(out, '_headers'));
for (const { from, to } of copies) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}
console.log(
  `Assembled ${copies.length + 1} files from ${built.map(({ name }) => name).join(' and ') || 'nothing'} into dist/.`,
);
