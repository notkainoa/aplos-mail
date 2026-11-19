import { expect, test } from '@playwright/test';
import { STATES, type Theme } from './states';
import { openState } from './support/gallery';

// The one-by-one card is a reading column (owner decision 2026-11-11): at most --card-w (680 px), shrinking with the pane,
// 16 to 24 px of side margin at narrow widths, no horizontal scroll, and the header, its hairline and the bar on that column.
const ONE = STATES.find(s => s.id === 'one-by-one')!;
const CARD = '.aplos-one-by-one__card .ui-thread-message';
const SIZES = [
  { name: 'narrow', width: 900, height: 700 },
  { name: 'normal', width: 1440, height: 900 },
  { name: 'ultra-wide', width: 2560, height: 1200 },
] as const;
const THEMES: readonly Theme[] = ['light', 'dark'];

for (const theme of THEMES)
  for (const size of SIZES)
    test(`the card is a bounded centred column, ${size.name} (${size.width}), ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openState(page, ONE, { theme });
      const card = page.locator(CARD).first();
      await expect(card).toBeVisible();
      const facts = await page.evaluate(selector => {
        const el = document.querySelector(selector)!;
        const pane = el.closest('.ui-pane__body, .ui-pane')!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const head = el.querySelector('.ui-thread-message__head')!.getBoundingClientRect();
        const bar = document.querySelector('.ui-reader-actions__bar')!.getBoundingClientRect();
        const frame = el.querySelector('iframe')?.getBoundingClientRect();
        const probe = document.createElement('div');
        probe.style.width = 'var(--measure-read)';
        el.querySelector('.ui-thread-message__body')!.append(probe);
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        const max = parseFloat(getComputedStyle(document.documentElement).fontSize) * 42.5;
        return {
          left: box.left - pane.left,
          right: pane.right - box.right,
          width: box.width,
          max,
          head: { left: head.left - box.left, right: box.right - head.right },
          frame: frame
            ? { left: frame.left - box.left, right: box.right - frame.right, width: frame.width }
            : null,
          measure,
          barCentre: bar.left + bar.width / 2,
          cardCentre: box.left + box.width / 2,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          paneOverflow: Array.from(document.querySelectorAll('.ui-pane__body')).some(
            e => e.scrollWidth > e.clientWidth + 1,
          ),
        };
      }, CARD);
      expect(facts.width, 'never wider than --card-w').toBeLessThanOrEqual(facts.max + 0.5);
      expect(Math.abs(facts.left - facts.right), 'centred').toBeLessThanOrEqual(1);
      expect(facts.overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
      expect(facts.paneOverflow, 'the pane does not scroll sideways').toBe(false);
      expect(facts.head.left).toBeGreaterThan(0);
      expect(
        Math.abs(facts.head.left - facts.head.right),
        'the header sits inside the column evenly',
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(facts.barCentre - facts.cardCentre),
        'the bar is centred on the column',
      ).toBeLessThanOrEqual(2);
      expect(facts.frame, 'the email frame is in the card').not.toBeNull();
      expect(facts.frame!.right, 'the email never pokes out of the card').toBeGreaterThanOrEqual(0);
      expect(facts.frame!.width, 'a plain body keeps the reading measure').toBeLessThanOrEqual(
        facts.measure + 1,
      );
      if (size.width >= 1440) expect(facts.width).toBeGreaterThanOrEqual(facts.max - 1);
      else {
        expect(facts.left, 'a side margin of at least 16 px').toBeGreaterThanOrEqual(15.5);
        expect(facts.left, 'and not more than 24 px of it plus the pane').toBeLessThan(facts.max);
        expect(facts.width).toBeLessThan(facts.max);
      }
    });
