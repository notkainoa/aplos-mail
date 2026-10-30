import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, NotificationItem } from '@aplos/contract';
import { fakeClock } from '../../src/clock/module';
import { createLater } from '../../src/clock/sources/later';
import {
  MAX_LISTED,
  MAX_REMINDERS_PER_FIRE,
  REMINDER_QUERIES,
} from '../../src/clock/sources/reminders';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { DAY, HOUR, idsOf, LA, MIN, SEC, threadId, utc, world, type World } from './world.helpers';

// The fixes after the time-4 review: idle Later fires, bounded reminder reads and fires, titles, a first announcement
// nobody hears, and a reminder set again.

const commitRows = (w: World) =>
  w.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM commits')!.n);

test('Later: 1,000 idle fires write no commit rows (the watermark is kept in memory)', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const later = createLater({
      store: w.store,
      clock: w.clock,
      frames: { emit: () => undefined },
      zone: () => LA,
    });
    later.start();
    const before = commitRows(w);
    for (let i = 0; i < 1_000; i++) {
      await w.clock.set(w.clock.now() + MIN);
      await later.source.fire(w.clock.now());
    }
    assert.equal(commitRows(w), before, 'no commit row for an idle fire');
    assert.equal(w.events.length, 0);
  } finally {
    w.done();
  }
});

test('Later: the stored watermark is refreshed once it is more than a day old', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const later = createLater({
      store: w.store,
      clock: w.clock,
      frames: { emit: () => undefined },
      zone: () => LA,
    });
    later.start();
    const before = commitRows(w);
    await w.clock.set(w.clock.now() + DAY + MIN);
    await later.source.fire(w.clock.now());
    await w.clock.set(w.clock.now() + MIN);
    await later.source.fire(w.clock.now());
    assert.equal(commitRows(w), before + 1);
  } finally {
    w.done();
  }
});

test('Later: a due return still moves the stored watermark and is announced once', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const e = w.boot();
    await e.loop.idle();
    w.snooze(1, w.clock.now() + 2 * MIN);
    await w.clock.advance(3 * MIN);
    await e.loop.idle();
    assert.deepEqual(idsOf(w), [threadId(1)]);
    const stored = w.store.read(q =>
      q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'later.fired_through'"),
    );
    assert.ok(Number(stored?.value) >= w.clock.now() - 2 * MIN);
    e.stop();
  } finally {
    w.done();
  }
});

test('Reminder/list queries: upcoming uses timers_wf, fired uses reminders_wf, both are capped and never scan or sort', () => {
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
    const unindexedScan = /SCAN w(?! USING)|TEMP B-TREE/;
    assert.match(plan(REMINDER_QUERIES.upcoming), /timers_wf/);
    assert.doesNotMatch(plan(REMINDER_QUERIES.upcoming), unindexedScan);
    assert.match(REMINDER_QUERIES.upcoming, /LIMIT \?/);
    assert.match(REMINDER_QUERIES.fired, /LIMIT \?/);
    assert.equal(MAX_LISTED, 200);
    // Migration 0004's `reminders_wf` covers the fired ones: ordered by the index, so no scan of the table and no sort.
    assert.match(plan(REMINDER_QUERIES.fired), /reminders_wf/);
    assert.doesNotMatch(plan(REMINDER_QUERIES.fired), unindexedScan);
  } finally {
    w.done();
  }
});

test('Reminder/list returns at most 200 upcoming and 200 fired reminders, soonest first', async () => {
  const w = world('2026-10-28T16:00:00Z', LA, 450);
  try {
    const now = w.clock.now();
    for (let n = 1; n <= 450; n++) w.remind(n, now + n * MIN);
    const r = w.boot();
    const listed = r.reminders.list();
    assert.equal(listed.length, MAX_LISTED);
    assert.deepEqual(
      listed.map(i => i.at),
      Array.from({ length: MAX_LISTED }, (_, i) => now + (i + 1) * MIN),
    );
    r.stop();
  } finally {
    w.done();
  }
});

test('reminders fire in capped batches: 200 overdue reminders all fire exactly once across passes', async () => {
  const w = world('2026-10-28T16:00:00Z', LA, 200);
  try {
    const past = w.clock.now() - HOUR;
    for (let n = 1; n <= 200; n++) w.remind(n, past + n);
    const e = w.boot();
    await e.loop.idle();
    assert.equal(w.events.length, MAX_REMINDERS_PER_FIRE, 'one fire announces at most the cap');
    for (let i = 0; i < 10 && w.events.length < 200; i++) {
      await w.clock.advance(SEC + 1);
      await e.loop.idle();
    }
    assert.equal(w.events.length, 200);
    assert.equal(new Set(w.events.map(ev => ev.threadId)).size, 200, 'each exactly once');
    await w.clock.advance(HOUR);
    await e.loop.idle();
    assert.equal(w.events.length, 200);
    e.stop();
  } finally {
    w.done();
  }
});

test('Reminder/list clamps a 5,000-character subject to the contract text limit', () => {
  const w = world('2026-10-28T16:00:00Z', LA, 1);
  try {
    w.store.commit({
      opId: 'long-subject',
      origin: 'import',
      writes: [msg('m9', 't9', 9, { subject: 'x'.repeat(5_000) })],
    });
    w.remind(9, w.clock.now() + HOUR);
    const r = w.boot();
    const item = r.reminders.list().find(i => i.threadId === threadId(9))!;
    assert.ok(item.title.length > 0 && item.title.length <= 2_000);
    r.stop();
  } finally {
    w.done();
  }
});

test('a reminder due before any host connection exists is still visible in Reminder/list, was-due and all', async () => {
  const file = tempDb();
  const clock = fakeClock(utc('2026-10-28T16:00:00Z'));
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({
    opId: 'seed',
    origin: 'import',
    writes: [accountWrite, ...folderWrites, msg('m1', 't1', 0)],
  });
  const due = clock.now() - 3 * HOUR;
  store.commit({
    opId: 'set',
    origin: 'local',
    writes: [
      {
        kind: 'workflow',
        accountId: ACCOUNT,
        remoteThreadId: 't1',
        patch: { reminderAt: due, editedAt: due - HOUR },
      },
    ],
  });
  const engine = await createEngine({ store, clock, log });
  try {
    await (engine.services.deadlines as unknown as { idle(): Promise<void> }).idle();
    // The host subscribes only now: the host event fired into the void.
    const hostEvents: NotificationItem[] = [];
    const main = engine.connect({ kind: 'host', scopes: ['host', 'read', 'triage'] });
    main.subscribe((f: Frame) => {
      if (f.frame === 'host' && f.event.type === 'reminder') hostEvents.push(f.event.item);
    });
    assert.deepEqual(hostEvents, []);
    const window = engine.connect();
    const out = await window.call('Reminder/list' as never, {} as never);
    const items = (out as { items: { threadId: string; at: number; firedAt?: number }[] }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].threadId, threadId(1));
    assert.equal(items[0].at, due, 'the was-due time');
    assert.equal(items[0].firedAt, clock.now(), 'fired at launch');
  } finally {
    await engine.close();
    store.close();
    file.cleanup();
  }
});

test('setting the same time again after it fired notifies again (the opId names edited_at)', async () => {
  const w = world('2026-10-28T16:00:00Z');
  try {
    const e = w.boot();
    const due = w.clock.now() + 5 * MIN;
    w.remind(1, due);
    await w.clock.advance(5 * MIN);
    await e.loop.idle();
    assert.equal(w.events.length, 1);
    // The owner sets exactly the same reminder time again (the thread was edited at a later instant).
    w.remind(1, due);
    await w.clock.advance(MIN);
    await e.loop.idle();
    assert.equal(w.events.length, 2, 'a second notification for the re-set reminder');
    assert.equal(w.events[1].threadId, threadId(1));
    // And it is not announced a third time.
    await w.clock.advance(HOUR);
    await e.loop.idle();
    assert.equal(w.events.length, 2);
    e.stop();
  } finally {
    w.done();
  }
});
