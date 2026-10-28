import { expect, test } from '@playwright/test';
import { trackRequests } from './support/network';

// Browser preview smoke: the shell renders from the built-in demo data (no account, no keys),
// and nothing leaves 127.0.0.1 / localhost.
test('browser preview renders the app shell and stays on loopback', async ({ page }) => {
  const requests = trackRequests(page);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));

  await page.goto('/');

  await expect(page).toHaveTitle('Aplos Mail');
  const mailboxes = page.getByRole('navigation', { name: 'Mailboxes' });
  await expect(mailboxes).toBeVisible();
  for (const name of ['Home', 'Later', 'All mail', 'Drafts', 'Sent']) {
    await expect(mailboxes.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();

  // Let late fetches (state load, event stream) happen before judging the network.
  await page.waitForLoadState('networkidle');

  const origins = [...new Set(requests.urls.map(url => new URL(url).origin))];
  test.info().annotations.push({ type: 'origins', description: origins.join(' ') });
  expect(requests.urls.length).toBeGreaterThan(0);
  expect(requests.external(), 'requests that left 127.0.0.1 / localhost').toEqual([]);
  expect(failures, 'uncaught page errors').toEqual([]);
});
