import { defineConfig } from '@playwright/test';
import { baseConfig, baseUse, browserPreviewServer, previewUrl, wantsBrowserPreview } from './base.config';

// Two tiers (plans/40-platform-quality.md Q3): the browser preview and the Electron app.
// Run from the repo root: npm run test:e2e
export default defineConfig({
  ...baseConfig,
  testDir: '.',
  projects: [
    {
      name: 'browser',
      testMatch: '*.browser.spec.ts',
      use: { ...baseUse, browserName: 'chromium', baseURL: previewUrl },
    },
    {
      // Drives the built app through support/electron.ts; it never opens a browser.
      name: 'electron',
      testMatch: '*.electron.spec.ts',
      use: { ...baseUse },
    },
  ],
  // Not started for `--project electron` runs.
  webServer: wantsBrowserPreview() ? browserPreviewServer() : undefined,
});
