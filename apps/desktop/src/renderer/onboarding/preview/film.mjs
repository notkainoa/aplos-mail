#!/usr/bin/env node
// Headless .webm recordings of the onboarding lane on the stand-in engine (plan 30 U8 acceptance 6). Like
// shoot.mjs it starts nothing: run the renderer's Vite server first, then:
//   node src/renderer/onboarding/preview/film.mjs [outDir] [--base http://127.0.0.1:5282] [--only walkthrough]
// Films:
//   walkthrough.webm (<60 s, keyboard only): Welcome Return → type an address, Return → connect (stand-in) →
//     Continue → AI step's Continue → the consent card's Allow → Finish setup → first sync with live progress →
//     Esc opens Aplos (the mail pane's first-mail line).
//   reconnect.webm (<30 s, keyboard only): the status slot's due line → Reconnect → the sheet's waiting →
//     "Reconnected" toast.
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
const OUT = path.resolve(args[0] || '/tmp/uionb-films');
const PAGE = `${BASE}/src/renderer/onboarding/preview/record.html`;

fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openFilm(browser, film) {
  const context = await browser.newContext({
    viewport: { width: 640, height: 600 },
    colorScheme: 'light',
    recordVideo: { dir: OUT, size: { width: 640, height: 600 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${PAGE}?film=${film}`);
  await page.waitForFunction(() => document.documentElement.dataset.previewReady === 'true');
  return { context, page };
}

/** Wait until the step's filled button reads `label` (a plain textContent match). */
async function waitButton(page, label) {
  await page.waitForFunction(
    l => [...document.querySelectorAll('button')].some(b => b.textContent.includes(l)),
    label,
  );
}

/** Wait until the step shows `text` anywhere (a title, a status line). */
async function waitText(page, text) {
  await page.waitForFunction(t => document.body.innerText.includes(t), text);
}

async function filmWalkthrough(browser) {
  const { context, page } = await openFilm(browser, 'walkthrough');
  // Welcome: the focused filled "Add an account".
  await sleep(1400);
  await page.keyboard.press('Enter'); // → Accounts
  await sleep(900);
  await page.keyboard.type('jordan.lee@example.com', { delay: 55 });
  await sleep(500);
  await page.keyboard.press('Enter'); // finds Google
  await waitButton(page, 'Continue with Google');
  await sleep(900);
  await page.keyboard.press('Enter'); // connect: "Waiting for Google in your browser…"
  await sleep(1400);
  await waitButton(page, 'Continue'); // connected: the account row landed
  await sleep(700);
  await page.keyboard.press('Enter'); // → AI step (Groq's key is in the environment: one Continue)
  await waitText(page, 'Set up AI');
  await sleep(1400);
  await page.keyboard.press('Enter'); // Continue → Voice and permissions
  await waitButton(page, 'Finish setup');
  await sleep(1200);
  await page.keyboard.press('Enter'); // → first sync
  await sleep(3000); // live progress: "Reading your newest mail · n of 50"
  await page.keyboard.press('Escape'); // Esc opens Aplos
  await page.waitForFunction(() => document.querySelector('.ui-status-slot') !== null);
  await sleep(1600); // let the mail pane read
  await context.close();
}

async function filmReconnect(browser) {
  const { context, page } = await openFilm(browser, 'reconnect');
  await sleep(1500); // the due line reads first
  // Keyboard only: put focus on the slot's Reconnect button (as Tab would), then Return opens the sheet.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(b =>
      /reconnect/i.test(b.textContent ?? ''),
    );
    button?.focus();
  });
  await sleep(300);
  await page.keyboard.press('Enter'); // → "Waiting for Google in your browser…"
  await sleep(1200);
  // Connected: the sheet closes and the "Reconnected" toast appears.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('body *')].some(() =>
        document.body.innerText.includes('Reconnected'),
      ),
    null,
    { timeout: 10_000 },
  );
  await sleep(1800);
  await context.close();
}

const browser = await chromium.launch({ headless: true });
const films = [
  ['walkthrough', filmWalkthrough],
  ['reconnect', filmReconnect],
].filter(([name]) => ONLY.length === 0 || ONLY.includes(name));
for (const [name, run] of films) {
  const before = new Set(fs.readdirSync(OUT));
  await run(browser);
  // Playwright names the file itself; rename the newest .webm to the film's name.
  const made = fs.readdirSync(OUT).filter(f => f.endsWith('.webm') && !before.has(f));
  if (made.length === 1) {
    const target = path.join(OUT, `${name}.webm`);
    fs.renameSync(path.join(OUT, made[0]), target);
    console.log(`${name}.webm (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
  } else {
    console.log(`WARN ${name}: ${made.length} new webm files`);
  }
}
await browser.close();
