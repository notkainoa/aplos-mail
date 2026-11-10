import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Opening an email from a list (owner request 2026-11-10): a click on a row that is not selected only selects it; a click on
// the row that is already selected opens it; Return and O open the selected row. The registry owns the keys, so this checks
// the real shell: the reader (the email card) appears and the list is gone.
const state = STATES.find(s => s.id === 'list-all-mail')!;
const ROWS = '[role="option"]';
const READER = '.aplos-reader__letter[data-paper="true"]';

async function open(page: Page): Promise<void> {
  await openState(page, state, { theme: 'light' });
  await expect(page.locator(ROWS).nth(2)).toBeVisible();
}

test.describe('open an email from a list', () => {
  test('the first click selects a row, the second opens it', async ({ page }) => {
    await open(page);
    const row = page.locator(ROWS).nth(2);
    await row.click();
    await expect(page.locator(READER)).toHaveCount(0);
    await expect(row).toHaveAttribute('data-cursor', 'true');
    await row.click();
    await expect(page.locator(READER)).toBeVisible();
  });

  for (const key of ['Enter', 'o'])
    test(`${key} opens the selected row`, async ({ page }) => {
      await open(page);
      await page.locator(ROWS).nth(2).click();
      await expect(page.locator(READER)).toHaveCount(0);
      await page.keyboard.press(key);
      await expect(page.locator(READER)).toBeVisible();
    });
});
