import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Only the release define decides: app.isPackaged follows the executable name, so a renamed local binary would
// look packaged. DevTools must be off in release windows and absent from the View menu.
const source = (name: string) =>
  readFile(new URL(`../../src/main/${name}`, import.meta.url), 'utf8');

test('release windows turn DevTools off by the release define', async () => {
  const windows = await source('windows.ts');
  assert.match(windows, /devTools: !releaseBuild/);
});

test('the Toggle Developer Tools menu item is gated on the release define, not app.isPackaged', async () => {
  const menu = await source('menu-bar.ts');
  assert.match(menu, /!releaseBuild \? \[\{ role: 'toggleDevTools'/);
  assert.doesNotMatch(menu, /isPackaged/);
});
