import { _electron, type ElectronApplication } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { repoRoot } from '../base.config';

const appDir = resolve(repoRoot, 'apps', 'desktop');

export interface LaunchOptions {
  /** Extra environment for the app. APLOS_TEST and APLOS_DATA_DIR cannot be overridden. */
  env?: Record<string, string>;
  /** Extra command line arguments after the app path. */
  args?: string[];
  /** Launch timeout in milliseconds. */
  timeout?: number;
}

export interface AplosApp {
  app: ElectronApplication;
  /** Fresh temp directory used as APLOS_DATA_DIR; never the real data directory. */
  dataDir: string;
  /** Fresh temp directory used as Chromium's userData (--user-data-dir), so the lock, caches and local storage are not the real ones. */
  userDataDir: string;
  /** Throws when any BrowserWindow is visible. */
  assertNoVisibleWindows(): Promise<void>;
  /** Closes the app and removes both temp directories. Safe to call twice. */
  cleanup(): Promise<void>;
}

/**
 * AI keys are blanked, not removed: dotenv (loadDevEnv in main/env.ts) never overrides a variable
 * that already exists, so a blank value also beats a real key in the repo's .env.
 */
const blankedVariables = [
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_API_KEY',
  'LM_STUDIO_API_KEY',
  'CUSTOM_AI_API_KEY',
];

/** Removed because it would turn Electron into plain Node. */
const strippedVariables = ['ELECTRON_RUN_AS_NODE'];

function builtMain(): string {
  const { main } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    main: string;
  };
  const file = join(appDir, main);
  if (!existsSync(file)) throw new Error(`${file} is missing; run "npm run build" first.`);
  return file;
}

/** The built main process (every file next to the entry) must contain the F8 test-mode switch. */
function assertBuildHonoursTestMode(mainFile: string): void {
  const dir = dirname(mainFile);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile() && /\.[cm]?js$/.test(item.name))
    .map(item => join(item.parentPath, item.name));
  if (!files.some(file => readFileSync(file, 'utf8').includes('APLOS_TEST'))) {
    throw new Error(
      `${dir} does not handle APLOS_TEST: the build predates F8 test mode and would open a visible window on the real data. Rebuild after F8 lands.`,
    );
  }
}

/** True when `child` is `parent` or inside it, after resolving symlinks (/var -> /private/var). */
function isInside(parent: string, child: string): boolean {
  try {
    const path = relative(realpathSync(parent), realpathSync(child));
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  } catch {
    return false;
  }
}

/**
 * Starts the built app in test mode (APLOS_TEST=1, fresh APLOS_DATA_DIR and --user-data-dir).
 * Refuses to run at all unless APLOS_E2E_ELECTRON=1 is set and the build handles APLOS_TEST, because
 * without the F8 test mode in main/lifecycle.ts a window would open on screen and the single-instance
 * lock would hit a running Aplos Mail. After launch it checks that userData is the temp directory
 * and that no window is visible; on any failure the app is closed and the temp directories removed.
 */
export async function launchAplos(options: LaunchOptions = {}): Promise<AplosApp> {
  if (process.env.APLOS_E2E_ELECTRON !== '1') {
    throw new Error(
      'launchAplos is off: set APLOS_E2E_ELECTRON=1 once F8 test mode (APLOS_TEST / APLOS_DATA_DIR, hidden windows) has landed',
    );
  }
  assertBuildHonoursTestMode(builtMain());
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-e2e-electron-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'aplos-e2e-userdata-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !strippedVariables.includes(key)) env[key] = value;
  }
  Object.assign(env, options.env, { APLOS_TEST: '1', APLOS_DATA_DIR: dataDir, TZ: 'UTC' });
  for (const key of blankedVariables) env[key] = '';

  let app: ElectronApplication | undefined;
  const cleanup = async () => {
    await app?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  };
  const assertNoVisibleWindows = async () => {
    const visible = await app!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length,
    );
    if (visible > 0) throw new Error(`${visible} BrowserWindow(s) are visible in test mode`);
  };

  try {
    app = await _electron.launch({
      args: [appDir, `--user-data-dir=${userDataDir}`, ...(options.args ?? [])],
      cwd: appDir,
      env,
      timeout: options.timeout ?? 30_000,
    });
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    // F8 test mode keeps Chromium's profile inside APLOS_DATA_DIR; either temp folder is isolated.
    if (!isInside(userDataDir, userData) && !isInside(dataDir, userData)) {
      throw new Error(
        `userData is ${userData}, not inside ${userDataDir} or ${dataDir}; the run would touch real app state`,
      );
    }
    await assertNoVisibleWindows();
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { app, dataDir, userDataDir, assertNoVisibleWindows, cleanup };
}
