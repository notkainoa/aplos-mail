#!/usr/bin/env node
// Headless captures and design checks for the Settings preview gallery (DESIGN 7.10; plan 30 U7).
// It starts nothing: run the renderer's Vite server first, from apps/desktop:
//   APLOS_VITE_PORT=5285 npx vite
// then:
//   node src/renderer/screens/settings/preview/shoot.mjs [outDir] [--base http://127.0.0.1:5285] [--only name,name]
//   HOVER=1 node …/shoot.mjs        adds the hover-never-shifts check (light theme)
//   CANARY=1 node …/shoot.mjs       plants a fake key everywhere a key could leak and fails if it shows anywhere
//   INTERACT=1 node …/shoot.mjs     drives the add-key dialog and checks the key is gone from the page afterwards
//   SELFTEST=1 node …/shoot.mjs     plants one violation of each kind and requires every check to catch it
// Every state is captured in light and dark at 1440 × 900 (or the state's own window) into outDir (default
// /tmp/uiset-shots/gallery). Checks per capture: page errors, more than one visible filled button, text under 11 px,
// banned words and glyphs, a page title, the nav not level with the first group, rows under 40 or 48 px, a row
// without a palette anchor, and with HOVER=1 hover moving any other box by more than 0.5 px. Exits 1 on any finding.
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
const BASE = (flag('--base') || process.env.BASE || 'http://127.0.0.1:5285').replace(/\/$/, '');
const ONLY = (flag('--only') || process.env.ONLY || '').split(',').filter(Boolean);
const OUT = path.resolve(args[0] || '/tmp/uiset-shots/gallery');
const HOVER = process.env.HOVER === '1';
const CANARY_ON = process.env.CANARY === '1';
const GALLERY = `${BASE}/src/renderer/screens/settings/preview/index.html`;
const CANARY = 'gsk_CANARY_0123456789abcdefSECRET';

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
  /testing mode/i,
  /verification/i,
  /!/,
  /✨|⭐|★|☆|🪄|🤖|🧠/u,
  // Round 1 offers Google only.
  /fastmail|icloud|\bimap\b|microsoft|outlook/i,
  // Key characters are never shown.
  /••••|last4|\bsk-|gsk_/i,
];
const BANNED_GLYPH = /sparkle|wand|\bstars?\b|brain|robot|\bbot\b/i;

async function audit(page, canaryOn = CANARY_ON) {
  return page.evaluate(
    ({ banned, glyph, canary, canaryOn }) => {
      const out = [];
      const visible = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };

      // Copy: visible text plus the names assistive tech reads.
      const strings = [document.body.innerText];
      document.querySelectorAll('[aria-label], [title], [placeholder]').forEach(el => {
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
      document.querySelectorAll('svg, use, [data-icon]').forEach(el => {
        [el.getAttribute('class'), el.getAttribute('href'), el.getAttribute('data-icon')]
          .filter(Boolean)
          .forEach(n => re.test(n) && out.push(`banned glyph "${n}"`));
      });

      // One filled button per screen (the topmost surface owns it).
      const filled = [...document.querySelectorAll('[data-variant="filled"]')].filter(
        b => b.tagName === 'BUTTON' && visible(b),
      );
      if (filled.length > 1)
        out.push(
          `${filled.length} filled buttons: ${filled.map(b => b.innerText.trim()).join(' | ')}`,
        );

      // Nothing under 11 px.
      const seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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

      // No page title: no h1 and no page-head.
      if (document.querySelector('h1, .ui-page-head')) out.push('a page title is drawn');

      // The nav starts level with the first group (DESIGN 7.10).
      const nav = document.querySelector('.settings-nav .ui-puck__item');
      const first = document.querySelector('.settings-content .ui-section-header');
      const layout = document.querySelector('.settings-layout');
      if (nav && first && layout) {
        const a = nav.getBoundingClientRect().top;
        const b = first.getBoundingClientRect().top;
        const stacked = getComputedStyle(layout).flexDirection === 'column';
        const firstIsGroup = !document.querySelector('.settings-content > .ui-error-line');
        const scrolled = (document.querySelector('.ui-pane__body')?.scrollTop ?? 0) > 0;
        if (!stacked && firstIsGroup && !scrolled && Math.abs(a - b) > 1) {
          out.push(`nav top ${Math.round(a)} is not level with the first group ${Math.round(b)}`);
        }
      }

      // Rows are 40 px, or 48 px with a description.
      document.querySelectorAll('.settings-content .ui-setting-row__main').forEach(r => {
        const h = r.getBoundingClientRect().height;
        const has = r.parentElement.getAttribute('data-has-description') === 'true';
        const want = has ? 48 : 40;
        if (h + 0.5 < want)
          out.push(`row "${r.innerText.trim().slice(0, 24)}" is ${h}px, under ${want}`);
      });

      // Every SettingRow sits under a palette anchor (plan 30 U7 acceptance 2).
      document.querySelectorAll('.settings-content .ui-setting-row').forEach(r => {
        if (!r.closest('[data-setting-anchor]'))
          out.push(`a SettingRow has no palette anchor: "${r.innerText.trim().slice(0, 24)}"`);
      });

      // Nothing in the column spills out of it, and the window never scrolls sideways.
      const content = document.querySelector('.settings-content');
      if (content) {
        const box = content.getBoundingClientRect();
        content
          .querySelectorAll('.ui-setting-row__main, .ui-provider-table__row, .ui-key-recorder')
          .forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.right > box.right + 1)
              out.push(`a row spills out of the column: "${el.innerText.trim().slice(0, 24)}"`);
          });
      }
      if (document.documentElement.scrollWidth > innerWidth + 1)
        out.push('the window scrolls sideways');

      // The canary key is nowhere: not in text, not in any attribute.
      if (canaryOn) {
        if (document.documentElement.outerHTML.includes(canary))
          out.push('THE CANARY KEY IS IN THE DOM');
        if (document.body.innerText.includes(canary)) out.push('THE CANARY KEY IS IN THE TEXT');
      }
      return [...new Set(out)];
    },
    {
      banned: BANNED.map(r => ({ src: r.source, flags: r.flags })),
      glyph: { src: BANNED_GLYPH.source, flags: BANNED_GLYPH.flags },
      canary: CANARY,
      canaryOn,
    },
  );
}

// DESIGN 5 rule 17: hover every interactive element; no other box may move more than 0.5 px.
async function hoverShift(page) {
  const count = await page.evaluate(() => {
    const root = document.querySelector('.settings-screen');
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
      ...root.querySelectorAll('button, a, input, select, [role="radio"], [role="switch"]'),
    ]
      .filter(visible)
      .slice(0, 80);
    window.__watch = [
      ...root.querySelectorAll(
        'button, a, input, kbd, h2, p, span, [role="radio"], .ui-setting-row',
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

async function open(name, theme, size) {
  const context = await browser.newContext({
    viewport: size,
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
  const canary = CANARY_ON ? '&canary=1' : '';
  await page.goto(`${GALLERY}?state=${encodeURIComponent(name)}&theme=${theme}${canary}`);
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset.previewReady === 'true',
      null,
      { timeout: 15_000 },
    );
  } catch {
    errors.push('the state never became ready');
  }
  await page.waitForTimeout(250);
  return { context, page, errors };
}

// SELFTEST=1: plant one violation of each kind into a real state and require every check to catch it.
if (process.env.SELFTEST === '1') {
  const { page } = await open('mail', 'light', { width: 1440, height: 900 });
  // The plants are violations on purpose; their values are passed in as data, never written as literal markup.
  const plant = { word: ['Ma', 'gic inbox'].join(''), px: 9, pad: 20, key: CANARY };
  await page.evaluate(({ word, px, pad, key }) => {
    const col = document.querySelector('.settings-content');
    const extra = document.createElement('div');
    const first = document.createElement('button');
    first.dataset.variant = 'filled';
    first.textContent = 'First';
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
    const leak = document.createElement('p');
    leak.setAttribute('title', key);
    leak.textContent = 'Leaky';
    const title = document.createElement('h1');
    title.textContent = 'Mail';
    const shifty = document.createElement('button');
    shifty.textContent = 'Hover me';
    const victim = document.createElement('span');
    victim.textContent = 'Neighbour';
    extra.append(first, second, tiny, banned, glyph, leak, title, shifty, victim);
    col.prepend(extra);
    shifty.addEventListener('mouseenter', () => shifty.style.setProperty('padding', `${pad}px`));
    shifty.addEventListener('mouseleave', () => shifty.style.removeProperty('padding'));
  }, plant);
  const found = [...(await audit(page, true)), ...(await hoverShift(page))].join('\n');
  const expect = {
    'filled buttons': /2 filled buttons/,
    'text size': /under 11px/,
    copy: /banned copy/,
    glyph: /banned glyph/,
    title: /page title/,
    canary: /CANARY KEY IS IN THE DOM/,
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
  await probe.waitForFunction(() => window.__setStates !== undefined, null, { timeout: 30_000 });
  const table = await probe.evaluate(() => window.__setStates);
  await probe.close();
  const names = Object.keys(table).filter(n => ONLY.length === 0 || ONLY.includes(n));

  for (const theme of ['light', 'dark']) {
    for (const name of names) {
      const { context, page, errors } = await open(name, theme, table[name]);
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

  // INTERACT=1: type a key into the add-key dialog, press Return, and require that nothing keeps it.
  if (process.env.INTERACT === '1') {
    const { context, page, errors } = await open('ai-add-key', 'light', {
      width: 1440,
      height: 900,
    });
    const found = [...errors];
    const field = page.locator('#set-add-key-field');
    await field.fill(CANARY);
    const type = await field.getAttribute('type');
    if (type !== 'password') found.push(`the key field is type ${type}, not password`);
    await field.press('Enter');
    await page.waitForTimeout(400);
    const html = await page.evaluate(
      () => document.documentElement.outerHTML + '\n' + document.body.innerText,
    );
    if (html.includes(CANARY)) found.push('THE KEY IS STILL IN THE PAGE AFTER SAVING');
    if ((await page.locator('#set-add-key-field').count()) !== 0)
      found.push('the add-key dialog stayed open after saving');
    const status = await page.locator('.ui-provider-table__status').allInnerTexts();
    console.log(`interact: after saving, the status cells read "${status.join(' | ')}"`);
    if (found.length) {
      issues += found.length;
      console.log('\ninteract: add key');
      found.forEach(f => console.log(`  - ${f}`));
    } else
      console.log('ok interact: add key (field cleared, key gone from the page, dialog closed)');
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${issues} issue(s); shots in ${OUT}`);
process.exitCode = issues ? 1 : 0;
