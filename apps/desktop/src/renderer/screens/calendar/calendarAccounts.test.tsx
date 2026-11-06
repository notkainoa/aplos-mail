// The accounts block under the Calendars legend, as markup: every state, the exact copy, the action's
// presence and wiring (grant vs reconnect), the legend never blank, no trailing period, at most one live region.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account } from '../../data';
import { CalendarAccounts, type CalendarAccountsModel } from './CalendarAccounts';
import { accountLinesOf, calendarSidebar } from './sidebar';
import { account } from './accountCalendarState.test';

const noop = () => {};
const render = (
  model: CalendarAccountsModel,
  onAction: (accountId: string, mode: 'reconnect' | 'grant') => void = noop,
) => renderToStaticMarkup(<CalendarAccounts model={model} onAction={onAction} />);

const CAL = {
  id: 'cal-1',
  accountId: 'acct-1',
  name: 'Work',
  primary: true,
  readOnly: false,
  shown: true,
  providerHidden: false,
};

const google = (over: Partial<Account> = {}) => account({ ...over });
const missing = google({
  id: 'acct-2',
  address: 'jordan.lee@example.com',
  name: 'Jordan Lee',
  missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
});
const reauth = google({
  id: 'acct-3',
  address: 'sam.kim@example.com',
  name: 'Sam Kim',
  health: { status: { state: 'needsReauth', reason: 'invalid_grant' } },
});

describe('the accounts block under the Calendars list', () => {
  test('on: every account shows its name and “Calendar on · N calendars”', () => {
    const html = render(accountLinesOf([google()], true, [CAL, { ...CAL, id: 'cal-2' }]));
    assert.match(html, /Alex Moreno/);
    assert.match(html, /Calendar on · 2 calendars/);
    assert.match(html, /cal-account__dot/);
    assert.doesNotMatch(html, /Allow calendar access/);
  });

  test('not allowed: the one-line Allow calendar access calls onAction with grant', () => {
    let called: [string, string] | null = null;
    const html = render(accountLinesOf([missing], true, []), (id, mode) => (called = [id, mode]));
    assert.match(html, /Calendar not allowed yet/);
    assert.match(html, /Allow calendar access/);
    const model = accountLinesOf([missing], true, []);
    renderToStaticMarkup(
      <CalendarAccounts model={model} onAction={(id, mode) => (called = [id, mode])} />,
    );
    assert.equal(called, null, 'nothing runs until the button is pressed');
  });

  test('needs sign-in: the Sign in again action is reconnect', () => {
    const model = accountLinesOf([reauth], true, []);
    assert.equal(model.lines[0]?.state?.kind, 'needs-signin');
    assert.equal(model.lines[0]?.state?.action?.mode, 'reconnect');
    const html = render(model);
    assert.match(html, /Needs sign-in again/);
    assert.match(html, /Sign in again/);
  });

  test('syncing: a granted account with the list unanswered reads Syncing…', () => {
    const html = render(accountLinesOf([google()], true, undefined));
    assert.match(html, /Syncing…/);
    assert.doesNotMatch(html, /No calendars/);
  });

  test('none: granted, the list answered empty after first sync reads No calendars', () => {
    const html = render(accountLinesOf([google()], true, []));
    assert.match(html, /No calendars/);
  });

  test('no accounts: the block says so, never blank', () => {
    const html = render(accountLinesOf([], true, []));
    assert.match(html, /No accounts yet/);
    assert.match(html, /Accounts/);
  });

  test('accounts not loaded yet: Syncing…, not “no accounts”', () => {
    const html = render(accountLinesOf([], false, undefined));
    assert.match(html, /Syncing…/);
    assert.doesNotMatch(html, /No accounts yet/);
  });

  test('demo and non-Google accounts show the name with no claim', () => {
    const html = render(
      accountLinesOf(
        [google({ id: 'demo', demo: true, provider: 'demo', name: 'Demo mail' })],
        true,
        [],
      ),
    );
    assert.match(html, /Demo mail/);
    assert.doesNotMatch(html, /Calendar on/);
    assert.doesNotMatch(html, /not allowed/);
  });

  test('no trailing periods on the quiet states, at most one live region', () => {
    for (const model of [
      accountLinesOf([], true, []),
      accountLinesOf([google()], true, []),
      accountLinesOf([google()], true, undefined),
      accountLinesOf([missing], true, []),
      accountLinesOf([reauth], true, []),
    ]) {
      const html = render(model);
      assert.doesNotMatch(html, /No accounts yet\./, 'no period on the empty state');
      assert.doesNotMatch(html, /No calendars\./, 'no period on the empty state');
      assert.doesNotMatch(html, /Syncing…\./, 'no period after the ellipsis');
      const live = (html.match(/aria-live|role="status"/g) ?? []).length;
      assert.ok(live <= 1, `at most one live region, got ${live}`);
    }
  });
});

describe('the muted line under the Calendars head (emptyNote)', () => {
  const sidebarFor = (
    accounts: Account[],
    opts: { accountsLoaded?: boolean; calendars?: import('../../data').Calendar[] | undefined },
  ) => {
    return calendarSidebar({
      state: { view: 'week', anchor: '2026-10-29', solo: null } as never,
      calendars: opts.calendars ?? [],
      entries: [],
      today: '2026-10-29',
      weekStartsOn: 0,
      dispatch: () => {},
      accounts,
      accountsLoaded: opts.accountsLoaded ?? true,
      calendarsLoaded: opts.calendars !== undefined,
      onAccessAction: () => {},
    }).calendars.emptyNote;
  };

  test('non-empty legend draws no line', () => {
    assert.equal(sidebarFor([google()], { calendars: [CAL] }), undefined);
  });
  test('no accounts says so', () => {
    assert.equal(sidebarFor([], { calendars: [] }), 'No accounts yet');
  });
  test('unanswered reads Syncing…', () => {
    assert.equal(sidebarFor([google()], { calendars: undefined }), 'Syncing…');
    assert.equal(sidebarFor([google()], { accountsLoaded: false, calendars: [] }), 'Syncing…');
  });
  test('a syncing account reads Syncing…', () => {
    const a = google({ id: 'a2', health: { status: { state: 'syncing' } } });
    assert.equal(sidebarFor([a], { calendars: [] }), 'Syncing…');
  });
  test('needs sign-in names the fix', () => {
    assert.equal(sidebarFor([reauth], { calendars: [] }), 'Sign in again to see calendars');
  });
  test('not allowed waits for access', () => {
    assert.equal(sidebarFor([missing], { calendars: [] }), 'Waiting for calendar access');
  });
  test('granted and answered empty reads No calendars yet', () => {
    assert.equal(sidebarFor([google()], { calendars: [] }), 'No calendars yet');
  });
});
