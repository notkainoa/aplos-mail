import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Final hands-on test 2026-11-16: Later then Done acted on a thread the owner had not seen, opening an email left it
// unread, "Go one by one" had no button role in the accessibility tree. Demo data only; nothing is sent.
const HOME = STATES.find(s => s.id === 'home-full')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';

const paperThread = (page: Page) => page.locator(LETTER).getAttribute('data-thread');

async function openReader(page: Page): Promise<string> {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
  return (await paperThread(page))!;
}

test('Later then Done act on two different threads, each the one on screen', async ({ page }) => {
  const first = await openReader(page);
  await page
    .getByRole('button', { name: /^Later/ })
    .last()
    .click();
  await expect.poll(() => paperThread(page)).not.toBe(first);
  const second = (await paperThread(page))!;
  await expect(page.getByText('Moved to Later')).toBeVisible();
  await page.getByRole('button', { name: /^Done/ }).last().click();
  await expect.poll(() => paperThread(page)).not.toBe(second);
  const third = (await paperThread(page))!;
  expect(new Set([first, second, third]).size).toBe(3);
});

test('opening an email reads it; the menu then offers Mark unread', async ({ page }) => {
  await openReader(page);
  await page.locator('.ui-pane__tools [aria-label="Thread actions"]').click();
  await expect(page.getByRole('menuitem', { name: /^Mark unread/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Mark read/ })).toHaveCount(0);
});

test('Go one by one is a button in the accessibility tree', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await expect(page.getByRole('button', { name: /Go one by one/ })).toBeVisible();
});

test('a thread read from Trash offers Restore and no Move to Trash; Restore leaves the reader', async ({
  page,
}) => {
  const trash = STATES.find(s => s.id === 'list-trash')!;
  await openState(page, trash, { theme: 'light' });
  await page.keyboard.press('Enter');
  await expect(page.locator(LETTER)).toBeVisible();
  await page.locator('.ui-pane__tools [aria-label="Thread actions"]').click();
  await expect(page.getByRole('menuitem', { name: /^Move to Trash/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: /^Restore/ }).click();
  await expect(page.getByText('Restored')).toBeVisible();
});
