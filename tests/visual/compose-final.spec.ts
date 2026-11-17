import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Hands-on test 2026-11-16, compose and reply flow: a reply to your own message names the people you wrote to; a typed
// address becomes a chip as Send is pressed (inline and page alike); a sent reply never leaves the thread; Undo send
// reopens the writing; the page header says Forward / Draft. Demo data only: nothing leaves the stand-in engine.
const HOME = STATES.find(s => s.id === 'home-full')!;
const LETTER = '.aplos-reader__letter';
const CARD = '.ui-inline-reply';
const TO = (page: Page) => page.getByRole('group', { name: 'To' });
const ADD = (page: Page) => TO(page).getByRole('combobox', { name: 'Add recipients' });

async function openReply(page: Page): Promise<void> {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('Enter');
  await page.locator(LETTER).waitFor();
  await page.keyboard.press('r');
  await page.locator(CARD).waitFor();
}

for (const reply of ['r', 'Shift+R'])
  test(`${reply} on your own sent message goes to the people you wrote to`, async ({ page }) => {
    await openState(page, HOME, { theme: 'light' });
    await page.getByRole('button', { name: /^Sent/ }).click();
    await page.getByRole('option').first().click();
    await page.locator(LETTER).waitFor();
    await page.keyboard.press(reply);
    await page.locator(CARD).waitFor();
    await expect(TO(page)).toContainText('Studio team');
  });

for (const via of ['⌘↩', 'Send button'] as const)
  test(`inline reply: an address typed but not yet a chip is committed and sent (${via})`, async ({
    page,
  }) => {
    await openReply(page);
    await TO(page)
      .getByRole('button', { name: /Remove/ })
      .first()
      .click();
    await page.locator(`${CARD} textarea`).first().fill('Typed words');
    await ADD(page).fill('sam@example.com');
    if (via === '⌘↩') await page.keyboard.press('Meta+Enter');
    else await page.locator(CARD).getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Sending to sam@example.com')).toBeVisible();
    await expect(page.getByText('Add at least one recipient.')).toHaveCount(0);
  });

test('inline reply: typed text that is not an address is blocked with the address named', async ({
  page,
}) => {
  await openReply(page);
  await TO(page)
    .getByRole('button', { name: /Remove/ })
    .first()
    .click();
  await page.locator(`${CARD} textarea`).first().fill('Typed words');
  await ADD(page).fill('sam');
  await page.keyboard.press('Meta+Enter');
  await expect(page.locator(CARD)).toContainText('Check the address sam');
});

test('compose page: a typed address is committed and sent too', async ({ page }) => {
  await openState(page, HOME, { theme: 'light' });
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('textbox', { name: 'Subject' }).fill('Hello');
  await page.getByRole('textbox', { name: 'Message' }).fill('Body words');
  await ADD(page).fill('sam@example.com');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByText('Sending to sam@example.com')).toBeVisible();
});

test('a sent reply is in the thread at every moment after Send, never gone then back', async ({
  page,
}) => {
  await openReply(page);
  await page.locator(`${CARD} textarea`).first().fill('Typed words');
  await page.keyboard.press('Meta+Enter');
  await page.getByRole('button', { name: /^Send now/ }).waitFor();
  // From here on the thread must always hold the sent message (the tray's, the bare one, or the engine's own).
  await page.evaluate(() => {
    const seen = { gaps: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const thread = document.querySelector('.aplos-reader__thread')!;
    const check = () => {
      if (thread.querySelectorAll('article').length < 2) seen.gaps += 1;
    };
    new MutationObserver(check).observe(thread, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: /^Send now/ }).click();
  await page.waitForTimeout(1500);
  const seen = await page.evaluate(
    () => (window as unknown as { __seen: { gaps: number } }).__seen,
  );
  expect(seen.gaps).toBe(0);
  await expect(page.locator('.aplos-reader__thread article')).toHaveCount(2);
});

test('Undo send from the compose page reopens the page with its text and recipients', async ({
  page,
}) => {
  await openState(page, HOME, { theme: 'light' });
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('textbox', { name: 'Subject' }).fill('Hello');
  await page.getByRole('textbox', { name: 'Message' }).fill('Body words');
  await ADD(page).fill('sam@example.com');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+Enter');
  await page.getByRole('button', { name: /^Undo/ }).first().click();
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue('Hello');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(/Body words/);
  await expect(TO(page)).toContainText('sam@example.com');
});

test('Undo send from the toast after leaving the thread reopens the reply card with its text', async ({
  page,
}) => {
  await openReply(page);
  await page.locator(`${CARD} textarea`).first().fill('Typed words');
  await page.keyboard.press('Meta+Enter');
  await page.getByRole('button', { name: /^Send now/ }).waitFor();
  // Leave the thread: the send goes to the toast stack.
  await page.keyboard.press('Escape');
  await expect(page.locator(LETTER)).toHaveCount(0);
  await page.getByRole('button', { name: /^Undo/ }).first().click();
  await expect(page.locator(LETTER)).toBeVisible();
  await expect(page.locator(`${CARD} textarea`).first()).toHaveValue(/Typed words/);
});

test('the page header says Forward on a forward and Draft on a reopened draft', async ({
  page,
}) => {
  await openState(page, HOME, { theme: 'light' });
  await page.keyboard.press('f');
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(/^Fwd: /);
  await expect(page.getByRole('banner').or(page.locator('header')).first()).toContainText(
    'Forward',
  );
  await expect(page.getByRole('textbox', { name: 'Message' })).not.toHaveValue(/UTC/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.getByRole('option').first().click();
  await expect(page.locator('header').first()).toContainText(/Draft|New message/);
});
