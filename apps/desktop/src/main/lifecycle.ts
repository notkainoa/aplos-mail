import { app, dialog, nativeTheme } from 'electron';
import { config } from 'dotenv';
import { loadDevEnv } from './env';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installPermissionHandlers } from './security';
import { windows, focusMain, syncTheme, createWindow, setMain } from './windows';
import { handleLink } from './protocol';
import { menus } from './menu-bar';
import { updates, installUpdate, startUpdates } from './updater';
import { service, bootEngine } from './engine-host';
import {
  isTest,
  testModeError,
  testDataDir,
  testAppName,
  silenceDialogs,
  markTestDir,
} from './test-mode';

let started = false;
let closing = false;
let quitting = false;
function finishQuit() {
  if (closing) return;
  closing = true;
  void Promise.resolve(service?.close()).finally(() => {
    updates?.stop();
    if (!(installUpdate && updates?.install())) app.quit();
  });
}
function cancelQuit() {
  quitting = false;
}

if (testModeError) {
  // Before anything touches data: a test must never fall back to the real mailbox.
  process.stderr.write(`${testModeError}\n`);
  process.exit(2);
}
if (isTest) {
  // Hidden test mode (APLOS_TEST=1): no Dock icon or activation, no dialogs, own keychain item and own Electron state.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  app.dock?.hide();
  // Chromium's in-memory keychain: safeStorage works without touching the login keychain at all, so a test can
  // neither prompt nor leave items behind (an ad-hoc rebuilt app would be refused a keychain item an earlier build made).
  // The separate app name below is the second line of defence should the switch ever be ignored.
  app.commandLine.appendSwitch('use-mock-keychain');
  silenceDialogs(dialog, line => console.error(`Aplos Mail test: ${line}`));
  markTestDir(testDataDir!);
  app.setPath('userData', join(testDataDir!, 'electron'));
}
app.setName(isTest ? testAppName : 'Aplos Mail');
// Test instances run side by side, each on its own data directory, so they take no single-instance lock.
const locked = isTest || app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleLink(url);
  });
  app.on('second-instance', (_event, argv) => {
    focusMain();
    for (const arg of argv) if (/^(mailto|aplos):/i.test(arg)) handleLink(arg);
  });
  app.on('activate', () => {
    if (started) focusMain();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', event => {
    if (started && !closing) {
      event.preventDefault();
      quitting = true;
      if (!windows.size) finishQuit();
      else for (const win of windows) win.close();
    }
  });
  void app
    .whenReady()
    .then(async () => {
      // Electron makes the app a regular (Dock) app when launching finishes, so test mode re-applies accessory here.
      if (isTest) {
        if (process.platform === 'darwin') app.setActivationPolicy('accessory');
        app.dock?.hide();
      }
      // A packaged app shows its bundle icon (AppIcon.icon); a development run would otherwise show Electron's.
      if (!app.isPackaged && !isTest) app.dock?.setIcon(join(__dirname, 'icon.png'));
      // A test run gets only the environment its caller passes: never the owner's config file or a checkout's .env.
      if (app.isPackaged && !isTest)
        config({ path: join(homedir(), '.config', 'aplos-mail', '.env'), quiet: true });
      else if (!app.isPackaged && !isTest) loadDevEnv();
      app.setAboutPanelOptions({
        applicationName: 'Aplos Mail',
        applicationVersion: app.getVersion(),
        copyright: 'Independent software. Built with original code and design.',
      });
      installPermissionHandlers();
      await bootEngine();
      started = true;
      nativeTheme.on('updated', () => syncTheme(true));
      startUpdates();
      menus();
      // eng-host: a menu-bar status item added here must also skip creation when `isTest`.
      setMain(createWindow());
      if (!isTest) app.setAsDefaultProtocolClient('aplos');
      for (const arg of process.argv) if (/^(mailto|aplos):/i.test(arg)) handleLink(arg);
    })
    .catch(error => {
      dialog.showErrorBox(
        'Aplos Mail could not start',
        error instanceof Error ? error.message : 'An unknown startup error occurred.',
      );
      if (isTest) app.exit(1);
      else app.quit();
    });
}

export { started, closing, quitting, finishQuit, cancelQuit };
