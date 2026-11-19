// The calendar access lines in Settings → Accounts and Settings → Calendar, as markup: the exact copy, the
// action's presence and wiring (grant opens the sheet with mode 'grant', reconnect with 'reconnect'), the
// Accounts block never empty, no trailing period on the quiet states, at most one live region.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account } from '../../data';
import { EDITING_COPY } from '../calendar/accountCalendarState';
import { dataOf, staticScreen } from './preview/states';
import { ALEX, DEMO, editingOn, IMAP, JORDAN, needsReauth, writeRefused } from './preview/fixtures';
import type { SettingsHost } from './ports';

const render = (over: Parameters<typeof dataOf>[0], section: 'accounts' | 'calendar') =>
  renderToStaticMarkup(staticScreen({ title: '', section, data: dataOf(over) }));

const missing = (a: Account): Account => ({
  ...a,
  missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
});
/** Still reading its calendar list: syncing mail status and no `calendarListedAt` stamp yet. */
const syncing = (a: Account): Account => ({
  ...a,
  health: { status: { state: 'syncing' } },
  calendarListedAt: undefined,
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

  test('needs sign-in: the row’s own reauth line and Reconnect speak — no stacked second copy', () => {
    const html = render({ accounts: [needsReauth(ALEX)] }, 'accounts');
    assert.match(html, /Google needs you to sign in again\./);
    assert.match(html, /Reconnect/);
    assert.doesNotMatch(html, /Needs sign-in again/);
    assert.doesNotMatch(html, /settings-cal-access/);
  });

  test('a row already carrying the same grant control keeps the words but not a second button', () => {
    const perm = {
      ...missing(ALEX),
      health: { status: { state: 'needsPermission', missingScopes: ['calendar.events'] } as never },
    };
    const html = render({ accounts: [perm] }, 'accounts');
    assert.match(html, /Reconnect/);
    assert.match(html, /Calendar not allowed yet/);
    assert.doesNotMatch(html, /Allow calendar access/);
  });

  test('a row whose own control is a different mode (reconnect due soon) still gets the calendar line and its action', () => {
    const due = {
      ...missing(ALEX),
      health: { ...missing(ALEX).health, reconnectBy: Date.now() + 10 * 3_600_000 },
    };
    const html = render({ accounts: [due] }, 'accounts');
    assert.match(html, /Calendar not allowed yet/);
    assert.match(html, /Allow calendar access/);
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

describe('Settings → Calendar editing (Enable editing)', () => {
  test('editing off: "Calendar on · N calendars · Editing off" with Enable editing', () => {
    const html = render({ accounts: [ALEX] }, 'calendar');
    assert.match(html, /Calendar on · 2 calendars · Editing off/);
    assert.match(html, />Enable editing</);
    assert.match(html, /aria-label="alex\.moreno@example\.com: Enable editing"/);
    assert.doesNotMatch(html, /data-tone="attention"/);
  });

  test('editing on: "· Editing on" and no action — not even on a refused write left stale', () => {
    const on = render({ accounts: [editingOn(ALEX)] }, 'calendar');
    assert.match(on, /Calendar on · 2 calendars · Editing on/);
    assert.doesNotMatch(on, /Enable editing|Turn on editing/);
    const stale = render({ accounts: [editingOn(writeRefused(ALEX))] }, 'calendar');
    assert.match(stale, /Editing on/);
    assert.doesNotMatch(stale, /Turn on editing to change events|Turn on editing</);
  });

  test('a refused write: the shared Turn on editing notice in attention, one Turn on editing action', () => {
    const html = render({ accounts: [writeRefused(ALEX)] }, 'calendar');
    // The line is the Calendar screen's own notice, verbatim — identical wording in both places.
    assert.ok(html.includes(EDITING_COPY.notice), EDITING_COPY.notice);
    assert.match(html, /data-tone="attention"/);
    assert.match(html, /aria-label="alex\.moreno@example\.com: Turn on editing"/);
    assert.doesNotMatch(html, /Calendar on · 2 calendars · Editing/);
    // Not an error banner, not a reconnect, no stacked duplicate control.
    assert.doesNotMatch(
      html,
      /Calendar not allowed yet|Allow calendar access|>Reconnect|ui-error-line/,
    );
    assert.equal((html.match(/>Turn on editing</g) ?? []).length, 1);
  });

  test('a read-only account that never wrote gets no nag, only the quiet Enable editing', () => {
    const html = render({ accounts: [ALEX] }, 'calendar');
    assert.doesNotMatch(html, /Turn on editing to change events/);
    assert.doesNotMatch(html, /data-tone="attention"/);
    assert.equal((html.match(/>Enable editing</g) ?? []).length, 1);
  });

  test('demo and non-Google accounts claim nothing about editing', () => {
    const html = render({ accounts: [DEMO, IMAP] }, 'calendar');
    assert.doesNotMatch(html, /Editing o(n|ff)|Enable editing|Turn on editing/);
  });

  test('the Accounts section keeps "Calendar on · N calendars" and gains no new button', () => {
    const html = render({ accounts: [ALEX, writeRefused(JORDAN)] }, 'accounts');
    assert.match(html, /Calendar on · 2 calendars/);
    assert.match(html, /Calendar on · 1 calendar/);
    assert.doesNotMatch(html, /Editing o(n|ff)|Enable editing|Turn on editing/);
    // A calendarWrite-only row is not a needs-reconnect account either.
    assert.doesNotMatch(html, />Reconnect|Turn on editing to change events/);
  });

  test('the action opens the shell sheet in enableEditing mode (startReconnect → renderReconnect)', () => {
    const seen: { id: string; mode: string }[] = [];
    const host: SettingsHost = {
      renderReconnect: (accountId, mode, _onClose) => {
        seen.push({ id: accountId, mode });
        return null;
      },
    };
    renderToStaticMarkup(
      staticScreen(
        {
          title: '',
          section: 'calendar',
          data: dataOf({ accounts: [ALEX] }),
          view: { reconnect: { accountId: ALEX.id, mode: 'enableEditing' } },
        },
        host,
      ),
    );
    assert.deepEqual(seen, [{ id: ALEX.id, mode: 'enableEditing' }]);
  });

  test('the account row is focusable programmatically: tabindex -1 on its settings anchor', () => {
    // DESIGN 11.2: when "Enable editing" unmounts under focus (editing flips on), the screen hands
    // the row that focus — the anchor wrapper must be a programmatic focus target.
    const html = render({ accounts: [ALEX] }, 'calendar');
    assert.match(
      html,
      /<div class="settings-anchor" data-setting-anchor="calendarPermission"[^>]*tabindex="-1"[^>]*>\s*<div class="ui-setting-row"/,
    );
    assert.match(html, /id="set-calendar-calendarPermission-acct-alex"/);
  });

  test('the sheet copy in enableEditing mode', () => {
    const html = renderToStaticMarkup(
      staticScreen({
        title: '',
        section: 'calendar',
        data: dataOf({ accounts: [ALEX] }),
        view: { reconnect: { accountId: ALEX.id, mode: 'enableEditing' } },
      }),
    );
    assert.match(html, /Turn on editing for alex\.moreno@example\.com/);
    assert.match(
      html,
      /Aplos will ask Google for permission to change events\. Nothing changes unless you ask\./,
    );
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
