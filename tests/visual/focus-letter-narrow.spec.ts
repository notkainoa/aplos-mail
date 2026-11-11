import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The focus letter in a narrow pane (owner hand-check): the main action keeps its label at every width, and the
// secondary parts give way in order (Later and Done lose their keys, then their words, last the main action's key).
const HOME_FOCUS = STATES.find(state => state.id === 'home-focus')!;

interface ButtonFacts {
  readonly label: string;
  readonly width: number;
  readonly caps: number;
}

async function actionRow(page: Page): Promise<ButtonFacts[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ui-focus-letter__actions .ui-list-btn')].map(button => {
      const label = button.querySelector<HTMLElement>('.ui-list-btn__label');
      const shown = (element: Element | null) =>
        element !== null && (element as HTMLElement).offsetParent !== null;
      return {
        label: shown(label) ? (label?.textContent ?? '') : '',
        width: Math.round(button.getBoundingClientRect().width),
        caps: [...button.querySelectorAll('.ui-list-kbd')].filter(shown).length,
      };
    }),
  );
}

for (const [pane, mainCap, secondaryCaps, secondaryLabels] of [
  [1100, true, true, true],
  [520, true, false, true],
  [420, true, false, false],
  [360, false, false, false],
] as const) {
  test(`focus letter at a ${pane}px window keeps the main label and drops parts in order`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: pane, height: 800 });
    await openState(page, HOME_FOCUS);
    const [main, later, done] = await actionRow(page);
    expect(main!.label, 'the main action keeps its words').not.toBe('');
    expect(main!.width, 'the main action does not collapse').toBeGreaterThanOrEqual(64);
    expect(main!.caps > 0, 'the main action key').toBe(mainCap);
    for (const secondary of [later!, done!]) {
      expect(secondary.caps > 0, 'a secondary key').toBe(secondaryCaps);
      expect(secondary.label !== '', 'a secondary word').toBe(secondaryLabels);
    }
  });
}
