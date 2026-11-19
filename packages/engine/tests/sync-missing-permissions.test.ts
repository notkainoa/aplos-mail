import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, type CalendarAdapter, type PlannedStep } from '../src/ports';
import {
  ACCOUNT,
  FakeAdapter,
  connectResult,
  disk,
  settle,
  until,
  world,
} from './sync-actor-helpers';

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

const CAL_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

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
        missingScopes: [CAL_LIST, CAL_EVENTS],
      },
    ]);
    // The account itself is not halted: mail status is not needsPermission.
    assert.notEqual(runtime.status.state, 'needsPermission');
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('a grant holding one calendar scope names only the other as missing', async () => {
  const d = disk();
  try {
    const w = world(d, () => idle(calendarStub()));
    w.store.commit({
      opId: 'grant',
      origin: 'system',
      writes: [{ kind: 'account', id: ACCOUNT, grantedScopes: ['gmail.modify', CAL_LIST] }],
    });
    await w.host.start(ACCOUNT);
    await settle();
    const runtime = w.host.status(ACCOUNT)!;
    assert.deepEqual(runtime.missingPermissions, [
      {
        capability: 'calendar',
        reasonCode: 'permission.calendar',
        missingScopes: [CAL_EVENTS],
      },
    ]);
    await w.kill();
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
          'https://www.googleapis.com/auth/calendar.events.readonly',
        ],
        capabilities: capsWith(true),
      }),
    );
    const runtime = w.host.status(ACCOUNT)!;
    assert.equal(runtime.missingPermissions, undefined);
    assert.equal(runtime.capabilities.calendar, true);

    // The same reconnect again changes nothing and emits nothing (emit-on-change, not emit-always).
    const emits: unknown[] = [];
    const unsub = w.host.subscribe((_id, runtime) => emits.push(runtime));
    await w.host.reconnected(
      ACCOUNT,
      connectResult({
        grantedScopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.events.readonly',
        ],
        capabilities: capsWith(true),
      }),
    );
    assert.equal(emits.length, 0);
    unsub();

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
        missingScopes: [CAL_LIST, CAL_EVENTS],
      },
    ]);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('a permission refusal on a calendar step names the gap and never halts mail', async () => {
  const d = disk();
  try {
    const refused = () =>
      Promise.reject(
        new ProviderError({
          class: 'permission',
          provider: 'google',
          method: 'gcal.events.list',
          reason: 'insufficientPermissions',
          missingScopes: [CAL_EVENTS],
        }),
      );
    // Each scope is offered until it has run once; re-offering a due step forever busy-loops the actor.
    const adapter = new FakeAdapter(
      input => {
        const due: PlannedStep[] = [];
        if (!adapter.calls.some(c => c.startsWith('cal:primary')))
          due.push({
            scope: 'cal:primary',
            lane: 'incremental',
            origin: 'incremental',
            trigger: input.trigger,
          });
        if (!adapter.calls.some(c => c.startsWith('window:inbox')))
          due.push({
            scope: 'window:inbox',
            lane: 'incremental',
            origin: 'incremental',
            trigger: input.trigger,
          });
        return due;
      },
      {
        'cal:primary': refused,
        'window:inbox': () => Promise.resolve({ nextStates: [], done: true, costUnits: 1 }),
      },
    );
    // On this branch `cal:` scopes dispatch to the calendar half, so the refusal lives in its syncStep
    // (tracked on its own calls — adapter.calls only sees mail steps).
    const calendarCalls: string[] = [];
    const refusing: CalendarAdapter = {
      ...calendarStub(),
      syncStep: (id: string) => {
        calendarCalls.push(id);
        return refused();
      },
    };
    (adapter as { calendar?: CalendarAdapter }).calendar = refusing;
    const w = world(d, () => adapter);
    await w.host.start(ACCOUNT);
    await until(() => calendarCalls.length > 0, 'the calendar step');
    await until(() => adapter.calls.some(c => c.startsWith('window:inbox')), 'the mail step');
    await settle();

    const runtime = w.host.status(ACCOUNT)!;
    // Mail ran and no halt: the refusal became the calendar's row, not needsPermission.
    assert.ok(adapter.calls.some(c => c.startsWith('window:inbox')));
    assert.notEqual(runtime.status.state, 'needsPermission');
    assert.deepEqual(runtime.missingPermissions, [
      {
        capability: 'calendar',
        reasonCode: 'permission.calendar',
        missingScopes: [CAL_EVENTS],
      },
    ]);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});
