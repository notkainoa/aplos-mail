// Renders build/dmg-background.html to build/background.png (800×392; Finder shows the top 800×360) and build/background@2x.png,
// which electron-builder combines into the DMG window background. Run with: npm run dmg-background
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');
const width = 800,
  height = 392;
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.dock?.hide();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(join(build, 'dmg-background.html'));
  await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const retina = join(build, 'background@2x.png'),
    normal = join(build, 'background.png');
  writeFileSync(
    retina,
    image.resize({ width: width * 2, height: height * 2, quality: 'best' }).toPNG(),
  );
  writeFileSync(normal, image.resize({ width, height, quality: 'best' }).toPNG());
  // tiffutil -cathidpicheck pairs the two by DPI, so mark them 72 and 144.
  execFileSync('/usr/bin/sips', ['-s', 'dpiWidth', '144', '-s', 'dpiHeight', '144', retina], {
    stdio: 'ignore',
  });
  execFileSync('/usr/bin/sips', ['-s', 'dpiWidth', '72', '-s', 'dpiHeight', '72', normal], {
    stdio: 'ignore',
  });
  console.log('Wrote build/background.png and build/background@2x.png');
  app.quit();
});
