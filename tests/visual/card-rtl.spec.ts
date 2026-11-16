import { expect, test } from '@playwright/test';
import { STATES, type Theme } from './states';
import { openState } from './support/gallery';

// Right-to-left and very long sender names on the one-by-one card (ui-polish punch list 2026-11-11). The name is `dir="auto"`, so
// its own text runs right to left while the header row keeps its order (mark, name, time, To, actions); a long name ellipsizes
// and never pushes the time, the To button or the actions out of the card. The name text is swapped in the page for a layout
// check (the data path and the monogram's first letter are unit-tested in readerPeople.test.ts).
const ONE = STATES.find(s => s.id === 'one-by-one')!;
const CARD = '.aplos-one-by-one__card .ui-thread-message';
const NAMES = [
  ['Arabic', 'محمد علي عبد الرحمن'],
  ['Hebrew', 'שרה כהן־לוי'],
  ['a very long Arabic name', 'محمد علي عبد الرحمن '.repeat(12)],
  [
    'a very long Latin name',
    'Maximiliana Alexandrina Wilhelmina Konstantinopolitanischer '.repeat(5),
  ],
] as const;
const THEMES: readonly Theme[] = ['light', 'dark'];

for (const theme of THEMES)
  for (const [label, name] of NAMES)
    test(`${label} sender name keeps the header row intact, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await openState(page, ONE, { theme });
      await expect(page.locator(CARD).first()).toBeVisible();
      await page
        .locator(`${CARD} .ui-thread-message__from`)
        .first()
        .evaluate((el, text) => {
          el.textContent = text;
        }, name);
      const facts = await page.evaluate(selector => {
        const card = document.querySelector(selector)!;
        const box = card.getBoundingClientRect();
        const line = card.querySelector('.ui-thread-message__line')!;
        const from = card.querySelector<HTMLElement>('.ui-thread-message__from')!;
        const inside = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        };
        const kids = Array.from(line.children).map(k => ({ cls: k.className, ok: inside(k) }));
        return {
          direction: getComputedStyle(from).direction,
          clipped: from.scrollWidth > from.clientWidth,
          kids,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          order: Array.from(line.children).map(k => k.getBoundingClientRect().left),
        };
      }, CARD);
      expect(
        facts.kids.every(k => k.ok),
        JSON.stringify(facts.kids),
      ).toBe(true);
      expect(facts.overflow).toBeLessThanOrEqual(0);
      expect(
        [...facts.order].sort((a, b) => a - b),
        'the row keeps its order',
      ).toEqual(facts.order);
      if (label.includes('Arabic') || label === 'Hebrew') expect(facts.direction).toBe('rtl');
      else expect(facts.direction).toBe('ltr');
      if (label.startsWith('a very long'))
        expect(facts.clipped, 'a long name ellipsizes').toBe(true);
      await expect(page.locator(`${CARD} .aplos-recipients__button`).first()).toBeVisible();
      await expect(
        page.locator(`${CARD} button[aria-label="Message actions"]`).first(),
      ).toBeVisible();
    });
