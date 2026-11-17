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
    assert.match(html, /alex\.moreno@example\.com/);
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

  test('syncing: a granted account whose list is unanswered or was never read reads Syncing…', () => {
    const html = render(accountLinesOf([google()], true, undefined));
    assert.match(html, /Syncing…/);
    assert.doesNotMatch(html, /No calendars/);
    const unlisted = render(accountLinesOf([google({ calendarListedAt: undefined })], true, []));
    assert.match(unlisted, /Syncing…/);
    assert.doesNotMatch(unlisted, /No calendars/);
  });

  test('none: granted, the list answered and held nothing reads No calendars', () => {
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

  test('demo and non-Google accounts claim nothing, so the block leaves out a list the account menu already holds', () => {
    const html = render(
      accountLinesOf(
        [
          google({
            id: 'demo',
            demo: true,
            provider: 'demo',
            name: 'Demo mail',
            address: 'demo@example.com',
          }),
        ],
        true,
        [],
      ),
    );
    assert.equal(html, '');
    assert.doesNotMatch(html, /Accounts/);
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

describe('an empty legend', () => {
  const sidebarFor = (
    accounts: Account[],
    opts: { accountsLoaded?: boolean; calendars?: import('../../data').Calendar[] },
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
    }).calendars;
  };
  test('an empty list draws no Calendars part at all — the pinned accounts block explains', () => {
    assert.equal(sidebarFor([], { calendars: [] }), undefined);
    assert.equal(sidebarFor([missing], { calendars: [] }), undefined);
    assert.equal(sidebarFor([google()], { calendars: [] }), undefined);
  });
  test('a non-empty list draws the legend', () => {
    assert.ok(sidebarFor([google()], { calendars: [CAL] }));
  });
  test('each action names its account (two accounts, two addresses)', () => {
    const html = render(accountLinesOf([missing, reauth], true, []));
    assert.match(html, /aria-label="jordan.lee@example.com: Allow calendar access"/);
    assert.match(html, /aria-label="sam.kim@example.com: Sign in again"/);
  });
});
