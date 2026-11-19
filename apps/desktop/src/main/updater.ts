import { app, dialog } from 'electron';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { UpdateController, disabledReason, teamIdentifier, type Updater } from './updates';
import { emit, focusMain } from './windows';
import { releaseBuild } from './oauth-config';
import { isTest } from './test-mode';

let updates: UpdateController | undefined;
/** Set by Restart: the normal quit (drafts saved, engine closed) ends by installing the update instead of quitting. */
let installUpdate = false;
/** The running .app bundle (…/Aplos Mail.app/Contents/MacOS/Aplos Mail → …/Aplos Mail.app). */
function bundlePath() {
  return resolve(process.execPath, '..', '..', '..');
}
function createUpdates() {
  // Never in a release build, whatever app.isPackaged says (it follows the executable's name).
  const devFeed = !releaseBuild && !app.isPackaged && process.env.APLOS_UPDATE_DEV === '1';
  const log = (line: string) => console.log(`Aplos Mail: ${line}`);
  // Updates are off in test mode (a local package build; release builds compile test mode out): a test must never reach
  // the update feed or replace the build under test.
  const disabled = isTest
    ? 'Updates are off in test mode.'
    : disabledReason({
        platform: process.platform,
        packaged: app.isPackaged,
        devFeed,
        bundlePath: bundlePath(),
        teamId: () => {
          const result = spawnSync(
            '/usr/bin/codesign',
            ['--display', '--verbose=2', bundlePath()],
            {
              encoding: 'utf8',
            },
          );
          return teamIdentifier(`${result.stdout}\n${result.stderr}`);
        },
      });
  return new UpdateController({
    currentVersion: app.getVersion(),
    disabled,
    log,
    emit: info => emit({ type: 'update', payload: info }),
    updater: () => {
      // Loaded only when updates can run, so development and unsigned builds never start electron-updater.
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
      autoUpdater.logger = {
        info: (m: unknown) => log(`updater: ${String(m)}`),
        warn: (m: unknown) => log(`updater warning: ${String(m)}`),
        error: (m: unknown) => log(`updater error: ${String(m)}`),
        debug: () => {},
      };
      // dev-app-update.yml in apps/desktop points at `npm run update-feed`.
      if (devFeed) autoUpdater.forceDevUpdateConfig = true;
      return autoUpdater as unknown as Updater;
    },
  });
}
function restartToUpdate() {
  if (!updates?.ready) return;
  installUpdate = true;
  app.quit();
}
async function checkManually() {
  if (!updates) return;
  const info = await updates.check(true),
    status = info.status;
  const show = (message: string, detail?: string) =>
    void dialog.showMessageBox({ type: 'info', title: 'Aplos Mail', message, detail });
  if (status.state === 'current')
    show('You’re up to date', `Aplos Mail ${info.currentVersion} is the newest version.`);
  else if (status.state === 'downloading')
    show(
      `Aplos Mail ${status.version} is downloading`,
      'You can restart to update when it is ready.',
    );
  else if (status.state === 'ready') {
    void focusMain();
  } else if (status.state === 'disabled') show('Automatic updates are off', status.reason);
  else if (status.state === 'error') show('Couldn’t check for updates', status.message);
}
function startUpdates() {
  updates = createUpdates();
  updates.start();
}
function cancelInstall() {
  installUpdate = false;
}

export { updates, installUpdate, restartToUpdate, checkManually, startUpdates, cancelInstall };
