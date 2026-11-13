import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// A message to many people (ui-polish): the header says who it went to in words and how many more, and the details
// popover for five hundred recipients stays inside the window and scrolls instead of growing past it.
const FEW = STATES.find(s => s.id === 'reader-rich-crowd')!;
const MANY = STATES.find(s => s.id === 'reader-rich-crowd-details')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';

test.describe('many recipients', () => {
  test('the header names two people and says how many more, in words', async ({ page }) => {
    await openState(page, FEW, { theme: 'light' });
    const button = page.locator(`${LETTER} .aplos-recipients__button`);
    await expect(button).toBeVisible();
    await expect(page.locator(`${LETTER} .aplos-circle`)).toHaveCount(0);
    // Two named, then the rest: Alex is among the seven, so "me", one name and five more.
    await expect(button).toHaveText(/^to me, .+ and 5 more$/);
    await expect(button).toHaveAttribute('aria-label', /^to me, .+ and 5 more, show details$/);
  });

  for (const theme of ['light', 'dark'] as const)
    test(`five hundred recipients: the details popover stays inside the window and scrolls, ${theme}`, async ({
      page,
    }) => {
      await openState(page, MANY, { theme });
      const popover = page.getByRole('dialog', { name: 'Message details' });
      await expect(popover).toBeVisible();
      const facts = await page.evaluate(() => {
        const details = document.querySelector('.aplos-details')!;
        const box = details.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          viewport: window.innerHeight,
          scrolls: details.scrollHeight > details.clientHeight + 1,
          people: details.querySelectorAll('.aplos-details__person').length,
          overflowY: getComputedStyle(details).overflowY,
        };
      });
      expect(
        facts.people,
        'every recipient is listed (the sender and 501 on the To line)',
      ).toBeGreaterThan(500);
      expect(facts.top).toBeGreaterThanOrEqual(0);
      expect(facts.bottom, 'inside the window').toBeLessThanOrEqual(facts.viewport + 1);
      expect(facts.scrolls, 'long, so it scrolls').toBe(true);
      expect(facts.overflowY).toBe('auto');
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden();
    });
});
