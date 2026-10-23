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
const save=async(png,name)=>sharp(png).webp({quality:88,effort:6}).toFile(`${out}/${name}.webp`);
for(const scheme of ['light','dark']){
  const open=async(width,height)=>{
    const page=await(await browser.newContext({viewport:{width,height},deviceScaleFactor:2,colorScheme:scheme})).newPage();
    const errors=[];page.on('console',m=>m.type()==='error'&&errors.push(m.text()));page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url);await page.waitForTimeout(1500);
    const demo=page.getByText('Explore the demo');if(await demo.count())await demo.click();
    await page.waitForTimeout(1200);return {page,errors};
  };
  let {page,errors}=await open(1240,680);
  await save(await page.screenshot(),`home-${scheme}`);
  await save(await page.screenshot({clip:{x:256,y:80,width:610,height:276}}),`focus-${scheme}`);
  await save(await page.screenshot({clip:{x:880,y:0,width:360,height:230}}),`ask-${scheme}`);
  if(errors.length)throw new Error(errors.join('\n'));
  ({page,errors}=await open(1440,860));
  await page.getByText('Calendar',{exact:true}).first().click();await page.waitForTimeout(1200);
  await page.mouse.click(1440-23,22); // close the docked Ask panel
  await page.mouse.move(180,760);await page.waitForTimeout(1200); // park the pointer so no tooltip is showing
  await save(await page.screenshot(),`calendar-${scheme}`);
  if(errors.length)throw new Error(errors.join('\n'));
}
await browser.close();
