// Exports the website's icons and social card from the logo, apps/web/brand/aplos-mail.svg (built from
// brand/aplos-mail.icon). Nothing is redrawn: each raster is that SVG, rendered by Chromium and resized.
// Run on a Mac (the card uses the system font) after the logo changes:
//   CAPTURE_DEPS=/path/with/playwright-and-sharp node apps/web/scripts/brand-assets.mjs
// Writes public/favicon.svg (a copy), public/favicon.png (64 px), public/apple-touch-icon.png (180 px, full bleed on
// the logo's green, since iOS rounds the corners itself) and public/og.png (1200 × 630).
import { createRequire } from 'node:module';
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.env.CAPTURE_DEPS ?? '.', 'noop.js'));
const sharp = require('sharp');
const { chromium } = require('playwright');

const web = resolve(import.meta.dirname, '..');
const logoPath = resolve(web, 'brand/aplos-mail.svg');
const logo = `data:image/svg+xml;base64,${readFileSync(logoPath).toString('base64')}`;
const GREEN = '#075244';

async function render(page, html, width, height, transparent) {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ omitBackground: transparent });
}

function logoPage(size, background) {
  return `<style>html,body{margin:0;background:${background}}img{display:block;width:${size}px;height:${size}px}</style><img src="${logo}">`;
}

// The card: the app's light shell grey, the logo, the name and the line from the hero. No gradient, no texture.
const card = `<style>
body{margin:0;width:1200px;height:630px;background:#f5f5f6;color:#1d1e21;display:flex;align-items:center;gap:64px;padding:0 112px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased}
img{width:232px;height:232px;flex:none}
h1{margin:0;font-size:88px;font-weight:600;letter-spacing:-.024em;line-height:1}
p{margin:22px 0 0;font-size:38px;line-height:1.25;letter-spacing:-.012em;color:#46484d;max-width:13em;text-wrap:balance}
</style><img src="${logo}"><div><h1>Aplos Mail</h1><p>Finish your inbox, one email at a time.</p></div>`;

copyFileSync(logoPath, resolve(web, 'public/favicon.svg'));
const browser = await chromium.launch(
  process.env.CHROME ? { executablePath: process.env.CHROME } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 1 });
const big = await render(page, logoPage(512, 'transparent'), 512, 512, true);
await sharp(big).resize(64).png({ compressionLevel: 9 }).toFile(resolve(web, 'public/favicon.png'));
const bleed = await render(page, logoPage(512, GREEN), 512, 512, false);
await sharp(bleed)
  .resize(180)
  .png({ compressionLevel: 9 })
  .toFile(resolve(web, 'public/apple-touch-icon.png'));
await sharp(await render(page, card, 1200, 630, false))
  .png({ compressionLevel: 9 })
  .toFile(resolve(web, 'public/og.png'));
await browser.close();
