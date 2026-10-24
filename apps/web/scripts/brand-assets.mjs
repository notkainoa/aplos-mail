// Exports the website's icon rasters and social card from the app icon PNGs (apps/desktop/assets, made by build-icon.mjs).
// Nothing is redrawn: every file is the real icon, resized. Run after the app icon changes:
//   CAPTURE_DEPS=/path/with/playwright-and-sharp node apps/web/scripts/brand-assets.mjs
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.env.CAPTURE_DEPS??'.','noop.js'));
const sharp=require('sharp');
const {chromium}=require('playwright');
const web=resolve(import.meta.dirname,'..');
const assets=resolve(web,'../desktop/assets');
// icon.png is the 824 px macOS icon centred on a 1024 px canvas; cut it out edge to edge.
const edge=()=>sharp(`${assets}/icon.png`).extract({left:100,top:100,width:824,height:824});
await edge().resize(512).webp({quality:90,effort:6}).toFile(`${web}/src/assets/icon-512.webp`);
await sharp(`${assets}/icon-64.png`).toFile(`${web}/public/favicon.png`);
await edge().resize(180).flatten({background:'#9fd3ff'}).png().toFile(`${web}/public/apple-touch-icon.png`);

// Social card, 1200 × 630: the icon on the sky field, the name and the line from the hero.
const icon=readFileSync(`${assets}/icon.png`).toString('base64');
const font=readFileSync(resolve(web,'../../node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2')).toString('base64');
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
const page=await browser.newPage({viewport:{width:1200,height:630}});
await page.setContent(`<style>
@font-face{font-family:N;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:200 800}
body{margin:0;width:1200px;height:630px;background:#9fd3ff;color:#0d1b2a;display:grid;grid-template-columns:420px 1fr;align-items:center;font-family:N}
img{width:400px;margin-left:40px}
h1{margin:0;font-size:104px;font-weight:500;letter-spacing:-.025em;line-height:1}
p{margin:22px 0 0;font-size:44px;line-height:1.1;letter-spacing:-.015em;max-width:12em}
</style><img src="data:image/png;base64,${icon}"><div><h1>Aplos Mail</h1><p>Finish your inbox, one email at a time.</p></div>`);
await page.evaluate(()=>document.fonts.ready);
await sharp(await page.screenshot()).png({compressionLevel:9}).toFile(`${web}/public/og.png`);
await browser.close();
