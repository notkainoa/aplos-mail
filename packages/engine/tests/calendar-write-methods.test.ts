import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
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

const rejects = (promise: Promise<unknown>, type: string, reasonCode?: string) =>
  assert.rejects(
    promise,
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === type &&
      (reasonCode === undefined || e.body.reasonCode === reasonCode),
  );

test('an edit is based on the stored version: the series gets the master etag, one occurrence its own', async () => {
  const w = await world();
  await w.call('Event/set', {
    opId: 'e1',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1',
      scope: 'series',
      fields: { title: 'Renamed' },
    },
  });
  await w.call('Event/set', {
    opId: 'e2',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261028T170000Z',
      scope: 'occurrence',
      fields: { title: 'Only today' },
    },
  });
  await w.call('Event/set', {
    opId: 'e3',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261029T170000Z',
      scope: 'occurrence',
      fields: { title: 'No exception yet' },
    },
  });
  const sent = w.calls.map(
    c => c.args[1] as { etag?: string; recurrenceId?: string; remoteId?: string },
  );
  assert.equal(sent[0]!.etag, '"v1"');
  assert.equal(sent[1]!.etag, '"o1"');
  assert.equal(sent[1]!.recurrenceId, '20261028T170000Z');
  assert.equal(sent[2]!.etag, undefined);
  assert.equal(sent[2]!.remoteId, 'ev1');
});

test('a change another device made first is a conflict the caller can act on, not an overwrite', async () => {
  const w = await world({ kind: 'conflict' });
  await rejects(
    w.call('Event/set', {
      opId: 'c1',
      change: {
        type: 'update',
        id: 'acct-1:primary/ev1',
        scope: 'series',
        fields: { title: 'Mine' },
      },
    }),
    'conflict',
    'calendar.conflict',
  );
  await rejects(
    w.call('Event/set', {
      opId: 'c2',
      change: { type: 'destroy', id: 'acct-1:primary/ev1', scope: 'series' },
    }),
    'conflict',
    'calendar.conflict',
  );
  await rejects(
    w.call('Event/rsvp', {
      opId: 'c3',
      id: 'acct-1:primary/ev1',
      response: 'accepted',
      scope: 'series',
      notify: false,
    }),
    'conflict',
    'calendar.conflict',
  );
});

test('a read-only calendar, a missing calendar and a missing event never reach the provider', async () => {
  const w = await world();
  await rejects(
    w.call('Event/set', {
      opId: 'r1',
      change: {
        type: 'create',
        calendarId: 'acct-1:holidays',
        fields: {
          title: 'x',
          start: { type: 'utc', utc: 1_800_000_000_000 },
          end: { type: 'utc', utc: 1_800_003_600_000 },
          allDay: false,
        },
      },
    }),
    'unsupported',
    'calendar.readOnly',
  );
  await rejects(
    w.call('Event/set', {
      opId: 'r2',
      change: {
        type: 'create',
        calendarId: 'acct-1:nope',
        fields: {
          title: 'x',
          start: { type: 'utc', utc: 1_800_000_000_000 },
          end: { type: 'utc', utc: 1_800_003_600_000 },
          allDay: false,
        },
      },
    }),
    'notFound',
  );
  await rejects(
    w.call('Event/set', {
      opId: 'r3',
      change: { type: 'destroy', id: 'acct-1:primary/missing', scope: 'series' },
    }),
    'notFound',
  );
  await rejects(
    w.call('Event/rsvp', {
      opId: 'r4',
      id: 'acct-1:holidays/ev1',
      response: 'declined',
      scope: 'series',
    }),
    'unsupported',
    'calendar.readOnly',
  );
  assert.deepEqual(w.calls, []);
});

test('an rsvp that tells no one goes at once with the stored version', async () => {
  const w = await world();
  const receipt = await w.call('Event/rsvp', {
    opId: 'v1',
    id: 'acct-1:primary/ev1',
    response: 'tentative',
    scope: 'series',
    notify: false,
  });
  assert.notEqual(receipt.undoable, true);
  const [ref, response, opts] = w.calls[0]!.args.slice(1) as [
    { etag?: string },
    string,
    { notify: boolean },
  ];
  assert.equal(ref.etag, '"v1"');
  assert.equal(response, 'tentative');
  assert.equal(opts.notify, false);
});

test('a create names its event from the op id: the same op is the same event, another op or account is not', async () => {
  const { eventIdForOp } = await import('../src/calendar/event-id');
  const a = await eventIdForOp('acct-1', 'op-1');
  assert.match(a, /^[0-9a-v]{26}$/);
  assert.equal(a, await eventIdForOp('acct-1', 'op-1'));
  assert.notEqual(a, await eventIdForOp('acct-1', 'op-2'));
  assert.notEqual(a, await eventIdForOp('acct-2', 'op-1'));

  const w = await world();
  const create = {
    type: 'create' as const,
    calendarId: 'acct-1:primary',
    fields: {
      title: 'x',
      start: { type: 'utc' as const, utc: 1_800_000_000_000 },
      end: { type: 'utc' as const, utc: 1_800_003_600_000 },
      allDay: false,
    },
  };
  await w.call('Event/set', { opId: 'op-1', change: create });
  await w.call('Event/set', { opId: 'op-1', change: create });
  const ids = w.calls.map(c => (c.args[1] as { newRemoteId?: string }).newRemoteId);
  assert.equal(ids[0], a);
  assert.equal(ids[1], a);
});

test('a series edit opened from one occurrence moves the series by the same offset, not to that day', async () => {
  const w = await world();
  const hour = 3_600_000;
  const thatDay = Date.UTC(2026, 9, 28, 17, 0);
  await w.call('Event/set', {
    opId: 'rb1',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261028T170000Z',
      scope: 'series',
      fields: {
        start: { type: 'utc', utc: thatDay + hour },
        end: { type: 'utc', utc: thatDay + hour + 30 * 60_000 },
        allDay: false,
      },
    },
  });
  const sent = w.calls[0]!.args[1] as {
    remoteId: string;
    recurrenceId?: string;
    fields: { start?: { utc: number }; end?: { utc: number } };
  };
  // The master's own slot (Oct 27 17:00 UTC) moves one hour later; it does not jump to Oct 28.
  assert.equal(sent.fields.start?.utc, Date.UTC(2026, 9, 27, 18, 0));
  assert.equal(sent.fields.end?.utc, Date.UTC(2026, 9, 27, 18, 30));
});

test('an end-only series edit opened from one occurrence resizes the master in place', async () => {
  const w = await world();
  // The Oct 28 occurrence (17:00-17:30) is resized to end at 18:00: a +30min delta to its own end.
  await w.call('Event/set', {
    opId: 'rb2',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261028T170000Z',
      scope: 'series',
      fields: { end: { type: 'utc', utc: Date.UTC(2026, 9, 28, 18, 0) }, allDay: false },
    },
  });
  const sent = w.calls[0]!.args[1] as {
    fields: { start?: { utc: number }; end?: { utc: number } };
  };
  // The master keeps its own start (Oct 27 17:00); its end shifts by the same +30min to 18:00.
  assert.equal(sent.fields.start?.utc, Date.UTC(2026, 9, 27, 17, 0));
  assert.equal(sent.fields.end?.utc, Date.UTC(2026, 9, 27, 18, 0));
});

test('an all-day series edit opened from one occurrence moves the series by whole days', async () => {
  const w = await world();
  // The Oct 28 all-day occurrence moves to Oct 29-30: a +1 day shift, same one-day span.
  await w.call('Event/set', {
    opId: 'rb3',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev2@20261028',
      scope: 'series',
      fields: {
        start: { type: 'date', date: '2026-10-29' },
        end: { type: 'date', date: '2026-10-30' },
        allDay: true,
      },
    },
  });
  const sent = w.calls[0]!.args[1] as {
    fields: { start?: { date: string }; end?: { date: string } };
  };
  // The master's own slot (Oct 27-28) shifts one day; it does not jump to Oct 29.
  assert.equal(sent.fields.start?.date, '2026-10-28');
  assert.equal(sent.fields.end?.date, '2026-10-29');
});

test('an end-only all-day series edit keeps the master start and shifts its end by whole days', async () => {
  const w = await world();
  // The Oct 28 all-day occurrence (ends Oct 29) is extended to end Oct 31: a +2 day end delta.
  await w.call('Event/set', {
    opId: 'rb4',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev2@20261028',
      scope: 'series',
      fields: { end: { type: 'date', date: '2026-10-31' }, allDay: true },
    },
  });
  const sent = w.calls[0]!.args[1] as {
    fields: { start?: { date: string }; end?: { date: string } };
  };
  // The master keeps Oct 27; its end (Oct 28) shifts +2 days to Oct 30 — a three-day series.
  assert.equal(sent.fields.start?.date, '2026-10-27');
  assert.equal(sent.fields.end?.date, '2026-10-30');
});

test('a series edit from an occurrence with zoned times moves the series by the offset, in the same zone', async () => {
  const w = await world();
  const LA = 'America/Los_Angeles';
  await w.call('Event/set', {
    opId: 'rb2',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261028T170000Z',
      scope: 'series',
      fields: {
        // The occurrence (Oct 28, 10:00 LA) moved to 11:00 LA, 30 minutes long.
        start: { type: 'floating', local: '2026-10-28T11:00:00', timeZone: LA },
        end: { type: 'floating', local: '2026-10-28T11:30:00', timeZone: LA },
        allDay: false,
      },
    },
  });
  const sent = w.calls[0]!.args[1] as { fields: { start?: unknown; end?: unknown } };
  // The master (Oct 27, 10:00 LA) moves to 11:00 LA on ITS day, not to the clicked day.
  assert.deepEqual(sent.fields.start, {
    type: 'floating',
    local: '2026-10-27T11:00:00',
    timeZone: LA,
  });
  assert.deepEqual(sent.fields.end, {
    type: 'floating',
    local: '2026-10-27T11:30:00',
    timeZone: LA,
  });
});

test('a series resize from an occurrence (end only, zoned) shifts the master end by the same amount; an unknown zone is refused', async () => {
  const w = await world();
  const LA = 'America/Los_Angeles';
  await w.call('Event/set', {
    opId: 'rb3',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261028T170000Z',
      scope: 'series',
      fields: {
        // The occurrence ends 10:30 LA; dragged to 11:00 LA. Only the end is sent.
        end: { type: 'floating', local: '2026-10-28T11:00:00', timeZone: LA },
        allDay: false,
      },
    },
  });
  const sent = w.calls[0]!.args[1] as { fields: { start?: unknown; end?: unknown } };
  // The master keeps its own slot: its start is sent unchanged, in the same zone.
  assert.deepEqual(sent.fields.start, {
    type: 'floating',
    local: '2026-10-27T10:00:00',
    timeZone: LA,
  });
  assert.deepEqual(sent.fields.end, {
    type: 'floating',
    local: '2026-10-27T11:00:00',
    timeZone: LA,
  });

  await rejects(
    w.call('Event/set', {
      opId: 'rb4',
      change: {
        type: 'update',
        id: 'acct-1:primary/ev1@20261028T170000Z',
        scope: 'series',
        fields: { end: { type: 'floating', local: '2026-10-28T11:00:00' }, allDay: false },
      },
    }),
    'unsupported',
    'calendar.floatingSeries',
  );
  assert.equal(w.calls.length, 1, 'nothing was sent for the refused one');
});

test('a series time change moves by the WALL CLOCK: an occurrence moved across a daylight-saving change keeps its clock time', async () => {
  const w = await world();
  const LA = 'America/Los_Angeles';
  // The Nov 3 occurrence (10:00 PST, after the clocks went back) has an exception of its own.
  w.store.commit({
    opId: 'dst',
    origin: 'sync',
    writes: [
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev1_20261103T180000Z',
        rows: [
          {
            recurrenceId: '20261103T180000Z',
            masterRemoteId: 'ev1',
            status: 'confirmed',
            etag: '"o2"',
            startUtc: Date.UTC(2026, 10, 3, 18, 0),
            endUtc: Date.UTC(2026, 10, 3, 18, 30),
            allDay: false,
            data: GEVENT('Daily (Nov 3)'),
          },
        ],
      },
    ],
  });
  // Moved to Oct 31 at the same 10:00 (PDT): the owner changed the day only.
  await w.call('Event/set', {
    opId: 'dst1',
    change: {
      type: 'update',
      id: 'acct-1:primary/ev1@20261103T180000Z',
      scope: 'series',
      fields: {
        start: { type: 'floating', local: '2026-10-31T10:00:00', timeZone: LA },
        end: { type: 'floating', local: '2026-10-31T10:30:00', timeZone: LA },
        allDay: false,
      },
    },
  });
  const sent = w.calls[0]!.args[1] as { fields: { start?: unknown; end?: unknown } };
  // Master Oct 27 10:00 LA moves three days earlier at 10:00 (not 09:00 or 11:00).
  assert.deepEqual(sent.fields.start, {
    type: 'floating',
    local: '2026-10-24T10:00:00',
    timeZone: LA,
  });
  assert.deepEqual(sent.fields.end, {
    type: 'floating',
    local: '2026-10-24T10:30:00',
    timeZone: LA,
  });
});

test('series times that cannot be moved by an offset are refused, and nothing reaches the port', async () => {
  const w = await world();
  const LA = 'America/Los_Angeles';
  const refused = (opId: string, fields: Record<string, unknown>) =>
    rejects(
      w.call('Event/set', {
        opId,
        change: {
          type: 'update',
          id: 'acct-1:primary/ev1@20261028T170000Z',
          scope: 'series',
          fields: { allDay: false, ...fields } as never,
        },
      }),
      'unsupported',
      'calendar.floatingSeries',
    );
  const at = (local: string, timeZone?: string) => ({
    type: 'floating',
    local,
    ...(timeZone ? { timeZone } : {}),
  });
  await refused('x1', { start: at('2026-10-28T11:00:00') });
  await refused('x2', { start: at('2026-10-28T11:00:00', 'Mars/Olympus') });
  await refused('x3', {
    start: at('2026-10-28T11:00:00', LA),
    end: at('2026-10-28T20:00:00', 'Europe/London'),
  });
  // The series is in Los Angeles: a series edit in another zone would rewrite the whole series into it.
  await refused('x4', {
    start: at('2026-10-28T19:00:00', 'Europe/London'),
    end: at('2026-10-28T19:30:00', 'Europe/London'),
  });
  // A utc start with a date end describes nothing one offset can move.
  await refused('x5', {
    start: { type: 'utc', utc: 1_800_000_000_000 },
    end: { type: 'date', date: '2026-10-29' },
  });
  assert.deepEqual(w.calls, []);
});
