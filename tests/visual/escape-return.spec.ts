import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Esc (or Back) from an open email puts the owner back where they were (owner request 2026-11-11): the same screen, the
// same scroll offset and the same row under the cursor, so J and K carry on from there. This drives the real shell on
// the stand-in engine: scroll, open a row, press Esc, and read the scroller and the cursor again.
const ROWS = '[role="option"]';
// The cursor row: `data-cursor` in a list, `aria-selected` on Home's focus letter.
const CURSOR = `${ROWS}[data-cursor="true"], ${ROWS}[aria-selected="true"]`;
const WALK = '.aplos-one-by-one';
const READER = '.aplos-reader__letter[data-paper="true"]';

function stateOf(id: string) {
  const state = STATES.find(s => s.id === id);
  if (!state) throw new Error(`no state ${id}`);
  return state;
}

/** Scrolls the scroller that holds the first row to `top`; returns the offset it settled on. */
async function scrollTo(page: Page, top: number): Promise<number> {
  return page.evaluate(offset => {
    let node = document.querySelector('[role="option"]')?.parentElement ?? null;
    while (
      node &&
      !(
        node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      )
    )
      node = node.parentElement;
    if (!node) return 0;
    node.scrollTop = offset;
    return node.scrollTop;
  }, top);
}

/** The offset of the scroller that holds the cursor row. */
async function scrollOf(page: Page, selector = CURSOR): Promise<number> {
  return page.evaluate(sel => {
    let node = document.querySelector(sel)?.parentElement ?? null;
    while (
      node &&
      !(
        node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      )
    )
      node = node.parentElement;
    return node ? node.scrollTop : -1;
  }, selector);
}

async function cursorId(page: Page): Promise<string | null> {
  return page.locator(CURSOR).first().getAttribute('id');
}

/** The id of the row after `id` in document order. */
async function rowAfter(page: Page, id: string): Promise<string | null> {
  return page.evaluate(current => {
    const ids = [...document.querySelectorAll('[role="option"]')].map(row => row.id);
    return ids[ids.indexOf(current) + 1] ?? null;
  }, id);
}

async function openWithEnter(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.locator(READER)).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(0);
}

async function backWithEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(READER)).toHaveCount(0);
  await expect(page.locator(ROWS).first()).toBeVisible();
}

test.describe('Esc from an open email returns to the same spot', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
  });

  test('a scrolled list: same scroll, same row, arrows carry on', async ({ page }) => {
    await openState(page, stateOf('list-all-mail'), { theme: 'light' });
    await expect(page.locator(ROWS).nth(2)).toBeVisible();
    const scrolled = await scrollTo(page, 240);
    expect(scrolled, 'the list must scroll for this check to mean anything').toBeGreaterThan(100);
    // A row in the middle of what is on screen: the first click selects it, the keys then open it.
    const target = page.locator(ROWS).nth(8);
    await target.click();
    const opened = await cursorId(page);
    expect(opened).not.toBeNull();
    const before = await scrollOf(page);
    await openWithEnter(page);
    await backWithEscape(page);
    expect(await cursorId(page)).toBe(opened);
    expect(Math.abs((await scrollOf(page)) - before)).toBeLessThanOrEqual(1);
    const next = await rowAfter(page, opened ?? '');
    await page.keyboard.press('j');
    expect(await cursorId(page)).toBe(next);
  });

  test('Home: the row under the cursor and the scroll come back', async ({ page }) => {
    await openState(page, stateOf('home-full'), { theme: 'light' });
    await expect(page.locator(CURSOR).first()).toBeVisible();
    for (let step = 0; step < 8; step += 1) await page.keyboard.press('j');
    const opened = await cursorId(page);
    const before = await scrollOf(page);
    expect(before, 'Home must scroll for this check to mean anything').toBeGreaterThan(0);
    await openWithEnter(page);
    await backWithEscape(page);
    expect(await cursorId(page)).toBe(opened);
    expect(Math.abs((await scrollOf(page)) - before)).toBeLessThanOrEqual(1);
  });

  test('J in the reader, then Esc: the list is on the email last read', async ({ page }) => {
    await openState(page, stateOf('list-all-mail'), { theme: 'light' });
    await page.locator(ROWS).nth(3).click();
    const first = await cursorId(page);
    const next = await rowAfter(page, first ?? '');
    await openWithEnter(page);
    const read = await page.locator(READER).innerText();
    await page.keyboard.press('j');
    await expect(page.locator(READER)).not.toHaveText(read);
    await backWithEscape(page);
    expect(await cursorId(page)).toBe(next);
  });

  test('the email was marked Done while open: the cursor lands on a neighbour', async ({
    page,
  }) => {
    await openState(page, stateOf('home-full'), { theme: 'light' });
    await expect(page.locator(CURSOR).first()).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    const opened = await cursorId(page);
    await openWithEnter(page);
    const read = await page.locator(READER).innerText();
    await page.keyboard.press('e');
    // Done takes the reader to the next email (or out of it): either way the email on show changes.
    await expect
      .poll(async () => {
        const open = page.locator(READER);
        return (await open.count()) === 0 || (await open.innerText()) !== read;
      })
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator(READER)).toHaveCount(0);
    await expect(page.locator(CURSOR).first()).toBeVisible();
    expect(await cursorId(page)).not.toBe(opened);
  });

  test('the Low importance sheet opens again on the same email', async ({ page }) => {
    await openState(page, stateOf('home-low-sheet'), { theme: 'light' });
    const sheet = page.locator('.ui-low-sheet__panel');
    await expect(sheet).toBeVisible();
    // The sheet's rows open on a double-click.
    const row = sheet.locator(ROWS).last();
    const opened = await row.getAttribute('id');
    await row.dblclick();
    await expect(page.locator(READER)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(READER)).toHaveCount(0);
    await expect(sheet).toBeVisible();
    expect(await sheet.locator(CURSOR).first().getAttribute('id')).toBe(opened);
  });

  test('one by one: back on the same thread', async ({ page }) => {
    await openState(page, stateOf('one-by-one-middle'), { theme: 'light' });
    const card = page.locator('.aplos-one-by-one__card');
    await expect(card).toBeVisible();
    const shown = await card.getAttribute('id');
    await page.keyboard.press('Enter');
    // The walk's own card wears the reader's paper, so the walk being gone is what says the reader is open.
    await expect(page.locator(WALK)).toHaveCount(0);
    await expect(page.locator(READER)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(WALK)).toBeVisible();
    expect(await page.locator('.aplos-one-by-one__card').getAttribute('id')).toBe(shown);
  });

  test('a section: Done comes back on the same row', async ({ page }) => {
    await openState(page, stateOf('done-screen-rows'), { theme: 'light' });
    await expect(page.locator(ROWS).nth(2)).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    const opened = await cursorId(page);
    await openWithEnter(page);
    await backWithEscape(page);
    expect(await cursorId(page)).toBe(opened);
  });

  test('Esc with a menu open closes the menu and stays in the email', async ({ page }) => {
    await openState(page, stateOf('list-all-mail'), { theme: 'light' });
    await page.locator(ROWS).nth(2).click();
    await openWithEnter(page);
    const menu = page.locator('[role="menu"]');
    await page.locator('button[aria-haspopup="menu"][aria-label="More"]').click();
    await expect(menu.first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.locator(READER)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(READER)).toHaveCount(0);
  });
});
