import { isAbsolute } from 'node:path';

/**
 * `APLOS_TEST=1` is the hidden mode agents use to run the app headlessly beside a real Aplos Mail (and beside
 * each other): windows load but are never shown, no Dock icon, no single-instance lock, nothing system-wide,
 * no OS notifications or dialogs, no updates. It must run on its own data directory, so a test can never open
 * the real mailbox. This file holds the decision and the small helpers; it imports no Electron so it is testable.
 */
export type TestMode = { enabled: false } | { enabled: true; dataDir: string } | { error: string };

/** The keychain item Electron's safeStorage creates is named after the app, so tests get their own item and never touch the signed app's. */
export const testAppName = 'Aplos Mail Test';

export function testMode(env: Record<string, string | undefined>): TestMode {
  if (env.APLOS_TEST !== '1') return { enabled: false };
  const dataDir = env.APLOS_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir))
    return { error: 'APLOS_TEST=1 requires APLOS_DATA_DIR to be set to an absolute path.' };
  return { enabled: true, dataDir };
}

const mode = testMode(process.env);
/** Read by the main-process modules: true only when test mode is on and valid (an invalid one exits at startup). */
export const isTest = 'enabled' in mode && mode.enabled;
/** Set when `APLOS_TEST=1` but the environment is unusable; lifecycle prints it and exits 2 before touching data. */
export const testModeError = 'error' in mode ? mode.error : undefined;
export const testDataDir = 'dataDir' in mode ? mode.dataDir : undefined;

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
