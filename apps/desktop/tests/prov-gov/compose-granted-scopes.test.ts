import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorePort } from '@aplos/engine/ports';
import { grantedScopesOf } from '../../src/host/compose';

// `grantedScopesOf` feeds a reconnect's held-scopes answer: every shape the column can take must either read back
// its string list or fail toward `undefined` (which re-asks required scopes only — never a wider grant).

/** A store whose `read` hands the callback a canned `accounts` row. */
const storeWith = (row: { granted_scopes: string | null } | undefined): StorePort =>
  ({ read: run => run({ get: () => row }) }) as unknown as StorePort;

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
