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
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev1',
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
      },
    ],
  });
  return { ...(await boot()), boot, clock, calls, store, setAnswer: (a: Answer) => (next = a) };
}

const rename = (opId: string) => ({
  opId,
  notify: true,
  change: {
    type: 'update' as const,
    id: 'acct-1:primary/ev1',
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
  await w.call('Event/set', rename('d2'));
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
