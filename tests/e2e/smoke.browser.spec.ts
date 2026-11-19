import { expect, test } from '@playwright/test';
import { trackRequests } from './support/network';

// Browser preview smoke: the shell renders from the built-in demo data (no account, no keys),
// and nothing leaves 127.0.0.1 / localhost.
test('browser preview renders the app shell and stays on loopback', async ({ page }) => {
  const requests = await trackRequests(page);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));

  await page.goto('/');

  await expect(page).toHaveTitle('Aplos Mail');
  const places = page.getByRole('navigation', { name: 'Places' });
  await expect(places).toBeVisible();
  for (const name of ['Search', 'Home', 'Later', 'Calendar']) {
    await expect(places.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  const mail = page.getByRole('navigation', { name: 'Mail' });
  await expect(mail).toBeVisible();
  for (const name of ['All mail', 'Done', 'Drafts', 'Sent']) {
    await expect(mail.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'New message' })).toBeVisible();

  // Let late fetches (state load, event stream) happen before judging the network.
  await page.waitForLoadState('networkidle');

  const origins = [...new Set(requests.urls.map(url => new URL(url).origin))];
  test.info().annotations.push({ type: 'origins', description: origins.join(' ') });
  expect(requests.urls.length).toBeGreaterThan(0);
  expect(requests.external(), 'requests that left 127.0.0.1 / localhost').toEqual([]);
  expect(requests.blocked(), 'outside hosts the page tried to reach (blocked by CSP)').toEqual([]);
  expect(failures, 'uncaught page errors').toEqual([]);
});
