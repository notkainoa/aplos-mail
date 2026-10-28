import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  tmpdir: string;
  home: string;
  realpath(path: string): string;
  exists(path: string): boolean;
}
const machine: TestModeHost = {
  compiledIn,
  tmpdir: tmpdir(),
  home: homedir(),
  realpath: path => realpathSync(path),
  exists: path => existsSync(path),
};

const refuse = (why: string) => ({
  error: `APLOS_TEST=1 refuses this APLOS_DATA_DIR: ${why}. Create a fresh directory under the system temp folder (mkdtemp) for each run.`,
});
const within = (child: string, parent: string) =>
  child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Test mode needs a directory made for the run (freeze R2H-1): it must exist, resolve (symlinks followed) to a
 * directory inside the system temp folder or inside an explicit `APLOS_TEST_ROOT`, and never be that folder itself,
 * `/`, the home folder or the real or preview Aplos data folders. A directory that already holds a mailbox key from a
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
  const roots = [host.realpath(host.tmpdir)];
  if (env.APLOS_TEST_ROOT && isAbsolute(env.APLOS_TEST_ROOT) && host.exists(env.APLOS_TEST_ROOT))
    roots.push(host.realpath(env.APLOS_TEST_ROOT));
  const home = host.realpath(host.home);
  const appDirs = [
    join(home, 'Library', 'Application Support', 'Aplos Mail'),
    join(home, 'Library', 'Application Support', 'Aplos Mail Preview'),
  ];
  if (real === sep || real === home || roots.includes(real) || appDirs.includes(real))
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
