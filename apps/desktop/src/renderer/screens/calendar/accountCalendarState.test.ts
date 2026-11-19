// `calendarAccessOf`: every state and edge, on hand-written contract values (demo, non-Google, reauth +
// missing calendar, granted with 0 and 1 and N calendars, syncing vs none, non-calendar missingPermissions).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { HARNESS_NOW_MS, type Account, type Calendar } from '../../data';
import {
  CALENDAR_EVENTS_SCOPE,
  calendarAccessOf,
  calendarEditingOf,
  calendarListedKey,
  calendarOnLine,
  calendarWriteRefused,
} from './accountCalendarState';

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
    // Even once the account has listed before: the list the UI holds is what counts.
    assert.equal(calendarAccessOf(account({ calendarListedAt: NOW }), undefined)?.kind, 'syncing');
  });

  test('listed, the list answered empty: No calendars — even while mail still syncs', () => {
    for (const status of [
      { state: 'ok' },
      { state: 'starting' },
      { state: 'syncing' },
      { state: 'backfilling', done: 12 },
    ] as const) {
      const access = calendarAccessOf(account({ health: { status } }), []);
      assert.equal(access?.kind, 'none', status.state);
      assert.equal(access?.line, 'No calendars');
      assert.equal(access?.action, null);
    }
  });

  test('a stamp at epoch 0 still counts as listed', () => {
    // EpochMs 0 is falsy; the rule is presence (`!== undefined`), not truthiness.
    assert.equal(calendarAccessOf(account({ calendarListedAt: 0 }), [])?.kind, 'none');
  });

  test('never listed, the list answered empty: Syncing… — even with ok and baselineDoneAt', () => {
    // The old proxy read this exact case as "No calendars"; the fact says the list was never read.
    const done = account({ calendarListedAt: undefined });
    assert.equal(calendarAccessOf(done, [])?.kind, 'syncing');
    assert.equal(
      calendarAccessOf(account({ calendarListedAt: undefined, baselineDoneAt: undefined }), [])
        ?.kind,
      'syncing',
    );
    assert.equal(
      calendarAccessOf(
        account({ calendarListedAt: undefined, health: { status: { state: 'syncing' } } }),
        [],
      )?.kind,
      'syncing',
    );
  });

  test('calendars present read on with the count — even while mail syncs, even unlisted', () => {
    const syncing = calendarAccessOf(
      account({ health: { status: { state: 'syncing' } }, calendarListedAt: undefined }),
      [calendar('c1', 'acct-1')],
    );
    assert.equal(syncing?.kind, 'on');
    assert.equal(syncing?.line, 'Calendar on · 1 calendar');
    const backfilling = calendarAccessOf(
      account({ health: { status: { state: 'backfilling', done: 3 } } }),
      [calendar('c1', 'acct-1'), calendar('c2', 'acct-1')],
    );
    assert.equal(backfilling?.kind, 'on');
    assert.equal(backfilling?.line, 'Calendar on · 2 calendars');
  });

  test('halted accounts claim nothing: unknown kind, no line, no action — whatever the list says', () => {
    for (const state of ['paused', 'error', 'offline', 'needsAdmin', 'misconfigured'] as const) {
      for (const calendarListedAt of [NOW, undefined] as const) {
        const a = account({ health: { status: { state } as never }, calendarListedAt });
        const access = calendarAccessOf(a, []);
        assert.equal(access?.kind, 'unknown', `${state} listed=${calendarListedAt}`);
        assert.equal(access?.line, null);
        assert.equal(access?.action, null);
      }
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
    assert.doesNotThrow(() =>
      calendarAccessOf(account({ calendarListedAt: 'not-a-number' as never }), [
        { accountId: 'acct-1' } as never,
      ]),
    );
  });

  test('calendarOnLine: the exact words', () => {
    assert.equal(calendarOnLine(1), 'Calendar on · 1 calendar');
    assert.equal(calendarOnLine(4), 'Calendar on · 4 calendars');
  });
});

describe('calendarEditingOf', () => {
  test('the events scope in grantedScopes means on; a read-only grant means off', () => {
    assert.equal(calendarEditingOf(account({ grantedScopes: [CALENDAR_EVENTS_SCOPE] })), 'on');
    assert.equal(
      calendarEditingOf(
        account({
          grantedScopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
        }),
      ),
      'off',
      'the read scope alone is not editing',
    );
    assert.equal(calendarEditingOf(account()), 'off');
  });

  test('demo and non-Google accounts claim nothing (null)', () => {
    assert.equal(
      calendarEditingOf(
        account({ demo: true, provider: 'demo', grantedScopes: [CALENDAR_EVENTS_SCOPE] }),
      ),
      null,
    );
    assert.equal(
      calendarEditingOf(account({ provider: 'imap', grantedScopes: [CALENDAR_EVENTS_SCOPE] })),
      null,
    );
  });
});

describe('calendarWriteRefused', () => {
  test('a refused write leaves a calendarWrite row — and it is not the read gap', () => {
    const refused = account({
      missingPermissions: [{ capability: 'calendarWrite', reasonCode: 'permission.calendarWrite' }],
    });
    assert.equal(calendarWriteRefused(refused), true);
    // The calendar read stays "on": a calendarWrite-only row is never 'Calendar not allowed yet'.
    const access = calendarAccessOf(refused, [calendar('c', 'acct-1')]);
    assert.equal(access?.kind, 'on');
    assert.equal(access?.line, 'Calendar on · 1 calendar');
    assert.equal(access?.action, null);
    assert.equal(calendarAccessOf(refused, [])?.kind, 'none');
  });

  test('other rows still count as the read gap or nothing; the write row is never a standing nag', () => {
    assert.equal(calendarWriteRefused(account()), false);
    assert.equal(calendarWriteRefused(missingCalendar()), false);
    const both = account({
      missingPermissions: [
        { capability: 'calendar', reasonCode: 'permission.calendar' },
        { capability: 'calendarWrite', reasonCode: 'permission.calendarWrite' },
      ],
    });
    assert.equal(calendarWriteRefused(both), true);
    assert.equal(calendarAccessOf(both, [])?.kind, 'not-allowed', 'the read gap still wins');
  });
});

describe('calendarListedKey', () => {
  test('moves exactly when a stamp lands or moves, or a Google account joins or leaves', () => {
    const unlisted = account({ calendarListedAt: undefined });
    const listed = account({ calendarListedAt: NOW - 60_000 });
    assert.notEqual(calendarListedKey([unlisted]), calendarListedKey([listed]), 'a stamp landing');
    assert.notEqual(
      calendarListedKey([listed]),
      calendarListedKey([account({ calendarListedAt: NOW })]),
      'a stamp moving',
    );
    // Colour, name, health and mail-sync fields never move it — no refetch on flicker.
    const flicker = account({
      calendarListedAt: NOW - 60_000,
      colorTag: 'ember',
      name: 'A. Moreno',
      health: { status: { state: 'syncing' }, lastSyncAt: NOW },
      baselineDoneAt: undefined,
      pendingChanges: 3,
    });
    assert.equal(calendarListedKey([listed]), calendarListedKey([flicker]));
    // Joining or leaving moves it; order does not.
    const other = account({ id: 'acct-2', calendarListedAt: NOW });
    assert.notEqual(calendarListedKey([listed]), calendarListedKey([listed, other]), 'joining');
    assert.notEqual(calendarListedKey([other]), calendarListedKey([listed, other]), 'leaving');
    assert.equal(calendarListedKey([listed, other]), calendarListedKey([other, listed]));
    // Non-Google accounts carry no calendar claim, so they never move the key.
    const imap = account({ id: 'acct-imap', provider: 'imap' });
    assert.equal(calendarListedKey([listed]), calendarListedKey([listed, imap]));
  });

  test('both fetch effects re-read Calendar/get on the key (source shape)', () => {
    // The stamp arrives live through useAccounts while each list was fetched once; the deps carry the
    // key so a first list commit (rows plus stamp) refetches instead of reading "No calendars".
    const screen = readFileSync(new URL('./CalendarScreen.tsx', import.meta.url), 'utf8');
    assert.match(screen, /calendarListedKey\(accounts\)/);
    assert.match(screen, /useEffect\(get, \[get, listedKey\]\)/);
    const settings = readFileSync(
      new URL('../settings/SettingsContainer.tsx', import.meta.url),
      'utf8',
    );
    assert.match(settings, /calendarListedKey\(base\.accounts\)/);
    assert.match(settings, /\}, \[section, view\.queue, actions, keepData, listedKey\]\)/);
  });
});
