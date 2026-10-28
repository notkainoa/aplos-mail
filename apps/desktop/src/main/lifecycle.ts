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

app.setName('Aplos Mail');
const locked = app.requestSingleInstanceLock();
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
      // A packaged app shows its bundle icon (AppIcon.icon); a development run would otherwise show Electron's.
      if (!app.isPackaged) app.dock?.setIcon(join(__dirname, 'icon.png'));
      if (app.isPackaged)
        config({ path: join(homedir(), '.config', 'aplos-mail', '.env'), quiet: true });
      else loadDevEnv();
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
      setMain(createWindow());
      app.setAsDefaultProtocolClient('aplos');
      for (const arg of process.argv) if (/^(mailto|aplos):/i.test(arg)) handleLink(arg);
    })
    .catch(error => {
      dialog.showErrorBox(
        'Aplos Mail could not start',
        error instanceof Error ? error.message : 'An unknown startup error occurred.',
      );
      app.quit();
    });
}

export { started, closing, quitting, finishQuit, cancelQuit };
