import { defineConfig } from '@playwright/test';
import {
  baseConfig,
  baseUse,
  browserPreviewServer,
  previewUrl,
  repoRoot,
  wantsBrowserPreview,
} from './base.config';

// Two tiers (plans/40-platform-quality.md Q3): the browser preview and the Electron app.
// Run from the repo root: npm run test:e2e
//
// Specs live either here or in a lane's own folder (apps/desktop/tests/<lane>/), so the search
// starts at the repo root and each project matches both places by name.
const testIgnore = ['**/node_modules/**', '**/dist/**', '**/release/**'];

export default defineConfig({
  ...baseConfig,
  testDir: repoRoot,
  testIgnore,
  projects: [
    {
      name: 'browser',
      testMatch: ['tests/e2e/**/*.browser.spec.ts', 'apps/desktop/tests/**/*.browser.spec.ts'],
      use: { ...baseUse, browserName: 'chromium', baseURL: previewUrl },
    },
    {
      // Drives the built app through support/electron.ts; it never opens a browser.
      name: 'electron',
      testMatch: ['tests/e2e/**/*.electron.spec.ts', 'apps/desktop/tests/**/*.electron.spec.ts'],
      use: { ...baseUse },
    },
  ],
  // Not started for `--project electron` runs.
  webServer: wantsBrowserPreview() ? browserPreviewServer() : undefined,
});
