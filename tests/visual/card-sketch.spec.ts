import { expect, test } from '@playwright/test';
import { STATES, type Theme } from './states';
import { openState } from './support/gallery';

// The one-by-one card against the owner's sketch (2026-11-10, items 1 to 6), in both themes, in the real shell on the
// stand-in engine: nothing above the card, no subject row, no rail, the header row in the sketch's order with one
// hairline under it, the bar unchanged. (A plain email on the card is its own PR, plain-mail.spec.)
const ONE = STATES.find(s => s.id === 'one-by-one')!;
const CARD = '.aplos-one-by-one__card';
const THEMES: readonly Theme[] = ['light', 'dark'];

for (const theme of THEMES)
  test.describe(`the card against the sketch, ${theme}`, () => {
    test('1 and 2: nothing above the card but the top bar, and no subject row', async ({
      page,
    }) => {
      await openState(page, ONE, { theme });
      await expect(page.locator(`${CARD} .ui-thread-message`).first()).toBeVisible();
      await expect(page.locator(`${CARD} .ui-reader-head, ${CARD} .ui-summary`)).toHaveCount(0);
      await expect(page.locator(`${CARD} .ui-chip[data-kind="due"]`)).toHaveCount(0);
      await expect(page.locator(`${CARD} .ui-thread-message__subject`)).toHaveCount(0);
      const first = await page.locator(`${CARD} .ui-thread-message`).first().boundingBox();
      const firstChild = await page
        .locator(`${CARD} .ui-thread-message > *`)
        .first()
        .evaluate(el => el.className);
      expect(firstChild, 'the first row of the card is the header').toContain(
        'ui-thread-message__head',
      );
      expect(first?.y).toBeLessThan(160);
    });

    test('3: no rail to the left of the sender', async ({ page }) => {
      await openState(page, ONE, { theme });
      const content = await page
        .locator(`${CARD} .ui-thread-message`)
        .first()
        .evaluate(el => getComputedStyle(el, '::before').content);
      expect(content).toBe('none');
    });

    test('4: header row in the sketch order, then one hairline', async ({ page }) => {
      await openState(page, ONE, { theme });
      const order = await page
        .locator(`${CARD} .ui-thread-message__line`)
        .first()
        .evaluate(line => {
          const kinds: string[] = [];
          for (const child of Array.from(line.children)) {
            if (child.matches('.aplos-sender-mark')) kinds.push('mark');
            else if (child.matches('.ui-thread-message__from')) kinds.push('name');
            else if (child.matches('time')) kinds.push('time');
            else if (child.matches('.aplos-recipients')) kinds.push('to');
            else if (child.matches('.ui-thread-message__actions'))
              for (const a of Array.from(child.children))
                kinds.push(
                  a.matches('.aplos-bell')
                    ? 'bell'
                    : a.getAttribute('aria-label') === 'Message actions'
                      ? 'more'
                      : /Important|Low importance/.test(a.getAttribute('aria-label') ?? '')
                        ? 'importance'
                        : (a.textContent ?? 'other'),
                );
          }
          return kinds;
        });
      expect(order).toEqual(['mark', 'name', 'time', 'to', 'bell', 'importance', 'more']);
      const line = await page
        .locator(`${CARD} .ui-thread-message__head`)
        .first()
        .evaluate(el => getComputedStyle(el).boxShadow);
      expect(line, 'one hairline under the header').not.toBe('none');
      const head = await page.locator(`${CARD} .ui-thread-message__head`).first().boundingBox();
      const card = await page.locator(`${CARD} .ui-thread-message`).first().boundingBox();
      expect(head!.width, 'the hairline runs the card width inside its padding').toBeGreaterThan(
        card!.width - 60,
      );
    });

    test('6: the bar and the keys are unchanged; the Reply stub is not under the card', async ({
      page,
    }) => {
      await openState(page, ONE, { theme });
      await expect(page.locator(`${CARD} .ui-reader-actions`)).toBeVisible();
      await expect(
        page.locator(`${CARD} .ui-reader-actions button`, { hasText: 'Reply' }),
      ).toBeVisible();
      await expect(
        page.locator(`${CARD} .ui-reader-actions button`, { hasText: 'Later' }),
      ).toBeVisible();
      await expect(
        page.locator(`${CARD} .ui-reader-actions button`, { hasText: 'Done' }),
      ).toBeVisible();
      await expect(page.locator(`${CARD} .ui-reply-stub`)).toBeHidden();
    });
  });
