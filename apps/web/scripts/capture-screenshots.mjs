// Re-creates the product screenshots on the website from the app's original demo data.
//
//   1. Start the app on its own ports with throwaway storage:
//        APLOS_API_PORT=4517 APLOS_VITE_PORT=5517 APLOS_DATA_DIR=$(mktemp -d) npm run dev
//   2. Run this script from a folder where `playwright` and `sharp` are installed
//      (they are not dependencies of the repo):
//        CAPTURE_DEPS=/path/to/that/folder node apps/web/scripts/capture-screenshots.mjs
//
// It drives a headless browser only. Set CHROME to a headless Chromium executable if Playwright's own is missing.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.env.CAPTURE_DEPS??'.','noop.js'));
const {chromium}=require('playwright');
const sharp=require('sharp');
const url=process.env.APP_URL??'http://127.0.0.1:5517/';
const out=resolve(import.meta.dirname,'../src/assets/shots');
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
const save=async(png,name)=>sharp(png).webp({quality:88,effort:6}).toFile(`${out}/${name}${scheme==='light'?'-light':''}.webp`);
let scheme;
for(scheme of ['dark','light']){ // the site follows the visitor's appearance, so each shot exists in both
  const open=async(width,height)=>{
    const page=await(await browser.newContext({viewport:{width,height},deviceScaleFactor:2,colorScheme:scheme})).newPage();
    const errors=[];page.on('console',m=>m.type()==='error'&&errors.push(m.text()));page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url);await page.waitForTimeout(1500);
    // A fresh data folder opens the welcome flow; Escape on its first step skips setup.
    if(await page.getByRole('dialog',{name:'Welcome to Aplos Mail'}).count())await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);return {page,errors};
  };
  let {page,errors}=await open(1240,760);
  await save(await page.screenshot(),'home');
  if(errors.length)throw new Error(errors.join('\n'));
  ({page,errors}=await open(1440,860));
  await page.getByText('Calendar',{exact:true}).first().click();await page.waitForTimeout(1200);
  await page.mouse.click(1440-23,22); // close the docked Ask panel
  await page.mouse.move(180,760);await page.waitForTimeout(1200); // park the pointer so no tooltip is showing
  await save(await page.screenshot(),'calendar');
  // The site's calendar switcher shows the same week as a day and as a month too.
  for(const view of ['Day','Month']){
    await page.getByText(view,{exact:true}).first().click();
    await page.mouse.move(180,760);await page.waitForTimeout(1200);
    await save(await page.screenshot(),`calendar-${view.toLowerCase()}`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
}
await browser.close();
