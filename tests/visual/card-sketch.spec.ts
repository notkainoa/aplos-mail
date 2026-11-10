import { expect, test, type Page } from '@playwright/test';
import { STATES, type Theme } from './states';
import { openState } from './support/gallery';

// The one-by-one card against the owner's sketch (2026-11-10, items 1 to 6), in both themes, in the real shell on the
// stand-in engine: nothing above the card, no subject row, no rail, the header row in the sketch's order with one
// hairline under it, a plain email drawn straight on the card (a newsletter keeps its paper), the bar unchanged.
const ONE = STATES.find(s => s.id === 'one-by-one')!;
const NEWSLETTER = STATES.find(s => s.id === 'reader-images-blocked')!;
const CARD = '.aplos-one-by-one__card';
const THEMES: readonly Theme[] = ['light', 'dark'];

async function frameFacts(page: Page, scope: string) {
  return page.evaluate(selector => {
    const frame = document.querySelector<HTMLIFrameElement>(`${selector} iframe`);
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return null;
    const own = getComputedStyle(frame);
    const body = getComputedStyle(doc.body);
    return {
      padding: own.paddingLeft,
      radius: own.borderTopLeftRadius,
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
      bodyFont: body.fontFamily,
      bodyBorder: body.borderTopWidth,
    };
  }, scope);
}

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
                    : a.getAttribute('aria-label') === 'More'
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

    test('5: a plain email is drawn straight on the card in the app body type and colour', async ({
      page,
    }) => {
      await openState(page, ONE, { theme });
      await expect(page.locator(`${CARD} iframe`).first()).toBeVisible();
      const f = await frameFacts(page, CARD);
      expect(f).not.toBeNull();
      expect(f!.padding, 'no inner padding block').toBe('0px');
      expect(f!.radius, 'no rounded panel').toBe('0px');
      expect(f!.bodyBorder, 'no inner border').toBe('0px');
      // The sentinel surface is the card's own colour (a one-step difference in blue is invisible).
      expect(f!.bodyBackground).toBe(theme === 'dark' ? 'rgb(33, 34, 37)' : 'rgb(255, 255, 254)');
      expect(f!.bodyColor).toBe(theme === 'dark' ? 'rgb(236, 236, 237)' : 'rgb(29, 30, 33)');
    });

    test('5: a newsletter keeps its paper frame', async ({ page }) => {
      await openState(page, NEWSLETTER, { theme });
      await expect(
        page.locator('.aplos-reader__letter[data-paper="true"] iframe').first(),
      ).toBeVisible();
      const f = await frameFacts(page, '.aplos-reader__letter[data-paper="true"]');
      expect(f).not.toBeNull();
      expect(f!.bodyBackground).not.toMatch(/^rgb\(255, 255, 254\)|^rgb\(33, 34, 37\)/);
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
