import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Earlier messages in a thread (owner feedback 2026-11-11): each compact row is a bare chevron named "Show full", the whole row opens
// it (mouse, Enter, Space, O unchanged), an opened message has the card's header row and "Show less" in the same place,
// and the one toggle button keeps keyboard focus through a fold. The row shows the message's own first words, no summary.
const state = STATES.find(s => s.id === 'reader-rich-project')!;
const LETTER = '.aplos-reader__letter[data-paper="true"]';
const CARDS = `${LETTER} .ui-thread-message`;
const TOGGLES = `${LETTER} .ui-thread-message__toggle`;

async function open(page: Page): Promise<void> {
  await openState(page, state, { theme: 'light' });
  await expect(page.locator(TOGGLES).first()).toBeVisible();
}

test.describe('earlier messages', () => {
  test('every folded row is a bare chevron named Show full, and the message’s own first words', async ({
    page,
  }) => {
    await open(page);
    const toggles = page.locator(TOGGLES);
    const count = await toggles.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i += 1) {
      const toggle = toggles.nth(i);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toHaveText('');
      await expect(toggle.locator('svg')).toBeVisible();
      await expect(toggle).toHaveAccessibleName(/^Show full, message from /);
    }
    const first = page.locator(CARDS).first();
    await expect(first.locator('.ui-thread-message__excerpt')).toContainText('first pass');
    await expect(first.locator('.ui-summary')).toHaveCount(0);
  });

  test('a click anywhere on a folded row opens it, with the card header row and Show less', async ({
    page,
  }) => {
    await open(page);
    const card = page.locator(CARDS).first();
    // A real pointer click on the first words (the row's overlay is the button's, so a locator click would be refused).
    const words = (await card.locator('.ui-thread-message__excerpt').boundingBox())!;
    await page.mouse.click(words.x + 20, words.y + words.height / 2);
    const toggle = card.locator('.ui-thread-message__toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAccessibleName(/^Show less, message from /);
    await expect(
      card.locator('.ui-thread-message__line[data-layout="card"] .aplos-sender-mark'),
    ).toBeVisible();
    await expect(card.locator('.aplos-recipients__button')).toBeVisible();
    await expect(card.locator('.ui-thread-message__body')).toBeVisible();
    // The same header row as the latest card: the time follows the name, only the chevron is on the far right.
    const gaps = await card.evaluate(el => {
      const r = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
      return {
        timeAfterName: r('.ui-thread-message__when').left - r('.ui-thread-message__from').right,
        buttonAfterRecipients: r('.ui-thread-message__toggle').left - r('.aplos-recipients').right,
      };
    });
    expect(gaps.timeAfterName, 'the time follows the name').toBeLessThan(24);
    expect(gaps.buttonAfterRecipients, 'the chevron is pushed to the far right').toBeGreaterThan(
      24,
    );
    // The Importance, bell and ⋯ are the latest message's, not an earlier one's.
    await expect(card.locator('.ui-thread-message__actions')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName(/^Show full, message from /);
  });

  test('Enter and Space open and fold it, and focus stays on the same button', async ({ page }) => {
    await open(page);
    const toggle = page.locator(TOGGLES).first();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('O opens the card the cursor is on, as before', async ({ page }) => {
    await open(page);
    await page.locator(TOGGLES).nth(1).focus();
    await page.keyboard.press('o');
    await expect(page.locator(TOGGLES).nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(TOGGLES).first()).toHaveAttribute('aria-expanded', 'false');
  });
});
