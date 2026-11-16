import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// A thread with a saved reply draft: R opens that draft, never a blank reply (ui-council finding 2026-11-16: reply, Esc,
// leave, return, R showed a blank card while the draft sat in Drafts). The card used to look for the thread's draft
// before the drafts window had its rows. The demo's first thread already has a saved reply draft ("Hi Jordan, …").
// (The gallery's clock stands still, so this spec edits nothing: it reads what the engine already holds.)
const HOME = STATES.find(s => s.id === 'home-full')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';
const CARD = '.ui-inline-reply';
const SAVED = /^Hi Jordan/;

async function openLetter(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Enter');
  await page.locator(LETTER).waitFor();
}

test('R on a thread with a saved reply draft opens that draft', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await openLetter(page);
  await page.keyboard.press('r');
  await expect(page.locator(`${CARD} textarea`).first()).toHaveValue(SAVED);
});

test('reply, Esc, leave, return, R: the draft is on the card again', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await openLetter(page);
  await page.keyboard.press('r');
  await expect(page.locator(`${CARD} textarea`).first()).toHaveValue(SAVED);
  // Esc closes the card (the draft stays), a second Esc leaves the thread.
  await page.keyboard.press('Escape');
  await expect(page.locator(CARD)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator(LETTER)).toHaveCount(0);
  await openLetter(page);
  await page.keyboard.press('r');
  await expect(page.locator(`${CARD} textarea`).first()).toHaveValue(SAVED);
});
