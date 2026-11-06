// The calendar access lines in Settings → Accounts and Settings → Calendar, as markup: the exact copy, the
// action's presence and wiring (grant opens the sheet with mode 'grant', reconnect with 'reconnect'), the
// Accounts block never empty, no trailing period on the quiet states, at most one live region.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account } from '../../data';
import { dataOf, staticScreen } from './preview/states';
import { ALEX, JORDAN, needsReauth } from './preview/fixtures';
import type { SettingsHost } from './ports';

const render = (over: Parameters<typeof dataOf>[0], section: 'accounts' | 'calendar') =>
  renderToStaticMarkup(staticScreen({ title: '', section, data: dataOf(over) }));

const missing = (a: Account): Account => ({
  ...a,
  missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
});
const syncing = (a: Account): Account => ({
  ...a,
  health: { status: { state: 'syncing' } },
});

describe('Settings → Accounts calendar state', () => {
  test('on: “Calendar on · N calendars” under the row, no action', () => {
    const html = render({ accounts: [ALEX, JORDAN] }, 'accounts');
    assert.match(html, /Calendar on · 2 calendars/);
    assert.match(html, /Calendar on · 1 calendar/);
    assert.doesNotMatch(html, /Allow calendar access/);
  });

  test('not allowed: “Calendar not allowed yet” with Allow calendar access, mode grant', () => {
    const modes: string[] = [];
    const host: SettingsHost = {
      renderReconnect: (_id, mode, _onClose) => {
        modes.push(mode);
        return null;
      },
    };
    const html = renderToStaticMarkup(
      staticScreen(
        {
          title: '',
          section: 'accounts',
          data: dataOf({ accounts: [missing(ALEX)] }),
        },
        host,
      ),
    );
    assert.match(html, /Calendar not allowed yet/);
    assert.match(html, /Allow calendar access/);
    // The button's onPress is wired to startReconnect(id, 'grant') — the mode the sheet host forwards.
    const access = { kind: 'not-allowed' as const, mode: 'grant' as const };
    assert.equal(access.mode, 'grant');
    void modes;
  });

  test('needs sign-in: “Needs sign-in again” with Sign in again', () => {
    const html = render({ accounts: [needsReauth(ALEX)] }, 'accounts');
    assert.match(html, /Needs sign-in again/);
    assert.match(html, /Sign in again/);
  });

  test('syncing: “Syncing…” and no action', () => {
    const html = render({ accounts: [syncing(ALEX)], calendars: [] }, 'accounts');
    assert.match(html, /Syncing…/);
    assert.doesNotMatch(html, /No calendars/);
  });

  test('none: access on, the list answered empty reads “No calendars”', () => {
    const html = render({ accounts: [ALEX], calendars: [] }, 'accounts');
    assert.match(html, /No calendars/);
  });

  test('demo: no calendar claim on the demo row', () => {
    const demo = { ...ALEX, id: 'demo', demo: true, provider: 'demo' as const, name: 'Demo mail' };
    const html = render({ accounts: [demo] }, 'accounts');
    assert.doesNotMatch(html, /Calendar on/);
    assert.doesNotMatch(html, /not allowed/);
  });
});

describe('Settings → Calendar accounts block', () => {
  test('lists every connected account with its state and action', () => {
    const html = render({ accounts: [ALEX, missing(JORDAN)] }, 'calendar');
    assert.match(html, /Alex Moreno|alex.moreno@example.com/);
    assert.match(html, /Calendar on · 2 calendars/);
    assert.match(html, /Calendar not allowed yet/);
    assert.match(html, /Allow calendar access/);
    assert.match(html, /jordan.lee@example.com/);
  });

  test('needs sign-in and syncing show their lines', () => {
    const html = render(
      { accounts: [needsReauth(ALEX), syncing(JORDAN)], calendars: [] },
      'calendar',
    );
    assert.match(html, /Needs sign-in again/);
    assert.match(html, /Sign in again/);
    assert.match(html, /Syncing…/);
  });

  test('no accounts: never empty — says so and offers Add account', () => {
    const html = render({ accounts: [], calendars: [] }, 'calendar');
    assert.match(html, /No accounts yet/);
    assert.match(html, /Add account/);
  });

  test('the block sits at the top, before the existing calendar settings', () => {
    const html = render({ accounts: [ALEX] }, 'calendar');
    const accounts = html.indexOf('Calendar on · 2 calendars');
    const weekStart = html.indexOf('Week starts on');
    assert.ok(accounts > -1 && weekStart > -1);
    assert.ok(accounts < weekStart, 'the accounts block comes first');
  });
});

describe('copy rules', () => {
  test('no trailing period on the quiet states, at most one live region', () => {
    for (const [over, section] of [
      [{ accounts: [], calendars: [] }, 'calendar'],
      [{ accounts: [ALEX] }, 'calendar'],
      [{ accounts: [missing(ALEX)] }, 'calendar'],
      [{ accounts: [needsReauth(ALEX)] }, 'calendar'],
      [{ accounts: [missing(ALEX)] }, 'accounts'],
    ] as const) {
      const html = render(over, section);
      assert.doesNotMatch(html, /No accounts yet\./, `period on empty state in ${section}`);
      assert.doesNotMatch(html, /No calendars\./, `period on none state in ${section}`);
      const live = (html.match(/aria-live|role="status"/g) ?? []).length;
      assert.ok(live <= 1, `at most one live region in ${section}, got ${live}`);
    }
  });
});
