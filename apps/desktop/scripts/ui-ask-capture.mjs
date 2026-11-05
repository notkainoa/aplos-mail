#!/usr/bin/env node
// Owner-review captures for the ui-ask lane (feature 7: Ask dock, Today, ⌘K palette, Search), on the fixture's
// demo scenario only. From the repo root:
//   node apps/desktop/scripts/ui-ask-capture.mjs [outDir] [--port 5194]
// outDir defaults to ~/.local/share/aplos-mail-review/ui-ask/<short sha>/.
//
// It starts its own Vite dev server on the repo-root config (tests/visual/vite.config.ts: no CSP plugin, so it
// serves the preview galleries and can transform src/renderer/main.tsx) on its own port, then drives headless
// Chromium (the repo's playwright install):
//   1. every state of the Ask/Today gallery and the palette/search gallery × light/dark × 1440/1100 at
//      deviceScaleFactor 2;
//   2. the real app booted in the browser on the stand-in engine (a page-route serves a wrapper HTML whose only
//      script is /apps/desktop/src/renderer/main.tsx, so dev mode mounts <App/> on the demo scenario), ten scenes
//      × light/dark at 1440×900;
//   3. a keyboard-only walkthrough with numbered frames, a webm recording and walkthrough.md.
// Nothing leaves 127.0.0.1, no keys are read or set, and findings (page errors, console errors, the gallery
// audit's banned-word/glyph checks) land in findings.json for index.md.
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const { chromium } = require(path.join(repoRoot, 'node_modules', 'playwright'));

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const sha = () => execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 1100, h: 760 },
];
const ASK_GALLERY = '/apps/desktop/src/renderer/screens/ask/preview/index.html';
const PALETTE_GALLERY = '/apps/desktop/src/renderer/screens/palette/preview/index.html';
const SHELL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aplos Mail</title></head>
<body><div id="root"></div><script type="module" src="/apps/desktop/src/renderer/main.tsx"></script></body></html>`;

const KEY_CHARS = /sk-[A-Za-z0-9]|api[_-]?key[=: ]?\w|bearer [a-z0-9._-]+|xox[baprs]-/i;
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
  /✨|⭐|★|☆|🪄|🤖|🧠/u,
];
const BANNED_GLYPH = /sparkle|wand|\bstars?\b|brain|robot|\bbot\b/i;

const findings = [];
const priorFindings = file => {
  try {
    for (const f of JSON.parse(fs.readFileSync(file, 'utf8'))) findings.push(f);
  } catch {
    // no earlier run's findings to keep
  }
};
const safe = text => (KEY_CHARS.test(text) ? '[redacted: key-shaped string]' : text);
const note = (where, what) => findings.push(`${where}: ${safe(String(what))}`);

function attach(page, where) {
  page.on('pageerror', e => note(where, `pageerror ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') note(where, `console.error ${m.text()}`);
  });
  page.on('requestfailed', r =>
    note(where, `requestfailed ${r.url()} ${r.failure()?.errorText ?? ''}`),
  );
}

/** The gallery audit from screens/ask/preview/shoot.mjs: banned copy, banned glyphs, stray key-shaped text. */
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
      if (new RegExp(keyChars, 'i').test(text)) out.push('key-shaped text rendered');
      const glyphRe = new RegExp(glyph, 'i');
      for (const el of root.querySelectorAll('*')) {
        if (!visible(el)) continue;
        const name = `${el.getAttribute('class') || ''} ${el.getAttribute('data-icon') || ''}`;
        if (glyphRe.test(name)) out.push(`banned glyph in class: ${name.slice(0, 80)}`);
      }
      return out;
    },
    { banned: BANNED.map(r => r.source), glyph: BANNED_GLYPH.source, keyChars: KEY_CHARS.source },
  );
}

/** A port nobody else is on: bind 0, take what the OS gives. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startVite(port) {
  const child = spawn(
    'npx',
    [
      'vite',
      '--config',
      'tests/visual/vite.config.ts',
      '--port',
      String(port),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', d => process.stderr.write(d));
  const url = `http://127.0.0.1:${port}${ASK_GALLERY}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return child;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`vite did not come up on ${port} within 60 s`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Wait one rAF after fonts, so captures never catch a fallback face or half-applied theme. */
async function settle(page, ms = 150) {
  await page.evaluate(() =>
    document.fonts.ready.then(
      () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
    ),
  );
  await wait(ms);
}

async function stateList(browser, base, gallery, globalName) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}${gallery}`);
    return await page.evaluate(name => window[name] ?? [], globalName);
  } finally {
    await page.close();
  }
}

async function shootGalleries(browser, base) {
  const sets = [
    {
      gallery: ASK_GALLERY,
      globalName: '__askStates',
      ready: "document.documentElement.dataset.previewReady === 'true'",
      wParam: true,
    },
    {
      gallery: PALETTE_GALLERY,
      globalName: '__paletteStates',
      ready: 'window.__previewReady === true',
      wParam: false,
    },
  ];
  let count = 0;
  for (const { gallery, globalName, ready, wParam } of sets) {
    const names = await stateList(browser, base, gallery, globalName);
    if (!names.length) note(gallery, 'no states exported');
    for (const name of names) {
      for (const theme of ['light', 'dark']) {
        for (const { w, h } of WIDTHS) {
          const ctx = await browser.newContext({
            viewport: { width: w, height: h },
            deviceScaleFactor: 2,
            reducedMotion: 'reduce',
          });
          const page = await ctx.newPage();
          attach(page, `${name} ${theme} ${w}`);
          const url = `${base}${gallery}?state=${encodeURIComponent(name)}&theme=${theme}${wParam ? `&w=${w}` : ''}`;
          try {
            await page.goto(url);
            await page.waitForFunction(ready, null, { timeout: 15_000 });
            await settle(page);
            const file = path.join(OUT, `${name}-${theme}-${w}.png`);
            await page.screenshot({ path: file });
            for (const hit of await audit(page)) note(`${name} ${theme} ${w}`, hit);
            count++;
          } catch (e) {
            note(`${name} ${theme} ${w}`, `capture failed: ${e.message?.split('\n')[0]}`);
          }
          await ctx.close();
        }
      }
    }
  }
  return count;
}

/** Boot the real renderer on the stand-in engine: '/' is fulfilled with the wrapper, everything else hits vite. */
async function shellPage(browser, theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.route(`${BASE}/`, route =>
    route.fulfill({ contentType: 'text/html', body: SHELL_HTML }),
  );
  attach(page, `shell ${theme}`);
  await page.goto(`${BASE}/`);
  await page.evaluate(t => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForSelector('[data-screen="home"]', { timeout: 30_000 });
  await settle(page, 400);
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function shellScenes(browser, theme) {
  const t = name => `shell-${name}-${theme}`;
  const { ctx, page } = await shellPage(browser, theme);
  try {
    // 1. First run: Home, dock closed.
    await shot(page, t('home'));
    // 2. 'a' opens the dock on Ask: suggestions and the field.
    await page.keyboard.press('a');
    await page.waitForSelector('section.ui-pane[data-kind="dock"]', { timeout: 10_000 });
    await page.waitForSelector('.ui-ask-dock__option', { timeout: 10_000 });
    await settle(page);
    await shot(page, t('ask-empty'));
    // 3. Ask a suggested question; wait for the settled answer (caret gone, sources/citations in).
    await page.click('.ui-ask-dock__option');
    const answered = await page
      .waitForSelector('.ui-ask-turn__answer', { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!answered) {
      // The suggestion only filled the field: Return submits it.
      note(`shell ${theme}`, 'suggestion click filled the field; pressed Return to submit');
      await page.keyboard.press('Enter');
      await page
        .waitForSelector('.ui-ask-turn__answer', { timeout: 15_000 })
        .catch(() => undefined);
    }
    await page
      .waitForSelector('.ui-ask-turn__caret', { state: 'detached', timeout: 15_000 })
      .catch(() => undefined);
    await settle(page, 600);
    await shot(page, t('ask-answered'));
    // 4. The Today tab.
    await page.click('.ui-ask-dock__tab >> text=Today');
    await page.waitForSelector('.today-screen', { timeout: 10_000 });
    await settle(page);
    await shot(page, t('today'));
    // 5. ⌘K first open, then a typed query.
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.ui-palette__panel', { timeout: 10_000 });
    await settle(page);
    await shot(page, t('palette-open'));
    await page.keyboard.type('sett', { delay: 25 });
    await settle(page, 250);
    await shot(page, t('palette-query'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ui-palette__panel', { state: 'detached', timeout: 10_000 });
    // 6. A destructive confirm row: compose a draft, then the palette's "Discard the draft". ⌘J closes the
    //    dock first so the single-key 'c' can't land in its field.
    await page.keyboard.press('Meta+j');
    await wait(300);
    await page.keyboard.press('c');
    await page.waitForSelector('.aplos-compose', { timeout: 10_000 });
    await settle(page);
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.ui-palette__panel', { timeout: 10_000 });
    await page.keyboard.type('discard', { delay: 25 });
    await settle(page, 200);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ui-palette__confirm', { timeout: 10_000 });
    await settle(page);
    await shot(page, t('confirm'));
    // Back out: cancel the confirm, close the palette, leave compose.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Escape');
      await wait(300);
      if (
        (await page.$('.aplos-compose')) === null &&
        (await page.$('.ui-palette__panel')) === null
      )
        break;
    }
    // 7. Search: '/' opens it, 'project' matches three demo threads, an in:done pill plus a term one
    //    done thread really matches ('coffee' is the done "Coffee and the next chapter" thread).
    await page.keyboard.press('/');
    await page.waitForSelector('.search-screen', { timeout: 10_000 });
    await settle(page);
    await shot(page, t('search-empty'));
    await page.keyboard.type('project', { delay: 25 });
    await settle(page, 500);
    await shot(page, t('search-query'));
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('in:done coffee', { delay: 25 });
    await page.waitForSelector('.ui-operator-token', { timeout: 10_000 });
    await settle(page, 400);
    await shot(page, t('search-indone'));
    // 8. The consent hold, for real: the page's own data api revokes the stand-in's consent record,
    //    the dock reopens on Ask, a typed question's Return is held by the consent line — not run.
    const revoked = await page
      .evaluate(async () => {
        try {
          const data = await import('/apps/desktop/src/renderer/data/index.ts');
          await data.api.consent.revoke({ scope: 'background' });
          return true;
        } catch (e) {
          return String(e?.message ?? e);
        }
      })
      .catch(e => String(e?.message ?? e));
    if (revoked !== true) note(`shell ${theme}`, `Consent/revoke via page api failed: ${revoked}`);
    await page.keyboard.press('Meta+j');
    await page.waitForSelector('section.ui-pane[data-kind="dock"]', { timeout: 10_000 });
    let consentUp = await page
      .waitForSelector('.ask-screen__consent', { timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!consentUp) {
      // The dock may have reopened on the Today tab; the consent line only draws on Ask.
      await page.click('.ui-ask-dock__tab >> text=Ask').catch(() => undefined);
      consentUp = await page
        .waitForSelector('.ask-screen__consent', { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!consentUp) note(`shell ${theme}`, 'consent line never showed after Consent/revoke');
    // A fresh chat so the held state is not crowded by the earlier answered turn.
    await page.keyboard.press('Meta+n');
    // The tab click moved focus; put it back in the field before typing.
    await page.click('.ui-ask-dock__input').catch(() => undefined);
    await page.keyboard.type('What needs my reply today?', { delay: 20 });
    await page.keyboard.press('Enter');
    await settle(page, 400);
    await shot(page, t('ask-consent'));
  } finally {
    await ctx.close();
  }
}

const walkNotes = [];
async function walkthrough(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: path.join(OUT, 'video'), size: { width: 1440, height: 900 } },
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.route(`${BASE}/`, route =>
    route.fulfill({ contentType: 'text/html', body: SHELL_HTML }),
  );
  attach(page, 'walkthrough');
  let n = 0;
  const frame = async what => {
    n++;
    const file = path.join(OUT, `walkthrough-${String(n).padStart(2, '0')}.png`);
    await settle(page, 200);
    await page.screenshot({ path: file });
    walkNotes.push({ n, file: path.basename(file), what });
  };
  const step = async (keys, what, act) => {
    try {
      await act();
    } catch (e) {
      walkNotes.push({
        n: null,
        what: `after ${keys}: action threw — ${safe(e.message?.split('\n')[0] ?? e)}`,
      });
    }
    // `what` may be a thunk so a note can describe the state the key left behind.
    await frame(typeof what === 'function' ? await what() : what);
  };
  const expect = async (sel, what) => {
    const ok = await page
      .waitForSelector(sel, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) walkNotes.push({ n: null, what: `expected but never saw ${sel} — ${what}` });
    return ok;
  };

  await page.goto(`${BASE}/`);
  await expect('[data-screen="home"]', 'Home on the stand-in engine');
  await frame('Boot: Home on the stand-in engine (demo data), dock closed.');

  await step('⌘K', '⌘K pressed: expected the command palette over Home.', () =>
    page.keyboard.press('Meta+k'),
  );
  await expect('.ui-palette__panel', 'the palette after ⌘K');
  await step("'sett' typed", 'Typed sett: filtered command list.', async () => {
    await page.keyboard.type('sett', { delay: 30 });
    await wait(300);
  });
  await step('Esc', 'Esc pressed: expected the palette to close.', () =>
    page.keyboard.press('Escape'),
  );
  await step("'/'", '/ pressed: expected the Search page.', () => page.keyboard.press('/'));
  await expect('.search-screen', 'the Search page after /');
  await step("'project' typed", 'Typed project: local results as ordinary rows.', async () => {
    await page.keyboard.type('project', { delay: 30 });
    await wait(500);
  });
  const whereAmI = async () => {
    const on = await page.evaluate(() => ({
      screen:
        document.querySelector('[data-screen]')?.getAttribute('data-screen') ??
        (document.querySelector('.search-screen')
          ? 'search'
          : document.querySelector('.aplos-compose')
            ? 'compose'
            : '?'),
      focus: document.activeElement?.tagName?.toLowerCase() ?? '?',
      dock: document.querySelector('section.ui-pane[data-kind="dock"]') !== null,
    }));
    return `${on.screen} screen, focus in <${on.focus}>${on.dock ? ', dock open' : ''}`;
  };
  await step(
    'Esc',
    async () => `Esc on Search: afterwards ${await whereAmI()}.`,
    () => page.keyboard.press('Escape'),
  );
  walkNotes.push({
    n: null,
    what:
      'Bare keys cannot leave the search field — it owns the keystrokes by design — so ⌘J ' +
      '(a modified key) opens the Ask dock here, never a bare a.',
  });
  await step('⌘J', '⌘J pressed: expected the Ask dock over Search.', () =>
    page.keyboard.press('Meta+j'),
  );
  await expect('section.ui-pane[data-kind="dock"]', 'the Ask dock after ⌘J');
  await step('question typed', 'A question typed into the Ask field.', async () => {
    await page.keyboard.type('What needs my reply today?', { delay: 20 });
    await wait(200);
  });
  await step('Return', 'Return submits: the run streams (steps, answer, citations).', () =>
    page.keyboard.press('Enter'),
  );
  await expect('.ui-ask-turn__answer', 'an answer streaming/settled after Return');
  await wait(1_600);
  await frame('Whatever state the run reached.');
  await step(
    'Esc',
    async () => `Esc in the dock: afterwards ${await whereAmI()}.`,
    () => page.keyboard.press('Escape'),
  );
  await step(
    'Esc again',
    async () => `Second Esc: afterwards ${await whereAmI()}.`,
    () => page.keyboard.press('Escape'),
  );
  await frame('Final frame.');

  await ctx.close();
  const dir = path.join(OUT, 'video');
  const webm = fs.readdirSync(dir).find(f => f.endsWith('.webm'));
  if (webm) fs.renameSync(path.join(dir, webm), path.join(OUT, 'walkthrough.webm'));
  fs.rmSync(dir, { recursive: true, force: true });

  const lines = [
    '# Keyboard walkthrough (headless Chromium, demo data, light theme, 1440×900)',
    '',
    'No mouse events were sent; every step used `page.keyboard` only.',
    '',
  ];
  for (const w of walkNotes) {
    if (w.n) lines.push(`${w.n}. \`${w.file}\` — ${w.what}`);
    else lines.push(`- ${w.what}`);
  }
  fs.writeFileSync(path.join(OUT, 'walkthrough.md'), lines.join('\n'));
}

const port = Number(flag('--port')) || (await freePort());
const BASE = `http://127.0.0.1:${port}`;
const ONLY_RUN = (flag('--only') || 'gallery,shell,walk').split(',');
// Positional args are read only after every flag() splice, so a flag name is never taken for the out dir.
const OUT = path.resolve(
  args[0] || path.join(os.homedir(), '.local', 'share', 'aplos-mail-review', 'ui-ask', sha()),
);
fs.mkdirSync(OUT, { recursive: true });
priorFindings(path.join(OUT, 'findings.json'));
if (ONLY_RUN.includes('walk')) {
  // Frame numbering restarts at 1: drop stale frames and the old recording.
  for (const f of fs.readdirSync(OUT))
    if (/^walkthrough-\d+\.png$/.test(f) || f === 'walkthrough.webm') fs.rmSync(path.join(OUT, f));
}

const vite = await startVite(port);
try {
  const browser = await chromium.launch();
  try {
    if (ONLY_RUN.includes('gallery')) {
      const galleryCount = await shootGalleries(browser, BASE);
      console.log(`gallery: ${galleryCount} captures`);
    }
    if (ONLY_RUN.includes('shell')) {
      for (const theme of ['light', 'dark']) await shellScenes(browser, theme);
      console.log('shell: 22 captures');
    }
    if (ONLY_RUN.includes('walk')) {
      await walkthrough(browser);
      console.log('walkthrough done');
    }
  } finally {
    await browser.close();
  }
} finally {
  vite.kill();
}
const unique = [...new Set(findings)];
fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(unique, null, 2));
console.log(`OUT=${OUT}`);
if (unique.length) {
  console.log(`findings (${unique.length}):`);
  for (const f of unique) console.log(`  ${f}`);
}
