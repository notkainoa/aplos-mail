import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../src/diag/log';
import { createEngine, laneExtensions } from '../src/index';
import type { CalendarPort, CalendarWriteResult } from '../src/ports';
import { openStore } from '../src/store';
import { manualClock } from './runtime.helpers';
import { accountWrite, tempDb } from './store/helpers';

// `Event/set` and `Event/rsvp` (prov-cal): what the methods check and hand to the CalendarPort. The provider side has
// its own tests (apps/desktop/tests/prov-cal); here the port is a recording stub.

const GEVENT = (summary: string) =>
  JSON.stringify({
    summary,
    start: { dateTime: '2026-10-27T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-10-27T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
    status: 'confirmed',
  });

type Call = { op: 'put' | 'remove' | 'rsvp'; args: unknown[] };

async function world(answer: CalendarWriteResult = { kind: 'saved', upserts: [], removals: [] }) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const calls: Call[] = [];
  const calendar: CalendarPort = {
    put: (...args) => (calls.push({ op: 'put', args }), Promise.resolve(answer)),
    remove: (...args) => (calls.push({ op: 'remove', args }), Promise.resolve(answer)),
    rsvp: (...args) => (calls.push({ op: 'rsvp', args }), Promise.resolve(answer)),
  };
  const engine = await createEngine({ store, clock, log, ports: { calendar } });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  store.commit({ opId: 'a', origin: 'local', writes: [{ ...accountWrite }] });
  const calendarWrite = (remoteId: string, readOnly: boolean) => ({
    kind: 'calendar' as const,
    accountId: 'acct-1',
    remoteId,
    name: remoteId,
    hidden: false,
    readOnly,
    selected: true,
  });
  store.commit({
    opId: 'cal',
    origin: 'sync',
    writes: [
      calendarWrite('primary', false),
      calendarWrite('holidays', true),
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev1',
        rows: [
          {
            status: 'confirmed',
            etag: '"v1"',
            recurrence: { rrule: ['RRULE:FREQ=DAILY;COUNT=3'] },
            startUtc: Date.UTC(2026, 9, 27, 17, 0),
            endUtc: Date.UTC(2026, 9, 27, 17, 30),
            allDay: false,
            data: GEVENT('Daily'),
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev1_20261028T170000Z',
        rows: [
          {
            recurrenceId: '20261028T170000Z',
            masterRemoteId: 'ev1',
            status: 'confirmed',
            etag: '"o1"',
            startUtc: Date.UTC(2026, 9, 28, 17, 0),
            endUtc: Date.UTC(2026, 9, 28, 17, 30),
            allDay: false,
            data: GEVENT('Daily (moved)'),
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev2',
        rows: [
          {
            status: 'confirmed',
            etag: '"v2"',
            recurrence: { rrule: ['RRULE:FREQ=DAILY;COUNT=3'] },
            startUtc: Date.UTC(2026, 9, 27),
            endUtc: Date.UTC(2026, 9, 28),
            allDay: true,
            data: GEVENT('All-day daily'),
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev2_20261028',
        rows: [
          {
            recurrenceId: '20261028',
            masterRemoteId: 'ev2',
            status: 'confirmed',
            etag: '"o2"',
            startUtc: Date.UTC(2026, 9, 28),
            endUtc: Date.UTC(2026, 9, 29),
            allDay: true,
            data: GEVENT('All-day daily (moved)'),
          },
        ],
      },
    ],
  });
  return { call, calls, store };
}

const LA = 'America/Los_Angeles';
const seed = (
  w: Awaited<ReturnType<typeof world>>,
  id: string,
  mS: number,
  mE: number,
  rid: string,
  oS: number,
  oE: number,
) => {
  const data = JSON.stringify({
    summary: id,
    start: { dateTime: 'x', timeZone: LA },
    end: { dateTime: 'x', timeZone: LA },
    status: 'confirmed',
  });
  w.store.commit({
    opId: `seed-${id}`,
    origin: 'sync',
    writes: [
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: id,
        rows: [
          {
            status: 'confirmed',
            etag: '"m"',
            recurrence: { rrule: ['RRULE:FREQ=DAILY;COUNT=30'] },
            startUtc: mS,
            endUtc: mE,
            allDay: false,
            data,
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: `${id}_${rid}`,
        rows: [
          {
            recurrenceId: rid,
            masterRemoteId: id,
            status: 'confirmed',
            etag: '"o"',
            startUtc: oS,
            endUtc: oE,
            allDay: false,
            data,
          },
        ],
      },
    ],
  });
};
const go = async (
  w: Awaited<ReturnType<typeof world>>,
  id: string,
  rid: string,
  fields: Record<string, unknown>,
) => {
  const before = w.calls.length;
  await w.call('Event/set', {
    opId: `p-${Math.random()}`,
    change: {
      type: 'update',
      id: `acct-1:primary/${id}@${rid}`,
      scope: 'series',
      fields: { allDay: false, ...fields } as never,
    },
  });
  const f = (
    w.calls[before]!.args[1] as { fields: { start?: { local?: string }; end?: { local?: string } } }
  ).fields;
  return [f.start?.local, f.end?.local];
};
const u = (y: number, mo: number, d: number, h: number, mi = 0) => ({
  type: 'utc',
  utc: Date.UTC(y, mo, d, h, mi),
});

test('a utc series pair keeps an evening 18:00-02:00 across the fall-back night (unchanged)', async () => {
  const w = await world();
  // master Oct 27 18:00 PDT (Oct 28 01:00Z) - Oct 28 02:00 PDT (09:00Z); occ Oct 31 18:00 PDT (Nov 1 01:00Z) - Nov 1 02:00 PST (10:00Z)
  seed(
    w,
    'eve',
    Date.UTC(2026, 9, 28, 1),
    Date.UTC(2026, 9, 28, 9),
    '20261101T010000Z',
    Date.UTC(2026, 10, 1, 1),
    Date.UTC(2026, 10, 1, 10),
  );
  assert.deepEqual(
    await go(w, 'eve', '20261101T010000Z', { start: u(2026, 10, 1, 1), end: u(2026, 10, 1, 10) }),
    ['2026-10-27T18:00:00', '2026-10-28T02:00:00'],
  );
});
test('a utc start move keeps the wall-clock end of an evening series across fall-back', async () => {
  const w = await world();
  seed(
    w,
    'eve',
    Date.UTC(2026, 9, 28, 1),
    Date.UTC(2026, 9, 28, 9),
    '20261101T010000Z',
    Date.UTC(2026, 10, 1, 1),
    Date.UTC(2026, 10, 1, 10),
  );
  assert.deepEqual(
    await go(w, 'eve', '20261101T010000Z', { start: u(2026, 10, 1, 2), end: u(2026, 10, 1, 10) }),
    ['2026-10-27T19:00:00', '2026-10-28T02:00:00'],
  );
});
test('a utc end-only resize follows the owner’s wall clock across fall-back', async () => {
  const w = await world();
  // master Oct 27 18:00 - Oct 28 00:30 PDT (07:30Z); occ Oct 31 18:00 PDT - Nov 1 00:30 PDT (07:30Z)
  seed(
    w,
    'late',
    Date.UTC(2026, 9, 28, 1),
    Date.UTC(2026, 9, 28, 7, 30),
    '20261101T010000Z',
    Date.UTC(2026, 10, 1, 1),
    Date.UTC(2026, 10, 1, 7, 30),
  );
  assert.deepEqual(await go(w, 'late', '20261101T010000Z', { end: u(2026, 10, 1, 9, 30) }), [
    '2026-10-27T18:00:00',
    '2026-10-28T01:30:00',
  ]);
});
test('the floating path agrees with the utc path on the evening series', async () => {
  const w = await world();
  seed(
    w,
    'eve',
    Date.UTC(2026, 9, 28, 1),
    Date.UTC(2026, 9, 28, 9),
    '20261101T010000Z',
    Date.UTC(2026, 10, 1, 1),
    Date.UTC(2026, 10, 1, 10),
  );
  assert.deepEqual(
    await go(w, 'eve', '20261101T010000Z', {
      start: { type: 'floating', local: '2026-10-31T18:00:00', timeZone: LA },
      end: { type: 'floating', local: '2026-11-01T02:00:00', timeZone: LA },
    }),
    ['2026-10-27T18:00:00', '2026-10-28T02:00:00'],
  );
});
test('spring-forward: an occurrence moved across the change keeps 10:00 on the master', async () => {
  const w = await world();
  // master Mar 5 10:00 PST (18:00Z)-10:30; occ Mar 7 18:00Z
  seed(
    w,
    'spr',
    Date.UTC(2026, 2, 5, 18),
    Date.UTC(2026, 2, 5, 18, 30),
    '20260307T180000Z',
    Date.UTC(2026, 2, 7, 18),
    Date.UTC(2026, 2, 7, 18, 30),
  );
  assert.deepEqual(
    await go(w, 'spr', '20260307T180000Z', {
      start: u(2026, 2, 9, 17),
      end: u(2026, 2, 9, 17, 30),
    }),
    ['2026-03-07T10:00:00', '2026-03-07T10:30:00'],
  );
});
test('spring-forward night: 01:30-03:30 (one hour elapsed, two on the wall) stays unchanged', async () => {
  const w = await world();
  // master Mar 5 01:30-03:30 PST (09:30Z-11:30Z); occ Mar 8 01:30 PST (09:30Z) - 03:30 PDT (10:30Z)
  seed(
    w,
    'sn',
    Date.UTC(2026, 2, 5, 9, 30),
    Date.UTC(2026, 2, 5, 11, 30),
    '20260308T093000Z',
    Date.UTC(2026, 2, 8, 9, 30),
    Date.UTC(2026, 2, 8, 10, 30),
  );
  assert.deepEqual(
    await go(w, 'sn', '20260308T093000Z', {
      start: u(2026, 2, 8, 9, 30),
      end: u(2026, 2, 8, 10, 30),
    }),
    ['2026-03-05T01:30:00', '2026-03-05T03:30:00'],
  );
});

test('a utc end-only resize into the repeated hour falls back to the ELAPSED move of the end', async () => {
  const w = await world();
  // master Oct 27 01:00-01:30 PDT (08:00Z-08:30Z); the Nov 1 occurrence 01:00-01:30 PDT (08:00Z-08:30Z)
  seed(
    w,
    'rep',
    Date.UTC(2026, 9, 27, 8),
    Date.UTC(2026, 9, 27, 8, 30),
    '20261101T080000Z',
    Date.UTC(2026, 10, 1, 8),
    Date.UTC(2026, 10, 1, 8, 30),
  );
  // Its end dragged to 09:00Z = 01:00 PST: on the wall clock that is 01:00 again, a zero-length series (01:00-01:00).
  // The elapsed move (+30 minutes) is what the owner meant: the master's end moves 30 minutes later, to 02:00.
  assert.deepEqual(await go(w, 'rep', '20261101T080000Z', { end: u(2026, 10, 1, 9) }), [
    '2026-10-27T01:00:00',
    '2026-10-27T02:00:00',
  ]);
});
