// The site's images, all drawn from the dog-tag mark (../web/public/icon.svg). Run after the mark
// or the headline changes: `pnpm -F @baymutt/site images`.
//
// - public/favicon.png, public/apple-touch-icon.png: the mark.
// - public/og.png: 1200×630, rendered from scripts/og.html by the pinned headless shell at 2x.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { screenshotHtml } from '@internal/html-screenshot';
import sharp from 'sharp';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mark = path.resolve(siteRoot, '../web/public/icon.svg');

// The light scheme's paper (`--background`), for the icon iOS insists is opaque.
const PAPER = '#f8f5ee';

await sharp(mark, { density: 288 })
  .resize(96, 96)
  .png()
  .toFile(path.join(siteRoot, 'public/favicon.png'));

await sharp(mark, { density: 576 })
  .resize(132, 132)
  .extend({ top: 24, bottom: 24, left: 24, right: 24, background: PAPER })
  .flatten({ background: PAPER })
  .png()
  .toFile(path.join(siteRoot, 'public/apple-touch-icon.png'));

const font = (pkg: string, file: string) =>
  pathToFileURL(path.join(siteRoot, 'node_modules/@fontsource-variable', pkg, 'files', file)).href;

const tmp = mkdtempSync(path.join(tmpdir(), 'baymutt-og-'));
try {
  const html = readFileSync(path.join(siteRoot, 'scripts/og.html'), 'utf8')
    .replaceAll('{{sans}}', font('schibsted-grotesk', 'schibsted-grotesk-latin-wght-normal.woff2'))
    .replaceAll('{{mono}}', font('geist-mono', 'geist-mono-latin-wght-normal.woff2'));
  const htmlPath = path.join(tmp, 'og.html');
  writeFileSync(htmlPath, html);
  const png = await screenshotHtml(htmlPath, { width: 1200, height: 630 });
  await sharp(png)
    .resize(1200, 630, { kernel: 'lanczos3' })
    .png()
    .toFile(path.join(siteRoot, 'public/og.png'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
