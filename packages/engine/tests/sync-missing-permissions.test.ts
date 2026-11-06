import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarAdapter } from '../src/ports';
import { ACCOUNT, FakeAdapter, connectResult, disk, settle, world } from './sync-actor-helpers';

// `Account.missingPermissions`'s producer (D12): an adapter with a calendar half whose grant lacks its scopes gets
// the feature-level row — never needsPermission, which is the core mail scope's alone. The Settings Calendar
// section's "Aplos needs permission to use your Google Calendar" row reads this.

/** A `calendar` slot that exists but is never driven (these tests exercise the producer, not the syncer). */
const calendarStub = (): CalendarAdapter => ({
  budget: 'gcal',
  plan: () => [],
  listCalendars: () => Promise.reject(new Error('unused')),
  syncStep: () => Promise.reject(new Error('unused')),
  put: () => Promise.reject(new Error('unused')),
  remove: () => Promise.reject(new Error('unused')),
  rsvp: () => Promise.reject(new Error('unused')),
});

const idle = (calendar?: CalendarAdapter): FakeAdapter => {
  const adapter = new FakeAdapter(() => [], {});
  if (calendar) (adapter as { calendar?: CalendarAdapter }).calendar = calendar;
  return adapter;
};

const capsWith = (calendar: boolean) => ({
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar,
  filters: false,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  threading: 'native' as const,
});

test('a calendar-capable adapter on a grant without calendar scopes records missingPermissions', async () => {
  const d = disk();
  try {
    const w = world(d, () => idle(calendarStub()));
    await w.host.start(ACCOUNT);
    await settle();
    const runtime = w.host.status(ACCOUNT)!;
    assert.deepEqual(runtime.missingPermissions, [
      {
        capability: 'calendar',
        reasonCode: 'permission.calendar',
        missingScopes: [],
      },
    ]);
    // The account itself is not halted: mail status is not needsPermission.
    assert.notEqual(runtime.status.state, 'needsPermission');
  } finally {
    await d.cleanup();
  }
});

test('no row without a calendar half, or when the grant already holds the scopes', async () => {
  const d = disk();
  try {
    // No calendar slot: a falsy calendar capability is the provider's own, not a missing grant.
    const without = world(d, () => idle());
    await without.host.start(ACCOUNT);
    await settle();
    assert.equal(without.host.status(ACCOUNT)!.missingPermissions, undefined);
    await without.kill();

    // capabilities.calendar true: nothing missing.
    const d2 = disk();
    const withCaps = world(d2, () => idle(calendarStub()));
    withCaps.store.commit({
      opId: 'caps',
      origin: 'system',
      writes: [{ kind: 'account', id: ACCOUNT, capabilities: capsWith(true) }],
    });
    await withCaps.host.start(ACCOUNT);
    await settle();
    assert.equal(withCaps.host.status(ACCOUNT)!.missingPermissions, undefined);
    await withCaps.kill();
  } finally {
    await d.cleanup();
  }
});

test('a reconnect that granted the scopes clears the row; one that did not keeps it', async () => {
  const d = disk();
  try {
    const w = world(d, () => idle(calendarStub()));
    await w.host.start(ACCOUNT);
    await settle();
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions?.length, 1);

    await w.host.reconnected(
      ACCOUNT,
      connectResult({
        grantedScopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.events',
        ],
        capabilities: capsWith(true),
      }),
    );
    const runtime = w.host.status(ACCOUNT)!;
    assert.equal(runtime.missingPermissions, undefined);
    assert.equal(runtime.capabilities.calendar, true);

    // A later grant-less reconnect re-marks it (the grant it replaced still lacks the scopes).
    await w.host.reconnected(
      ACCOUNT,
      connectResult({
        grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
        capabilities: capsWith(false),
      }),
    );
    assert.deepEqual(w.host.status(ACCOUNT)!.missingPermissions, [
      {
        capability: 'calendar',
        reasonCode: 'permission.calendar',
        missingScopes: [],
      },
    ]);
  } finally {
    await d.cleanup();
  }
});
