import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Go one by one shows the whole email card (owner request 2026-11-10); its header menus are reachable by keyboard and
// leave out what this view cannot do (there is no reply-all of its own here).
const state = STATES.find(s => s.id === 'one-by-one')!;
const CARD = '.aplos-one-by-one__card';

async function open(page: Page): Promise<void> {
  await openState(page, state, { theme: 'light' });
  await expect(page.locator(`${CARD} .ui-thread-message`).first()).toBeVisible();
}

test.describe('one by one: the email card', () => {
  test('the . key keeps one by one’s own menu (Set a date, Why it’s here), not the reader’s', async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press('.');
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Set a date/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Why it/ })).toBeVisible();
  });

  test('the card holds the header with the bell, Importance and More, and the pinned bar', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator(`${CARD} .ui-thread-message__subject`)).toHaveCount(0);
    await expect(page.locator(`${CARD} .aplos-recipients__button`)).toBeVisible();
    await expect(page.locator(`${CARD} button[aria-label="Message actions"]`)).toBeVisible();
    await expect(page.locator(`${CARD} .ui-reader-actions`)).toBeVisible();
  });

  test('More leaves out Reply all here, and Esc returns focus to its button', async ({ page }) => {
    await open(page);
    const more = page.locator(`${CARD} button[aria-label="Message actions"]`);
    await more.click();
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu.getByRole('menuitem', { name: /Later/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Reply all/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
  });

  test('Importance is chosen by keyboard and moves the thread with the Home toast', async ({
    page,
  }) => {
    await open(page);
    const button = page.locator(`${CARD} button[aria-haspopup="menu"]`, { hasText: 'Important' });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Moved to Low importance')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Always do this for/ })).toBeVisible();
  });
});
