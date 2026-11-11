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

// Held calendar writes in the Queue inspector (prov-cal): content-free items that survive a reload, Retry that sends,
// Dismiss that drops. Nothing here names a title or a guest.

const SAVED: CalendarWriteResult = { kind: 'saved', upserts: [], removals: [] };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
};

async function rig(answers: (() => Promise<CalendarWriteResult>)[], calendarZone?: string) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const calls: string[] = [];
  const answer = () => answers.shift()?.() ?? Promise.resolve(SAVED);
  const calendar: CalendarPort = {
    put: () => (calls.push('put'), answer()),
    remove: () => (calls.push('remove'), answer()),
    rsvp: () => (calls.push('rsvp'), answer()),
  };
  const boot = async () => {
    const engine = await createEngine({ store, clock, log, ports: { calendar } });
    const window = engine.connect();
    const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
      window.call(method, args) as Promise<Output<M>>;
    return { engine, window, call };
  };
  const { engine, window, call } = await boot();
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
        ...(calendarZone ? { timeZone: calendarZone } : {}),
      },
      ...['ev1', 'ev2'].map(remoteId => ({
        kind: 'event' as const,
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId,
        rows: [
          {
            status: 'confirmed' as const,
            etag: '"v1"',
            startUtc: Date.UTC(2099, 0, 1, 17, 0),
            endUtc: Date.UTC(2099, 0, 1, 17, 30),
            allDay: false,
            data: JSON.stringify({ summary: 'Later', status: 'confirmed' }),
          },
        ],
      })),
    ],
  });
  return { call, calls, clock, store, engine, window, boot };
}

const rename = (opId: string, id: string) => ({
  opId,
  notify: true,
  change: { type: 'update' as const, id, scope: 'series' as const, fields: { title: 'Renamed' } },
});

const failWith = (reasonCode: string) => () =>
  Promise.reject(new ContractError({ type: 'unavailable', message: 'Not now.', reasonCode }));

const queueOf = async (w: Awaited<ReturnType<typeof rig>>) =>
  (await w.call('Queue/list', { kinds: ['op'] })).list.filter(i => i.id.startsWith('cal:'));

test('a waiting hold shows in the queue, content-free, and Dismiss undoes it', async () => {
  const w = await rig([]);
  await w.call('Event/set', rename('q1', 'acct-1:primary/ev1'));
  const [item] = await queueOf(w);
  assert.equal(item!.id, 'cal:q1');
  assert.equal(item!.label, 'Calendar change');
  assert.equal(item!.state, 'queued');
  assert.equal(item!.accountId, 'acct-1');
  assert.equal(item!.scope, 'send');
  assert.equal(item!.canRetry, false);
  assert.equal(item!.canDiscard, true);
  assert.ok(item!.nextAt !== undefined, 'when it will be sent');
  assert.doesNotMatch(
    JSON.stringify(item),
    /Renamed|friend@|Standup|ev1/,
    'no title, guest or event id',
  );
  await w.call('Queue/discard', { id: 'cal:q1' });
  assert.deepEqual(await queueOf(w), []);
  w.clock.advance(60_000);
  await settle();
  assert.deepEqual(w.calls, [], 'a dismissed waiting change is never sent');
});

test('a failed hold survives in the queue with its reason; Retry sends it; a sent one leaves the list', async () => {
  const w = await rig([failWith('calendar.unavailable')]);
  await w.call('Event/set', rename('q2', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  const [item] = await queueOf(w);
  assert.equal(item!.state, 'failed');
  assert.equal(item!.problem?.reasonCode, 'calendar.unavailable');
  assert.equal(item!.problem?.message, 'Not now.');
  assert.equal(item!.canRetry, true);
  await w.call('Queue/retry', { id: 'cal:q2' });
  assert.deepEqual(w.calls, ['put', 'put']);
  assert.deepEqual(await queueOf(w), [], 'sent: nothing left to look at');
});

test('a change whose answer was lost cannot be retried from the queue, only dismissed after checking', async () => {
  const w = await rig([failWith('calendar.uncertain')]);
  await w.call('Event/set', rename('q3', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  const [item] = await queueOf(w);
  assert.equal(item!.problem?.reasonCode, 'calendar.uncertain');
  assert.equal(item!.canRetry, false);
  assert.equal(item!.canDiscard, true);
  await assert.rejects(
    w.call('Queue/retry', { id: 'cal:q3' }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.checkFirst',
  );
  assert.deepEqual(w.calls, ['put'], 'the refused retry sent nothing');
  await w.call('Queue/discard', { id: 'cal:q3' });
  assert.deepEqual(await queueOf(w), []);
  assert.equal((await w.call('Operation/get', { opIds: ['q3'] })).list[0]!.state, 'cancelled');
});

test('a hold that is sending cannot be dismissed, and a sent one is no longer listed', async () => {
  let finish!: () => void;
  const w = await rig([
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        finish = () => resolve(SAVED);
      }),
  ]);
  await w.call('Event/set', rename('q4', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await queueOf(w))[0]!.canDiscard, false);
  await assert.rejects(
    w.call('Queue/discard', { id: 'cal:q4' }),
    (e: unknown) => e instanceof ContractError && e.type === 'conflict',
  );
  finish();
  await settle();
  assert.deepEqual(await queueOf(w), []);
  await assert.rejects(
    w.call('Queue/discard', { id: 'cal:q4' }),
    (e: unknown) => e instanceof ContractError && e.type === 'notFound',
  );
});

test('the queue needs the send permission to retry or dismiss a held change, not just admin', async () => {
  const w = await rig([failWith('calendar.unavailable')]);
  await w.call('Event/set', rename('q5', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  const cheap = w.engine.connect({
    kind: 'listener',
    via: 'socket',
    clientId: 'tool',
    scopes: ['read', 'triage', 'admin'],
  });
  for (const method of ['Queue/retry', 'Queue/discard'] as const)
    await assert.rejects(
      cheap.call(method, { id: 'cal:q5' }),
      (e: unknown) => e instanceof ContractError && e.type === 'forbidden',
    );
  assert.equal((await queueOf(w))[0]!.state, 'failed');
});
