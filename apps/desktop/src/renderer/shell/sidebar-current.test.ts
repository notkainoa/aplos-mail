// Only the current place is marked in the sidebar: on Help, Help alone (not Settings too).
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/sidebar-current.test.ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentPlace } from './nav';
import { Sidebar } from './Sidebar';
import { setSettingsSection } from './store-route';

afterEach(() => setSettingsSection(null));

function currentRows(screen: Parameters<typeof Sidebar>[0]['screen']): string[] {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      screen,
      counts: {},
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
    }),
  );
  const rows = html.match(/<button[^>]*aria-current="page"[^>]*>.*?<\/button>/g) ?? [];
  return rows.map(row => row.replace(/<[^>]+>/g, '').trim());
}

test('currentPlace is Help only while Settings shows its Help section', () => {
  assert.equal(currentPlace('settings', null), 'settings');
  assert.equal(currentPlace('settings', 'general'), 'settings');
  assert.equal(currentPlace('settings', 'help'), 'help');
  assert.equal(currentPlace('home', 'help'), 'home');
});

test('on Settings the sidebar marks Settings alone', () => {
  assert.deepEqual(currentRows('settings'), ['Settings']);
});

test('on the Help section the sidebar marks Help alone', () => {
  setSettingsSection('help');
  assert.deepEqual(currentRows('settings'), ['Help']);
});

test('while the reader is open the place it came from stays the one marked', async () => {
  const { originPlace } = await import('./nav');
  const thread = { label: 'thread' } as const;
  assert.equal(originPlace(thread, 'later'), 'later');
  assert.equal(originPlace(thread, { label: 'one by one' }), 'home');
  assert.equal(originPlace(thread, { label: 'Search' }), 'search');
  assert.equal(originPlace(thread, null), null);
  assert.equal(originPlace('home', 'later'), null);
});
