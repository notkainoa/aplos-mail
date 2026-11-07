// `calendarAccessOf`: every state and edge, on hand-written contract values (demo, non-Google, reauth +
// missing calendar, granted with 0 and 1 and N calendars, syncing vs none, non-calendar missingPermissions).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HARNESS_NOW_MS, type Account, type Calendar } from '../../data';
import { calendarAccessOf, calendarOnLine } from './accountCalendarState';

const NOW = HARNESS_NOW_MS;

export function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acct-1',
    rev: 1,
    provider: 'google',
    address: 'alex.moreno@example.com',
    name: 'Alex Moreno',
    colorTag: 'sky',
    demo: false,
    health: { status: { state: 'ok' }, lastSyncAt: NOW - 120_000 },
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: true,
      filters: true,
      push: true,
      sendAs: true,
      unsubscribeHeaders: true,
    },
    grantedScopes: [],
    aiAllowed: true,
    notifications: true,
    identities: [],
    pendingChanges: 0,
    baselineDoneAt: NOW - 86_400_000,
    calendarListedAt: NOW - 86_400_000,
    createdAt: NOW - 30 * 86_400_000,
    ...over,
  };
}

function calendar(id: string, accountId: string): Calendar {
  return {
    id,
    accountId,
    name: id,
    primary: false,
    readOnly: false,
    shown: true,
    providerHidden: false,
  };
}

const missingCalendar = (): Account =>
  account({
    missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
  });

describe('calendarAccessOf', () => {
  test('demo and non-Google providers claim nothing', () => {
    assert.equal(calendarAccessOf(account({ demo: true }), undefined), null);
    assert.equal(
      calendarAccessOf(account({ provider: 'demo', demo: true }), [calendar('c', 'acct-1')]),
      null,
    );
    assert.equal(calendarAccessOf(account({ provider: 'imap' }), []), null);
    assert.equal(calendarAccessOf(account({ provider: 'microsoft' }), undefined), null);
  });

  test('needsReauth signs in again, ahead of any missing permission', () => {
    const a = account({
      health: { status: { state: 'needsReauth', reason: 'invalid_grant' } },
      missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
    });
    const access = calendarAccessOf(a, [calendar('c', 'acct-1')]);
    assert.equal(access?.kind, 'needs-signin');
    assert.equal(access?.line, 'Needs sign-in again');
    assert.deepEqual(access?.action, { label: 'Sign in again', mode: 'reconnect' });
  });

  test('a missing calendar permission is not-allowed with the grant action', () => {
    const access = calendarAccessOf(missingCalendar(), [calendar('c', 'acct-1')]);
    assert.equal(access?.kind, 'not-allowed');
    assert.equal(access?.line, 'Calendar not allowed yet');
    assert.deepEqual(access?.action, { label: 'Allow calendar access', mode: 'grant' });
  });

  test('calendar capability off is not-allowed too', () => {
    const a = account({
      capabilities: { ...account().capabilities, calendar: false },
    });
    assert.equal(calendarAccessOf(a, [])?.kind, 'not-allowed');
  });

  test('needsPermission naming a calendar scope is not-allowed', () => {
    const a = account({
      health: {
        status: {
          state: 'needsPermission',
          missingScopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
        },
      },
    });
    assert.equal(calendarAccessOf(a, [])?.kind, 'not-allowed');
  });

  test('needsPermission for mail scopes alone leaves the calendar state alone', () => {
    const a = account({
      health: {
        status: { state: 'needsPermission', missingScopes: ['mail.modify'] },
      },
    });
    const access = calendarAccessOf(a, [calendar('c', 'acct-1')]);
    assert.equal(access?.kind, 'unknown');
  });

  test('a missing permission for another capability is not a calendar gap', () => {
    const a = account({
      missingPermissions: [{ capability: 'filters', reasonCode: 'permission.filters' }],
    });
    const access = calendarAccessOf(a, [calendar('c', 'acct-1')]);
    assert.equal(access?.kind, 'on');
    assert.equal(access?.line, 'Calendar on · 1 calendar');
  });

  test('granted: 1 and N calendars read with the count, singular for one', () => {
    const one = calendarAccessOf(account(), [calendar('c1', 'acct-1')]);
    assert.equal(one?.kind, 'on');
    assert.equal(one?.line, 'Calendar on · 1 calendar');
    const many = calendarAccessOf(account(), [
      calendar('c1', 'acct-1'),
      calendar('c2', 'acct-1'),
      calendar('c3', 'acct-1'),
      calendar('other', 'acct-2'),
    ]);
    assert.equal(many?.kind, 'on');
    assert.equal(many?.line, 'Calendar on · 3 calendars');
  });

  test('granted, list not answered yet: Syncing…', () => {
    assert.equal(calendarAccessOf(account(), undefined)?.kind, 'syncing');
    assert.equal(calendarAccessOf(account(), undefined)?.line, 'Syncing…');
  });

  test('granted with none yet while the account still syncs: Syncing…', () => {
    assert.equal(
      calendarAccessOf(account({ health: { status: { state: 'syncing' } } }), [])?.kind,
      'syncing',
    );
    assert.equal(
      calendarAccessOf(account({ health: { status: { state: 'starting' } } }), [])?.kind,
      'syncing',
    );
    assert.equal(calendarAccessOf(account({ calendarListedAt: undefined }), [])?.kind, 'syncing');
  });

  test('granted, the list answered empty after first sync: No calendars', () => {
    const access = calendarAccessOf(account(), []);
    assert.equal(access?.kind, 'none');
    assert.equal(access?.line, 'No calendars');
    assert.equal(access?.action, null);
  });

  test('listed: no calendarListedAt and zero calendars, even ok, reads Syncing…', () => {
    const access = calendarAccessOf(account({ calendarListedAt: undefined }), []);
    assert.equal(access?.kind, 'syncing');
    assert.equal(access?.line, 'Syncing…');
  });

  test('listed: calendarListedAt set and zero calendars reads No calendars', () => {
    const access = calendarAccessOf(account({ calendarListedAt: NOW - 60_000 }), []);
    assert.equal(access?.kind, 'none');
    assert.equal(access?.line, 'No calendars');
    assert.equal(access?.action, null);
    // baselineDoneAt is out of this decision: a listed account without it still reads “No calendars”.
    assert.equal(calendarAccessOf(account({ baselineDoneAt: undefined }), [])?.kind, 'none');
  });

  test('listed: calendarListedAt set with calendars reads on with the count', () => {
    const access = calendarAccessOf(account({ calendarListedAt: NOW - 60_000 }), [
      calendar('c1', 'acct-1'),
      calendar('c2', 'acct-1'),
    ]);
    assert.equal(access?.kind, 'on');
    assert.equal(access?.line, 'Calendar on · 2 calendars');
  });

  test('listed: needsReauth, halted and needsPermission still win over the list state', () => {
    const listed = { calendarListedAt: NOW - 60_000 };
    assert.equal(
      calendarAccessOf(
        account({
          ...listed,
          health: { status: { state: 'needsReauth', reason: 'invalid_grant' } },
        }),
        [],
      )?.kind,
      'needs-signin',
    );
    assert.equal(
      calendarAccessOf(account({ ...listed, health: { status: { state: 'paused' } as never } }), [])
        ?.kind,
      'unknown',
    );
    assert.equal(
      calendarAccessOf(
        account({
          ...listed,
          health: { status: { state: 'needsPermission', missingScopes: ['calendar.events'] } },
        }),
        [],
      )?.kind,
      'not-allowed',
    );
  });

  test('listed: an old account without the field (baselineDoneAt set, ok, zero) reads Syncing…', () => {
    const old = account({ calendarListedAt: undefined });
    assert.ok(old.baselineDoneAt !== undefined);
    assert.equal(calendarAccessOf(old, [])?.kind, 'syncing');
  });

  test('halted accounts claim nothing: unknown kind, no line, no action', () => {
    for (const state of ['paused', 'error', 'offline', 'needsAdmin', 'misconfigured'] as const) {
      const a = account({ health: { status: { state } as never } });
      const access = calendarAccessOf(a, []);
      assert.equal(access?.kind, 'unknown', state);
      assert.equal(access?.line, null);
      assert.equal(access?.action, null);
    }
  });

  test('needsAdmin/misconfigured with a calendar gap is still unknown — the grant cannot succeed', () => {
    const a = missingCalendar();
    const admin = account({
      health: { status: { state: 'needsAdmin', reason: 'policy' } },
      missingPermissions: a.missingPermissions,
    });
    assert.equal(calendarAccessOf(admin, [])?.kind, 'unknown');
  });

  test('needsPermission without a calendar gap is unknown; with one it is not-allowed', () => {
    const mail = account({
      health: { status: { state: 'needsPermission', missingScopes: ['mail.modify'] } },
    });
    assert.equal(calendarAccessOf(mail, [])?.kind, 'unknown');
    const cal = account({
      health: { status: { state: 'needsPermission', missingScopes: ['calendar.events'] } },
    });
    assert.equal(calendarAccessOf(cal, [])?.kind, 'not-allowed');
  });

  test('malformed accounts never throw', () => {
    assert.doesNotThrow(() =>
      calendarAccessOf({ provider: 'google' } as unknown as Account, undefined),
    );
    assert.doesNotThrow(() =>
      calendarAccessOf(account({ health: { status: { state: 'needsPermission' } } as never }), []),
    );
  });

  test('calendarOnLine: the exact words', () => {
    assert.equal(calendarOnLine(1), 'Calendar on · 1 calendar');
    assert.equal(calendarOnLine(4), 'Calendar on · 4 calendars');
  });
});
