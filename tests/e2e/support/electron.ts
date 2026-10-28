import { _electron, type ElectronApplication } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  /** Throws when any BrowserWindow is visible. */
  assertNoVisibleWindows(): Promise<void>;
  /** Closes the app and removes the temp data directory. Safe to call twice. */
  cleanup(): Promise<void>;
}

/** Variables that must never reach a test run: AI keys and a mode that would break Electron. */
const strippedVariables = [
  'ELECTRON_RUN_AS_NODE',
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

function builtMain(): string {
  const { main } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    main: string;
  };
  const file = join(appDir, main);
  if (!existsSync(file)) throw new Error(`${file} is missing; run "npm run build" first.`);
  return file;
}

/**
 * Starts the built app in test mode (APLOS_TEST=1, fresh APLOS_DATA_DIR). Needs the F8 test mode
 * in main/lifecycle.ts; without it a window would open on screen, so specs gate on
 * APLOS_E2E_ELECTRON=1 until it lands.
 */
export async function launchAplos(options: LaunchOptions = {}): Promise<AplosApp> {
  builtMain();
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-e2e-electron-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !strippedVariables.includes(key)) env[key] = value;
  }
  Object.assign(env, options.env, { APLOS_TEST: '1', APLOS_DATA_DIR: dataDir, TZ: 'UTC' });

  let app: ElectronApplication | undefined;
  const cleanup = async () => {
    await app?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  };
  const assertNoVisibleWindows = async () => {
    const visible = await app!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length,
    );
    if (visible > 0) throw new Error(`${visible} BrowserWindow(s) are visible in test mode`);
  };

  try {
    app = await _electron.launch({
      args: [appDir, ...(options.args ?? [])],
      cwd: appDir,
      env,
      timeout: options.timeout ?? 30_000,
    });
    await assertNoVisibleWindows();
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { app, dataDir, assertNoVisibleWindows, cleanup };
}
