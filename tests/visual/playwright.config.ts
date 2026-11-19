import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { baseConfig, baseUse } from '../e2e/base.config';
import { galleryOrigin, galleryPort, repoRoot, visualDir } from './support/paths';

// The visual harness (DESIGN 12.5, plan 30 6.2). It extends the one pinned Playwright base in
// tests/e2e: headless Chromium, en-US, reduced motion. Run from the repo root:
//   npx playwright test -c tests/visual/playwright.config.ts

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1100x760', width: 1100, height: 760 },
] as const;

export default defineConfig({
  ...baseConfig,
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: join(visualDir, 'test-results'),
  reporter: [['list'], ['json', { outputFile: join(visualDir, 'results.json') }]],
  // Each state is independent and cheap. Workers share the one gallery server.
  fullyParallel: true,
  use: {
    ...baseUse,
    baseURL: galleryOrigin,
    browserName: 'chromium',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'light',
  },
  projects: viewports.map(({ name, width, height }) => ({
    name,
    use: { viewport: { width, height } },
  })),
  webServer: {
    command: `npx vite --config tests/visual/vite.config.ts --port ${galleryPort} --strictPort --host 127.0.0.1`,
    cwd: repoRoot,
    url: `${galleryOrigin}/tests/visual/gallery/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Blank keys: nothing in the gallery reads them, and none may leak into a page.
    env: { GROQ_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' },
  },
});
