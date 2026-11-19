// Builds one image of every captured shot, light beside dark, so a person can look at the whole set.
//   node tests/visual/contact-sheet.mjs [project] [first-state-index] [count]
// Reads <shots>/<project>/ (default 1440x900) and writes
// artifacts/visual/contact-<project>-<n>.png. <shots> is VISUAL_CAPTURE_DIR when set (the same rule as
// visual.spec.ts), else artifacts/visual/shots. Headless Chromium only.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', 'artifacts', 'visual');
const project = process.argv[2] ?? '1440x900';
const first = Number(process.argv[3] ?? 0);
const count = Number(process.argv[4] ?? 6);
const shots = process.env.VISUAL_CAPTURE_DIR
  ? resolve(process.env.VISUAL_CAPTURE_DIR)
  : join(root, 'shots');
const dir = join(shots, project);
if (!existsSync(dir)) throw new Error(`No shots in ${dir}. Run the visual spec first.`);

const ids = [
  ...new Set(
    readdirSync(dir)
      .filter(file => /\.(light|dark)\.png$/.test(file))
      .map(file => file.replace(/\.(light|dark)\.png$/, '')),
  ),
].sort();
const chosen = ids.slice(first, first + count);
const width = 720;
const cells = chosen
  .map(
    id => `<figure><figcaption>${id}</figcaption>
      <img src="file://${join(dir, `${id}.light.png`)}" width="${width}"><img src="file://${join(dir, `${id}.dark.png`)}" width="${width}"></figure>`,
  )
  .join('');
const html = `<style>body{margin:0;background:#888;font:12px Helvetica}figure{margin:0 0 6px;display:grid;grid-template-columns:${width}px ${width}px;gap:6px}
figcaption{grid-column:1/3;color:#fff;background:#222;padding:3px 6px}img{display:block}</style>${cells}`;
mkdirSync(root, { recursive: true });
const page = join(root, 'contact.html');
writeFileSync(page, html);

const browser = await chromium.launch({ headless: true });
const tab = await browser.newPage({ viewport: { width: width * 2 + 6, height: 600 } });
await tab.goto(`file://${page}`);
await tab.waitForLoadState('load');
const out = join(root, `contact-${project}-${first}.png`);
await tab.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
