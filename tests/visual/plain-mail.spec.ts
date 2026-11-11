import { expect, test, type Page } from '@playwright/test';
import { STATES, type Theme } from './states';
import { openState } from './support/gallery';

// A plain email (no author colours, styles, images or layout tables) is drawn straight on the reader card in the app's own
// body type and colours in both themes: no padding block, rounding or border of its own. A newsletter keeps its light paper.
// Real shell, stand-in engine, stand-in (srcdoc) frame; the sealed frame has the same rule in packages/mail-html.
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
  test.describe(`plain mail, ${theme}`, () => {
    test('a plain email is drawn straight on the card in the app body type and colour', async ({
      page,
    }) => {
      await openState(page, ONE, { theme });
      await expect(page.locator(`${CARD} iframe`).first()).toBeVisible();
      const f = await frameFacts(page, CARD);
      expect(f).not.toBeNull();
      expect(f!.padding, 'no inner padding block').toBe('0px');
      expect(f!.radius, 'no rounded panel').toBe('0px');
      expect(f!.bodyBorder, 'no inner border').toBe('0px');
      // The card's own colour, in each theme.
      expect(f!.bodyBackground).toBe(theme === 'dark' ? 'rgb(33, 34, 37)' : 'rgb(255, 255, 255)');
      expect(f!.bodyColor).toBe(theme === 'dark' ? 'rgb(236, 236, 237)' : 'rgb(29, 30, 33)');
    });

    test('a newsletter keeps its paper frame', async ({ page }) => {
      await openState(page, NEWSLETTER, { theme });
      await expect(
        page.locator('.aplos-reader__letter[data-paper="true"] iframe').first(),
      ).toBeVisible();
      const f = await frameFacts(page, '.aplos-reader__letter[data-paper="true"]');
      expect(f).not.toBeNull();
      expect(f!.bodyBackground, 'a newsletter paints its own surface').not.toBe('rgb(33, 34, 37)');
    });
  });
