import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The toast deck fans out while focus is inside it and holds every toast's clock. Closing the focused toast (Undo, Set
// a date) removes its button while it has focus; React drops that blur, so the deck used to stay fanned and held for ever.
const HOME = STATES.find(s => s.id === 'home-full')!;
const STACK = '.ui-toast-stack';
const UNDO = `${STACK} .ui-toast button:has-text("Undo")`;

test('closing the toast that has focus folds the deck again', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  // Two Done toasts: the stack holds two Undo toasts.
  await page.keyboard.press('e');
  await expect(page.locator(UNDO)).toHaveCount(1);
  await page.keyboard.press('e');
  await expect(page.locator(UNDO)).toHaveCount(2);
  // Focus the front toast's Undo with the keyboard path (focus inside the stack fans the deck), then press it.
  await page.locator(UNDO).last().focus();
  await expect(page.locator(`${STACK}[data-expanded]`)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator(UNDO)).toHaveCount(1);
  // Focus is no longer in the stack, so the deck folds and the remaining toast's clock runs again.
  await expect(page.locator(`${STACK}[data-expanded]`)).toHaveCount(0);
});
