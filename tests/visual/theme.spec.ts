import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// A state opened in the dark run must be dark. The shell's Theme setting defaults to System and follows
// `prefers-color-scheme`, so openState emulates the scene's scheme too; without it every real-shell scene (Home, lists, the
// reader, one by one) captured light in its dark run (found by ui-polish after #450).
for (const id of ['home-full', 'one-by-one', 'reader-rich-project'])
  for (const theme of ['light', 'dark'] as const)
    test(`${id} opens ${theme}`, async ({ page }) => {
      const state = STATES.find(s => s.id === id)!;
      await openState(page, state, { theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const shell = await page.evaluate(() => {
        const el = document.querySelector('.aplos-shell');
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      // --shell is #f5f5f6 in light and #121314 in dark.
      expect(shell).toBe(theme === 'dark' ? 'rgb(18, 19, 20)' : 'rgb(245, 245, 246)');
    });
