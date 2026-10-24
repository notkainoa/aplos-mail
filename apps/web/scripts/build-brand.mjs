// Exports the site's brand rasters from the app icon PNGs in apps/desktop/assets (the icon itself is never redrawn):
//   src/assets/brand/icon-640.webp the icon edge to edge, for the hero
//   public/favicon-32.png, public/apple-touch-icon.png
//   public/og.png                  1200x630 share image: the icon, the headline, the airmail band
// Needs macOS (sips), and Playwright with a Chromium and sharp, like capture-screenshots.mjs:
//   CAPTURE_DEPS=/path/to/folder/with/playwright [CHROME=/path/to/chromium] node apps/web/scripts/build-brand.mjs
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const here=import.meta.dirname;
const assets=resolve(here,'../../desktop/assets');
const sips=(...args)=>execFileSync('/usr/bin/sips',args,{stdio:'ignore'});
const temporary=mkdtempSync(join(tmpdir(),'aplos-brand-'));
try {
  // icon.png is the 824 px icon on a 1024 px canvas: crop the margin, then scale.
  const full=join(temporary,'icon-full.png');
  sips('-c','824','824',join(assets,'icon.png'),'--out',full);
  const scaled=join(temporary,'icon-640.png');
  sips('-z','640','640',full,'--out',scaled);
  sips('-z','32','32',join(assets,'icon-256.png'),'--out',resolve(here,'../public/favicon-32.png'));
  sips('-z','180','180',join(assets,'icon-256.png'),'--out',resolve(here,'../public/apple-touch-icon.png'));

  const require=createRequire(resolve(process.env.CAPTURE_DEPS??'.','noop.js'));
  const {chromium}=require('playwright');
  await require('sharp')(scaled).webp({quality:90,alphaQuality:100,effort:6}).toFile(resolve(here,'../src/assets/brand/icon-640.webp'));
  const font=pathToFileURL(resolve(here,'../../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-soft-normal.woff2')).href;
  const icon=pathToFileURL(scaled).href;
  const html=`<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:Fraunces;src:url(${font});font-weight:100 900}
    *{box-sizing:border-box;margin:0}
    body{width:1200px;height:630px;background:#3fa3fb;color:#06162e;position:relative;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
    h1{position:absolute;left:72px;top:190px;width:660px;font:560 70px/1 Fraunces;font-variation-settings:"SOFT" 100;letter-spacing:-0.035em}
    .name{position:absolute;left:72px;top:64px;font-size:30px;font-weight:600;letter-spacing:-0.01em}
    img{position:absolute;right:56px;top:96px;width:440px;transform:rotate(6deg)}
    .band{position:absolute;left:0;right:0;bottom:0;height:34px;background:#fff url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="34" viewBox="0 0 64 17"><polygon points="0,17 12,0 24,0 12,17" fill="#e2392f"/><polygon points="32,17 44,0 56,0 44,17" fill="#2b5fd0"/></svg>')}") 0 0/128px 34px repeat-x}
  </style><div class="name">Aplos Mail</div><h1>Finish your inbox, one email at a time.</h1><img src="${icon}"><div class="band"></div>`;
  const page=join(temporary,'og.html');writeFileSync(page,html);
  const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
  const tab=await browser.newPage({viewport:{width:1200,height:630}});
  await tab.goto(pathToFileURL(page).href);await tab.evaluate(()=>document.fonts.ready);await tab.waitForTimeout(300);
  await tab.screenshot({path:resolve(here,'../public/og.png')});
  await browser.close();
  console.log('Wrote the hero icon, favicons and og.png.');
} finally {rmSync(temporary,{recursive:true,force:true});}
