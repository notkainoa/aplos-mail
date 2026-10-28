import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createTimerLoop, fakeClock } from '../../src/clock/module';
import {
  createTimeSources,
  LATER_QUERIES,
  REMINDER_QUERIES,
  resolvePresets,
  type LaterEvent,
  type ReminderEvent,
} from '../../src/clock/sources';
import { localTime, zonedEpoch } from '../../src/clock/zone';
import { dispatch, type EngineServices, type MethodContext } from '../../src/methods/index';
import { openStore, type StorePort } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';

const LA = 'America/Los_Angeles';
const utc = (iso: string) => Date.parse(iso);
const threadId = (n: number) => `${ACCOUNT}:t${n}`;

/** A store with threads t1..tN, a fake clock, the timer loop and both sources registered on it. */
function setup(threads: number, start: string, zone = LA) {
  const file = tempDb();
  const clock = fakeClock(utc(start));
  const store = openStore(file.open(), { now: clock.now });
  const writes = Array.from({ length: threads }, (_, i) => msg(`m${i + 1}`, `t${i + 1}`, i));
  store.commit({
    opId: 'seed',
    origin: 'import',
    writes: [accountWrite, ...folderWrites, ...writes],
  });
  const records: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'test-salt',
    clock,
    level: 'debug',
  });
  const loop = createTimerLoop({ clock, log });
  const reminderEvents: ReminderEvent[] = [];
  const laterEvents: LaterEvent[] = [];
  const sources = createTimeSources({
    store,
    clock,
    deadlines: loop,
    emit: e => reminderEvents.push(e),
    emitLater: e => laterEvents.push(e),
    timeZone: () => zone,
  });
  let opN = 0;
  const patch = (n: number, fields: Record<string, unknown>) =>
    store.commit({
      opId: `edit-${opN++}`,
      origin: 'local',
      writes: [
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: `t${n}`,
          patch: fields,
        },
      ],
    });
  return {
    clock,
    store,
    loop,
    sources,
    reminderEvents,
    laterEvents,
    patch,
    stuck: () => records.filter(r => r.event === 'engine.watchdog').length,
    done: () => {
      loop.stop();
      store.close();
      file.cleanup();
    },
  };
}

const workflowOf = (store: StorePort, n: number) =>
  store.read(q =>
    q.get<{
      status: string;
      later_until: number | null;
      reminder_at: number | null;
      reminder_fired_at: number | null;
    }>(
      `SELECT w.status, w.later_until, w.reminder_at, w.reminder_fired_at FROM thread_workflow w
       JOIN threads t ON t.id = w.thread_id WHERE t.remote_id = ?`,
      `t${n}`,
    ),
  )!;

// ------------------------------------------------------------ time zone math

test('zonedEpoch: a wall time across DST, a repeated hour and a skipped hour', () => {
  // Spring forward 2026-03-08 (02:00 -> 03:00): 09:00 that day is PDT (UTC-7).
  assert.equal(new Date(zonedEpoch(LA, 2026, 3, 8, 9)).toISOString(), '2026-03-08T16:00:00.000Z');
  // Fall back 2026-11-01: 09:00 is PST (UTC-8), the day before it is PDT.
  assert.equal(new Date(zonedEpoch(LA, 2026, 11, 1, 9)).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.equal(new Date(zonedEpoch(LA, 2026, 10, 31, 9)).toISOString(), '2026-10-31T16:00:00.000Z');
  // 01:30 happens twice on 2026-11-01; the first (PDT) wins.
  assert.equal(
    new Date(zonedEpoch(LA, 2026, 11, 1, 1, 30)).toISOString(),
    '2026-11-01T08:30:00.000Z',
  );
  // 02:30 does not exist on 2026-03-08; it lands after the gap, at 03:30 PDT.
  assert.equal(
    new Date(zonedEpoch(LA, 2026, 3, 8, 2, 30)).toISOString(),
    '2026-03-08T10:30:00.000Z',
  );
  // A day past the end of the month rolls over.
  assert.equal(new Date(zonedEpoch(LA, 2026, 10, 32, 9)).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.deepEqual(localTime(utc('2026-11-01T17:00:00Z'), LA), {
    year: 2026,
    month: 11,
    day: 1,
    hour: 9,
    minute: 0,
    second: 0,
    weekday: 0,
  });
});

test('Later presets: a weekday morning, the evening cutoff, and a weekend', () => {
  const at = (iso: string) =>
    Object.fromEntries(
      resolvePresets(utc(iso), LA).map(p => [p.key, p.until && new Date(p.until).toISOString()]),
    );
  // Wed 2026-10-28 08:00 PDT.
  assert.deepEqual(at('2026-10-28T15:00:00Z'), {
    'today-evening': '2026-10-29T01:00:00.000Z',
    tomorrow: '2026-10-29T16:00:00.000Z',
    weekend: '2026-10-31T16:00:00.000Z',
    'next-week': '2026-11-02T17:00:00.000Z',
    someday: undefined,
  });
  assert.ok('today-evening' in at('2026-10-28T23:59:00Z'), '16:59 local is before the cutoff');
  assert.ok(!('today-evening' in at('2026-10-29T00:00:00Z')), '17:00 local is not');
  // Sat 2026-10-31 20:00 PDT, the evening before the clocks go back: This weekend is already here.
  assert.deepEqual(at('2026-11-01T03:00:00Z'), {
    tomorrow: '2026-11-01T17:00:00.000Z',
    'next-week': '2026-11-02T17:00:00.000Z',
    someday: undefined,
  });
  // Sat 2026-10-31 06:00 PDT: the weekend is still ahead, at 09:00 today.
  assert.equal(at('2026-10-31T13:00:00Z').weekend, '2026-10-31T16:00:00.000Z');
  // Sun 2026-11-01 10:00 PST: no weekend; Monday is tomorrow, so Next week is tomorrow too.
  const sunday = at('2026-11-01T18:00:00Z');
  assert.equal(sunday.weekend, undefined);
  assert.equal(sunday.tomorrow, sunday['next-week']);
});

test('Later/presets answers in the configured zone from the engine clock, and survives a bad zone', async () => {
  let zone = 'Pacific/Auckland';
  const t = setup(0, '2026-10-28T15:00:00Z', zone);
  const ctx = {
    caller: { kind: 'window', scopes: ['read'] },
    signal: new AbortController().signal,
    services: {
      later: t.sources.later,
      reminders: t.sources.reminders,
    } as unknown as EngineServices,
  } as MethodContext;
  try {
    const out = (await dispatch('Later/presets', {}, ctx)) as {
      now: number;
      presets: { key: string; until?: number }[];
    };
    assert.equal(out.now, t.clock.now());
    // 15:00Z is 04:00 NZDT on Thursday the 29th; Tomorrow 09:00 NZDT is 2026-10-29T20:00Z.
    assert.equal(out.presets.find(p => p.key === 'tomorrow')?.until, utc('2026-10-29T20:00:00Z'));
    zone = 'Not/AZone';
    assert.ok(resolvePresets(t.clock.now(), 'UTC').length >= 4);
    assert.doesNotThrow(() => t.sources.later.presets());
  } finally {
    t.done();
  }
});

// ------------------------------------------------------------ reminders and Later fire

test('late fires once: a three-day jump across DST fires every reminder once with its was-due time', async () => {
  const t = setup(4, '2026-10-28T15:00:00Z');
  try {
    const due = [
      utc('2026-10-29T16:00:00Z'), // 09:00 PDT
      utc('2026-10-31T16:00:00Z'), // 09:00 PDT
      utc('2026-11-01T17:00:00Z'), // 09:00 PST, after the clocks went back
    ];
    due.forEach((reminderAt, i) => t.patch(i + 1, { reminderAt }));
    t.patch(4, { reminderAt: utc('2026-11-03T17:00:00Z') });
    t.loop.start();
    await t.clock.flush();

    const wake = utc('2026-11-01T20:00:00Z'); // the Mac wakes three days later
    await t.clock.set(wake);
    assert.deepEqual(
      t.reminderEvents.map(e => [e.threadId, e.dueAt, e.firedAt]),
      due.map((at, i) => [threadId(i + 1), at, wake]),
    );
    assert.ok(wake - due[0] > 2 * 86_400_000, 'the first one is days late');
    for (let n = 1; n <= 3; n++) assert.equal(workflowOf(t.store, n).reminder_fired_at, wake);
    assert.equal(workflowOf(t.store, 4).reminder_fired_at, null, 'a future reminder waits');

    t.loop.wake();
    await t.clock.advance(60_000);
    await t.clock.advance(60 * 60_000);
    assert.equal(
      t.reminderEvents.length,
      3,
      'a re-read, a wake and an hour more fire nothing twice',
    );
    assert.equal(t.stuck(), 0, 'every fire moved next() past now');

    await t.clock.set(utc('2026-11-03T17:00:00Z'));
    assert.deepEqual(
      t.reminderEvents.slice(3).map(e => [e.threadId, e.dueAt, e.firedAt]),
      [[threadId(4), utc('2026-11-03T17:00:00Z'), utc('2026-11-03T17:00:00Z')]],
      'on time: fired at its own due time',
    );
    assert.equal(t.reminderEvents.length, 4);
  } finally {
    t.done();
  }
});

test('late fires once: Later set the evening before the DST change returns at 09:00 local after it', async () => {
  const t = setup(3, '2026-11-01T03:00:00Z'); // Sat 2026-10-31 20:00 PDT
  try {
    const tomorrow = t.sources.later.presets().presets.find(p => p.key === 'tomorrow')!.until!;
    assert.equal(
      new Date(tomorrow).toISOString(),
      '2026-11-01T17:00:00.000Z',
      '09:00 PST, not 08:00',
    );
    t.patch(1, { status: 'later', laterUntil: tomorrow });
    t.patch(2, { status: 'later', laterUntil: tomorrow + 3_600_000 });
    t.patch(3, { status: 'done', laterUntil: tomorrow }); // not in Later: never touched
    t.loop.start();
    await t.clock.flush();

    await t.clock.set(tomorrow - 1);
    assert.equal(
      workflowOf(t.store, 1).status,
      'later',
      'a 24 h timer would have fired an hour early',
    );
    await t.clock.set(tomorrow);
    assert.equal(workflowOf(t.store, 1).status, 'new');
    assert.equal(workflowOf(t.store, 1).later_until, null);
    assert.equal(workflowOf(t.store, 2).status, 'later');
    await t.clock.set(tomorrow + 4 * 86_400_000); // a long sleep
    assert.equal(workflowOf(t.store, 2).status, 'new');
    assert.equal(workflowOf(t.store, 3).status, 'done');
    assert.deepEqual(
      t.laterEvents.map(e => [e.threadId, e.dueAt, e.firedAt]),
      [
        [threadId(1), tomorrow, tomorrow],
        [threadId(2), tomorrow + 3_600_000, tomorrow + 4 * 86_400_000],
      ],
    );
    assert.equal(t.stuck(), 0);
  } finally {
    t.done();
  }
});

test('two fires racing for the same now mark each reminder and each Later thread once', async () => {
  const t = setup(2, '2026-10-28T15:00:00Z');
  try {
    const at = t.clock.now() - 3_600_000;
    t.patch(1, { reminderAt: at });
    t.patch(2, { status: 'later', laterUntil: at });
    const now = t.clock.now();
    await Promise.all([
      t.sources.reminders.source.fire(now),
      t.sources.reminders.source.fire(now),
      t.sources.later.source.fire(now),
      t.sources.later.source.fire(now),
    ]);
    assert.equal(t.reminderEvents.length, 1);
    assert.equal(t.laterEvents.length, 1);
    assert.equal(workflowOf(t.store, 1).reminder_fired_at, now);
    // A fire at a later instant (a crash re-fire) changes nothing.
    await t.sources.reminders.source.fire(now + 1_000);
    assert.equal(workflowOf(t.store, 1).reminder_fired_at, now);
    assert.equal(t.reminderEvents.length, 1);
    assert.equal(await t.sources.reminders.source.next(), undefined, 'next() moved past now');
    assert.equal(await t.sources.later.source.next(), undefined);
  } finally {
    t.done();
  }
});

test('a re-fire of a set already committed (a second engine, a crash) replays and emits nothing', async () => {
  const t = setup(1, '2026-10-28T15:00:00Z');
  try {
    const now = t.clock.now();
    t.patch(1, { reminderAt: now - 1_000 });
    await t.sources.reminders.source.fire(now);
    // The other engine read the same due row before the commit and now commits the same fire.
    t.patch(1, { reminderAt: now - 1_000, reminderFiredAt: null });
    await t.sources.reminders.source.fire(now);
    assert.equal(t.reminderEvents.length, 1, 'same set at the same now: replayed, silent');
  } finally {
    t.done();
  }
});

test('both sources read their deadline from their partial index', () => {
  const t = setup(0, '2026-10-28T15:00:00Z');
  try {
    const cases = [
      [REMINDER_QUERIES, 'timers_wf'],
      [LATER_QUERIES, 'wf_later'],
    ] as const;
    for (const [queries, index] of cases)
      for (const [name, sql] of Object.entries(queries)) {
        const plan = t.store.read(q =>
          q.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(name === 'due' ? [0] : [])),
        );
        assert.ok(
          plan.some(r => String(r.detail).includes(index)),
          `${name} uses ${index}: ${plan.map(r => r.detail).join('; ')}`,
        );
      }
  } finally {
    t.done();
  }
});

// ------------------------------------------------------------ Reminder/list and Reminder/ack

test('Reminder/list shows upcoming and fired-not-acked with titles; Reminder/ack marks seen once', async () => {
  const t = setup(3, '2026-10-28T15:00:00Z');
  try {
    const now = t.clock.now();
    t.patch(1, { reminderAt: now - 60_000 });
    t.patch(2, { reminderAt: now + 3_600_000 });
    await t.sources.reminders.source.fire(now);
    const ctx = {
      caller: { kind: 'window', scopes: ['read', 'triage'] },
      signal: new AbortController().signal,
      services: {
        reminders: t.sources.reminders,
        later: t.sources.later,
      } as unknown as EngineServices,
    } as MethodContext;

    const list = async () =>
      ((await dispatch('Reminder/list', {}, ctx)) as { items: Record<string, unknown>[] }).items;
    assert.deepEqual(await list(), [
      {
        threadId: threadId(1),
        at: now - 60_000,
        firedAt: now,
        ifNoReply: false,
        title: 'Subject t1',
      },
      { threadId: threadId(2), at: now + 3_600_000, ifNoReply: false, title: 'Subject t2' },
    ]);

    const ack = (opId: string, ids: string[]) =>
      dispatch('Reminder/ack', { opId, threadIds: ids }, ctx) as Promise<{
        opId: string;
        appliedState: { dbEpoch: string; seq: number };
        undoable?: boolean;
      }>;
    const first = await ack('ack-1', [threadId(1), threadId(2), 'nobody:t9']);
    assert.equal(first.opId, 'ack-1');
    assert.equal(first.undoable, false);
    assert.equal(first.appliedState.seq, t.store.seq());
    assert.deepEqual(
      (await list()).map(i => i.threadId),
      [threadId(2)],
      'the fired one is seen; the unfired one is not touched',
    );
    assert.equal(
      workflowOf(t.store, 1).reminder_fired_at,
      now,
      'the fire time stays for the thread row',
    );
    assert.equal(workflowOf(t.store, 2).reminder_at, now + 3_600_000);

    const again = await ack('ack-1', [threadId(1)]);
    assert.deepEqual(again.appliedState, first.appliedState, 'a replayed opId changes nothing');
    const nothing = await ack('ack-2', [threadId(1)]);
    assert.equal(
      nothing.appliedState.seq,
      first.appliedState.seq,
      'acking the seen again writes nothing',
    );
  } finally {
    t.done();
  }
});

test('a reminder set while the loop sleeps is picked up by changed()', async () => {
  const t = setup(1, '2026-10-28T15:00:00Z');
  try {
    t.loop.start();
    await t.clock.flush();
    assert.equal(t.clock.pending(), 0, 'nothing to wait for');
    t.patch(1, { reminderAt: t.clock.now() + 60_000 });
    t.loop.changed('reminders');
    await t.clock.advance(59_999);
    assert.equal(t.reminderEvents.length, 0);
    await t.clock.advance(1);
    assert.equal(t.reminderEvents.length, 1);
  } finally {
    t.done();
  }
});
