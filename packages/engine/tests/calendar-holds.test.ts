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

// Held calendar writes (prov-cal): a change that tells guests waits its undo window, can be undone before Google hears
// of it, reads `queued` through Operation/get, survives a restart and can be retried when it fails.

const SAVED: CalendarWriteResult = { kind: 'saved', upserts: [], removals: [] };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
};

type Answer = () => Promise<CalendarWriteResult>;

async function rig(answer: Answer = () => Promise.resolve(SAVED)) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const calls: string[] = [];
  let next = answer;
  const calendar: CalendarPort = {
    put: () => (calls.push('put'), next()),
    remove: () => (calls.push('remove'), next()),
    rsvp: () => (calls.push('rsvp'), next()),
  };
  const boot = async () => {
    const engine = await createEngine({ store, clock, log, ports: { calendar } });
    const window = engine.connect();
    const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
      window.call(method, args) as Promise<Output<M>>;
    return { engine, call };
  };
  store.commit({ opId: 'a', origin: 'local', writes: [{ ...accountWrite }] });
  store.commit({
    opId: 'cal',
    origin: 'sync',
    writes: [
      {
        kind: 'calendar',
        accountId: 'acct-1',
        remoteId: 'primary',
        name: 'Personal',
        hidden: false,
        readOnly: false,
        selected: true,
      },
      ...['ev1', 'ev2'].map(remoteId => ({
        kind: 'event' as const,
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId,
        rows: [
          {
            status: 'confirmed',
            etag: '"v1"',
            startUtc: Date.UTC(2026, 9, 27, 17, 0),
            endUtc: Date.UTC(2026, 9, 27, 17, 30),
            allDay: false,
            data: JSON.stringify({ summary: 'Standup', status: 'confirmed' }),
          },
        ],
      })),
    ],
  });
  return { ...(await boot()), boot, clock, calls, store, setAnswer: (a: Answer) => (next = a) };
}

const rename = (opId: string, id = 'acct-1:primary/ev1') => ({
  opId,
  notify: true,
  change: {
    type: 'update' as const,
    id,
    scope: 'series' as const,
    fields: { title: 'Renamed' },
  },
});

test('a change that tells guests is held: undoable, nothing sent, and sent once when the window ends', async () => {
  const w = await rig();
  const { receipt } = await w.call('Event/set', rename('h1'));
  assert.equal(receipt.undoable, true);
  assert.equal(receipt.undoUntil, w.clock.now() + 8_000, 'the owner’s undo-send window');
  assert.deepEqual(w.calls, []);
  const held = await w.call('Operation/get', { opIds: ['h1', 'unknown'] });
  assert.equal(held.list[0]!.state, 'queued');
  assert.equal(held.list[0]!.undoable, true);
  assert.equal(held.list[0]!.scope, 'send');
  assert.deepEqual(held.notFound, ['unknown']);

  w.clock.advance(7_000);
  await settle();
  assert.deepEqual(w.calls, [], 'still inside the window');
  w.clock.advance(1_500);
  await settle();
  assert.deepEqual(w.calls, ['put']);
  const done = await w.call('Operation/get', { opIds: ['h1'] });
  assert.equal(done.list[0]!.state, 'synced');
  assert.equal(done.list[0]!.undoable, false);
  w.clock.advance(60_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'never sent twice');
});

test('undo inside the window cancels it before Google hears of it; after it, undo says it was sent', async () => {
  const w = await rig();
  await w.call('Event/set', rename('u1'));
  const undone = await w.call('Operation/undo', { opId: 'u1', undoOpId: 'u1-undo' });
  assert.equal(undone.opId, 'u1-undo');
  assert.equal((await w.call('Operation/get', { opIds: ['u1'] })).list[0]!.state, 'cancelled');
  w.clock.advance(60_000);
  await settle();
  assert.deepEqual(w.calls, [], 'a cancelled change is never sent');
  await assert.rejects(
    w.call('Operation/undo', { opId: 'u1', undoOpId: 'u1-again' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );

  await w.call('Event/set', rename('u2'));
  w.clock.advance(9_000);
  await settle();
  await assert.rejects(
    w.call('Operation/undo', { opId: 'u2', undoOpId: 'u2-undo' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );
  assert.deepEqual(w.calls, ['put']);
});

test('a change that tells no one goes at once and is not undoable', async () => {
  const w = await rig();
  const { receipt } = await w.call('Event/set', { ...rename('n1'), notify: false });
  assert.notEqual(receipt.undoable, true);
  assert.deepEqual(w.calls, ['put']);
});

test('a held answer is a failed operation with the plain error, and Retry sends it again', async () => {
  const w = await rig(() =>
    Promise.reject(
      new ContractError({
        type: 'unavailable',
        message: 'Google Calendar is not available right now. Nothing was changed. Try again soon.',
        reasonCode: 'calendar.unavailable',
      }),
    ),
  );
  await w.call('Event/set', rename('f1'));
  w.clock.advance(9_000);
  await settle();
  const failed = (await w.call('Operation/get', { opIds: ['f1'] })).list[0]!;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error?.reasonCode, 'calendar.unavailable');
  assert.equal(failed.undoable, false);

  w.setAnswer(() => Promise.resolve(SAVED));
  await w.call('Operation/retry', { opId: 'f1' });
  assert.equal((await w.call('Operation/get', { opIds: ['f1'] })).list[0]!.state, 'synced');
  assert.deepEqual(w.calls, ['put', 'put']);
  await assert.rejects(
    w.call('Operation/retry', { opId: 'f1' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );
});

test('a conflict at send time is a failed operation that says the event changed elsewhere', async () => {
  const w = await rig(() => Promise.resolve({ kind: 'conflict' }));
  await w.call('Event/set', rename('c1'));
  w.clock.advance(9_000);
  await settle();
  const op = (await w.call('Operation/get', { opIds: ['c1'] })).list[0]!;
  assert.equal(op.state, 'failed');
  assert.equal(op.error?.reasonCode, 'calendar.conflict');
});

test('a hold survives a restart: the new engine sends it once its window has ended', async () => {
  const w = await rig();
  await w.call('Event/set', rename('r1'));
  await w.engine.close();
  w.clock.advance(20_000);
  const again = await w.boot();
  w.clock.advance(1_000);
  await settle();
  assert.deepEqual(w.calls, ['put']);
  assert.equal((await again.call('Operation/get', { opIds: ['r1'] })).list[0]!.state, 'synced');
  await again.engine.close();
});

test('a send the previous run never finished is reported uncertain, never sent again', async () => {
  const w = await rig();
  await w.call('Event/set', rename('s1'));
  const key = 'calendar.hold.s1';
  const row = w.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key),
  )!;
  w.store.commit({
    opId: 'crash',
    origin: 'local',
    writes: [
      { kind: 'meta', key, value: JSON.stringify({ ...JSON.parse(row.value), state: 'syncing' }) },
    ],
  });
  await w.engine.close();
  const again = await w.boot();
  w.clock.advance(1_000);
  await settle();
  const op = (await again.call('Operation/get', { opIds: ['s1'] })).list[0]!;
  assert.equal(op.state, 'failed');
  assert.equal(op.error?.reasonCode, 'calendar.uncertain');
  assert.deepEqual(w.calls, []);
  await again.engine.close();
});

test('undo and retry need the scope of the method that made the change, not only their own', async () => {
  const w = await rig();
  await w.call('Event/set', rename('p1'));
  const cheap = w.engine.connect({
    kind: 'listener',
    via: 'socket',
    clientId: 'tool',
    scopes: ['read', 'triage'],
  });
  await assert.rejects(
    cheap.call('Operation/undo', { opId: 'p1', undoOpId: 'p1-undo' }),
    (e: unknown) => e instanceof ContractError && e.type === 'forbidden',
  );
  assert.equal((await w.call('Operation/get', { opIds: ['p1'] })).list[0]!.state, 'queued');
});

test('an undo that lands while an earlier hold is still sending stops the next one', async () => {
  let release!: () => void;
  const w = await rig(
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        release = () => resolve(SAVED);
      }),
  );
  await w.call('Event/set', rename('d1'));
  await w.call('Event/set', rename('d2', 'acct-1:primary/ev2'));
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'the first is on its way, the second waits behind it');
  await w.call('Operation/undo', { opId: 'd2', undoOpId: 'd2-undo' });
  release();
  await settle();
  w.clock.advance(1_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'the undone change is never sent');
  assert.equal((await w.call('Operation/get', { opIds: ['d1'] })).list[0]!.state, 'synced');
  assert.equal((await w.call('Operation/get', { opIds: ['d2'] })).list[0]!.state, 'cancelled');
});

const withGuest = (opId: string, id = 'acct-1:primary/ev1') => ({
  opId,
  notify: true,
  change: {
    type: 'update' as const,
    id,
    scope: 'series' as const,
    fields: { attendees: [{ address: 'friend@example.test' }] },
  },
});
const metaRow = (w: Awaited<ReturnType<typeof rig>>, opId: string) =>
  w.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', `calendar.hold.${opId}`),
  );

test('two Retry presses send once: the second sees the first already sending', async () => {
  let fail = true;
  let release!: () => void;
  const w = await rig(() =>
    fail
      ? Promise.reject(
          new ContractError({
            type: 'unavailable',
            message: 'x',
            reasonCode: 'calendar.unavailable',
          }),
        )
      : new Promise<CalendarWriteResult>(resolve => {
          release = () => resolve(SAVED);
        }),
  );
  await w.call('Event/set', rename('rr1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['rr1'] })).list[0]!.state, 'failed');
  fail = false;
  const first = w.call('Operation/retry', { opId: 'rr1' });
  await settle();
  // The retry's own `syncing` was saved (it once was dropped as a repeated commit id).
  assert.equal((await w.call('Operation/get', { opIds: ['rr1'] })).list[0]!.state, 'syncing');
  await assert.rejects(
    w.call('Operation/retry', { opId: 'rr1' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );
  release();
  await first;
  assert.deepEqual(
    w.calls,
    ['put', 'put'],
    'one send for the first try, one for the retry, no more',
  );
});

test('a hold whose window ended long ago is not sent on launch; only an explicit Retry sends it', async () => {
  const w = await rig();
  await w.call('Event/set', rename('st1'));
  await w.engine.close();
  w.clock.advance(3 * 24 * 60 * 60 * 1000);
  const again = await w.boot();
  w.clock.advance(1_000);
  await settle();
  assert.deepEqual(w.calls, [], 'an edit made days ago is not sent unasked');
  const op = (await again.call('Operation/get', { opIds: ['st1'] })).list[0]!;
  assert.equal(op.state, 'failed');
  assert.equal(op.error?.reasonCode, 'calendar.late');
  await again.call('Operation/retry', { opId: 'st1' });
  assert.deepEqual(w.calls, ['put'], 'the owner pressed Retry: now it goes');
  await again.engine.close();
});

test('an invitation for an event that has already started is not sent unasked', async () => {
  const w = await rig();
  const startsSoon = w.clock.now() + 4_000;
  await w.call('Event/set', {
    opId: 'late1',
    notify: true,
    change: {
      type: 'create',
      calendarId: 'acct-1:primary',
      fields: {
        title: 'Starting now',
        start: { type: 'utc', utc: startsSoon },
        end: { type: 'utc', utc: startsSoon + 3_600_000 },
        allDay: false,
        attendees: [{ address: 'friend@example.test' }],
      },
    },
  });
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, [], 'the meeting began while the change waited');
  const op = (await w.call('Operation/get', { opIds: ['late1'] })).list[0]!;
  assert.equal(op.error?.reasonCode, 'calendar.late');
});

test('an edit of a weekly series that tells guests is sent when the window ends: a series is never already started', async () => {
  const w = await rig();
  const weekAgo = w.clock.now() - 7 * 86_400_000;
  w.store.commit({
    opId: 'series',
    origin: 'sync',
    writes: [
      {
        kind: 'event' as const,
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'weekly',
        rows: [
          {
            status: 'confirmed',
            etag: '"v1"',
            startUtc: weekAgo,
            endUtc: weekAgo + 1_800_000,
            allDay: false,
            recurrence: { rrule: ['RRULE:FREQ=WEEKLY'] },
            data: JSON.stringify({ summary: 'Weekly sync', status: 'confirmed' }),
          },
        ],
      },
    ],
  });
  await w.call('Event/set', rename('wk1', 'acct-1:primary/weekly'));
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'sent by itself, no Retry needed');
  const op = (await w.call('Operation/get', { opIds: ['wk1'] })).list[0]!;
  assert.equal(op.state, 'synced');
});

test('a second change to an event that is still held is refused until the first is sent or undone', async () => {
  const w = await rig();
  await w.call('Event/set', rename('s1'));
  await assert.rejects(
    w.call('Event/set', rename('s2')),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.holdPending',
  );
  await w.call('Operation/undo', { opId: 's1', undoOpId: 's1-undo' });
  await w.call('Event/set', rename('s3'));
  assert.equal((await w.call('Operation/get', { opIds: ['s3'] })).list[0]!.state, 'queued');
});

test('a replayed op id answers the same receipt and makes no second hold', async () => {
  const w = await rig();
  const first = await w.call('Event/set', rename('rp1'));
  const again = await w.call('Event/set', rename('rp1'));
  assert.equal(again.receipt.undoUntil, first.receipt.undoUntil);
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put']);
});

test('a finished hold keeps no guest address, and is purged after a day', async () => {
  const w = await rig();
  await w.call('Event/set', withGuest('pg1'));
  assert.match(metaRow(w, 'pg1')!.value, /friend@example\.test/);
  w.clock.advance(9_000);
  await settle();
  assert.doesNotMatch(metaRow(w, 'pg1')!.value, /friend@example\.test/, 'sent: the call is gone');

  await w.call('Event/set', withGuest('pg2', 'acct-1:primary/ev1'));
  await w.call('Operation/undo', { opId: 'pg2', undoOpId: 'pg2-undo' });
  assert.doesNotMatch(metaRow(w, 'pg2')!.value, /friend@example\.test/, 'undone: the call is gone');

  w.clock.advance(25 * 60 * 60 * 1000);
  await settle();
  assert.equal(metaRow(w, 'pg1'), undefined);
  assert.equal(metaRow(w, 'pg2'), undefined);
});

test('an unreadable hold row never stalls the others, and is cleared', async () => {
  const w = await rig();
  w.store.commit({
    opId: 'bad',
    origin: 'local',
    writes: [{ kind: 'meta', key: 'calendar.hold.bad', value: 'not json {' }],
  });
  await w.call('Event/set', rename('ok1'));
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put']);
  assert.equal(metaRow(w, 'bad'), undefined);
});

test('Operation/get answers in the order asked', async () => {
  const w = await rig();
  await w.call('Event/set', rename('o1'));
  w.clock.advance(1_000);
  await w.call('Operation/undo', { opId: 'o1', undoOpId: 'o1-undo' });
  await w.call('Event/set', rename('o2'));
  const got = await w.call('Operation/get', { opIds: ['o2', 'nope', 'o1'] });
  assert.deepEqual(
    got.list.map(o => o.opId),
    ['o2', 'o1'],
  );
  assert.deepEqual(got.notFound, ['nope']);
});

test('a second failure shows its own error, not the first one’s', async () => {
  let n = 0;
  const w = await rig(() =>
    Promise.reject(
      new ContractError({
        type: 'unavailable',
        message: `try ${++n}`,
        reasonCode: 'calendar.unavailable',
      }),
    ),
  );
  await w.call('Event/set', rename('e1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['e1'] })).list[0]!.error?.message, 'try 1');
  await w.call('Operation/retry', { opId: 'e1' });
  assert.equal((await w.call('Operation/get', { opIds: ['e1'] })).list[0]!.error?.message, 'try 2');
});

test('undo refuses a change that is already being sent', async () => {
  let release!: () => void;
  const w = await rig(
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        release = () => resolve(SAVED);
      }),
  );
  await w.call('Event/set', rename('is1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['is1'] })).list[0]!.state, 'syncing');
  await assert.rejects(
    w.call('Operation/undo', { opId: 'is1', undoOpId: 'is1-undo' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );
  release();
  await settle();
  assert.deepEqual(w.calls, ['put']);
});

test('a retry in flight is not reported uncertain by the next sweep', async () => {
  let fail = true;
  const releases: (() => void)[] = [];
  const w = await rig(() =>
    fail
      ? Promise.reject(
          new ContractError({
            type: 'unavailable',
            message: 'x',
            reasonCode: 'calendar.unavailable',
          }),
        )
      : new Promise<CalendarWriteResult>(resolve => {
          releases.push(() => resolve(SAVED));
        }),
  );
  await w.call('Event/set', rename('if1'));
  w.clock.advance(9_000);
  await settle();
  fail = false;
  const retrying = w.call('Operation/retry', { opId: 'if1' });
  await settle();
  // Another hold comes due and runs a sweep while the retry is still out.
  await w.call('Event/set', rename('if2', 'acct-1:primary/ev2'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['if1'] })).list[0]!.state, 'syncing');
  for (const release of releases) release();
  await retrying;
  assert.equal((await w.call('Operation/get', { opIds: ['if1'] })).list[0]!.state, 'synced');
});

test('retry needs the scope of the method that made the change', async () => {
  const w = await rig(() =>
    Promise.reject(
      new ContractError({ type: 'unavailable', message: 'x', reasonCode: 'calendar.unavailable' }),
    ),
  );
  await w.call('Event/set', rename('rs1'));
  w.clock.advance(9_000);
  await settle();
  const cheap = w.engine.connect({
    kind: 'listener',
    via: 'socket',
    clientId: 'tool',
    scopes: ['read', 'triage'],
  });
  await assert.rejects(
    cheap.call('Operation/retry', { opId: 'rs1' }),
    (e: unknown) => e instanceof ContractError && e.type === 'forbidden',
  );
  assert.deepEqual(w.calls, ['put'], 'the refused retry sent nothing');
});

test('a hold failed long after it was made stays readable and retriable; it is never purged', async () => {
  const w = await rig();
  await w.call('Event/set', withGuest('fl1'));
  await w.engine.close();
  w.clock.advance(3 * 24 * 60 * 60 * 1000); // made days ago, past the keep window
  const again = await w.boot();
  w.clock.advance(1_000);
  await settle();
  const op = (await again.call('Operation/get', { opIds: ['fl1'] })).list[0]!;
  assert.equal(op.state, 'failed');
  assert.equal(op.error?.reasonCode, 'calendar.late');
  assert.match(
    metaRow(w, 'fl1')!.value,
    /friend@example\.test/,
    'the failed hold keeps its call for Retry',
  );
  w.clock.advance(2 * 24 * 60 * 60 * 1000); // far past the keep window again
  await settle();
  assert.equal(
    (await again.call('Operation/get', { opIds: ['fl1'] })).list[0]!.state,
    'failed',
    'a failed hold waits for a Retry or a dismiss; it is not purged',
  );
  await again.call('Operation/retry', { opId: 'fl1' });
  assert.deepEqual(w.calls, ['put'], 'the kept call still sends');
  await again.engine.close();
});

test('a sent hold is purged a day after it finished, not a day after it was made', async () => {
  const w = await rig();
  await w.call('Event/set', rename('pf1'));
  await w.engine.close();
  w.clock.advance(23 * 60 * 60 * 1000);
  const again = await w.boot();
  w.clock.advance(1_000);
  await settle();
  assert.equal((await again.call('Operation/get', { opIds: ['pf1'] })).list[0]!.state, 'failed');
  await again.call('Operation/retry', { opId: 'pf1' }); // finishes ~23 h after it was made
  assert.deepEqual(w.calls, ['put']);
  w.clock.advance(23 * 60 * 60 * 1000); // 46 h after it was made, ~23 h after it finished
  await settle();
  assert.ok(metaRow(w, 'pf1'), 'kept: the keep window runs from finishedAt');
  w.clock.advance(2 * 60 * 60 * 1000); // past a day since it finished
  await settle();
  assert.equal(metaRow(w, 'pf1'), undefined, 'purged a day after it finished');
  await again.engine.close();
});

test('a series change is held against the next occurrence, not the series’ first slot', async () => {
  const w = await rig();
  w.store.commit({
    opId: 'ser',
    origin: 'sync',
    writes: [
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ser1',
        rows: [
          {
            status: 'confirmed',
            etag: '"s1"',
            recurrence: { rrule: ['RRULE:FREQ=DAILY;COUNT=30'] },
            startUtc: Date.UTC(2026, 9, 20, 17, 0), // began Oct 20, still runs to mid-November
            endUtc: Date.UTC(2026, 9, 20, 17, 30),
            allDay: false,
            data: JSON.stringify({
              summary: 'Daily',
              status: 'confirmed',
              start: { dateTime: '2026-10-20T17:00:00Z' },
              end: { dateTime: '2026-10-20T17:30:00Z' },
            }),
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ser2',
        rows: [
          {
            status: 'confirmed',
            etag: '"s2"',
            recurrence: { rrule: ['RRULE:FREQ=DAILY;COUNT=3'] },
            startUtc: Date.UTC(2026, 9, 20, 18, 0), // ended Oct 22, all past
            endUtc: Date.UTC(2026, 9, 20, 18, 30),
            allDay: false,
            data: JSON.stringify({
              summary: 'Short',
              status: 'confirmed',
              start: { dateTime: '2026-10-20T18:00:00Z' },
              end: { dateTime: '2026-10-20T18:30:00Z' },
            }),
          },
        ],
      },
    ],
  });
  await w.call('Event/set', rename('ns1', 'acct-1:primary/ser1'));
  await w.call('Event/set', rename('ns2', 'acct-1:primary/ser2'));
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'the ongoing series sends; the finished one does not');
  const ops = await w.call('Operation/get', { opIds: ['ns1', 'ns2'] });
  assert.equal(ops.list[0]!.state, 'synced');
  assert.equal(ops.list[1]!.state, 'failed');
  assert.equal(ops.list[1]!.error?.reasonCode, 'calendar.late');
});
