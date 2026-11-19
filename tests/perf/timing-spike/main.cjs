// Timing-validity spike (plan 30 U1): can a never-shown Electron window give trustworthy
// requestAnimationFrame cadence, long-animation-frame and Event Timing data, and real pixels
// from capturePage? Run: SPIKE_OUT=/tmp/out <electron binary> tests/perf/timing-spike/main.cjs
// The window is created with show:false and is never shown; the app runs as an accessory
// (no Dock icon, never activated), so nothing on screen changes and focus is never taken.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron main script run as CommonJS (.cjs), where require is the module system */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const outDir = process.env.SPIKE_OUT || '/tmp/aplos-timing-spike';
const PAGE = path.join(__dirname, 'page.html');

app.setActivationPolicy?.('accessory');

function measureIn(win) {
  return win.webContents.executeJavaScript('window.__spike.run()', true);
}

async function sendKeys(win, count) {
  for (let i = 0; i < count; i += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'J' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'j' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'J' });
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function capture(win, name) {
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const colours = new Set();
  for (let i = 0; i < bitmap.length; i += 4 * 97) colours.add(bitmap.readUInt32LE(i));
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  return {
    width: size.width,
    height: size.height,
    sampledColours: colours.size,
    empty: image.isEmpty(),
  };
}

// One window for every pass: some sandboxed agent shells refuse a second renderer process
// (mach port rendezvous denied), so passes toggle throttling on the same webContents.
async function pass(win, name, throttling) {
  win.webContents.setBackgroundThrottling(throttling);
  await win.webContents.executeJavaScript('window.__spike.reset()', true);
  const keysDone = sendKeys(win, 20);
  const timing = await measureIn(win);
  await keysDone;
  const events = await win.webContents.executeJavaScript('window.__spike.events()', true);
  const shot = await capture(win, name);
  return { name, visible: win.isVisible(), ...timing, ...events, capture: shot };
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { backgroundThrottling: false },
  });
  const html = fs.readFileSync(PAGE, 'utf8');
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const results = [];
  results.push(await pass(win, 'hidden-throttling-off', false));
  results.push(await pass(win, 'hidden-throttling-on', true));
  win.destroy();
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    date: new Date().toISOString(),
    results,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  app.exit(0);
});
