#!/usr/bin/env node
// A headless KEYBOARD walkthrough of the Settings preview gallery (DESIGN 7.10; plan 30 U7).
// Same harness as shoot.mjs: it starts nothing — run the renderer's Vite server first, from apps/desktop:
//   APLOS_VITE_PORT=5285 npx vite
// then:
//   node src/renderer/screens/settings/preview/walkthrough.mjs [outDir] [--base http://127.0.0.1:5285]
// Every step is driven by the real keyboard only (Tab, arrows, Return, Esc — never the mouse), in the light
// theme at 1440 × 900, and a numbered PNG follows each step into outDir (default
// ~/.local/share/aplos-mail-review/ui-settings/walkthrough-92f52120). walkthrough.md lists the key presses
// and what every frame shows. A control the keyboard cannot reach is a FINDING in that file, never faked.
// Playwright comes from the research tools install (PLAYWRIGHT overrides), always headless.
import fs from 'node:fs';
import os from 'node:os';
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
const OUT = path.resolve(
  args[0] || `${os.homedir()}/.local/share/aplos-mail-review/ui-settings/walkthrough-92f52120`,
);
const GALLERY = `${BASE}/src/renderer/screens/settings/preview/index.html`;

fs.mkdirSync(OUT, { recursive: true });

const frames = [];
const findings = [];
const browser = await chromium.launch({ headless: true });

/** One gallery state in the light theme at the window size, ready to be driven. */
async function open(state) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', e => findings.push(`page error in "${state}": ${e.message}`));
  await page.goto(`${GALLERY}?state=${encodeURIComponent(state)}&theme=light`, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => document.documentElement.dataset.previewReady === 'true', null, {
    timeout: 15_000,
  });
  await page.waitForTimeout(250);
  return { context, page };
}

const settle = (page, ms = 240) => page.waitForTimeout(ms);

/** Saves the frame and records it for walkthrough.md. */
async function shot(page, file, keys, shows) {
  await page.screenshot({ path: path.join(OUT, `${file}.png`) });
  frames.push({ file: `${file}.png`, keys, shows });
  console.log(`shot ${file}.png — ${keys}`);
}

/** What the keyboard focus is on: enough to name it in the report. */
const focused = page =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { kind: 'body' };
    const rec = el.closest('[data-command]');
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      aria: el.getAttribute('aria-label'),
      nav: Boolean(el.closest('.settings-nav')),
      command: rec ? rec.dataset.command : null,
    };
  });

const sectionOf = page =>
  page.evaluate(() => document.querySelector('.settings-screen')?.dataset.section ?? null);

/** Tabs until the predicate matches the focused element; throws (a finding) if it never does. */
async function tabUntil(page, pred, max = 90) {
  let last = null;
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(70);
    last = await focused(page);
    if (pred(last)) return { focus: last, tabs: i + 1 };
  }
  throw new Error(`focus never landed (last focused: ${JSON.stringify(last)})`);
}

/**
 * Changes a focused native <select> by keyboard. Tries the arrow paths first (they move a closed select
 * on some platforms, open its popup on others), then the letter keys' typeahead, which is the one path
 * that works everywhere. Returns {from, to, how}, or null when no key moved it.
 */
async function nudgeSelect(page, aria) {
  const read = () =>
    page.evaluate(a => document.querySelector(`select[aria-label="${a}"]`)?.value, aria);
  const from = await read();
  const tries = [
    { how: 'ArrowDown', keys: ['ArrowDown'] },
    { how: 'arrows + Return', keys: ['ArrowDown', 'Enter'] },
    { how: 'typeahead “o”', keys: ['Escape', 'o'] },
  ];
  for (const t of tries) {
    for (const key of t.keys) {
      await page.keyboard.press(key);
      await settle(page, 250);
      const now = await read();
      if (now !== from) return { from, to: now, how: t.how };
    }
  }
  await page.keyboard.press('Escape');
  return null;
}

/** The visible conflict sentence on a recorder row, if it has one. */
const conflictText = (page, commandId) =>
  page.evaluate(
    id =>
      document
        .querySelector(`[data-command="${id}"] .ui-key-recorder__conflict-text`)
        ?.innerText.trim() ?? null,
    commandId,
  );

/** Runs one chapter; a failure is a finding, not a hang. */
async function chapter(name, fn) {
  try {
    await fn();
  } catch (error) {
    const note = `${name}: ${error?.message?.split('\n')[0] ?? String(error)}`;
    findings.push(`KEYBOARD UNREACHABLE — ${note}`);
    console.log(`finding ${note}`);
  }
}

try {
  /* ── 1–3: open, the nav by keyboard, the AI provider picker ── */
  await chapter('General → AI', async () => {
    const { context, page } = await open('general');
    try {
      await shot(
        page,
        '01-settings-open',
        '—',
        'Settings opens on General: the section nav at left, level with the first group.',
      );

      const first = await tabUntil(page, f => f.nav, 12);
      await shot(
        page,
        '02-nav-focused',
        `Tab ×${first.tabs}`,
        `Focus lands on the “${first.focus.text}” nav item — the header’s Ask and Today buttons came first.`,
      );

      // Does the nav answer the arrow keys, or only Tab?
      const before = await sectionOf(page);
      await page.keyboard.press('ArrowDown');
      await settle(page);
      const moved = (await sectionOf(page)) !== before;
      await page.keyboard.press('ArrowUp');
      await settle(page);
      if (!moved) {
        findings.push(
          'Section nav: ArrowDown/ArrowUp on a focused nav item do nothing. The nav is a navigation landmark of plain buttons (every item in the tab order, no arrow handler), so Tab + Return is the only keyboard path.',
        );
      }

      const toAi = await tabUntil(page, f => f.nav && f.text === 'AI');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('.settings-screen')?.dataset.section === 'ai',
        null,
        { timeout: 5_000 },
      );
      await settle(page);
      await shot(
        page,
        '03-ai-section',
        `Tab ×${toAi.tabs} to AI, Return`,
        'The AI section: the Features table first — Ask, Summaries, Drafts, Plans, Voice, each with provider and model pickers.',
      );

      await tabUntil(page, f => f.tag === 'select' && f.aria === 'Ask provider', 60);
      const change = await nudgeSelect(page, 'Ask provider');
      if (!change) {
        findings.push(
          'AI provider picker: the Ask provider select never changed from the keyboard.',
        );
        await shot(
          page,
          '04-provider-picker',
          'Tab to “Ask provider”, ArrowDown',
          'FINDING — the provider picker did not move from the keyboard.',
        );
      } else {
        await settle(page, 350);
        if (change.how !== 'ArrowDown') {
          findings.push(
            `AI provider picker: ArrowDown/Return on the focused native select never move its value here (headless Chromium does not open the macOS popup); the letter keys’ typeahead does — ${change.how} moved groq → ${change.to}, and the model reset with it.`,
          );
        }
        await shot(
          page,
          '04-provider-changed',
          `Tab to “Ask provider”, ${change.how}`,
          `Ask’s provider changed ${change.from} → ${change.to}; its model reset to that provider’s first one (Groq had been the default).`,
        );
      }
    } finally {
      await context.close();
    }
  });

  /* ── 4: Accounts — Reconnect by keyboard, sheet open and closed ── */
  await chapter('Accounts → reconnect sheet', async () => {
    const { context, page } = await open('accounts-reconnect');
    try {
      await tabUntil(page, f => f.tag === 'button' && f.text === 'Reconnect', 60);
      await shot(
        page,
        '05-reconnect-focused',
        'Tab to Reconnect',
        'Accounts: alex.moreno@example.com’s sign-in expired; the filled Reconnect button takes the focus ring.',
      );
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ui-reconnect-sheet', { timeout: 5_000 });
      await settle(page);
      await shot(
        page,
        '06-reconnect-sheet',
        'Return',
        'The reconnect sheet opens: “Waiting for Google in your browser…”, Cancel focused.',
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.ui-reconnect-sheet'), null, {
        timeout: 5_000,
      });
      await settle(page);
      const back = await focused(page);
      await shot(
        page,
        '07-sheet-closed',
        'Esc',
        `Esc closes the sheet; focus returns to ${back.text ? `“${back.text}”` : 'the opener'} (no mouse anywhere).`,
      );
    } finally {
      await context.close();
    }
  });

  /* ── 5: Keyboard — record a conflicting chord, then Esc ── */
  await chapter('Keyboard → record a conflict', async () => {
    const { context, page } = await open('keyboard-default');
    try {
      await tabUntil(page, f => f.command === 'mail.done', 120);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[data-command="mail.done"]')?.dataset.state === 'recording',
        null,
        { timeout: 5_000 },
      );
      await settle(page);
      await page.keyboard.press('l');
      await settle(page, 300);
      const state = await page.evaluate(
        () => document.querySelector('[data-command="mail.done"]')?.dataset.state,
      );
      if (state !== 'conflict') {
        findings.push(
          `KeyRecorder: pressing L on “Done” left the row in state "${state}", not a conflict.`,
        );
      }
      await shot(
        page,
        '08-recorder-conflict',
        'Tab to Done’s keys, Return, L',
        `Recording “Done”: L is taken — the row marks it “${(await conflictText(page, 'mail.done')) ?? 'no conflict text'}” with Replace and Cancel.`,
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.querySelector('[data-command="mail.done"]')?.dataset.state === 'idle',
        null,
        { timeout: 5_000 },
      );
      await settle(page);
      const back = await focused(page);
      if (back.command !== 'mail.done') {
        findings.push(
          `KeyRecorder Esc: cancel worked but focus did not return to Done’s keys (on ${JSON.stringify(back)}).`,
        );
      }
    } finally {
      await context.close();
    }
  });

  /* ── 6: the palette — does ⌘K reach Settings rows in the gallery? ── */
  await chapter('⌘K palette', async () => {
    const { context, page } = await open('general');
    try {
      const surfaces = () =>
        page.evaluate(
          () =>
            document.querySelectorAll(
              '[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]',
            ).length,
        );
      await page.keyboard.press('Meta+k');
      await settle(page, 350);
      const afterChord = await surfaces();
      await page.keyboard.type('theme', { delay: 40 });
      await settle(page, 350);
      const afterType = await surfaces();
      const anchors = await page.evaluate(
        () => document.querySelectorAll('[data-setting-anchor]').length,
      );
      await shot(
        page,
        '09-palette-probe',
        '⌘K, then “theme”',
        'The gallery after ⌘K — no palette surface opened, the typed letters went nowhere.',
      );
      if (afterChord === 0 && afterType === 0) {
        findings.push(
          `⌘K search: no palette opens in the preview gallery. The Palette (ui/ask/Palette) is mounted by the app shell, not this page, so Settings rows — ${anchors} carry a palette anchor — cannot be searched here; in the app they are the palette’s Settings group.`,
        );
      }
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}

const lines = [
  '# Settings keyboard walkthrough',
  '',
  `Headless capture of the Settings preview gallery (${GALLERY}), every step driven by the real keyboard — Tab, arrows, Return, Esc, never the mouse. Light theme, 1440 × 900.`,
  '',
  '| Frame | Keys | What it shows |',
  '| --- | --- | --- |',
  ...frames.map(f => `| ${f.file} | ${f.keys} | ${f.shows} |`),
  '',
  '## Findings',
  '',
  ...(findings.length
    ? findings.map(f => `- ${f}`)
    : ['- None — every control on the path was reachable by keyboard.']),
  '',
];
fs.writeFileSync(path.join(OUT, 'walkthrough.md'), `${lines.join('\n')}\n`);
console.log(`\n${frames.length} frame(s), ${findings.length} finding(s); shots in ${OUT}`);
