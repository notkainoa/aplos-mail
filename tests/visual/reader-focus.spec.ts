import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The earlier-message cards of the reader, driven by the keyboard in the real components (owner review 2026-11-03):
// opening and folding a card keeps focus on its toggle, and O acts on the card that has focus.
const state = STATES.find(s => s.id === 'reader-rich-project')!;
const TOGGLES = '.aplos-reader__letter[data-paper="true"] .ui-thread-message__toggle';

async function open(page: Page): Promise<void> {
  await openState(page, state, { theme: 'light' });
}

const expanded = (page: Page, index: number) =>
  page.locator(TOGGLES).nth(index).getAttribute('aria-expanded');

test.describe('reader cards by keyboard', () => {
  test('Enter and Space open and fold a card and focus stays on its toggle', async ({ page }) => {
    await open(page);
    const toggle = page.locator(TOGGLES).first();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
  });

  // Tab belongs to the shell's region navigation, so a card is reached by focusing its toggle (a click or .focus(), the
  // same focus event a reader gives it); the cursor follows that focus and O acts on it.
  test('focusing a card and pressing O opens that card, not another', async ({ page }) => {
    await open(page);
    await page.locator(TOGGLES).nth(2).focus();
    await expect(page.locator(TOGGLES).nth(2)).toBeFocused();
    await page.keyboard.press('o');
    await expect(page.locator(TOGGLES).nth(2)).toHaveAttribute('aria-expanded', 'true');
    expect(await expanded(page, 0)).toBe('false');
    expect(await expanded(page, 1)).toBe('false');
    await expect(page.locator(TOGGLES).nth(2)).toBeFocused();
    await page.keyboard.press('o');
    await expect(page.locator(TOGGLES).nth(2)).toHaveAttribute('aria-expanded', 'false');
  });

  test('a click puts the cursor on the card, and an arrow key moves it on from there', async ({
    page,
  }) => {
    await open(page);
    await page.locator(TOGGLES).nth(2).click();
    const rail = (index: number) =>
      page
        .locator('.aplos-reader__letter[data-paper="true"] .ui-thread-message')
        .nth(index)
        .getAttribute('data-cursor');
    expect(await rail(2)).toBe('true');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => rail(1)).toBe('true');
    expect(await rail(2)).toBeNull();
  });
});
