import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The reader's top-bar ⋯ (owner's hands-on pass 2026-11-12: it only showed its tooltip) opens the same menu as the
// card's ⋯, under the bar's own button, and Esc closes it without leaving the email.
const HOME = STATES.find(s => s.id === 'home-full')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';
const BAR_MORE = '.ui-pane__tools [aria-label="More"]';

for (const theme of ['light', 'dark'] as const)
  test(`the top bar's ⋯ opens the More menu, ${theme}`, async ({ page }) => {
    await openState(page, HOME, { theme });
    await page.keyboard.press('Enter');
    await expect(page.locator(LETTER)).toBeVisible();
    const button = page.locator(BAR_MORE);
    await button.click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Bookmark/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Move to Trash/ })).toBeVisible();
    // Under the bar's button, not the card's.
    const at = await menu.boundingBox();
    const bar = await button.boundingBox();
    expect(at!.y).toBeGreaterThanOrEqual(bar!.y);
    expect(at!.y).toBeLessThan(bar!.y + 80);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.locator(LETTER)).toBeVisible();
  });

test('choosing Bookmark from the top bar menu runs it', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
  await page.locator(BAR_MORE).click();
  await page.getByRole('menuitem', { name: /^Bookmark/ }).click();
  await page.locator(BAR_MORE).click();
  await expect(page.getByRole('menuitem', { name: /Remove bookmark/ })).toBeVisible();
});

test('pressing the top-bar ⋯ again closes the menu', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
  await page.locator(BAR_MORE).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  await page.locator(BAR_MORE).click();
  await expect(menu).toBeHidden();
});

test('the . key opens the same menu from the keyboard', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
  await page.keyboard.press('.');
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'More' })).toBeHidden();
});
