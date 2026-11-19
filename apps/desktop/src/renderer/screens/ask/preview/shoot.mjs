#!/usr/bin/env node
// Headless captures for the ui-ask preview gallery: the Ask dock and Today (DESIGN 7.7, 12.5).
// It starts nothing: run the renderer's Vite server first, e.g. from apps/desktop:
//   APLOS_VITE_PORT=5286 npx vite
// then:
//   node src/renderer/screens/ask/preview/shoot.mjs [outDir] [--base http://127.0.0.1:5286] [--only name,name]
// Every state is captured in light and dark at 1440 × 900 and 1100 × 760 into outDir (default
// /tmp/aplos-shots/ui-ask). Checks per capture: page errors, more than one visible filled button, banned words
// (DESIGN 10), banned glyphs (sparkle, wand, star, brain, robot) and any key-shaped string. Exits 1 on findings.
// Playwright comes from the research tools install (PLAYWRIGHT overrides), always headless.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT || '/Users/knewton/.t3/aplos-research/tools/node_modules/playwright',
);

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const BASE = (flag('--base') || process.env.BASE || 'http://127.0.0.1:5286').replace(/\/$/, '');
const ONLY = (flag('--only') || process.env.ONLY || '').split(',').filter(Boolean);
const OUT = path.resolve(args[0] || '/tmp/aplos-shots/ui-ask');
const GALLERY = `${BASE}/src/renderer/screens/ask/preview/index.html`;
const WIDTHS = [1440, 1100];

fs.mkdirSync(OUT, { recursive: true });

const BANNED = [
  /swipe through them/i,
  /hold to talk/i,
  /\bhide all\b/i,
  /\btodos?\b/i,
  /be here now/i,
  /sent with/i,
  /ask me anything/i,
  /\bmagic\b/i,
  /ai-powered/i,
  /copilot/i,
  /\bbeta\b/i,
  /all clear for now/i,
  /ready when you are/i,
  /waiting on you/i,
  /no reply yet/i,
  /making room for your mail/i,
  /aplos needs a moment/i,
  /couldn't summarize this email/i,
  /!/,
  /✨|⭐|★|☆|🪄|🤖|🧠/u,
];
const BANNED_GLYPH = /sparkle|wand|\bstars?\b|brain|robot|\bbot\b/i;
const KEY_CHARS = /sk-[A-Za-z0-9]|api[_-]?key|bearer [a-z0-9]|xox[baprs]-/i;

async function audit(page) {
  return page.evaluate(
    ({ banned, glyph, keyChars }) => {
      const out = [];
      const root = document.querySelector('.prev-window') || document.body;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const text = root.innerText || '';
      for (const rule of banned) {
        const re = new RegExp(rule, 'i');
        if (re.test(text)) out.push(`banned words: ${re}`);
      }
      const keyRe = new RegExp(keyChars, 'i');
      if (keyRe.test(text)) out.push('key-shaped text rendered');
      const glyphRe = new RegExp(glyph, 'i');
      for (const el of root.querySelectorAll('*')) {
        if (!visible(el)) continue;
        const name = `${el.getAttribute('class') || ''} ${el.getAttribute('data-icon') || ''}`;
        if (glyphRe.test(name)) out.push(`banned glyph in class: ${name.slice(0, 80)}`);
      }
      const filled = [...root.querySelectorAll('button')].filter(
        b =>
          visible(b) &&
          getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          b.offsetHeight > 0,
      );
      const accentish = filled.filter(b => {
        const bg = getComputedStyle(b).backgroundColor;
        return bg.includes('var(') === false && /rgb/.test(bg);
      });
      if (accentish.length > 1)
        out.push(`more than one filled-looking button: ${accentish.length}`);
      return out;
    },
    {
      banned: BANNED.map(r => r.source),
      glyph: BANNED_GLYPH.source,
      keyChars: KEY_CHARS.source,
    },
  );
}

const browser = await chromium.launch();
const errors = [];
const names = await (async () => {
  const page = await browser.newPage();
  await page.goto(GALLERY);
  const list = await page.evaluate(() => window.__askStates ?? []);
  await page.close();
  return list;
})();
for (const name of names) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  for (const theme of ['light', 'dark']) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: width === 1440 ? 900 : 760 },
      });
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(String(e)));
      await page.goto(`${GALLERY}?state=${encodeURIComponent(name)}&theme=${theme}&w=${width}`);
      await page.waitForFunction(
        () => document.documentElement.dataset.previewReady === 'true',
        null,
        {
          timeout: 15_000,
        },
      );
      const file = path.join(OUT, `${name}-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      const found = [...pageErrors, ...(await audit(page))];
      if (found.length) errors.push(`${name} ${theme} ${width}: ${found.join('; ')}`);
      await page.close();
    }
  }
}
await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`captured ${names.length} states × 2 themes × ${WIDTHS.length} widths into ${OUT}`);
