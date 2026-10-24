// Re-creates the product screenshots on the website from the app's original demo data, and maps which
// controls in each screenshot lead to which other screenshot, so the site can let visitors click through them.
//
//   1. Start the app on its own ports with throwaway storage:
//        APLOS_API_PORT=4517 APLOS_VITE_PORT=5517 APLOS_DATA_DIR=$(mktemp -d) npm run dev
//   2. Run this script from a folder where `playwright` and `sharp` are installed
//      (they are not dependencies of the repo):
//        CAPTURE_DEPS=/path/to/that/folder node apps/web/scripts/capture-screenshots.mjs
//
// It drives a headless browser only. Set CHROME to a headless Chromium executable if Playwright's own is missing.
// Every link is checked rather than assumed: the script clicks each control in the real app and keeps it only
// if the app then looks exactly like one of the captured screens.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.env.CAPTURE_DEPS??'.','noop.js'));
const {chromium}=require('playwright');
const sharp=require('sharp');
const url=process.env.APP_URL??'http://127.0.0.1:5517/';
const out=resolve(import.meta.dirname,'../src/assets/shots');
mkdirSync(out,{recursive:true});
const now=new Date(); // frozen for the whole run so the current-time line never moves between captures

const nav=name=>p=>p.getByRole('navigation',{name:'Mailboxes'}).getByRole('button',{name:new RegExp(`^${name}( \\d+)?$`)});
const button=name=>p=>p.getByRole('button',{name,exact:true});
const event=name=>p=>p.getByRole('button',{name:new RegExp(`^${name},`)});
const row=name=>p=>p.getByRole('main').getByRole('button',{name:new RegExp(`^${name}`)});
const tab=name=>p=>p.getByRole('main').getByRole('tab',{name:new RegExp(`^${name}`)});
const questions=['What plans do I have this week?','Which emails still need a reply?','Book lunch with Maya Friday at noon'];

// A tour is a set of screens, each reached from a fresh start by a few clicks, and the controls a visitor may press.
const tours={
  hero:{
    size:[1240,760],
    screens:{
      home:[],
      'home-maple':[row('Maple Library')],
      'home-rowan':[row('Rowan Pottery')],
      later:[nav('Later')],
      'later-bookmarks':[nav('Later'),tab('Bookmarks')],
      'all-mail':[nav('All mail')],
      drafts:[nav('Drafts')],
      sent:[nav('Sent')],
      calendar:[button('Calendar')],
      'calendar-day':[button('Calendar'),button('Day')],
      'calendar-month':[button('Calendar'),button('Month')],
    },
    controls:[
      ['Home',nav('Home')],['Later',nav('Later')],['All mail',nav('All mail')],['Drafts',nav('Drafts')],['Sent',nav('Sent')],
      ['Calendar',button('Calendar')],
      ['Jordan Park',row('Jordan')],['Maple Library',row('Maple Library')],['Rowan Pottery',row('Rowan Pottery')],
      ['Todos',tab('Todos')],['Bookmarks',tab('Bookmarks')],
      ['Day',button('Day')],['Week',button('Week')],['Month',button('Month')],
    ],
    // The Ask suggestions open the working copy of Ask further down the page.
    asks:questions.map(q=>[q,p=>p.getByRole('option',{name:q})]),
  },
  calendar:{
    size:[1440,860],
    start:[button('Calendar'),button('Close')], // the calendar on its own, with the docked Ask panel closed
    screens:{
      week:[],
      day:[button('Day')],
      month:[button('Month')],
      'week-next':[button('Next week')],
      'week-prev':[button('Previous week')],
      'event-critique':[event('Design critique')],
      'event-retro':[event('Team retro')],
      'event-farmers':[event('Farmers market')],
      'event-prototype':[event('Prototype polish')],
    },
    controls:[
      ['Day',button('Day')],['Week',button('Week')],['Month',button('Month')],['Today',button('Today')],
      ['Previous week',button('Previous week')],['Next week',button('Next week')],
      ['Design critique',event('Design critique')],['Team retro',event('Team retro')],
      ['Farmers market',event('Farmers market')],['Prototype polish',event('Prototype polish')],
      ['Close the event',p=>p.getByRole('dialog',{name:'Event'}).getByRole('button',{name:'Close'})],
    ],
  },
};

const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
// Open the app in a new browser profile and click through to a screen. Each screen starts from a clean profile because
// the app remembers things like the calendar view between visits. A fresh data folder opens the welcome flow; Escape skips setup.
const errors=[];
const reach=async(tour,steps,{scheme='dark',scale=2}={})=>{
  const [width,height]=tour.size;
  const page=await(await browser.newContext({viewport:{width,height},deviceScaleFactor:scale,colorScheme:scheme})).newPage();
  page.on('console',m=>m.type()==='error'&&errors.push(m.text()));page.on('pageerror',e=>errors.push(String(e)));
  await page.clock.setFixedTime(now);
  // Opening an email marks it read on the server, which would change every later screen. Answer that call here instead.
  await page.route('**/api/invoke',route=>{
    const {method,payload}=route.request().postDataJSON()??{};
    if(method==='thread.update'&&JSON.stringify(payload?.patch)==='{"unread":false}')return route.fulfill({json:{result:null}});
    return route.fallback();
  });
  await page.goto(url);await page.waitForTimeout(1200);
  if(await page.getByRole('dialog',{name:'Welcome to Aplos Mail'}).count())await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  for(const step of [...(tour.start??[]),...steps]){await step(page).first().click();await page.waitForTimeout(500);}
  await settle(page);
  return page;
};
const done=page=>page.context().close();
const settle=async page=>{await page.mouse.move(2,2);await page.waitForTimeout(900);}; // park the pointer so no hover or tooltip shows
// Screens are compared at full size, so two empty weeks that differ only in their dates still count as different.
const pixels=async png=>sharp(png).greyscale().raw().toBuffer();
const same=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d+=Math.abs(a[i]-b[i]);return d/a.length<0.05;};
// Where a control is, as fractions of the screen, if it is on screen and not covered by something else.
const spot=async(page,locator)=>{
  const el=locator.first();
  if(!await el.count()||!await el.isVisible())return null;
  const box=await el.boundingBox();const {width,height}=page.viewportSize();
  if(!box||box.width<4||box.height<4)return null;
  const x=Math.max(0,box.x),y=Math.max(0,box.y),w=Math.min(width,box.x+box.width)-x,h=Math.min(height,box.y+box.height)-y;
  if(w<4||h<4)return null;
  const onTop=await el.evaluate((node,[cx,cy])=>{const hit=document.elementFromPoint(cx,cy);return !!hit&&(node===hit||node.contains(hit));},[x+w/2,y+h/2]);
  if(!onTop)return null;
  const r=n=>Math.round(n*10000)/100;
  return {x:r(x/width),y:r(y/height),w:r(w/width),h:r(h/height)};
};

const map={};
for(const [id,tour] of Object.entries(tours)){
  const names=Object.keys(tour.screens);
  // 1. Capture every screen in both appearances; the site shows the one that matches the visitor's.
  const refs={};
  for(const scheme of ['dark','light'])for(const name of names){
    const page=await reach(tour,tour.screens[name],{scheme,scale:2});
    const png=await page.screenshot();
    await sharp(png).webp({quality:88,effort:6}).toFile(`${out}/${id}-${name}${scheme==='light'?'-light':''}.webp`);
    if(scheme==='dark')refs[name]=await pixels(png);
    await done(page);
  }
  // 2. From each screen, press each control and see which captured screen the app lands on.
  const screens={};
  for(const name of names){
    let page=await reach(tour,tour.screens[name]);
    const found=[],spots=[];
    for(const [label,locate] of tour.controls){const where=await spot(page,locate(page));if(where)found.push([label,locate,where]);}
    for(const [i,[label,locate]] of (tour.asks??[]).entries()){
      const where=await spot(page,locate(page));
      if(where)spots.push({label,ask:i,...where});
    }
    await done(page);
    for(const [label,locate,where] of found){
      page=await reach(tour,tour.screens[name]);
      await locate(page).first().click();await settle(page);
      const shot=await pixels(await page.screenshot());
      await done(page);
      const to=names.find(other=>same(shot,refs[other]));
      if(to&&to!==name)spots.push({label,to,...where});
    }
    screens[name]=spots;
    console.log(id,name,spots.map(s=>`${s.label}→${s.to??`ask ${s.ask}`}`).join(', '));
  }
  // Nothing above should change the mailbox; check that the first screen still looks as captured.
  const page=await reach(tour,tour.screens[names[0]]);
  if(!same(await pixels(await page.screenshot()),refs[names[0]]))throw new Error(`${id}: the app changed while it was explored`);
  await done(page);
  if(errors.length)throw new Error(errors.join('\n'));
  map[id]={width:tour.size[0],height:tour.size[1],start:names[0],screens};
}
writeFileSync(`${out}/tours.json`,`${JSON.stringify(map,null,1)}\n`);
await browser.close();
