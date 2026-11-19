#!/usr/bin/env node
// Drives the recipient type-ahead preview with the keyboard and captures it (headless, light and dark).
//   APLOS_VITE_PORT=5394 npx vite     (from apps/desktop)
//   node src/renderer/screens/compose/preview/shoot.mjs <outDir> [--base http://127.0.0.1:5394]
// It also checks the behaviour: a name types ahead, ArrowDown moves, Tab and Return accept, Esc closes the list and
// nothing else, and the already-added person is not offered again. Exits 1 on the first miss.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Playwright comes from PLAYWRIGHT (a path to its package) or from the repo's own install.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const args = process.argv.slice(2);
const at = args.indexOf('--base');
const BASE = (at >= 0 ? args.splice(at, 2)[1] : 'http://127.0.0.1:5394').replace(/\/$/, '');
const OUT = path.resolve(args[0] || '/tmp/compose-suggest-shots');
fs.mkdirSync(OUT, { recursive: true });
const URL = theme => `${BASE}/src/renderer/screens/compose/preview/index.html?theme=${theme}`;

let missed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'MISSED'} ${name}`);
  if (!ok) missed += 1;
};

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', e => {
    console.log('pageerror', e.message);
    missed += 1;
  });
  await page.goto(URL(theme));
  const to = page.getByRole('combobox', { name: 'Add recipients' });
  const options = page.getByRole('option');
  await to.click();
  await to.pressSequentially('jo');
  await page.waitForTimeout(300);
  check(`${theme}: typing a name opens the list (3 matches)`, (await options.count()) === 3);
  check(
    `${theme}: the first match is highlighted while a name is typed`,
    (await options.first().getAttribute('aria-selected')) === 'true',
  );
  await page.screenshot({ path: `${OUT}/suggest-open-${theme}.png` });
  await to.press('ArrowDown');
  check(
    `${theme}: ArrowDown moves to the second`,
    (await options.nth(1).getAttribute('aria-selected')) === 'true',
  );
  await page.screenshot({ path: `${OUT}/suggest-arrow-${theme}.png` });
  await to.press('Tab');
  check(
    `${theme}: Tab accepts the highlighted match`,
    (await page.getByTestId('to-list').textContent()) === 'joanna.pierce@example.com',
  );
  check(
    `${theme}: focus stayed in the field after Tab`,
    await to.evaluate(el => el === document.activeElement),
  );
  await to.pressSequentially('jo');
  await page.waitForTimeout(300);
  check(`${theme}: the person already added is not offered again`, (await options.count()) === 2);
  await to.press('Escape');
  check(
    `${theme}: Esc closes the list`,
    (await options.count()) === 0 || !(await options.first().isVisible()),
  );
  check(`${theme}: Esc kept what was typed`, (await to.inputValue()) === 'jo');
  await to.press('ArrowDown');
  await to.press('Enter');
  check(
    `${theme}: after Esc the list stays shut for that text, so Return commits what was typed`,
    (await page.getByTestId('to-list').textContent()) === 'joanna.pierce@example.com, jo',
  );
  await to.pressSequentially('mina.o@x');
  await page.waitForTimeout(300);
  check(
    `${theme}: a typed address with @ has no highlight`,
    (await page.locator('[role=option][aria-selected=true]').count()) === 0,
  );
  await to.fill('');
  await to.pressSequentially('jon');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__prevented = null;
    window.addEventListener('keydown', e => (window.__prevented = e.defaultPrevented));
  });
  check(
    `${theme}: the typed text has a highlighted match to NOT pick`,
    (await page.locator('[role=option][aria-selected=true]').count()) === 1,
  );
  await to.press('Meta+Enter');
  check(
    `${theme}: the field prevented Cmd+Return, so the shell would not send`,
    (await page.evaluate(() => window.__prevented)) === true,
  );
  check(
    `${theme}: Cmd+Return with text typed commits that text, not the highlighted match`,
    (await page.getByTestId('to-list').textContent()) === 'joanna.pierce@example.com, jo, jon',
  );
  await page.close();
}
await browser.close();
process.exit(missed ? 1 : 0);
