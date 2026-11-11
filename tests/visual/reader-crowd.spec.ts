import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// A message to many people (ui-polish): the header's To circles stop at three and say how many more, and the details
// popover for five hundred recipients stays inside the window and scrolls instead of growing past it.
const FEW = STATES.find(s => s.id === 'reader-rich-crowd')!;
const MANY = STATES.find(s => s.id === 'reader-rich-crowd-details')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';

test.describe('many recipients', () => {
  test('the circles stop at three and the rest is one “+N” circle', async ({ page }) => {
    await openState(page, FEW, { theme: 'light' });
    const circles = page.locator(`${LETTER} .aplos-recipients__button .aplos-circle`);
    await expect(circles.first()).toBeVisible();
    // Three people circles and the "+4" one: Alex is among the seven, so three shown leaves four.
    await expect(circles).toHaveCount(4);
    await expect(
      page.locator(`${LETTER} .aplos-recipients__button .aplos-circle[data-more="true"]`),
    ).toHaveAttribute('data-mark', '+4');
    await expect(page.locator(`${LETTER} .aplos-recipients__button`)).toHaveAttribute(
      'aria-label',
      /and 4 more, show details$/,
    );
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
