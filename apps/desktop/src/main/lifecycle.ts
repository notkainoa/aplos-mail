import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  nativeTheme,
  powerMonitor,
  shell,
  systemPreferences,
} from 'electron';
import { config } from 'dotenv';
import { loadDevEnv } from './env';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { installPermissionHandlers } from './security';
import {
  windows,
  focusMain,
  syncTheme,
  ensureMain,
  startWindows,
  onboarding,
  handleOauthReturn,
} from './windows';
import { isOauthReturnLink } from '../host/providers/oauth/returns';
import { handleLink } from './protocol';
import { menus, startMenuBar, stopMenuBar } from './menu-bar';
import { updates, installUpdate, startUpdates } from './updater';
import { service, bootEngine, latestState, realPath, realEngine } from './engine-host';
import {
  activationPolicy,
  applyWindowChoice,
  createLinkGate,
  createProcessState,
  createQuitGate,
  closeThenRelease,
  pendingWork,
  quitWarning,
  quitWarningButtons,
  windowFallback,
  QUIT_DRAIN_MS,
  type ActivationPolicy,
} from '../host/lifecycle';
import { acquireLock, nodeLockPorts, type HeldLock } from '../host/lock';
import { watchPowerResume } from '../host/power';
import { createLoopMonitor, nodeDelayHistogram, startCrashReporting } from '../host/crash';
import { createPause, type SyncFacts } from '../host/menu-bar';
import { LOG_FILE, logDir } from '../host/logsink';
import {
  isTest,
  testModeError,
  testDataDir,
  dataDirOverride,
  testAppName,
  silenceDialogs,
  silenceSystem,
  exposeTestHooks,
  markTestDir,
  testOnlyFlags,
} from './test-mode';

let started = false;
// A second launch or Dock click while Aplos boots is answered once startup has chosen its window.
let pendingActivation = false;
let closing = false;
let quitting = false;
let systemShutdown = false;
/** Set by "Try again" after a park: the relaunch quit is ours, so the pending-work warning is skipped. */
let skipQuitWarning = false;
let lock: HeldLock | undefined;
let stopPower: (() => void) | undefined;
/**
 * `aplos://oauth-return` links the OS delivered before a window existed (an `open-url` during launch):
 * they are queued, bounded, and answered after `startWindows` — the nonce's own TTL still applies at
 * consume time, so a stale one is a silent no-op either way.
 */
// Held until the first window choice has been applied (not just until `started`): startup is async now, so a link
// answered earlier would find no window to focus and burn its one-time nonce.
const oauthGate = createLinkGate(8);
function routeLink(raw: string) {
  if (isOauthReturnLink(raw)) {
    if (oauthGate.hold(raw)) return;
    handleOauthReturn(raw);
    return;
  }
  handleLink(raw);
}

const pause = createPause(() => Date.now());
const timers = {
  every: (run: () => void, ms: number) => setInterval(run, ms),
  cancel: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
};
const processState = createProcessState();
/**
 * The tray's cached facts on the real engine path, refilled by `pollMenuSync`. Main holds no mailbox copy there,
 * so the menu's `sync` callback can only read this cache; a down or slow engine keeps the last answer.
 */
let menuSync: SyncFacts | undefined;
function pollMenuSync() {
  void realEngine
    .sync()
    .then(facts => {
      menuSync = facts ?? menuSync;
    })
    .catch(() => {});
}
const loopMonitor = createLoopMonitor({
  histogram: nodeDelayHistogram(),
  timers,
  log: line => console.error(`Aplos Mail: ${line}`),
});

/**
 * Today the legacy engine syncs on `sync {auto: true}`; the new engine takes `engine.wake()` here instead.
 * The legacy engine has no pause of its own, so while paused (or parked) main simply does not forward the wake.
 */
function wakeEngine() {
  if (pause.active() || processState.state === 'parked') return;
  // The real engine (the default) gets the power event itself; its host dedupes wakes (host/power.ts).
  if (realPath) return realEngine.wake();
  if (!service) return;
  void service.invoke('sync', { auto: true }).catch(() => {});
}

/** The engine's utility process stopped (any reason). The third stop within 60 s parks the app; returns true then. */
function noteEngineExit(): boolean {
  if (closing) return false;
  const parked = processState.noteEngineExit(Date.now());
  if (parked) void showParked();
  return parked;
}
async function showParked() {
  if (isTest)
    return console.error('Aplos Mail test: parked: the engine stopped 3 times in 60 seconds');
  app.focus({ steal: true });
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'Aplos Mail stopped reading your mail',
      detail:
        'The mailbox stopped 3 times in a minute. Your mail is safe. Send us the log, or try again.',
      buttons: ['Export diagnostics', 'Try again'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 1) break;
    // Until the diagnostics report exists, "Export diagnostics" shows the log folder.
    const dir = logDir({ dataDir: dataDirOverride });
    shell.showItemInFolder(existsSync(join(dir, LOG_FILE)) ? join(dir, LOG_FILE) : dir);
  }
  processState.tryAgain();
  skipQuitWarning = true;
  app.relaunch();
  app.quit();
}

// Resident mode: with no window Aplos is a menu-bar app (no Dock icon). Test mode stays accessory throughout.
let appliedPolicy: ActivationPolicy = isTest ? 'accessory' : 'regular';
function setPolicy(policy: ActivationPolicy) {
  if (process.platform !== 'darwin' || policy === appliedPolicy) return;
  appliedPolicy = policy;
  app.setActivationPolicy(policy);
  if (policy === 'regular') void app.dock?.show();
  else app.dock?.hide();
}
function applyPolicy() {
  if (quitting || closing) return;
  const open = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).length;
  setPolicy(activationPolicy(open, isTest));
}
function watchWindowCount() {
  app.on('browser-window-created', (_event, win) => {
    applyPolicy();
    win.on('closed', () => setImmediate(applyPolicy));
  });
}

async function confirmQuit(): Promise<boolean> {
  if (installUpdate || skipQuitWarning || systemShutdown) return true;
  // The real path asks the engine (`Outbox/pending`); a rejection counts as yes in the quit gate.
  const pending = realPath ? await realEngine.pending() : pendingWork(latestState);
  const warning = quitWarning(pending);
  if (!warning) return true;
  // A test must be able to quit: it records the text and goes on (a dialog would also answer with its first button).
  if (isTest) {
    console.error(`Aplos Mail test: quit warning: ${warning.message}`);
    return true;
  }
  // A menu-bar quit has no window to attach to; bring the dialog forward.
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: warning.message,
    detail: warning.detail,
    buttons: [...quitWarningButtons],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}
const quitGate = createQuitGate(confirmQuit, beginQuit);
function beginQuit() {
  quitting = true;
  // A test run must always end: if a window never answers its save-before-close, quit anyway after 15 s.
  if (isTest) setTimeout(() => app.exit(0), 15_000);
  if (!windows.size) finishQuit();
  else for (const win of windows) win.close();
}
function finishQuit() {
  if (closing) return;
  closing = true;
  stopPower?.();
  loopMonitor.stop();
  stopMenuBar();
  // At most 3 s for the engine to close its database; after that the quit goes ahead anyway.
  const quitTimers = {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  const engineClosed = realPath ? realEngine.close() : service?.close();
  // The data lock is let go only when the engine confirmed it closed: otherwise it stays held until this process is gone.
  void closeThenRelease(Promise.resolve(engineClosed), QUIT_DRAIN_MS, quitTimers, () =>
    lock?.release(),
  ).finally(() => {
    updates?.stop();
    if (!(installUpdate && updates?.install())) app.quit();
  });
}
function cancelQuit() {
  quitting = false;
}

/** Power events, the menu-bar item (never in test mode) and the event-loop monitor. Needs `app` to be ready. */
function startResident() {
  watchWindowCount();
  stopPower = watchPowerResume(
    powerMonitor,
    { wake: wakeEngine },
    { now: () => Date.now(), every: timers.every, cancel: timers.cancel },
  );
  powerMonitor.on('shutdown', () => {
    systemShutdown = true;
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'Utility' && details.serviceName === 'Aplos Mail Engine') noteEngineExit();
  });
  loopMonitor.start();
  if (isTest) return;
  if (realPath) {
    // `latestState` is a legacy-engine snapshot and never fills on this path; the menu would sit on "Starting…"
    // for the whole session without this poll (the menu itself calls back every 2 s against the cache).
    pollMenuSync();
    timers.every(pollMenuSync, 2000).unref();
  }
  startMenuBar({
    pause,
    sync: () =>
      realPath
        ? menuSync
        : latestState?.sync && { ...latestState.sync, accounts: latestState.accounts.length },
    open: () => {
      app.focus({ steal: true });
      void focusMain();
    },
    quit: () => app.quit(),
  });
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
  // APLOS_TEST_KEYCHAIN=login opts out: the run then touches the real login-keychain item — a signature
  // mismatch against the seal raises the macOS prompt or denies the unwrap (never a silent success).
  if (!testOnlyFlags.useLoginKeychain) app.commandLine.appendSwitch('use-mock-keychain');
  // -/--remote-debugging-address would defeat the loopback bind the e2e relies on, so it is refused
  // whenever test mode is on — whether or not APLOS_TEST_CDP_PORT was set. Chromium accepts a
  // single leading dash for switches, so both forms are refused.
  if (process.argv.some(arg => /^--?remote-debugging-address/i.test(arg))) {
    process.stderr.write(
      'Aplos Mail test: --remote-debugging-address is refused (loopback only).\n',
    );
    process.exit(2);
  }
  if (testOnlyFlags.cdpPort !== undefined)
    app.commandLine.appendSwitch('remote-debugging-port', String(testOnlyFlags.cdpPort));
  silenceDialogs(dialog, line => console.error(`Aplos Mail test: ${line}`));
  silenceSystem(shell, systemPreferences, line => console.error(`Aplos Mail test: ${line}`));
  markTestDir(testDataDir!);
  exposeTestHooks();
  app.setPath('userData', join(testDataDir!, 'electron'));
}
// Names the app, then starts the crash reporter (dumps stay on this Mac). After test mode set `userData`, which it keeps.
startCrashReporting(app, crashReporter, isTest ? testAppName : 'Aplos Mail');
// Test instances run side by side, each on its own data directory, so they take no single-instance lock.
const locked = isTest || app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    routeLink(url);
  });
  app.on('second-instance', (_event, argv) => {
    // While Aplos is still starting, startup is choosing the one window: a second launch only queues its link.
    if (started) void focusMain();
    else pendingActivation = true;
    for (const arg of argv) if (/^(mailto|aplos):/i.test(arg)) routeLink(arg);
  });
  app.on('activate', () => {
    if (started) void focusMain();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', event => {
    if (closing) return;
    // Every quit runs through here, even one that arrives while Aplos is still starting: a window's save-before-close
    // would otherwise cancel Electron's own quit, and with no window left nothing on macOS would restart it.
    event.preventDefault();
    if (quitting) return;
    quitGate.request();
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
      // One engine per data directory: a live holder refuses here (the catch below shows why), a dead one is reclaimed.
      lock = acquireLock(dataDirOverride ?? app.getPath('userData'), nodeLockPorts());
      await bootEngine({ noteExit: noteEngineExit, noteRestart: () => processState.tryAgain() });
      processState.engineReady();
      started = true;
      nativeTheme.on('updated', () => syncTheme(true));
      startUpdates();
      menus();
      startResident();
      const atLogin = !isTest && app.getLoginItemSettings().wasOpenedAtLogin;
      // A login launch is windowless and resident: the menu-bar item or the Dock opens the window.
      if (atLogin) setPolicy('accessory');
      // The choice is applied through the same guards as every activation, so whichever answer lands
      // second never makes a second window (F3); a failure falls back to the mail window (M3).
      const windowsSettled = startWindows(atLogin)
        .then(choice =>
          applyWindowChoice(choice, {
            onboardingOpen: () => onboarding.isOpen(),
            ensureMail: () => void ensureMain(),
            activate: () => {
              if (pendingActivation) void focusMain();
            },
          }),
        )
        .catch(error =>
          windowFallback(error, {
            report: failure =>
              console.error('Aplos Mail: could not open the first window:', failure),
            ensureMail: () => void ensureMain(),
            fatal: failedStart,
          }),
        );
      if (!isTest) app.setAsDefaultProtocolClient('aplos');
      // Links that arrived while the window was being chosen (and the cold-start argv) are answered once it exists.
      void windowsSettled.finally(() => {
        for (const link of oauthGate.release()) handleOauthReturn(link);
        for (const arg of process.argv) if (/^(mailto|aplos):/i.test(arg)) routeLink(arg);
      });
    })
    .catch(failedStart);
}

/** The "could not start" path: a quit that landed during start-up is finishing on its own, so no dialog. */
function failedStart(error: unknown) {
  if (closing) return;
  dialog.showErrorBox(
    'Aplos Mail could not start',
    error instanceof Error ? error.message : 'An unknown startup error occurred.',
  );
  if (isTest) app.exit(1);
  else app.quit();
}

export { started, closing, quitting, finishQuit, cancelQuit, failedStart };
