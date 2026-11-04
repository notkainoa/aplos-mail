#!/usr/bin/env node
// Headless captures and design checks for the onboarding preview gallery (DESIGN 7.11, 12.5; plan 30 U8 acceptance 6).
// It starts nothing: run the renderer's Vite server first, e.g. from apps/desktop:
//   APLOS_VITE_PORT=5282 npx vite
// then:
//   node src/renderer/onboarding/preview/shoot.mjs [outDir] [--base http://127.0.0.1:5282] [--only name,name]
//   HOVER=1 node …/shoot.mjs        adds the hover-never-shifts check (light theme)
// Every state is captured in light and dark at 640 × 600 (or the state's own height, 520 for the F13 check) into
// outDir (default /tmp/uionb-shots/gallery). Checks per capture: page errors, more than one visible filled button,
// text under 11 px, banned words (DESIGN 10 plus "magic", "AI-powered"), banned glyphs (sparkle, wand, star), and
// with HOVER=1 hover moving any other box by more than 0.5 px. Exits 1 when anything is found.
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
const BASE = (flag('--base') || process.env.BASE || 'http://127.0.0.1:5282').replace(/\/$/, '');
const ONLY = (flag('--only') || process.env.ONLY || '').split(',').filter(Boolean);
const OUT = path.resolve(args[0] || '/tmp/uionb-shots/gallery');
const HOVER = process.env.HOVER === '1';
const GALLERY = `${BASE}/src/renderer/onboarding/preview/index.html`;
const WIDTH = 640;

fs.mkdirSync(OUT, { recursive: true });

// DESIGN 10's lint list, the aplos-design skill's "Never" column, and the U8 copy rules.
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
  /testing mode/i,
  /verification/i,
  /!/,
  /✨|⭐|★|☆|🪄|🤖|🧠/u,
];
const BANNED_GLYPH = /sparkle|wand|\bstars?\b|brain|robot|\bbot\b/i;

async function audit(page) {
  return page.evaluate(
    ({ banned, glyph }) => {
      const out = [];
      const root = document.querySelector('.onb-frame') || document.body;
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
        const names = [
          el.getAttribute('class'),
          el.getAttribute('href'),
          el.getAttribute('xlink:href'),
          el.getAttribute('data-icon'),
        ].filter(Boolean);
        names.forEach(n => {
          if (re.test(n)) out.push(`banned glyph "${n}"`);
        });
      });

      // One filled button per screen (the topmost surface owns it).
      const filled = [...root.querySelectorAll('[data-variant="filled"]')].filter(
        b => b.tagName === 'BUTTON' && visible(b),
      );
      if (filled.length > 1)
        out.push(
          `${filled.length} filled buttons: ${filled.map(b => b.innerText.trim()).join(' | ')}`,
        );

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
        if (size < 11)
          out.push(`text under 11px (${size}px): "${node.textContent.trim().slice(0, 30)}"`);
      }
      // F13: the step's title is fully on screen, and content taller than the window scrolls inside the step's
      // body (never off the window's top).
      const title = root.querySelector('h1');
      const frame = root.getBoundingClientRect();
      if (title) {
        const r = title.getBoundingClientRect();
        if (r.top < frame.top || r.bottom > frame.bottom)
          out.push(`F13 title clipped (top ${Math.round(r.top)})`);
      }
      const body = root.querySelector('main');
      if (body && body.scrollHeight > body.clientHeight + 1) {
        const overflow = getComputedStyle(body).overflowY;
        if (overflow !== 'auto' && overflow !== 'scroll')
          out.push('F13 long content does not scroll inside the step');
      }
      if (document.documentElement.scrollHeight > innerHeight + 1)
        out.push('F13 the window itself scrolls');
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
    const root = document.querySelector('.onb-frame');
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
        'button, a, input, [role="radio"], [role="switch"], .ui-text-field-box',
      ),
    ].filter(visible);
    window.__watch = [
      ...root.querySelectorAll(
        'button, a, input, kbd, h1, p, span, dt, dd, [role="radio"], .ui-choice-row',
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
      return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
    }, i);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(160);
    const moved = await page.evaluate(
      ([i, before]) => {
        const t = window.__targets[i];
        const hits = [];
        window.__watch.forEach((e, j) => {
          if (t.contains(e) || e.contains(t) || e.closest('[role="tooltip"]')) return;
          const r = e.getBoundingClientRect();
          const b = before[j];
          if (
            Math.abs(r.x - b[0]) > 0.5 ||
            Math.abs(r.y - b[1]) > 0.5 ||
            Math.abs(r.width - b[2]) > 0.5 ||
            Math.abs(r.height - b[3]) > 0.5
          ) {
            hits.push((e.innerText || e.className || e.tagName).toString().trim().slice(0, 24));
          }
        });
        const name = (t.innerText || t.getAttribute('aria-label') || t.tagName).trim().slice(0, 24);
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

// SELFTEST=1: plant one violation of each kind into a real state and require every check to catch it.
if (process.env.SELFTEST === '1') {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 600 } });
  const page = await context.newPage();
  await page.goto(`${GALLERY}?state=welcome&theme=light`);
  await page.waitForFunction(() => document.documentElement.dataset.previewReady === 'true');
  // The plants are violations on purpose. The design lint has no disable comments, so their values are passed in
  // as data (word, size, rule) rather than written as literal markup and CSS here.
  const plant = { word: ['Ma', 'gic inbox'].join(''), px: 9, pad: 20 };
  await page.evaluate(({ word, px, pad }) => {
    const main = document.querySelector('.onb-frame main');
    const extra = document.createElement('div');
    const second = document.createElement('button');
    second.dataset.variant = 'filled';
    second.textContent = 'Second';
    const tiny = document.createElement('p');
    tiny.textContent = 'Tiny words';
    tiny.style.setProperty('font-size', `${px}px`);
    const banned = document.createElement('p');
    banned.textContent = word;
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('class', 'lucide lucide-sparkles');
    const shifty = document.createElement('button');
    shifty.id = 'shifty';
    shifty.textContent = 'Hover me';
    const victim = document.createElement('span');
    victim.textContent = 'Neighbour';
    extra.append(second, tiny, banned, glyph, shifty, victim);
    main.prepend(extra);
    shifty.addEventListener('mouseenter', () => shifty.style.setProperty('padding', `${pad}px`));
    shifty.addEventListener('mouseleave', () => shifty.style.removeProperty('padding'));
  }, plant);
  const found = [...(await audit(page)), ...(await hoverShift(page))].join('\n');
  const expect = {
    'filled buttons': /2 filled buttons/,
    'text size': /under 11px/,
    copy: /banned copy/,
    glyph: /banned glyph/,
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
  await probe.waitForFunction(() => window.__onbStates !== undefined, null, { timeout: 30_000 });
  const table = await probe.evaluate(() => window.__onbStates);
  await probe.close();
  const names = Object.keys(table).filter(n => ONLY.length === 0 || ONLY.includes(n));

  for (const theme of ['light', 'dark']) {
    for (const name of names) {
      const height = table[name].height || 600;
      const context = await browser.newContext({
        viewport: { width: WIDTH, height },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(`page error: ${e.message}`));
      page.on('console', m => {
        if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
      });
      await page.goto(`${GALLERY}?state=${encodeURIComponent(name)}&theme=${theme}`);
      try {
        await page.waitForFunction(
          () => document.documentElement.dataset.previewReady === 'true',
          null,
          {
            timeout: 15_000,
          },
        );
      } catch {
        errors.push('the state never became ready');
      }
      await page.waitForTimeout(250);
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
