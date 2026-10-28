#!/usr/bin/env node
// Headless captures and design checks for the Calendar preview gallery (DESIGN 7.8, 12.5; plan 30 U7 acceptance 6).
// It starts nothing: run the renderer's Vite server first, from apps/desktop:
//   APLOS_VITE_PORT=5284 npx vite
// then:
//   node src/renderer/screens/calendar/preview/shoot.mjs [outDir] [--base http://127.0.0.1:5284] [--only name,name]
//   HOVER=1 node …/shoot.mjs        adds the hover-never-shifts check (light theme)
//   SELFTEST=1 node …/shoot.mjs     plants one violation of each kind and requires every check to catch it
// Every state is captured in light and dark at its window size (1440 × 900 unless the state says otherwise) in
// America/Los_Angeles with the en-US locale (the harness clock is 2026-10-29 10:00 there) into outDir (default
// /tmp/uionb-shots/ui-calendar). Checks per capture: page errors; more than one visible filled button on the topmost
// surface; text under 11 px; banned words (DESIGN 10) and glyphs (sparkle, wand, star); no page title (h1); every
// lane and "+N" stack at least 44 px wide; no grid under a 720 px pane (the agenda instead); and, with HOVER=1, hover
// moving any other box by more than 0.5 px. Exits 1 when anything is found.
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
const BASE = (flag('--base') || process.env.BASE || 'http://127.0.0.1:5284').replace(/\/$/, '');
const ONLY = (flag('--only') || process.env.ONLY || '').split(',').filter(Boolean);
const OUT = path.resolve(args[0] || '/tmp/uionb-shots/ui-calendar');
const HOVER = process.env.HOVER === '1';
const GALLERY = `${BASE}/src/renderer/screens/calendar/preview/index.html`;
const CONTEXT = { timezoneId: 'America/Los_Angeles', locale: 'en-US', deviceScaleFactor: 2, reducedMotion: 'reduce' };

fs.mkdirSync(OUT, { recursive: true });

// DESIGN 10's lint list and the aplos-design skill's "Never" column.
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
  /\bsmart\b/i,
  /all clear for now/i,
  /ready when you are/i,
  /waiting on you/i,
  /no reply yet/i,
  /!/,
  /✨|⭐|★|☆|🪄|🤖|🧠/u,
];
const BANNED_GLYPH = /sparkle|wand|\bstars?\b|brain|robot|\bbot\b/i;

async function audit(page) {
  return page.evaluate(
    ({ banned, glyph }) => {
      const out = [];
      const root = document.querySelector('.calp-window') || document.body;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };

      // Copy: visible text plus the names assistive tech reads.
      const strings = [root.innerText];
      root.querySelectorAll('[aria-label], [title], [placeholder]').forEach(el => {
        for (const a of ['aria-label', 'title', 'placeholder']) {
          const v = el.getAttribute(a);
          if (v) strings.push(v);
        }
      });
      const copy = strings.join('\n');
      banned.forEach(({ src, flags }) => {
        const re = new RegExp(src, flags);
        const hit = copy.match(re);
        if (hit)
          out.push(
            `banned copy ${re} in "${copy.slice(Math.max(0, hit.index - 20), hit.index + 30).replace(/\s+/g, ' ')}"`,
          );
      });

      // Glyphs: icon class names, sprite references and icon attributes.
      const re = new RegExp(glyph.src, glyph.flags);
      root.querySelectorAll('svg, use, [data-icon]').forEach(el => {
        [el.getAttribute('class'), el.getAttribute('href'), el.getAttribute('xlink:href'), el.getAttribute('data-icon')]
          .filter(Boolean)
          .forEach(n => {
            if (re.test(n)) out.push(`banned glyph "${n}"`);
          });
      });

      // One filled button per screen, owned by the topmost surface: a dialog when one is open, else the pane.
      const dialog = [...root.querySelectorAll('.ui-dialog')].filter(visible).pop();
      const surface = dialog || root;
      const filled = [...surface.querySelectorAll('[data-variant="filled"]')].filter(
        b => b.tagName === 'BUTTON' && visible(b),
      );
      if (filled.length > 1)
        out.push(`${filled.length} filled buttons: ${filled.map(b => b.innerText.trim()).join(' | ')}`);

      // Nothing under 11 px.
      const seen = new Set();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim()) continue;
        const el = node.parentElement;
        if (!el || seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 11) out.push(`text under 11px (${size}px): "${node.textContent.trim().slice(0, 30)}"`);
      }

      // No page titles (DESIGN 7): the date label is a small title, never a heading of the page.
      root.querySelectorAll('h1').forEach(h => {
        if (visible(h) && !h.closest('.ui-dialog')) out.push(`page title h1 "${h.innerText.trim().slice(0, 30)}"`);
      });

      // Lanes and the "+N" stack are never under 44 px (DESIGN 7.8; acceptance 6).
      root.querySelectorAll('.ui-calendar-grid__slot').forEach(slot => {
        const r = slot.getBoundingClientRect();
        if (visible(slot) && r.width < 43.5)
          out.push(`lane ${Math.round(r.width)}px wide: "${slot.innerText.trim().slice(0, 24)}"`);
      });

      // Under a 720 px pane the agenda replaces the grid.
      const screen = root.querySelector('.cal-screen');
      if (screen && screen.getBoundingClientRect().width < 720 && root.querySelector('.cal-screen [role="grid"]'))
        out.push('a grid under a 720 px pane');

      // Text that overflows its box without an ellipsis (clipped words).
      root.querySelectorAll('.ui-event-block__title, .ui-page-head__date-label, .ui-page-head__date-range').forEach(el => {
        if (!visible(el)) return;
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowWrap !== 'anywhere')
          out.push(`clipped text without an ellipsis: "${el.innerText.trim().slice(0, 24)}"`);
      });

      // The page itself never scrolls; the grid scrolls inside the pane.
      if (document.documentElement.scrollHeight > innerHeight + 1) out.push('the window itself scrolls');
      return [...new Set(out)];
    },
    {
      banned: BANNED.map(r => ({ src: r.source, flags: r.flags })),
      glyph: { src: BANNED_GLYPH.source, flags: BANNED_GLYPH.flags },
    },
  );
}

// DESIGN 5 rule 17: hover every interactive element; no other box may move more than 0.5 px.
async function hoverShift(page) {
  const count = await page.evaluate(() => {
    const root = document.querySelector('.calp-window');
    const visible = el => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        getComputedStyle(el).visibility !== 'hidden'
      );
    };
    window.__targets = [
      ...root.querySelectorAll(
        'button, a, input, [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemradio"], .ui-calendar-grid__track',
      ),
    ]
      .filter(visible)
      .slice(0, 160);
    window.__watch = [
      ...root.querySelectorAll(
        'button, a, input, kbd, h2, h3, p, span, [role="radio"], [role="tab"], .ui-calendar-grid__slot, .ui-calendar-grid__dh',
      ),
    ].filter(visible);
    return window.__targets.length;
  });
  const found = [];
  for (let i = 0; i < count; i += 1) {
    const before = await page.evaluate(() =>
      window.__watch.map(e => {
        const r = e.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
    const point = await page.evaluate(i => {
      const r = window.__targets[i].getBoundingClientRect();
      return { x: r.x + Math.min(r.width / 2, 40), y: r.y + Math.min(r.height / 2, 20) };
    }, i);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(140);
    const moved = await page.evaluate(
      ([i, before]) => {
        const t = window.__targets[i];
        const hits = [];
        window.__watch.forEach((e, j) => {
          if (t.contains(e) || e.contains(t) || e.closest('[role="tooltip"], .ui-part-tip')) return;
          const r = e.getBoundingClientRect();
          const b = before[j];
          if (
            Math.abs(r.x - b[0]) > 0.5 ||
            Math.abs(r.y - b[1]) > 0.5 ||
            Math.abs(r.width - b[2]) > 0.5 ||
            Math.abs(r.height - b[3]) > 0.5
          )
            hits.push((e.innerText || e.className || e.tagName).toString().trim().slice(0, 24));
        });
        const name = (t.innerText || t.getAttribute('aria-label') || t.className || t.tagName)
          .toString()
          .trim()
          .slice(0, 24);
        return hits.length ? `hover "${name}" moved: ${hits.slice(0, 3).join(' | ')}` : null;
      },
      [i, before],
    );
    if (moved) found.push(`LAYOUT SHIFT ${moved}`);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(60);
  }
  return [...new Set(found)];
}

const browser = await chromium.launch({ headless: true });
let issues = 0;

async function open(context, name, theme) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`page error: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
  });
  await page.goto(`${GALLERY}?state=${encodeURIComponent(name)}&theme=${theme}`);
  try {
    await page.waitForFunction(() => document.documentElement.dataset.previewReady === 'true', null, {
      timeout: 20_000,
    });
  } catch {
    errors.push('the state never became ready');
  }
  await page.waitForTimeout(300);
  return { page, errors };
}

// SELFTEST=1: plant one violation of each kind into a real state and require every check to catch it.
if (process.env.SELFTEST === '1') {
  const context = await browser.newContext({ ...CONTEXT, viewport: { width: 1440, height: 900 } });
  const { page } = await open(context, 'week-default', 'light');
  const plant = { word: ['Ma', 'gic calendar'].join(''), px: 9, pad: 20 };
  await page.evaluate(({ word, px, pad }) => {
    const head = document.querySelector('.cal-screen .ui-page-head');
    const extra = document.createElement('div');
    const one = document.createElement('button');
    one.dataset.variant = 'filled';
    one.textContent = 'First';
    const two = document.createElement('button');
    two.dataset.variant = 'filled';
    two.textContent = 'Second';
    const tiny = document.createElement('p');
    tiny.textContent = 'Tiny words';
    tiny.style.setProperty('font-size', `${px}px`);
    const banned = document.createElement('p');
    banned.textContent = word;
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('class', 'lucide lucide-sparkles');
    const title = document.createElement('h1');
    title.textContent = 'October';
    const shifty = document.createElement('button');
    shifty.textContent = 'Hover me';
    const victim = document.createElement('span');
    victim.textContent = 'Neighbour';
    extra.append(one, two, tiny, banned, glyph, title, shifty, victim);
    head.prepend(extra);
    shifty.addEventListener('mouseenter', () => shifty.style.setProperty('padding', `${pad}px`));
    shifty.addEventListener('mouseleave', () => shifty.style.removeProperty('padding'));
    const slot = document.querySelector('.ui-calendar-grid__slot');
    slot.style.setProperty('width', `${px * 3}px`);
  }, plant);
  const found = [...(await audit(page)), ...(await hoverShift(page))].join('\n');
  const expect = {
    'filled buttons': /filled buttons/,
    'text size': /under 11px/,
    copy: /banned copy/,
    glyph: /banned glyph/,
    'page title': /page title/,
    'narrow lane': /lane \d+px wide/,
    hover: /LAYOUT SHIFT/,
  };
  let missed = 0;
  for (const [name, re] of Object.entries(expect)) {
    const ok = re.test(found);
    if (!ok) missed += 1;
    console.log(`${ok ? 'caught' : 'MISSED'} ${name}`);
  }
  await browser.close();
  process.exit(missed ? 1 : 0);
}

try {
  const probe = await browser.newPage();
  await probe.goto(GALLERY);
  await probe.waitForFunction(() => window.__calStates !== undefined, null, { timeout: 30_000 });
  const table = await probe.evaluate(() => window.__calStates);
  await probe.close();
  const names = Object.keys(table).filter(n => ONLY.length === 0 || ONLY.includes(n));

  for (const theme of ['light', 'dark']) {
    for (const name of names) {
      const { width, height } = table[name];
      const context = await browser.newContext({ ...CONTEXT, viewport: { width, height }, colorScheme: theme });
      const { page, errors } = await open(context, name, theme);
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file) });
      const found = [...errors, ...(await audit(page))];
      if (HOVER && theme === 'light') found.push(...(await hoverShift(page)));
      if (found.length) {
        issues += found.length;
        console.log(`\n${file}`);
        found.forEach(f => console.log(`  - ${f}`));
      } else console.log(`ok ${file}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${issues} issue(s); shots in ${OUT}`);
process.exitCode = issues ? 1 : 0;
