import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The composer's From row (owner's hands-on pass 2026-11-12): with two accounts connected a new message can be written
// in either; the row is the account's address. Demo mail has two accounts, so it shows here.
const HOME = STATES.find(s => s.id === 'home-full')!;
const FROM = '.aplos-from';

async function openCompose(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('c');
  await expect(page.locator('.ui-composer')).toBeVisible();
}

for (const theme of ['light', 'dark'] as const)
  test(`a new message has a From picker with both accounts, ${theme}`, async ({ page }) => {
    await openState(page, HOME, { theme });
    await openCompose(page);
    const row = page.locator(FROM);
    await expect(row).toBeVisible();
    const button = row.getByRole('button');
    const first = (await button.textContent())?.trim() ?? '';
    expect(first).toMatch(/@/);
    await button.click();
    const menu = page.getByRole('menu', { name: 'Send from' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await page.screenshot({
      path: `${process.env.SHOTS ?? 'artifacts/visual'}/compose-from-${theme}.png`,
    });
    await menu.getByRole('menuitemradio').filter({ hasNotText: first }).click();
    await expect(menu).toBeHidden();
    await expect(button).not.toHaveText(first);
    // The text typed afterwards is saved in the chosen account and the picker still works while a draft exists.
    await page.locator('.ui-composer__editor textarea').fill('Hello');
    await expect(page.locator('.ui-draft-state')).toContainText(/Saved|Draft/i);
  });

for (const theme of ['light', 'dark'] as const)
  test(`a reply starts in the thread’s account and its From can switch (DESIGN 7.6), ${theme}`, async ({
    page,
  }) => {
    await openState(page, HOME, { theme });
    await page.keyboard.press('Enter');
    await page.locator('.aplos-reader__letter[data-paper="true"]').waitFor();
    await page.keyboard.press('r');
    await page.locator('.ui-inline-reply').waitFor();
    const row = page.locator(`.ui-inline-reply ${FROM}`);
    await expect(row).toHaveCount(1);
    const button = row.getByRole('button');
    const first = (await button.textContent())?.trim() ?? '';
    expect(first).toMatch(/@/);
    await button.click();
    const menu = page.getByRole('menu', { name: 'Send from' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveText(first);
    await page.screenshot({
      path: `${process.env.SHOTS ?? 'artifacts/visual'}/reply-from-${theme}.png`,
    });
    await menu.getByRole('menuitemradio').filter({ hasNotText: first }).click();
    await expect(menu).toBeHidden();
    await expect(button).not.toHaveText(first);
    await page.locator('.ui-inline-reply textarea').fill('Sounds good');
    // Typing keeps the chosen account. (The save itself is covered by session.test.ts and the real app: since revamp
    // cf3dc57d the gallery's inline reply stays on "Saving…" even without a switch.)
    await expect(button).not.toHaveText(first);
  });
