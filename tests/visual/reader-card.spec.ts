import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The reader's card header (owner request 2026-11-10): "To", the recipient circles and a chevron open the message's
// details in a popover; by keyboard it opens, Esc closes it and focus returns to the button. Circles are monograms,
// never an <img>, so no avatar is fetched.
const state = STATES.find(s => s.id === 'reader-rich-project')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';
const BUTTON = `${LETTER} .aplos-recipients__button`;

async function open(page: Page): Promise<void> {
  await openState(page, state, { theme: 'light' });
}

test.describe('reader card header', () => {
  test('the subject is the first card top line and the head carries sender, time and the To circles', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator(`${LETTER} .ui-thread-message__subject`)).toHaveCount(1);
    const head = page.locator(`${LETTER} .ui-thread-message`).last();
    await expect(head.locator('.ui-thread-message__from')).toBeVisible();
    await expect(head.locator('.ui-thread-message__when')).toBeVisible();
    await expect(page.locator(`${BUTTON} .aplos-circle`).first()).toBeVisible();
    await expect(page.locator(`${LETTER} .ui-thread-message__line img`)).toHaveCount(0);
  });

  test('Enter opens the details, Esc closes them and focus returns to the button', async ({
    page,
  }) => {
    await open(page);
    const button = page.locator(BUTTON);
    await button.focus();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: 'Message details' });
    await expect(popover).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['From', 'To', 'Date'])
      await expect(popover.getByRole('group', { name: label })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  test('a click opens it and a second click closes it', async ({ page }) => {
    await open(page);
    await page.locator(BUTTON).click();
    await expect(page.getByRole('dialog', { name: 'Message details' })).toBeVisible();
    await page.locator(BUTTON).click();
    await expect(page.getByRole('dialog', { name: 'Message details' })).toBeHidden();
  });
});
