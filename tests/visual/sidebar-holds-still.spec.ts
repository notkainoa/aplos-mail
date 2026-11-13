// The sidebar holds still (DESIGN 3 rule 5, 7.1): the places, the "Mail" label and Settings and Help sit at the same
// place on Home and on Calendar, at the roomy size and at the 900 x 600 minimum, and only the current place is marked.
import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

const SIZES = [
  { width: 1440, height: 900 },
  { width: 900, height: 600 },
] as const;

interface Layout {
  readonly mail: { top: number; height: number };
  readonly settingsTop: number;
  readonly helpTop: number;
  readonly marked: string[];
}

async function layoutOf(page: Page, id: string, size: (typeof SIZES)[number]): Promise<Layout> {
  await page.setViewportSize(size);
  const state = STATES.find(s => s.id === id);
  if (!state) throw new Error(`no state ${id}`);
  await openState(page, state);
  await page.locator('.aplos-sidebar [aria-current]').first().waitFor();
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const side = document.querySelector('.aplos-sidebar') as HTMLElement;
    const head = [...side.querySelectorAll('.ui-nav-head')].find(el => el.textContent === 'Mail');
    const row = (label: string) =>
      [...side.querySelectorAll('button')].find(el => el.textContent?.startsWith(label));
    const box = (el: Element | undefined) => el?.getBoundingClientRect() ?? new DOMRect();
    return {
      mail: { top: box(head).top, height: box(head).height },
      settingsTop: box(row('Settings')).top,
      helpTop: box(row('Help')).top,
      marked: [...side.querySelectorAll('[aria-current]')].map(el => (el.textContent ?? '').trim()),
    };
  });
}

test.describe('sidebar holds still', () => {
  for (const size of SIZES) {
    test(`Home and Calendar agree at ${size.width} x ${size.height}`, async ({ page }) => {
      const home = await layoutOf(page, 'home-full', size);
      const calendar = await layoutOf(page, 'shell-calendar-sidebar', size);
      expect(calendar.mail).toEqual(home.mail);
      expect(calendar.mail.height).toBe(28);
      expect(calendar.settingsTop).toBe(home.settingsTop);
      expect(calendar.helpTop).toBe(home.helpTop);
      expect(calendar.helpTop, 'Help stays inside the window').toBeLessThanOrEqual(size.height);
    });
  }

  test('on Help only Help is marked, not Settings as well', async ({ page }) => {
    const help = await layoutOf(page, 'shell-help-sidebar', SIZES[0]);
    expect(help.marked).toEqual(['Help']);
  });
});
