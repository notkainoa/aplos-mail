import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

/**
 * `APLOS_TEST=1` is the hidden mode agents use to run the app headlessly beside a real Aplos Mail (and beside
 * each other): windows load but are never shown, no Dock icon, no single-instance lock, nothing system-wide,
 * no OS notifications or dialogs, no updates. It must run on its own data directory, so a test can never open
 * the real mailbox. This file holds the decision and the small helpers; it imports no Electron so it is testable.
 */
export type TestMode = { enabled: false } | { enabled: true; dataDir: string } | { error: string };

/** The keychain item Electron's safeStorage creates is named after the app, so tests get their own item and never touch the signed app's. */
export const testAppName = 'Aplos Mail Test';

/** Written into a test data directory on first use, so the same directory is accepted again after a restart. */
export const testMarker = '.aplos-test';

/**
 * Set by `scripts/build-main.mjs`: false in release builds (`APLOS_RELEASE_BUILD=1`), so a distributed app ignores
 * `APLOS_TEST` and `APLOS_DATA_DIR` entirely (plan 40 section 6; freeze R2H-4). Local `npm run package` builds and
 * development runs keep test mode for headless checks.
 */
declare const __APLOS_TEST_MODE__: boolean | undefined;
const compiledIn = typeof __APLOS_TEST_MODE__ === 'undefined' ? true : __APLOS_TEST_MODE__;

/** What `testMode` needs from the machine, injectable for tests. */
export interface TestModeHost {
  compiledIn: boolean;
  /** The system temp roots a test data directory must sit inside (never taken from TMPDIR). */
  tempRoots: string[];
  home: string;
  realpath(path: string): string;
  exists(path: string): boolean;
}
/**
 * Fixed system temp roots (freeze round 3, R2H-1): macOS per-user temp (`/var/folders`, what `mkdtemp(os.tmpdir())`
 * gives) and `/tmp`. Never `TMPDIR` or a caller-chosen root, which an environment could point at `/` or home.
 */
export const systemTempRoots = ['/private/var/folders', '/private/tmp', '/tmp', '/var/folders'];
const machine: TestModeHost = {
  compiledIn,
  tempRoots: systemTempRoots,
  home: homedir(),
  realpath: path => realpathSync(path),
  exists: path => existsSync(path),
};

const refuse = (why: string) => ({
  error: `APLOS_TEST=1 refuses this APLOS_DATA_DIR: ${why}. Create a fresh directory under the system temp folder (mkdtemp) for each run.`,
});
// macOS disks are case-insensitive by default, so every comparison ignores case.
const fold = (path: string) => path.toLowerCase();
const within = (child: string, parent: string) =>
  fold(child).startsWith(fold(parent.endsWith(sep) ? parent : parent + sep));
const same = (a: string, b: string) => fold(a) === fold(b);

/**
 * Test mode needs a directory made for the run (freeze R2H-1): it must exist, resolve (symlinks followed) to a
 * directory inside a fixed system temp root (`systemTempRoots`; never `TMPDIR`), and never be a root itself, `/`, the
 * home folder or the real or preview Aplos data folders (compared without regard to case). A directory that already holds a mailbox key from a
 * non-test run (no marker) is refused too.
 */
export function testMode(
  env: Record<string, string | undefined>,
  host: TestModeHost = machine,
): TestMode {
  if (!host.compiledIn || env.APLOS_TEST !== '1') return { enabled: false };
  const dataDir = env.APLOS_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir))
    return { error: 'APLOS_TEST=1 requires APLOS_DATA_DIR to be set to an absolute path.' };
  if (!host.exists(dataDir)) return refuse('it does not exist');
  const real = host.realpath(dataDir);
  const roots = host.tempRoots;
  const home = host.realpath(host.home);
  const appDirs = [
    join(home, 'Library', 'Application Support', 'Aplos Mail'),
    join(home, 'Library', 'Application Support', 'Aplos Mail Preview'),
  ];
  if (
    real === sep ||
    same(real, home) ||
    roots.some(root => same(real, root)) ||
    appDirs.some(app => same(real, app))
  )
    return refuse('it is a system, home or app folder');
  if (appDirs.some(app => within(real, app)))
    return refuse('it is inside the real Aplos data folder');
  if (!roots.some(root => within(real, root)))
    return refuse('it is not inside the system temp folder');
  if (host.exists(join(real, 'engine-key.bin')) && !host.exists(join(real, testMarker)))
    return refuse('it holds a mailbox from a non-test run');
  return { enabled: true, dataDir: real };
}

const mode = testMode(process.env);
/** Read by the main-process modules: true only when test mode is on and valid (an invalid one exits at startup). */
export const isTest = 'enabled' in mode && mode.enabled;
/** Set when `APLOS_TEST=1` but the environment is unusable; lifecycle prints it and exits 2 before touching data. */
export const testModeError = 'error' in mode ? mode.error : undefined;
export const testDataDir = 'dataDir' in mode ? mode.dataDir : undefined;
/**
 * Where the engine keeps its data when not the app's own folder: the test directory in test mode, else a development
 * `APLOS_DATA_DIR`. Release builds ignore `APLOS_DATA_DIR` entirely (freeze round 3, R2H-4).
 */
export const dataDirOverride = compiledIn
  ? (testDataDir ?? (process.env.APLOS_DATA_DIR || undefined))
  : undefined;

/** Marks the test data directory, so a restart of the same run is accepted (a fresh mailbox key alone is not). */
export function markTestDir(dataDir: string) {
  writeFileSync(join(dataDir, testMarker), 'Aplos Mail test data. Safe to delete.\n', {
    mode: 0o600,
  });
}

/** OS notifications are not shown in test mode; they are kept here so a test can inspect them. */
export const recordedNotifications: { title: string; body: string; threadId?: string }[] = [];
export function recordNotification(title: string, body: string, threadId?: string) {
  recordedNotifications.push({ title, body, threadId });
  console.log(`Aplos Mail test: notification "${title}": ${body}`);
}

type Method = (...args: unknown[]) => unknown;
/**
 * Replace every native dialog with a stderr line, in place on Electron's `dialog`, so no module (including
 * future ones) can open one. Message boxes answer with the first button; save/open answer `canceled`.
 */
export function silenceDialogs(dialog: object, log: (line: string) => void) {
  const target = dialog as Record<string, Method>;
  const options = (args: unknown[]) => args[args.length - 1] as { message?: string } | undefined;
  target.showErrorBox = (title, content) => log(`dialog "${title}": ${String(content)}`);
  target.showMessageBox = async (...args) => {
    log(`dialog: ${options(args)?.message ?? ''}`);
    return { response: 0, checkboxChecked: false };
  };
  target.showMessageBoxSync = (...args) => {
    log(`dialog: ${options(args)?.message ?? ''}`);
    return 0;
  };
  target.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  target.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  target.showSaveDialogSync = () => undefined;
  target.showOpenDialogSync = () => undefined;
}

/** Links the app asked the system to open in test mode (`globalThis.aplosTest.externalLinks`), so a test can finish an OAuth connect. */
export const recordedExternalLinks: string[] = [];

/** What `handleOauthReturn` did with each `aplos://oauth-return` link, never the nonce. */
export const recordedOauthReturns: string[] = [];
export function recordOauthReturn(entry: string) {
  if (isTest) recordedOauthReturns.push(entry);
}
/**
 * Freeze round 2, R2H-5: the engine's `openExternal` request (OAuth connect) and the session's microphone permission
 * handler reach `shell.openExternal` and `systemPreferences.askForMediaAccess` without a test-mode check, which would
 * open the default browser or raise a macOS permission prompt. Like `silenceDialogs`, this replaces both in place, so no
 * module (including future ones) can reach them: a link is recorded and dropped, the microphone is "not allowed".
 */
export function silenceSystem(
  shell: object,
  systemPreferences: object,
  log: (line: string) => void,
) {
  const sh = shell as Record<string, Method>;
  const prefs = systemPreferences as Record<string, Method>;
  sh.openExternal = async (...args) => {
    recordedExternalLinks.push(String(args[0]));
    log(`openExternal dropped: ${String(args[0]).replace(/[?#].*$/, '')}`);
  };
  sh.openPath = async () => '';
  sh.showItemInFolder = () => {};
  prefs.askForMediaAccess = async () => false;
}

/**
 * `globalThis.aplosTest` in the main process, test mode only: what a hidden run recorded, for a test that reads it with
 * `electronApp.evaluate` (Playwright) instead of scraping logs. Holds the notifications and the links that were dropped.
 */
export function exposeTestHooks() {
  Object.defineProperty(globalThis, 'aplosTest', {
    value: {
      notifications: recordedNotifications,
      externalLinks: recordedExternalLinks,
      oauthReturns: recordedOauthReturns,
    },
    enumerable: false,
  });
}

/**
 * Test-only window/CDP/keychain flags (APLOS_TEST=1 required for all):
 * - APLOS_TEST_SHOW_WINDOWS=1: windows order in with showInactive() instead of staying hidden — a headless run a
 *   CDP driver can screenshot. Never steals focus or switches Space, but they do become visible on screen.
 * - APLOS_TEST_CDP_PORT=<0-65534>: append --remote-debugging-port for the run; 0 asks for a random port. The flag
 *   is loopback-only by Chromium design; a caller-supplied -/--remote-debugging-address in argv is refused at startup.
 * - APLOS_TEST_KEYCHAIN=login: skip the in-memory keychain. On Electron 44 the safeStorage item resolves from the
 *   package name — i.e. the real "Aplos Mail Safe Storage" item. A seal made by an identically-signed build unwraps
 *   (same build re-run); a signature mismatch either raises the macOS keychain prompt (never silently) or denies the
 *   unwrap, in which case the engine runs with a key error and accounts stay locked.
 * Without APLOS_TEST=1 every flag is inert — normal launches are byte-for-byte unchanged.
 */
export interface TestFlags {
  readonly showWindows: boolean;
  readonly useLoginKeychain: boolean;
  readonly cdpPort: number | undefined;
}

export function testFlags(env: NodeJS.ProcessEnv, isTest: boolean): TestFlags {
  const none: TestFlags = { showWindows: false, useLoginKeychain: false, cdpPort: undefined };
  if (!isTest) return none;
  const raw = env.APLOS_TEST_CDP_PORT;
  let cdpPort: number | undefined;
  if (raw !== undefined) {
    if (!/^\d{1,5}$/.test(raw)) return none;
    const port = Number(raw);
    if (port > 65534) return none;
    cdpPort = port;
  }
  return {
    showWindows: env.APLOS_TEST_SHOW_WINDOWS === '1',
    useLoginKeychain: env.APLOS_TEST_KEYCHAIN === 'login',
    cdpPort,
  };
}

export const testOnlyFlags = testFlags(process.env, isTest);
