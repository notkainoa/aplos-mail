// Re-creates the website's screenshot of the app (src/assets/app/home-{wide,card}-{light,dark}.webp) from the app's
// original demo data, with AI off. The wide crop is the top of a 1240 × 760 window at 2x; the card crop is Home's
// section label and focus card, for phones.
//
//   1. Build the app: npm run build -w @aplos/desktop
//   2. From apps/desktop, start it with throwaway storage and a debugging port (never with real mail or accounts):
//        D=$(mktemp -d -t aplos-web)
//        env -u ELECTRON_RUN_AS_NODE -u GROQ_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY \
//          -u OPENROUTER_API_KEY -u OPENCODE_API_KEY -u OLLAMA_API_KEY -u LM_STUDIO_API_KEY -u CUSTOM_AI_API_KEY \
//          APLOS_ENGINE=real APLOS_TEST=1 APLOS_DATA_DIR="$D" APLOS_TEST_CDP_PORT=9666 \
//          ../../node_modules/.bin/electron . &
//   3. From the repo root, with playwright and sharp in CAPTURE_DEPS (they are not dependencies of the repo):
//        CAPTURE_DEPS=/path/to/node_modules node apps/web/scripts/capture-screenshots.mjs
//   4. Stop only the Electron process you started.
//
// No provider key may reach the app, so AI is off and no summary can be painted on. The script also checks this
// before saving and refuses to write the screenshots otherwise.
// It clicks "Try demo mail" if the welcome window is showing, then shoots Home in both appearances. Nothing is sent.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.env.CAPTURE_DEPS ?? '.', 'noop.js'));
const { chromium } = require('playwright');
const sharp = require('sharp');

const CDP = process.env.APLOS_CDP ?? 'http://127.0.0.1:9666';
const out = resolve(import.meta.dirname, '../src/assets/app');
const SIZE = { width: 1240, height: 760, scale: 2 };
const WIDE_HEIGHT = 550; // CSS px from the top of the window kept in the wide crop

function allPages(browser) {
  return browser.contexts().flatMap(context => context.pages());
}

const visible = locator => locator.isVisible().catch(() => false);

async function waitForHome(browser) {
  for (let tries = 0; tries < 60; tries += 1) {
    for (const page of allPages(browser)) {
      const demo = page.getByRole('button', { name: 'Try demo mail' });
      if (await visible(demo)) await demo.click();
      if (await visible(page.locator('.ui-focus-letter'))) return page;
    }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('Home never appeared. Is the app running with APLOS_TEST_CDP_PORT?');
}

async function setWindow(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width,
    height: SIZE.height,
    deviceScaleFactor: SIZE.scale,
    mobile: false,
  });
}

// The phone crop: Home's section label above the focus card, with a little room around both.
async function cardBox(page) {
  const box = await page.locator('.ui-focus-letter').first().boundingBox();
  const x = Math.max(0, box.x - 12);
  const y = Math.max(0, box.y - 40);
  return { x, y, width: box.width + 24, height: box.height + 52 };
}

async function save(png, name, region) {
  const s = SIZE.scale;
  const area = {
    left: Math.round(region.x * s),
    top: Math.round(region.y * s),
    width: Math.round(region.width * s),
    height: Math.round(region.height * s),
  };
  await sharp(png).extract(area).webp({ quality: 88, effort: 6 }).toFile(`${out}/${name}.webp`);
  console.log(`${name}.webp ${area.width} × ${area.height}`);
}

// AI must be off: no "Summarizing…" placeholder and no serif summary (a summary is the only serif text on Home's focus
// card). Throws before anything is saved.
async function assertAiOff(page) {
  const problem = await page.evaluate(() => {
    const card = document.querySelector('.ui-focus-letter');
    if (!card) return 'no focus card';
    if (/summariz/i.test(card.textContent ?? '')) return 'a summary is being written';
    const serif = /newsreader|new york|georgia|(^|,\s*)serif\s*(,|$)/i;
    const painted = [
      ...card.querySelectorAll('.ui-focus-letter__summary, .ui-focus-letter__summary *'),
    ].find(el => serif.test(getComputedStyle(el).fontFamily));
    return painted ? 'a serif summary is showing' : '';
  });
  if (problem)
    throw new Error(`AI is not off (${problem}). Restart the app without provider keys.`);
}

async function shoot(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(600);
  await assertAiOff(page);
  const png = await page.screenshot();
  const wide = { x: 0, y: 0, width: SIZE.width, height: WIDE_HEIGHT };
  await save(png, `home-wide-${scheme}`, wide);
  await save(png, `home-card-${scheme}`, await cardBox(page));
}

const browser = await chromium.connectOverCDP(CDP);
const page = await waitForHome(browser);
await setWindow(page);
await shoot(page, 'light');
await shoot(page, 'dark');
await browser.close();
