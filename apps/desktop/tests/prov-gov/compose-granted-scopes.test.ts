import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorePort } from '@aplos/engine/ports';
import { grantedScopesOf } from '../../src/host/compose';

// `grantedScopesOf` feeds a reconnect's held-scopes answer: every shape the column can take must either read back
// its string list or fail toward `undefined` (which re-asks required scopes only — never a wider grant).

/** A store whose `read` hands the callback a canned `accounts` row. */
const storeWith = (row: { granted_scopes: string | null } | undefined): StorePort =>
  ({
    read: (run: (q: { get: () => unknown }) => unknown) => run({ get: () => row }),
  }) as unknown as StorePort;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
];

test('a stored scope list reads back as held', () => {
  const store = storeWith({ granted_scopes: JSON.stringify(SCOPES) });
  assert.deepEqual(grantedScopesOf(store, 'acct-1'), SCOPES);
});

test('no row, or a NULL column, is an unknown grant', () => {
  assert.equal(grantedScopesOf(storeWith(undefined), 'acct-1'), undefined);
  assert.equal(grantedScopesOf(storeWith({ granted_scopes: null }), 'acct-1'), undefined);
  assert.equal(grantedScopesOf(storeWith({ granted_scopes: '' }), 'acct-1'), undefined);
});

test('malformed or wrong-shaped JSON is an unknown grant, not a crash', () => {
  assert.equal(grantedScopesOf(storeWith({ granted_scopes: '{bad' }), 'acct-1'), undefined);
  assert.equal(grantedScopesOf(storeWith({ granted_scopes: '{"a":1}' }), 'acct-1'), undefined);
  assert.equal(grantedScopesOf(storeWith({ granted_scopes: '42' }), 'acct-1'), undefined);
});

test('non-string members are filtered out, not fatal', () => {
  const store = storeWith({ granted_scopes: JSON.stringify([SCOPES[0], 7, null, SCOPES[1]]) });
  assert.deepEqual(grantedScopesOf(store, 'acct-1'), SCOPES);
});

import { GOOGLE_CALENDAR_SCOPES } from '@aplos/engine/sync/actor';
import { connectOptionalScopes } from '../../src/host/compose';
import { scopesForFeatures } from '../../src/host/providers/oauth/scopes';

const CAL_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const CAL_EVENTS_RO = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CAL_EVENTS_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const GMAIL_SETTINGS = 'https://www.googleapis.com/auth/gmail.settings.basic';

test('the composition asks the calendar read pair on a new sign-in, the mode default otherwise', () => {
  // Pin the whole answer, not just membership: nothing beyond the two read-only scopes is ever asked.
  assert.deepEqual(connectOptionalScopes({ mode: 'new' }), [CAL_LIST, CAL_EVENTS_RO]);
  assert.equal(connectOptionalScopes({ mode: 'reconnect' }), undefined);
  assert.equal(connectOptionalScopes({ mode: 'grantPermissions' }), undefined);
  const asked = connectOptionalScopes({ mode: 'new' })!;
  assert.ok(!asked.includes(CAL_EVENTS_WRITE));
  assert.ok(!asked.includes(GMAIL_SETTINGS));
});

test("the engine's calendar scope copy matches the manifest's calendar features", () => {
  // actor.ts keeps its own URL list for the missingPermissions gap; a manifest drift must not go unnoticed.
  assert.deepEqual(
    [...GOOGLE_CALENDAR_SCOPES].sort(),
    [...scopesForFeatures('calendarList', 'calendarEvents')].sort(),
  );
});
