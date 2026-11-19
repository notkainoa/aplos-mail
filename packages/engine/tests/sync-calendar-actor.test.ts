import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../src/ports';
import type { CalendarAdapter, PlannedStep, SyncLane, SyncState } from '../src/ports';
import { ACCOUNT, FakeAdapter, disk, settle, world } from './sync-actor-helpers';

// The actor's calendar dispatch (actor-calendar.ts): `calendars` and `cal:<id>` steps run on the
// adapter's calendar half, commit calendars/events rows, and carry their state in
// `runtime.calendars` — mail status, baseline and failure stay untouched (D12).

const LIST: PlannedStep = {
  scope: 'calendars',
  lane: 'incremental',
  origin: 'incremental',
  trigger: 'first',
  notBefore: 0,
};
const CAL: PlannedStep = {
  scope: 'cal:work-1',
  lane: 'backfill',
  origin: 'backfill',
  trigger: 'first',
  notBefore: 0,
};

const state = (scope: PlannedStep['scope'], cursor?: string): SyncState => ({
  scope,
  ...(cursor !== undefined ? { cursor } : {}),
  generation: 1,
  updatedAt: 0,
});

const FACT = {
  calendarRemoteId: 'work-1',
  remoteId: 'ev-1',
  summary: 'Standup',
  location: '',
  description: '',
  start: { type: 'utc' as const, utc: Date.UTC(2026, 10, 9, 17, 0) },
  end: { type: 'utc' as const, utc: Date.UTC(2026, 10, 9, 17, 30) },
  allDay: false,
  attendees: [],
  status: 'confirmed' as const,
  organizerIsSelf: false,
  canEditShared: false,
  raw: '{"id":"ev-1"}',
};

/** A calendar stub whose plan emits each scope until its own `sync_state` exists (then quiesces). */
const calWorld = (
  d: ReturnType<typeof disk>,
  calendar: CalendarAdapter,
  options: { grantedScopes?: string[]; calendarCap?: boolean; calLane?: SyncLane } = {},
) => {
  const {
    grantedScopes = ['gmail.modify', 'cal.a', 'cal.b'],
    calendarCap = true,
    calLane = 'backfill',
  } = options;
  const adapter = new FakeAdapter(input => {
    const steps: PlannedStep[] = [];
    if (!input.states.some(s => s.scope === 'calendars')) steps.push(LIST);
    if (!input.states.some(s => s.scope === 'cal:work-1'))
      steps.push({
        ...CAL,
        lane: calLane,
        origin: calLane === 'backfill' ? 'backfill' : 'incremental',
      });
    return steps;
  }, {});
  (adapter as { calendar?: CalendarAdapter }).calendar = calendar;
  const w = world(d, () => adapter);
  w.store.commit({
    opId: 'caps-setup',
    origin: 'system',
    writes: [{ kind: 'account', id: ACCOUNT, grantedScopes, capabilities: caps(calendarCap) }],
  });
  return w;
};

const caps = (calendar = true) => ({
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

test('the actor lists calendars and syncs events into the tables the views read', async () => {
  const d = disk();
  try {
    const calendar: CalendarAdapter = {
      budget: 'gcal',
      plan: () => [],
      listCalendars: () =>
        Promise.resolve({
          calendars: [
            {
              remoteId: 'work-1',
              name: 'Work',
              hidden: false,
              selected: true,
              readOnly: false,
            },
          ],
          removed: [],
          nextState: state('calendars', 'list-token'),
          costUnits: 1,
        }),
      syncStep: () =>
        Promise.resolve({
          upserts: [FACT],
          removals: [],
          nextState: state('cal:work-1', 'cal-token'),
          done: true,
          costUnits: 1,
        }),
      put: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
      rsvp: () => Promise.reject(new Error('unused')),
    };
    const w = calWorld(d, calendar);
    await w.host.start(ACCOUNT);
    await settle();

    const rows = w.store.read(q => q.all<{ remote_id: string }>('SELECT remote_id FROM calendars'));
    assert.deepEqual(
      rows.map(r => r.remote_id),
      ['work-1'],
    );
    const events = w.store.read(q =>
      q.all<{ remote_id: string; data: string }>('SELECT remote_id, data FROM events'),
    );
    assert.deepEqual(
      events.map(e => e.remote_id),
      ['ev-1'],
    );
    assert.equal(events[0]!.data, '{"id":"ev-1"}', 'raw provider JSON lands verbatim');

    // Per-calendar state, not mail state (D12): no permission halt, nothing missing.
    const runtime = w.host.status(ACCOUNT)!;
    assert.deepEqual(
      runtime.calendars?.map(c => ({ id: c.remoteId, state: c.state })),
      [{ id: 'work-1', state: 'ok' }],
    );
    assert.notEqual(runtime.status.state, 'needsPermission');
    assert.equal(runtime.missingPermissions, undefined);

    // The sync set remembers the listed calendar with `sync: true`.
    const mem = w.store.read(
      q =>
        q.get<{ value: string }>(
          'SELECT value FROM provider_memory WHERE account_id = ? AND key = ?',
          ACCOUNT,
          'cal.sync',
        )?.value,
    );
    const set = JSON.parse(mem ?? '[]') as { id: string; sync?: boolean }[];
    assert.deepEqual(set, [{ id: 'work-1', sync: true }]);
  } finally {
    await d.cleanup();
  }
});

test('a permission refusal on a calendar step marks missingPermissions and leaves mail alone', async () => {
  const d = disk();
  try {
    const calendar: CalendarAdapter = {
      budget: 'gcal',
      plan: () => [],
      listCalendars: () =>
        Promise.resolve({
          calendars: [],
          removed: [],
          nextState: state('calendars'),
          costUnits: 0,
        }),
      syncStep: () =>
        Promise.reject(
          new ProviderError({
            class: 'permission',
            provider: 'google',
            method: 'gcal.events.list',
            reason: 'insufficientPermissions',
            missingScopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
          }),
        ),
      put: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
      rsvp: () => Promise.reject(new Error('unused')),
    };
    // The grant lacks the calendar scopes: the constructor's row names the derived gap; the
    // refusal's named scopes then replace it.
    const w = calWorld(d, calendar, { grantedScopes: ['gmail.modify'], calendarCap: false });
    await w.host.start(ACCOUNT);
    await settle();

    const runtime = w.host.status(ACCOUNT)!;
    assert.notEqual(runtime.status.state, 'needsPermission', 'a calendar refusal never halts mail');
    assert.equal(runtime.missingPermissions?.[0]?.reasonCode, 'permission.calendar');
    assert.deepEqual(runtime.missingPermissions?.[0]?.missingScopes, [
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ]);
  } finally {
    await d.cleanup();
  }
});

test('a calendar step in the incremental lane still runs on a secondary device', async () => {
  const d = disk();
  try {
    const calendar: CalendarAdapter = {
      budget: 'gcal',
      plan: () => [],
      listCalendars: () =>
        Promise.resolve({
          calendars: [
            { remoteId: 'work-1', name: 'Work', hidden: false, selected: true, readOnly: false },
          ],
          removed: [],
          nextState: state('calendars', 'list-token'),
          costUnits: 1,
        }),
      syncStep: () =>
        Promise.resolve({
          upserts: [FACT],
          removals: [],
          nextState: state('cal:work-1', 'cal-token'),
          done: true,
          costUnits: 1,
        }),
      put: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
      rsvp: () => Promise.reject(new Error('unused')),
    };
    // The adapter plans cal: scopes incremental (never 'backfill'), so a second Mac — whose lease
    // reads secondary — still fills its Calendar view; 'backfill' would be filtered by PRIMARY_ONLY.
    const w = calWorld(d, calendar, { calLane: 'incremental' });
    await w.host.start(ACCOUNT);
    w.host.leaseChanged(ACCOUNT, { role: 'secondary' });
    await settle();

    const events = w.store.read(q => q.all<{ remote_id: string }>('SELECT remote_id FROM events'));
    assert.deepEqual(
      events.map(e => e.remote_id),
      ['ev-1'],
    );
    assert.equal(
      w.host.status(ACCOUNT)!.calendars?.find(c => c.remoteId === 'work-1')?.state,
      'ok',
    );
  } finally {
    await d.cleanup();
  }
});

const stubCalendar = (
  list: () => ReturnType<CalendarAdapter['listCalendars']>,
): CalendarAdapter => ({
  budget: 'gcal',
  plan: () => [],
  listCalendars: list,
  syncStep: () =>
    Promise.resolve({
      upserts: [],
      removals: [],
      nextState: state('cal:work-1', 'cal-token'),
      done: true,
      costUnits: 0,
    }),
  put: () => Promise.reject(new Error('unused')),
  remove: () => Promise.reject(new Error('unused')),
  rsvp: () => Promise.reject(new Error('unused')),
});

const listedAt = (w: ReturnType<typeof calWorld>) =>
  w.store.read(
    q =>
      q.get<{ calendar_listed_at: number | null }>(
        'SELECT calendar_listed_at FROM accounts WHERE id = ?',
        ACCOUNT,
      )?.calendar_listed_at ?? null,
  );

test('the first calendar list stamps the account, EMPTY or not, so "No calendars" differs from "Syncing…"', async () => {
  const d = disk();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const w = calWorld(
      d,
      stubCalendar(async () => {
        await gate;
        return { calendars: [], removed: [], nextState: state('calendars', 't'), costUnits: 0 };
      }),
    );
    await w.host.start(ACCOUNT);
    await settle();
    assert.equal(listedAt(w), null, 'the list is still being read: Syncing…');
    release();
    await settle();
    assert.ok(
      (listedAt(w) ?? 0) > 0,
      'the list came back empty: stamped, so the UI can say No calendars',
    );
  } finally {
    await d.cleanup();
  }
});

test('a later list never moves calendarListedAt: the first one wins', async () => {
  const d = disk();
  try {
    const w = calWorld(
      d,
      stubCalendar(() =>
        Promise.resolve({
          calendars: [],
          removed: [],
          nextState: state('calendars', 't'),
          costUnits: 0,
        }),
      ),
    );
    await w.host.start(ACCOUNT);
    await settle();
    const first = listedAt(w);
    assert.ok(first);
    w.store.commit({
      opId: 'second-list',
      origin: 'sync',
      writes: [{ kind: 'account', id: ACCOUNT, calendarListedAt: (first as number) + 99_999 }],
    });
    assert.equal(listedAt(w), first, 'the stored first value stands');
  } finally {
    await d.cleanup();
  }
});

test('Account/get-shaped read: calendarListedAt is on the account only once listed', async () => {
  const d = disk();
  try {
    const w = calWorld(
      d,
      stubCalendar(() =>
        Promise.resolve({
          calendars: [],
          removed: [],
          nextState: state('calendars', 't'),
          costUnits: 0,
        }),
      ),
    );
    const { readAccount } = await import('../src/sync/account-read');
    const before = readAccount(w.store, ACCOUNT, undefined);
    assert.equal(before?.calendarListedAt, undefined);
    await w.host.start(ACCOUNT);
    await settle();
    const after = readAccount(w.store, ACCOUNT, undefined);
    assert.equal(typeof after?.calendarListedAt, 'number');
  } finally {
    await d.cleanup();
  }
});
