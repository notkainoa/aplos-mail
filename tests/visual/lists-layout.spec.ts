import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Layout checks for the lists that pixels alone would not catch: a crowded Done row keeps every mark, and every empty
// list puts its line at the same point in the pane (the owner's pass, items 13-14).

const stateOf = (id: string) => {
  const state = STATES.find(candidate => candidate.id === id);
  if (!state) throw new Error(`unknown state ${id}`);
  return state;
};

interface Box {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

async function boxesOf(page: Page, selector: string): Promise<Box[]> {
  return page.$$eval(selector, nodes =>
    nodes.map(node => {
      const { left, right, width } = node.getBoundingClientRect();
      return { left, right, width };
    }),
  );
}

test('a crowded Done row keeps its three marks, the dot and the whole stamp, clear of the summary', async ({
  page,
}) => {
  await openState(page, stateOf('done-rows-crowded'));
  const row = '#c-1';
  const marks = await boxesOf(page, `${row} .ui-list-row__mark`);
  expect(marks).toHaveLength(3);
  for (const mark of marks) expect(mark.width).toBeGreaterThan(8);
  const [stamp] = await boxesOf(page, `${row} .ui-list-row__stamp`);
  const stampText = await page.$eval(`${row} .ui-list-row__stamp`, node => ({
    clipped: node.scrollWidth > node.clientWidth,
    text: node.textContent,
  }));
  expect(stampText.clipped).toBe(false);
  expect(stampText.text).toContain('2025');
  const [line] = await boxesOf(page, `${row} .ui-list-row__line`);
  const [meta] = await boxesOf(page, `${row} .ui-list-row__meta`);
  expect(marks[0]!.left).toBeGreaterThanOrEqual(line!.right - 0.5);
  expect(stamp!.right).toBeLessThanOrEqual(meta!.right + 0.5);
  expect(stamp!.left).toBeGreaterThanOrEqual(meta!.left - 0.5);
});

async function emptyCentre(page: Page, id: string): Promise<{ x: number; y: number }> {
  await openState(page, stateOf(id));
  return page.$eval('.aplos-screen .ui-empty-line__copy', node => {
    const { left, top, width, height } = node.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  });
}

test('every list puts its empty line at the same point in the pane', async ({ page }) => {
  const spam = await emptyCentre(page, 'list-spam-empty');
  for (const id of ['list-trash-empty', 'done-empty', 'list-bookmarks-empty', 'later-empty']) {
    const centre = await emptyCentre(page, id);
    expect(Math.abs(centre.x - spam.x), `${id} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(centre.y - spam.y), `${id} y`).toBeLessThanOrEqual(1);
  }
});

for (const density of ['roomy', 'comfortable', 'compact'] as const) {
  test(`a subject-and-summary row stays one line at the narrowest window, ${density}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openState(page, stateOf('list-all-mail'));
    await page.evaluate(value => {
      for (const row of document.querySelectorAll<HTMLElement>('.ui-list-row'))
        row.dataset.density = value;
    }, density);
    const rows = await page.$$eval('.ui-list-row', nodes =>
      nodes.map(node => {
        const box = (selector: string) =>
          node.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const primary = box('.ui-list-row__primary');
        const secondary = box('.ui-list-row__secondary');
        return {
          height: node.getBoundingClientRect().height,
          primaryTop: primary?.top,
          secondaryTop: secondary?.top,
          secondaryWidth: secondary?.width ?? 0,
          sepFirst: Boolean(node.querySelector('.ui-list-row__sep')),
        };
      }),
    );
    const withSummary = rows.filter(row => row.secondaryWidth > 0);
    expect(withSummary.length).toBeGreaterThan(5);
    const height = { roomy: 48, comfortable: 40, compact: 34 }[density];
    for (const row of withSummary) {
      expect(row.height).toBe(height);
      expect(Math.abs((row.secondaryTop ?? 0) - (row.primaryTop ?? 0))).toBeLessThan(4);
      expect(row.secondaryWidth).toBeGreaterThanOrEqual(60);
      expect(row.sepFirst).toBe(true);
    }
  });
}
