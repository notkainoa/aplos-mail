import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The Low importance sheet takes focus when it opens (owner's hands-on pass 2026-11-12: Esc did nothing until a click
// inside), even though its rows arrive after it opens, and gives focus back to Home when it closes.
const HOME = STATES.find(s => s.id === 'home-full')!;
const SHEET = '.ui-low-sheet__panel';

test('the sheet holds focus once its rows have arrived, and Esc closes it', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.locator('#home-low').click();
  await expect(page.locator(SHEET)).toBeVisible();
  await expect(page.locator(`${SHEET} .ui-list-box`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(SHEET)).toHaveCount(0);
  await expect(page.locator('#home-list, .ui-list-box').first()).toBeFocused();
});

test('opening with Return from the keyboard works the same', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('j');
    if ((await page.locator('#home-low[aria-selected="true"]').count()) > 0) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator(SHEET)).toBeVisible();
  await expect(page.locator(`${SHEET} .ui-list-box`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(SHEET)).toHaveCount(0);
});
