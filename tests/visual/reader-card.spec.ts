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
  test('the head carries the sender mark, name, time and who it went to ("to me"); there is no subject row or summary above', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator(`${LETTER} .ui-thread-message__subject`)).toHaveCount(0);
    await expect(page.locator(`${LETTER} .ui-reader-head`)).toHaveCount(0);
    const head = page.locator(`${LETTER} .ui-thread-message`).last();
    await expect(head.locator('.ui-thread-message__from')).toBeVisible();
    await expect(head.locator('.ui-thread-message__when')).toBeVisible();
    await expect(page.locator(BUTTON)).toHaveText(/^to /);
    await expect(page.locator(`${BUTTON} .aplos-circle`)).toHaveCount(0);
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
    // Esc was the popover's: the real shell did not also take it as "back" and leave the reader.
    await expect(page.locator(LETTER)).toBeVisible();
  });

  test('a click opens it and a second click closes it', async ({ page }) => {
    await open(page);
    await page.locator(BUTTON).click();
    await expect(page.getByRole('dialog', { name: 'Message details' })).toBeVisible();
    await page.locator(BUTTON).click();
    await expect(page.getByRole('dialog', { name: 'Message details' })).toBeHidden();
  });

  test('Importance: Enter opens the menu, a choice moves the thread with an Undo toast, Esc returns focus', async ({
    page,
  }) => {
    await open(page);
    const button = page.locator(`${LETTER} button[aria-haspopup="menu"]`, { hasText: 'Important' });
    await button.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Importance' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    // Chosen by keyboard alone: the cursor starts on the checked item, ArrowDown moves it, Enter chooses.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Moved to Low importance')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Always do this for/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeVisible();
    await expect(
      page.locator(`${LETTER} button[aria-haspopup="menu"]`, { hasText: 'Low importance' }),
    ).toBeVisible();
  });

  test('the bell says whether the email notified, and More lists the reader’s own actions by keyboard', async ({
    page,
  }) => {
    await open(page);
    // The stand-in engine reports notifications (unread inbound mail is `sent`, the rest `none`): the bell names which.
    await expect(page.locator(`${LETTER} .aplos-bell[role="img"]`)).toHaveAttribute(
      'aria-label',
      /^This email (notified|did not notify) you$/,
    );
    await page.locator(`${LETTER} button[aria-label="More"]`).click();
    const menu = page.getByRole('menu', { name: 'More' });
    for (const name of ['Reply all', 'Later', 'Bookmark', 'Move to Trash'])
      await expect(menu.getByRole('menuitem', { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(menu).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('↑ moves the cursor to the earlier card, which shows a quiet accent edge; the latest shows none until then', async ({
    page,
  }) => {
    await open(page);
    const cards = page.locator(`${LETTER} .ui-thread-message`);
    const edge = (index: number) =>
      cards.nth(index).evaluate(el => getComputedStyle(el).boxShadow.includes('inset'));
    expect(await edge((await cards.count()) - 1), 'the latest card starts without an edge').toBe(
      false,
    );
    await page.keyboard.press('ArrowUp');
    await expect(cards.nth((await cards.count()) - 2)).toHaveAttribute('data-cursor', 'true');
    expect(await edge((await cards.count()) - 2)).toBe(true);
  });
});
