import { expect, test } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Hands-on test 2026-11-16: (11) the Google line under search results read "Nothing on Google either. Try fewer
// words." even with local results, sat at the foot of the window when nothing matched, and the scope label named the
// person instead of the account; (12) New event let you fill the form and only then said "Turn on editing" in a
// toast with a success check. Demo data only; nothing is sent.
const EMPTY = STATES.find(s => s.id === 'search-google-none-empty')!;
const LOCAL = STATES.find(s => s.id === 'search-google-none-local')!;
const EDITOR = STATES.find(s => s.id === 'editor-new-turn-on-editing')!;

test('no local results: the Google line is the empty state’s detail, directly under its sentence', async ({
  page,
}) => {
  await openState(page, EMPTY);
  const empty = page.locator('.search-screen__column > .ui-empty-line');
  await expect(empty).toContainText('No mail matches');
  const detail = empty.locator('.ui-empty-line__detail');
  await expect(detail).toHaveText('Nothing on Google either. Try fewer words.');
  const sentence = await empty.locator('.ui-empty-line__copy > :first-child').boundingBox();
  const under = await detail.boundingBox();
  expect(under!.y - (sentence!.y + sentence!.height)).toBeLessThan(48);
  await expect(page.locator('.search-screen__remote')).toHaveCount(0);
});

test('local results: Google’s line reads "No more results on Google"', async ({ page }) => {
  await openState(page, LOCAL);
  await expect(page.locator('.search-screen__remote')).toHaveText('No more results on Google');
  await expect(page.locator('body')).not.toContainText('Nothing on Google either');
});

test('a read-only calendar says so before the form is filled, and Save waits', async ({ page }) => {
  await openState(page, EDITOR);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.cal-editing')).toContainText(
    'Turn on editing to change events on this calendar.',
  );
  await expect(dialog.getByRole('button', { name: /^Save/ })).toBeDisabled();
});
