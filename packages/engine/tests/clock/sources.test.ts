import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, NotificationItem } from '@aplos/contract';
import { fakeClock } from '../../src/clock/module';
import { LATER_QUERIES, resolvePresets } from '../../src/clock/sources/later';
import {
  createReminders,
  MAX_REMINDERS_PER_FIRE,
  REMINDER_QUERIES,
} from '../../src/clock/sources/reminders';
import { localDayAndHour } from '../../src/clock/zone';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore, type StorePort } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { DAY, HOUR, idsOf, LA, LONDON, MIN, SEC, threadId, utc, world } from './world.helpers';

// ------------------------------------------------------------ Later presets

const at = (iso: string) => utc(iso);

test('presets: the picker rules, 8:00 and 18:00 local, across a DST change in either direction', () => {
  const keys = (now: number, zone: string, weekStart?: number) =>
    resolvePresets(now, zone, weekStart).map(
      p => `${p.key}=${p.until === undefined ? '-' : new Date(p.until).toISOString().slice(0, 16)}`,
    );
  // Wed Oct 28 2026 09:00 PDT: evening, tomorrow, the weekend and next Monday, all PDT (UTC-7).
  assert.deepEqual(keys(at('2026-10-28T16:00:00Z'), LA), [
    'evening=2026-10-29T01:00',
    'tomorrow=2026-10-29T15:00',
    'weekend=2026-10-31T15:00',
    'nextWeek=2026-11-02T16:00',
    'someday=-',
  ]);
  // Sat Oct 31 20:00 PDT: no evening (after 17:00), no weekend (Saturday); tomorrow is Sun Nov 1 8:00 PST (UTC-8).
  assert.deepEqual(keys(at('2026-11-01T03:00:00Z'), LA), [
    'tomorrow=2026-11-01T16:00',
    'nextWeek=2026-11-02T16:00',
    'someday=-',
  ]);
  // Sat Mar 7 23:59 PST, a minute before midnight: tomorrow is Sun Mar 8 8:00 PDT (UTC-7), after the spring change.
  assert.deepEqual(keys(at('2026-03-08T07:59:00Z'), LA), [
    'tomorrow=2026-03-08T15:00',
    'nextWeek=2026-03-09T15:00',
    'someday=-',
  ]);
  // London: Sat Oct 24 23:30 BST then Sun Oct 25 8:00 GMT; Sat Mar 28 23:30 GMT then Sun Mar 29 8:00 BST.
  assert.equal(keys(at('2026-10-24T22:30:00Z'), LONDON)[0], 'tomorrow=2026-10-25T08:00');
  assert.equal(keys(at('2026-03-28T23:30:00Z'), LONDON)[0], 'tomorrow=2026-03-29T07:00');
});

test('presets: the evening cutoff, the weekend window and the first weekday of the week', () => {
  const names = (now: number, weekStart?: number) =>
    resolvePresets(now, LA, weekStart).map(p => p.key);
  // 16:59 local still offers the evening; 17:00 does not.
  assert.ok(names(at('2026-10-28T23:59:00Z')).includes('evening'));
  assert.ok(!names(at('2026-10-29T00:00:00Z')).includes('evening'));
  // The weekend is offered Monday to Thursday only (Thu Oct 29 yes, Fri Oct 30 no).
  assert.ok(names(at('2026-10-29T16:00:00Z')).includes('weekend'));
  assert.ok(!names(at('2026-10-30T16:00:00Z')).includes('weekend'));
  // Next week starts on weekStart and is never today: a Sunday-first week on a Sunday means the following Sunday.
  const sunday = at('2026-11-01T17:00:00Z');
  const next = (weekStart: number) =>
    resolvePresets(sunday, LA, weekStart).find(p => p.key === 'nextWeek')!.until;
  assert.equal(new Date(next(1)!).toISOString(), '2026-11-02T16:00:00.000Z');
  assert.equal(new Date(next(0)!).toISOString(), '2026-11-08T16:00:00.000Z');
});

test('presets: the instant is the zone-local wall time, not a fixed offset (8:00 stays 8:00)', () => {
  for (const [zone, now] of [
    [LA, at('2026-03-07T20:00:00Z')],
    [LA, at('2026-10-31T20:00:00Z')],
    [LONDON, at('2026-03-28T12:00:00Z')],
    [LONDON, at('2026-10-24T12:00:00Z')],
  ] as const) {
    const tomorrow = resolvePresets(now, zone).find(p => p.key === 'tomorrow')!.until!;
    assert.equal(localDayAndHour(tomorrow, zone).hour, 8, `${zone} ${new Date(now).toISOString()}`);
  }
});

// ------------------------------------------------------------ reminders

test('a reminder due while the app was closed fires once, at the first pass, with its was-due time', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    w.remind(1, at('2026-10-27T16:00:00Z')); // yesterday 9:00 PDT
    const e = w.boot();
    await e.loop.idle();
    assert.equal(w.events.length, 1);
    const [item] = w.events;
    assert.equal(item.kind, 'reminder');
    assert.equal(item.threadId, threadId(1));
    assert.equal(item.accountId, ACCOUNT);
    assert.equal(item.title, 'Subject t1');
    assert.equal(item.wasDueAt, at('2026-10-27T16:00:00Z'));
    assert.equal(item.at, w.clock.now());
    assert.equal(item.body, 'Was due Tue, Oct 27, 9:00 AM');
    assert.equal(w.row(1).reminder_fired_at, w.clock.now());
    assert.equal(e.stuck(), 0, 'the fire moved the deadline past now: no backoff, no log');
    await w.clock.set(w.clock.now() + HOUR);
    await e.loop.idle();
    assert.equal(w.events.length, 1, 'it never fires again');
    e.stop();
  } finally {
    w.done();
  }
});

test('a reminder on time fires at its time with no was-due text', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const due = at('2026-10-28T16:01:00Z');
    w.remind(1, due);
    const e = w.boot();
    await w.clock.advance(MIN - 1);
    assert.equal(w.events.length, 0);
    await w.clock.advance(1);
    assert.equal(w.events.length, 1);
    assert.equal(w.events[0].at, due);
    assert.equal(w.events[0].wasDueAt, undefined);
    assert.equal(w.events[0].body, undefined);
    e.stop();
  } finally {
    w.done();
  }
});

/** The card's "late fires once": the clock jumps days across a DST change and each reminder fires once with its time. */
const JUMPS = [
  {
    name: 'Los Angeles, fall back (Nov 1)',
    zone: LA,
    start: '2026-10-30T16:00:00Z',
    due: ['2026-10-31T16:00:00Z', '2026-11-01T17:00:00Z', '2026-11-02T17:00:00Z'],
    jumpTo: '2026-11-02T18:00:00Z',
    said: ['Sat, Oct 31, 9:00 AM', 'Sun, Nov 1, 9:00 AM', '9:00 AM'],
  },
  {
    name: 'Los Angeles, spring forward (Mar 8)',
    zone: LA,
    start: '2026-03-06T17:00:00Z',
    due: ['2026-03-07T17:00:00Z', '2026-03-08T16:00:00Z', '2026-03-09T16:00:00Z'],
    jumpTo: '2026-03-09T17:00:00Z',
    said: ['Sat, Mar 7, 9:00 AM', 'Sun, Mar 8, 9:00 AM', '9:00 AM'],
  },
  {
    name: 'London, fall back (Oct 25)',
    zone: LONDON,
    start: '2026-10-23T08:00:00Z',
    due: ['2026-10-24T08:00:00Z', '2026-10-25T09:00:00Z', '2026-10-26T09:00:00Z'],
    jumpTo: '2026-10-26T12:00:00Z',
    said: ['Sat, Oct 24, 9:00 AM', 'Sun, Oct 25, 9:00 AM', '9:00 AM'],
  },
  {
    name: 'London, spring forward (Mar 29)',
    zone: LONDON,
    start: '2026-03-27T09:00:00Z',
    due: ['2026-03-28T09:00:00Z', '2026-03-29T08:00:00Z', '2026-03-30T08:00:00Z'],
    jumpTo: '2026-03-30T12:00:00Z',
    said: ['Sat, Mar 28, 9:00 AM', 'Sun, Mar 29, 9:00 AM', '9:00 AM'],
  },
];

for (const jump of JUMPS) {
  test(`late fires once: three reminders over a three-day jump, ${jump.name}`, async () => {
    const w = world(jump.start, jump.zone);
    try {
      const e = w.boot();
      await w.clock.flush();
      jump.due.forEach((iso, i) => w.remind(i + 1, at(iso)));
      e.loop.changed('reminders');
      await w.clock.set(at(jump.jumpTo));
      await e.loop.idle();
      assert.deepEqual(idsOf(w).sort(), [1, 2, 3].map(threadId));
      for (const [i, iso] of jump.due.entries()) {
        const item = w.events.find(x => x.threadId === threadId(i + 1))!;
        assert.equal(item.wasDueAt, at(iso));
        assert.equal(item.at, at(jump.jumpTo));
        assert.equal(item.body, `Was due ${jump.said[i]}`);
        assert.equal(w.row(i + 1).reminder_fired_at, at(jump.jumpTo));
      }
      // Deadline order, and nothing more on later wakes, waits or a Mac wake.
      assert.deepEqual(
        w.events.map(x => x.wasDueAt),
        jump.due.map(at),
      );
      e.loop.wake();
      await w.clock.set(at(jump.jumpTo) + DAY);
      await e.loop.idle();
      assert.equal(w.events.length, 3);
      e.stop();
    } finally {
      w.done();
    }
  });
}

test('twenty overdue reminders catch up in order, each once', async () => {
  const w = world('2026-10-28T16:00:00Z', LA, 20);
  try {
    for (let n = 1; n <= 20; n++) w.remind(n, at('2026-10-25T16:00:00Z') + (20 - n) * MIN);
    const e = w.boot();
    await e.loop.idle();
    assert.equal(w.events.length, 20);
    assert.deepEqual(
      w.events.map(x => x.wasDueAt),
      w.events.map(x => x.wasDueAt).sort((a, b) => a! - b!),
    );
    assert.equal(new Set(idsOf(w)).size, 20);
    e.stop();
  } finally {
    w.done();
  }
});

test('ack: a fired reminder is seen once, an upcoming one is untouched, a restart does not fire it again', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    w.remind(1, at('2026-10-28T10:00:00Z'));
    w.remind(2, at('2026-10-29T16:00:00Z'));
    const e = w.boot();
    await e.loop.idle();
    assert.deepEqual(
      e.reminders.list().map(i => [i.threadId, i.firedAt !== undefined]),
      [
        [threadId(1), true],
        [threadId(2), false],
      ],
    );
    const first = e.reminders.ack('ack-1', [threadId(1), threadId(2), 'nobody:here']);
    assert.equal(first.seq, w.store.seq());
    assert.deepEqual(
      e.reminders.list().map(i => i.threadId),
      [threadId(2)],
      'only the fired reminder left the list',
    );
    assert.equal(w.row(1).reminder_at, null);
    assert.notEqual(w.row(1).reminder_fired_at, null, 'the firing is kept');
    assert.equal(
      w.row(2).reminder_at,
      at('2026-10-29T16:00:00Z'),
      'an upcoming reminder is not cancelled by ack',
    );
    // The same opId again changes nothing and answers the same state.
    assert.deepEqual(e.reminders.ack('ack-1', [threadId(1)]), first);
    assert.deepEqual(e.reminders.ack('ack-2', []), { dbEpoch: first.dbEpoch, seq: first.seq });
    e.stop();

    // Restart the engine three days later: the acked reminder stays quiet, the other fires once, late.
    const again = w.reopen();
    await w.clock.set(at('2026-10-31T16:00:00Z'));
    const restarted = w.boot(again);
    await restarted.loop.idle();
    assert.deepEqual(idsOf(w), [threadId(1), threadId(2)]);
    assert.equal(w.events[1].wasDueAt, at('2026-10-29T16:00:00Z'));
    restarted.stop();
  } finally {
    w.done();
  }
});

test('setting a reminder again after it fired arms it again; clearing it never fires', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    w.remind(1, at('2026-10-28T16:05:00Z'));
    const e = w.boot();
    await w.clock.advance(5 * MIN);
    assert.equal(w.events.length, 1);
    w.remind(1, at('2026-10-28T17:00:00Z'));
    w.remind(2, at('2026-10-28T17:00:00Z'));
    w.patch(2, { reminderAt: null, reminderFiredAt: null });
    e.loop.changed('reminders');
    await w.clock.advance(HOUR);
    assert.deepEqual(idsOf(w), [threadId(1), threadId(1)]);
    e.stop();
  } finally {
    w.done();
  }
});

test('a reminder set while the loop sleeps fires on time without a changed() call', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const e = w.boot();
    await w.clock.advance(20 * SEC);
    // `Thread/act` commits and nothing tells the loop (yet): the source's own recheck picks it up.
    w.remind(1, at('2026-10-28T16:05:00Z'));
    await w.clock.advance(4 * MIN + 30 * SEC);
    assert.equal(w.events.length, 0);
    await w.clock.advance(10 * SEC);
    assert.equal(w.events.length, 1);
    assert.equal(w.events[0].wasDueAt, undefined, 'on time, not late');
    e.stop();
  } finally {
    w.done();
  }
});

test('a fire repeated after a hung call, or run by a second engine, notifies once (asserted on the store)', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const due = at('2026-10-28T15:00:00Z');
    w.remind(1, due);
    const a = w.boot();
    await a.loop.idle();
    const firedAt = w.row(1).reminder_fired_at;
    assert.equal(w.events.length, 1);
    // The loop gave up on a hung fire and calls it again (or a crash re-fires it): nothing is due, nothing is sent.
    await a.reminders.source.fire(w.clock.now() + MIN);
    await a.reminders.source.fire(w.clock.now() + 2 * MIN);
    assert.equal(w.events.length, 1);
    assert.equal(w.row(1).reminder_fired_at, firedAt, 'the first firing time stands');

    // A second engine that read the due set before the first committed: its commit replays, so it stays silent.
    w.remind(2, due);
    const other = w.reopen();
    const stale = other.read(q =>
      q.all(REMINDER_QUERIES.due, w.clock.now(), MAX_REMINDERS_PER_FIRE),
    );
    assert.equal(stale.length, 1);
    const racing = Object.create(other) as StorePort;
    racing.read = fn =>
      fn({
        all: () => stale,
        get: () => undefined,
        iterate: () => stale[Symbol.iterator](),
      } as never);
    const b = createReminders({
      store: racing,
      clock: w.clock,
      frames: {
        emit: f => f.frame === 'host' && f.event.type === 'reminder' && w.events.push(f.event.item),
      },
      zone: () => LA,
    });
    await a.reminders.source.fire(w.clock.now());
    const before = w.events.length;
    assert.equal(before, 2);
    const stamp = w.row(2).reminder_fired_at;
    await b.source.fire(w.clock.now() + 5 * SEC);
    assert.equal(w.events.length, before, 'the second engine did not announce it again');
    assert.equal(w.row(2).reminder_fired_at, stamp, 'and did not move the firing time');
    a.stop();
  } finally {
    w.done();
  }
});

test('a thread deleted between the read and the commit is not announced and does not stop the others', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    w.remind(1, at('2026-10-28T15:00:00Z'));
    w.remind(2, at('2026-10-28T15:30:00Z'));
    const stale = w.store.read(q =>
      q.all(REMINDER_QUERIES.due, w.clock.now(), MAX_REMINDERS_PER_FIRE),
    );
    w.store.commit({
      opId: 'gone',
      origin: 'sync',
      writes: [{ kind: 'threadDelete', accountId: ACCOUNT, remoteThreadId: 't1' }],
    });
    const racing = Object.create(w.store) as StorePort;
    racing.read = fn =>
      fn({
        all: () => stale,
        get: () => undefined,
        iterate: () => stale[Symbol.iterator](),
      } as never);
    const r = createReminders({
      store: racing,
      clock: w.clock,
      frames: {
        emit: f => f.frame === 'host' && f.event.type === 'reminder' && w.events.push(f.event.item),
      },
      zone: () => LA,
    });
    await r.source.fire(w.clock.now());
    assert.deepEqual(
      idsOf(w),
      [threadId(2)],
      'the deleted thread is not announced, thread 2 still is',
    );
  } finally {
    w.done();
  }
});

// ------------------------------------------------------------ Later

test('Later returns at the local time the preset chose, across the DST change, and the thread stays in Later', async () => {
  const w = world('2026-11-01T03:00:00Z'); // Sat Oct 31 20:00 PDT
  try {
    const e = w.boot();
    await w.clock.flush();
    const until = e.later.presets().presets.find(p => p.key === 'tomorrow')!.until!;
    assert.equal(
      new Date(until).toISOString(),
      '2026-11-01T16:00:00.000Z',
      'Sun 8:00 PST, not 8:00 PDT',
    );
    w.snooze(1, until);
    w.snooze(2, null); // Someday has no date and never returns
    await w.clock.set(until - 1);
    assert.equal(w.events.length, 0);
    await w.clock.set(until);
    await e.loop.idle();
    assert.equal(w.events.length, 1);
    assert.equal(w.events[0].kind, 'later');
    assert.equal(w.events[0].threadId, threadId(1));
    assert.equal(w.events[0].at, until, 'fired at its time');
    assert.equal(w.events[0].wasDueAt, undefined);
    assert.equal(localDayAndHour(w.events[0].at, LA).hour, 8);
    // The thread is still Later with its date: Home shows it as back from Later by comparing the date (views).
    assert.deepEqual([w.row(1).status, w.row(1).later_until], ['later', until]);
    await w.clock.set(until + 3 * DAY);
    await e.loop.idle();
    assert.equal(w.events.length, 1);
    e.stop();
  } finally {
    w.done();
  }
});

test('a Later that fell due while the app was closed is announced once, at launch, with its was-due time', async () => {
  const w = world('2026-11-01T03:00:00Z');
  try {
    const first = w.boot();
    await first.loop.idle();
    const until = first.later.presets().presets.find(p => p.key === 'tomorrow')!.until!;
    w.snooze(1, until);
    first.stop();

    await w.clock.set(until + 3 * DAY);
    const second = w.boot(w.reopen());
    await second.loop.idle();
    assert.equal(w.events.length, 1);
    assert.equal(w.events[0].wasDueAt, until);
    assert.equal(w.events[0].body, 'Was due Sun, Nov 1, 8:00 AM');
    second.stop();

    const third = w.boot(w.reopen());
    await third.loop.idle();
    await w.clock.set(w.clock.now() + DAY);
    await third.loop.idle();
    assert.equal(w.events.length, 1, 'a second restart announces nothing again');
    third.stop();
  } finally {
    w.done();
  }
});

test('a Later that was done before its time, or dates from before the engine first ran, is not announced', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    w.snooze(1, at('2026-10-20T16:00:00Z')); // old Later, imported before the first run
    const e = w.boot();
    await e.loop.idle();
    w.snooze(2, at('2026-10-28T20:00:00Z'));
    w.patch(2, { status: 'done', laterUntil: null });
    w.snooze(3, at('2026-10-28T21:00:00Z'));
    e.loop.changed('later');
    await w.clock.set(at('2026-10-29T00:00:00Z'));
    await e.loop.idle();
    assert.deepEqual(idsOf(w), [threadId(3)]);
    e.stop();
  } finally {
    w.done();
  }
});

test('Later announcements are idempotent per thread and capped per fire', async () => {
  const w = world('2026-10-28T16:00:00Z', LA, 30);
  try {
    const e = w.boot();
    await e.loop.idle();
    const due = at('2026-10-28T20:00:00Z');
    w.snooze(1, due);
    e.loop.changed('later');
    await w.clock.set(due + MIN);
    await e.loop.idle();
    assert.equal(w.events.length, 1);
    // The clock went back and the watermark with it: the same return is seen again and stays silent.
    w.store.commit({
      opId: 'rewind',
      origin: 'system',
      writes: [{ kind: 'meta', key: 'later.fired_through', value: String(due - HOUR) }],
    });
    await e.later.source.fire(due + 2 * MIN);
    assert.equal(w.events.length, 1);

    for (let n = 2; n <= 30; n++) w.snooze(n, due + 10 * MIN + n * MIN);
    await w.clock.set(due + DAY);
    await e.loop.idle();
    assert.equal(w.events.length, 1 + 20, 'twenty of the twenty-nine, soonest first');
    assert.equal(w.events[1].threadId, threadId(2));
    await w.clock.set(due + 2 * DAY);
    await e.loop.idle();
    assert.equal(w.events.length, 21, 'the rest are not announced later');
    e.stop();
  } finally {
    w.done();
  }
});

test('a watermark written by a clock that was ahead does not silence a Later that is due now', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const first = w.boot();
    await first.loop.idle();
    first.stop();
    w.store.commit({
      opId: 'ahead',
      origin: 'system',
      writes: [
        { kind: 'meta', key: 'later.fired_through', value: String(w.clock.now() + 10 * DAY) },
      ],
    });
    w.snooze(1, w.clock.now() + HOUR);
    const e = w.boot();
    await w.clock.set(w.clock.now() + HOUR);
    await e.loop.idle();
    assert.deepEqual(idsOf(w), [threadId(1)]);
    e.stop();
  } finally {
    w.done();
  }
});

// ------------------------------------------------------------ the queries

test('the due and next queries use the indexes built for them', () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const plan = (sql: string) =>
      w.store
        .read(q =>
          q.all<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${sql}`,
            ...(sql.match(/\?/g) ?? []).map(() => 0),
          ),
        )
        .map(r => r.detail)
        .join(' | ');
    // Both partial indexes now exist on reminder_at (0004 added `reminders_wf`); the pending reads name `timers_wf`.
    assert.match(plan(REMINDER_QUERIES.due), /timers_wf/);
    assert.match(plan(REMINDER_QUERIES.next), /timers_wf/);
    assert.doesNotMatch(plan(REMINDER_QUERIES.due), /SCAN w(?! USING)|TEMP B-TREE/);
    assert.match(plan(LATER_QUERIES.due), /wf_later/);
    assert.match(plan(LATER_QUERIES.next), /wf_later/);
  } finally {
    w.done();
  }
});

// ------------------------------------------------------------ through the engine

/** The real engine (every lane module): the handlers, the host event and the views lane's own writes. */
async function engineWorld() {
  const file = tempDb();
  const clock = fakeClock(utc('2026-10-28T16:00:00Z'));
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({
    opId: 'seed',
    origin: 'import',
    writes: [accountWrite, ...folderWrites, msg('m1', 't1', 0), msg('m2', 't2', 1)],
  });
  const engine = await createEngine({ store, clock, log });
  const main = engine.connect({ kind: 'host', scopes: ['host', 'read', 'triage'] });
  const hostEvents: NotificationItem[] = [];
  main.subscribe((f: Frame) => {
    if (f.frame === 'host' && f.event.type === 'reminder') hostEvents.push(f.event.item);
  });
  const window = engine.connect();
  return {
    clock,
    hostEvents,
    store,
    engine,
    call: ((method: string, args: unknown) => window.call(method as never, args as never)) as (
      method: string,
      args: unknown,
    ) => Promise<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    async cleanup() {
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

test('Thread/act reminder, the reminder host event, Reminder/list and Reminder/ack work end to end', async () => {
  const w = await engineWorld();
  try {
    const due = w.clock.now() + 2 * MIN;
    await w.call('Thread/act', {
      opId: 'r1',
      ids: [threadId(1)],
      action: { type: 'reminder', at: due },
    });
    // Nothing called deadlines.changed: the source's own recheck notices the new reminder.
    await w.clock.advance(MIN);
    assert.equal(w.hostEvents.length, 0);
    assert.equal((await w.call('Reminder/list', {})).items[0].firedAt, undefined);
    await w.clock.advance(MIN);
    assert.equal(w.hostEvents.length, 1);
    assert.equal(w.hostEvents[0].threadId, threadId(1));
    assert.equal(w.hostEvents[0].at, due);
    const listed = await w.call('Reminder/list', {});
    assert.deepEqual(
      listed.items.map((i: { threadId: string; firedAt?: number }) => [i.threadId, i.firedAt]),
      [[threadId(1), due]],
    );
    const receipt = await w.call('Reminder/ack', { opId: 'a1', threadIds: [threadId(1)] });
    assert.equal(receipt.opId, 'a1');
    assert.equal(receipt.undoable, false);
    assert.equal(receipt.appliedState.seq, w.store.seq());
    assert.deepEqual((await w.call('Reminder/list', {})).items, []);
    await w.clock.advance(HOUR);
    assert.equal(w.hostEvents.length, 1);
  } finally {
    await w.cleanup();
  }
});

test('Later/presets answers in the configured zone with the engine clock', async () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  const w = await engineWorld();
  try {
    const out = await w.call('Later/presets', {});
    assert.equal(out.now, w.clock.now());
    // 2026-10-28T16:00Z is Thu Oct 29 01:00 in Tokyo: evening is 18:00 JST = 09:00Z, tomorrow Fri 8:00 JST = 23:00Z.
    const until = Object.fromEntries(
      out.presets.map((p: { key: string; until?: number }) => [p.key, p.until]),
    );
    assert.equal(new Date(until.evening).toISOString(), '2026-10-29T09:00:00.000Z');
    assert.equal(new Date(until.tomorrow).toISOString(), '2026-10-29T23:00:00.000Z');
    assert.equal(until.someday, undefined);
  } finally {
    await w.cleanup();
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('a Later set through Thread/act is announced when its time comes', async () => {
  const w = await engineWorld();
  try {
    const until = w.clock.now() + 3 * MIN;
    await w.call('Thread/act', {
      opId: 'l1',
      ids: [threadId(2)],
      action: { type: 'later', until },
    });
    await w.clock.advance(3 * MIN);
    assert.deepEqual(
      w.hostEvents.map(e => [e.kind, e.threadId]),
      [['later', threadId(2)]],
    );
  } finally {
    await w.cleanup();
  }
});
