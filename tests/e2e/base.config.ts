// Shared Playwright settings for every Aplos E2E tier. tests/e2e/playwright.config.ts uses this
// file as is; UI-core's tests/visual harness imports it and adds its own projects:
//
//   import { defineConfig } from '@playwright/test';
//   import { baseUse, baseConfig, browserPreviewServer } from '../e2e/base.config';
//   export default defineConfig({ ...baseConfig, testDir: '.', projects: [...] });
//
// Rules baked in: headless only, Chromium only, fixed locale and time zone, reduced motion, a
// fixed viewport, an isolated temp data directory and no AI keys.
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Several agents share each Mac, so no run may open a visible window. `baseUse.headless` is only a
 * default: `--headed`, `--debug`, `--ui` and PWDEBUG would override it, so they are refused here.
 */
export function assertHeadless(argv: string[] = process.argv, env = process.env): void {
  const refused = argv.filter(arg => /^--(headed|debug|ui)(-host|-port)?(=|$)/.test(arg));
  if (env.PWDEBUG) refused.push('PWDEBUG');
  if (refused.length > 0) {
    throw new Error(
      `Aplos E2E is headless only: ${refused.join(', ')} would open a visible window on a shared Mac. Use the HTML trace (npx playwright show-trace) instead.`,
    );
  }
}
assertHeadless();

export const repoRoot = resolve(import.meta.dirname, '..', '..');
export const artifactsDir = join(repoRoot, 'artifacts', 'e2e');

/** Port of the browser preview (Vite). The loopback API takes the next port unless overridden. */
export const previewPort = Number(process.env.APLOS_E2E_PORT) || 4417;
export const apiPort = Number(process.env.APLOS_E2E_API_PORT) || previewPort + 1;
export const previewUrl = `http://127.0.0.1:${previewPort}`;

/** Every key the app reads from the environment. The preview server must never see a real one. */
const aiKeyVariables = [
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

/** One fresh temp data directory per Playwright run, shared with workers through the environment. */
function runDataDir(): string {
  if (process.env.APLOS_E2E_DATA_DIR) return process.env.APLOS_E2E_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'aplos-e2e-preview-'));
  process.env.APLOS_E2E_DATA_DIR = dir;
  // Only the main Playwright process (workers have TEST_WORKER_INDEX) removes what it created.
  if (process.env.TEST_WORKER_INDEX === undefined)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * False when the command line selects only non-browser projects (`--project electron`), so the
 * preview server is not started for runs that never open a page.
 */
export function wantsBrowserPreview(argv: string[] = process.argv): boolean {
  const projects: string[] = [];
  argv.forEach((arg, index) => {
    if (arg.startsWith('--project=')) projects.push(arg.slice('--project='.length));
    else if (arg === '--project' || arg === '-p') projects.push(argv[index + 1] ?? '');
  });
  return projects.length === 0 || projects.includes('browser');
}

/** The browser preview: `npm run dev -w @aplos/desktop` on its own ports, demo data, no keys. */
export function browserPreviewServer(): NonNullable<PlaywrightTestConfig['webServer']> {
  // dotenv never overrides a variable that already exists, so blank keys also beat a local .env.
  const blankKeys = Object.fromEntries(aiKeyVariables.map(name => [name, '']));
  return {
    command: 'npm run dev -w @aplos/desktop',
    cwd: repoRoot,
    url: previewUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...blankKeys,
      APLOS_DATA_DIR: runDataDir(),
      APLOS_VITE_PORT: String(previewPort),
      APLOS_API_PORT: String(apiPort),
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
    },
  };
}

export const baseUse = {
  headless: true,
  locale: 'en-US',
  timezoneId: 'UTC',
  reducedMotion: 'reduce',
  viewport: { width: 1280, height: 800 },
  trace: 'retain-on-failure',
} as const;

export const baseConfig = defineConfig({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  outputDir: join(artifactsDir, 'test-results'),
  reporter: [['list'], ['json', { outputFile: join(artifactsDir, 'results.json') }]],
  use: baseUse,
});
