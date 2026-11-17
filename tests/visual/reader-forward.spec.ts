import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Forward and Mark unread in the reader (hands-on test 2026-11-16: the reader's ⋯ menus listed neither and F did
// nothing). Both menus now carry them after Reply all, F opens the compose page on "Fwd:" with the quoted original and
// nobody in To, and Mark unread returns to the list. F works on a list row too. Demo data only; nothing is sent.
const HOME = STATES.find(s => s.id === 'home-full')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';
const BAR_MORE = '.ui-pane__tools [aria-label="Thread actions"]';
const CARD_MORE = '[aria-label="Message actions"]';
const SUBJECT = (page: Page) => page.getByRole('textbox', { name: 'Subject' });

async function openReader(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await openState(page, HOME, { theme });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
}

async function expectForwardPage(page: Page): Promise<void> {
  await expect(SUBJECT(page)).toHaveValue(/^Fwd: /);
  const to = page.getByRole('group', { name: 'To' });
  await expect(to.getByRole('combobox', { name: 'Add recipients' })).toHaveValue('');
  // A reply would prefill the sender here; a forward leaves To to the owner.
  await expect(to).not.toContainText(/jordan|alex|@/i);
  const body = page.getByRole('textbox', { name: 'Message' });
  await expect(body).toHaveValue(
    /---------- Forwarded message ----------\nFrom: .+\nDate: .+\nSubject: .+/,
  );
  await expect(body).toHaveValue(/\n\nHi Alex,/);
}

for (const theme of ['light', 'dark'] as const)
  test(`both ⋯ menus list Forward and Mark unread right after Reply all, ${theme}`, async ({
    page,
  }) => {
    await openReader(page, theme);
    for (const trigger of [BAR_MORE, CARD_MORE]) {
      await page.locator(trigger).first().click();
      const menu = page.getByRole('menu').first();
      await expect(menu).toBeVisible();
      const names = await menu.getByRole('menuitem').allInnerTexts();
      const at = (label: RegExp) => names.findIndex(name => label.test(name));
      expect(at(/^Forward/)).toBeGreaterThan(-1);
      expect(at(/^Mark (read|unread)/)).toBe(at(/^Forward/) + 1);
      if (at(/^Reply all/) >= 0) expect(at(/^Forward/)).toBe(at(/^Reply all/) + 1);
      await expect(menu.getByRole('menuitem', { name: /^Forward/ })).toContainText('F');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });

test('F in the reader opens a forward: Fwd:, the quoted original, nobody in To', async ({
  page,
}) => {
  await openReader(page);
  await page.keyboard.press('f');
  await expectForwardPage(page);
});

test('Forward from the menu opens the same page', async ({ page }) => {
  await openReader(page);
  await page.locator(BAR_MORE).click();
  await page.getByRole('menuitem', { name: /^Forward/ }).click();
  await expectForwardPage(page);
});

test('F on a list row opens a forward too', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('f');
  await expectForwardPage(page);
});

test('Mark unread goes back to the list, and the thread is unread there', async ({ page }) => {
  await openReader(page);
  await page.locator(BAR_MORE).click();
  const item = page.getByRole('menuitem', { name: /^Mark (read|unread)/ });
  if (/Mark read/.test((await item.innerText()).trim())) {
    // An unread thread: read it first, so the menu offers Mark unread.
    await item.click();
    await page.locator(BAR_MORE).click();
  }
  await page.getByRole('menuitem', { name: /^Mark unread/ }).click();
  await expect(page.locator(LETTER)).toHaveCount(0);
  await expect(page.getByText('Marked unread')).toBeVisible();
});
