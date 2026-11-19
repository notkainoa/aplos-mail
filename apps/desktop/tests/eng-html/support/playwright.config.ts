import { defineConfig } from '@playwright/test';
import { baseConfig } from '../../../../../tests/e2e/base.config';

// The leak harness's own Playwright config (plat-ci's tests/e2e/playwright.config.ts only matches *.browser.spec.ts and
// *.electron.spec.ts). It keeps the shared base: headless only, fixed locale and time zone, results in artifacts/e2e/.
export default defineConfig({
  ...baseConfig,
  testDir: '..',
  testMatch: ['leak.e2e.ts', 'reporter.e2e.ts', 'reporter-lifetime.e2e.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 10_000 },
});
