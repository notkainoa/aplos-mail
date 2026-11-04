// The mail frame's browser checks: each hostile corpus item in the real iframe in headless Chromium. It extends the
// pinned Playwright base (headless only, Chromium). No web server: the spec serves its host page and bundle through
// page.route, so every other request is visible and none leaves the machine. Run from the repo root:
//   npx playwright test -c apps/desktop/src/renderer/mailframe/browser/playwright.config.ts
// Output goes to a temp directory removed when the run exits; APLOS_MAILFRAME_KEEP=1 keeps it (traces on failure).
import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseConfig, baseUse } from '../../../../../../tests/e2e/base.config';

/** One temp output directory per run, shared with workers through the environment. */
function outputDir(): string {
  if (process.env.APLOS_MAILFRAME_OUT) return process.env.APLOS_MAILFRAME_OUT;
  const dir = mkdtempSync(join(tmpdir(), 'aplos-mailframe-'));
  process.env.APLOS_MAILFRAME_OUT = dir;
  const owner = process.env.TEST_WORKER_INDEX === undefined;
  if (owner && process.env.APLOS_MAILFRAME_KEEP !== '1') {
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return dir;
}

export default defineConfig({
  ...baseConfig,
  testDir: '.',
  testMatch: '*.browser.spec.ts',
  outputDir: outputDir(),
  reporter: [['list']],
  fullyParallel: true,
  use: { ...baseUse, browserName: 'chromium' },
});
