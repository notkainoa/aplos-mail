// The legacy reader's body gate in a real browser: SVG, MathML and remote images make no request while images are off (improve plan 001). It extends the
// pinned Playwright base (headless only, Chromium). No web server: the spec serves its host page and bundle through
// page.route, so every other request is visible and none leaves the machine. Run from the repo root:
//   npx playwright test -c apps/desktop/src/renderer/legacy/browser/playwright.config.ts
// Output goes to a temp directory removed when the run exits; APLOS_LEGACY_MAILBODY_KEEP=1 keeps it (traces on failure).
import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseConfig, baseUse } from '../../../../../../tests/e2e/base.config';

/** One temp output directory per run, shared with workers through the environment. */
function outputDir(): string {
  if (process.env.APLOS_LEGACY_MAILBODY_OUT) return process.env.APLOS_LEGACY_MAILBODY_OUT;
  const dir = mkdtempSync(join(tmpdir(), 'aplos-legacy-mailbody-'));
  process.env.APLOS_LEGACY_MAILBODY_OUT = dir;
  const owner = process.env.TEST_WORKER_INDEX === undefined;
  if (owner && process.env.APLOS_LEGACY_MAILBODY_KEEP !== '1') {
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
