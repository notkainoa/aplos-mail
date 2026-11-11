import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../src/diag/log';
import { createEngine, laneExtensions } from '../src/index';
import type { CalendarPort, CalendarWriteResult } from '../src/ports';
import { openStore } from '../src/store';
import { NotSentError } from '../src/ports';
import { framesOf, manualClock } from './runtime.helpers';
import { accountWrite, tempDb } from './store/helpers';

// Two more guards of the held calendar writes (prov-cal), split from calendar-holds.test.ts: a sweep never overwrites
// what finished while it was running, and a wall-clock time with no zone is read in the calendar's zone.

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
  const engine = await createEngine({ store, clock, log, ports: { calendar } });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
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
  return { call, calls, clock, store, engine, window };
}

const rename = (opId: string, id: string) => ({
  opId,
  notify: true,
  change: { type: 'update' as const, id, scope: 'series' as const, fields: { title: 'Renamed' } },
});

const unavailable = () =>
  Promise.reject(
    new ContractError({ type: 'unavailable', message: 'x', reasonCode: 'calendar.unavailable' }),
  );

test('a Retry that finishes while a sweep is running is not put back as failed by that sweep', async () => {
  let finishRetry!: () => void;
  let finishOther!: () => void;
  const w = await rig([
    unavailable, // the failing hold's first send
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        finishRetry = () => resolve(SAVED);
      }), // its Retry, left hanging
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        finishOther = () => resolve(SAVED);
      }), // the other hold's send, left hanging inside the sweep
  ]);
  // The other hold is made first with a long window, so it sits ahead of the failing one in every sweep.
  await w.call('Settings/set', { opId: 's1', patch: { mail: { undoSendSeconds: 30 } } });
  await w.call('Event/set', rename('other', 'acct-1:primary/ev2'));
  await w.call('Settings/set', { opId: 's2', patch: { mail: { undoSendSeconds: 8 } } });
  await w.call('Event/set', rename('failing', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['failing'] })).list[0]!.state, 'failed');

  const retrying = w.call('Operation/retry', { opId: 'failing' });
  await settle();
  w.clock.advance(22_000); // the other hold is now due: a sweep starts, and its send hangs
  for (let i = 0; i < 50; i++) {
    if ((await w.call('Operation/get', { opIds: ['other'] })).list[0]!.state === 'syncing') break;
    await settle();
  }
  assert.equal((await w.call('Operation/get', { opIds: ['other'] })).list[0]!.state, 'syncing');
  finishRetry(); // the failing hold's Retry finishes while that sweep is still running
  await retrying;
  assert.equal((await w.call('Operation/get', { opIds: ['failing'] })).list[0]!.state, 'synced');
  finishOther();
  await settle();
  assert.equal(
    (await w.call('Operation/get', { opIds: ['failing'] })).list[0]!.state,
    'synced',
    'the sweep did not turn a finished Retry back into an uncertain failure',
  );
  assert.equal((await w.call('Operation/get', { opIds: ['other'] })).list[0]!.state, 'synced');
});

test('a wall-clock time with no zone is read in the calendar’s zone when deciding whether the event started', async () => {
  const w = await rig([], 'America/Los_Angeles');
  // Five hours from now, written as Los Angeles wall-clock time with no zone attached. Read as UTC it would be hours
  // in the past, and the change would wait for a manual Retry although the event has not begun.
  const later = new Date(w.clock.now() + 5 * 3_600_000 - 8 * 3_600_000).toISOString().slice(0, 19);
  await w.call('Event/set', {
    opId: 'zone1',
    notify: true,
    change: {
      type: 'create',
      calendarId: 'acct-1:primary',
      fields: {
        title: 'This afternoon',
        start: { type: 'floating', local: later },
        end: { type: 'floating', local: later },
        allDay: false,
        attendees: [{ address: 'friend@example.test' }],
      },
    },
  });
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'the event has not started, so the change is sent');
  assert.equal((await w.call('Operation/get', { opIds: ['zone1'] })).list[0]!.state, 'synced');
});

test('a hold more than 15 minutes late is not sent unasked, even for an event far in the future', async () => {
  const w = await rig([]);
  await w.call('Event/set', rename('lt1', 'acct-1:primary/ev1')); // ev1 begins in 2099: only the age of the hold is late
  w.clock.advance(20 * 60_000);
  await settle();
  assert.deepEqual(w.calls, []);
  const op = (await w.call('Operation/get', { opIds: ['lt1'] })).list[0]!;
  assert.equal(op.error?.reasonCode, 'calendar.late');
  await w.call('Operation/retry', { opId: 'lt1' });
  assert.deepEqual(w.calls, ['put'], 'sent on the owner’s explicit Retry');
});

test('a hold only 10 minutes late is still sent (the 15-minute limit is not shorter)', async () => {
  const w = await rig([]);
  await w.call('Event/set', rename('lt2', 'acct-1:primary/ev1'));
  w.clock.advance(10 * 60_000);
  await settle();
  assert.deepEqual(w.calls, ['put']);
  assert.equal((await w.call('Operation/get', { opIds: ['lt2'] })).list[0]!.state, 'synced');
});

test('a hold sent after a failed Retry carries no trace of the old error', async () => {
  let finish!: () => void;
  const w = await rig([
    unavailable,
    () =>
      new Promise<CalendarWriteResult>(resolve => {
        finish = () => resolve(SAVED);
      }),
  ]);
  await w.call('Event/set', rename('er1', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal(
    (await w.call('Operation/get', { opIds: ['er1'] })).list[0]!.error?.reasonCode,
    'calendar.unavailable',
  );
  const retrying = w.call('Operation/retry', { opId: 'er1' });
  await settle();
  assert.equal(
    (await w.call('Operation/get', { opIds: ['er1'] })).list[0]!.error,
    undefined,
    'while it is being sent',
  );
  finish();
  await retrying;
  const done = (await w.call('Operation/get', { opIds: ['er1'] })).list[0]!;
  assert.equal(done.state, 'synced');
  assert.equal(done.error, undefined, 'and once it went through');
});

test('Google accepting a change that this device then cannot record is reported uncertain, never failed-to-retry', async () => {
  const w = await rig([]);
  await w.call('Event/set', rename('rc1', 'acct-1:primary/ev1'));
  const commit = w.store.commit.bind(w.store);
  // Recording `synced` fails, once; every other write works.
  let armed = true;
  w.store.commit = ((input: Parameters<typeof commit>[0]) => {
    if (armed && JSON.stringify(input.writes).includes('\\"state\\":\\"synced\\"')) {
      armed = false;
      throw new Error('disk full');
    }
    return commit(input);
  }) as typeof w.store.commit;
  w.clock.advance(9_000);
  await settle();
  assert.deepEqual(w.calls, ['put']);
  const op = (await w.call('Operation/get', { opIds: ['rc1'] })).list[0]!;
  assert.equal(op.state, 'failed');
  assert.equal(
    op.error?.reasonCode,
    'calendar.uncertain',
    'a Retry here would tell the guests twice',
  );
  // And it is refused: the owner checks the calendar and makes the change again if it is missing.
  await assert.rejects(w.call('Operation/retry', { opId: 'rc1' }), /may already have gone through/);
  w.clock.advance(60_000);
  await settle();
  assert.deepEqual(w.calls, ['put'], 'no second send, now or later');
});

test('a hold that comes due before its account has started waits and is sent once it has', async () => {
  let started = false;
  const w = await rig([
    () =>
      started
        ? Promise.resolve(SAVED)
        : Promise.reject(
            new NotSentError({
              class: 'transient',
              provider: 'engine',
              method: 'calendar.put',
              reason: 'accountNotStarted',
            }),
          ),
    () => Promise.resolve(SAVED),
  ]);
  await w.call('Event/set', rename('ns1', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  assert.equal(
    (await w.call('Operation/get', { opIds: ['ns1'] })).list[0]!.state,
    'queued',
    'not failed: nothing was sent',
  );
  started = true;
  w.clock.advance(31_000);
  await settle();
  assert.equal((await w.call('Operation/get', { opIds: ['ns1'] })).list[0]!.state, 'synced');
});

test('every state a hold moves through is announced as an operation frame', async () => {
  const w = await rig([]);
  const frames = framesOf(w.window);
  await w.call('Event/set', rename('fr1', 'acct-1:primary/ev1'));
  w.clock.advance(9_000);
  await settle();
  const states = frames
    .filter(f => f.frame === 'operation' && f.operation.opId === 'fr1')
    .map(f => (f.frame === 'operation' ? f.operation.state : ''));
  assert.deepEqual(states, ['queued', 'syncing', 'synced']);
});

test('Operation/get answers in the asked order when mail operations and held ones are mixed', async () => {
  const w = await rig([]);
  await w.call('Event/set', rename('h1', 'acct-1:primary/ev1'));
  await w.call('Event/set', rename('h2', 'acct-1:primary/ev2'));
  // A mail operation, as the mail side would answer it.
  const mail = {
    opId: 'mail1',
    kind: 'Thread/act',
    targets: [],
    state: 'synced' as const,
    appliedState: { dbEpoch: 'e', seq: 1 },
    undoable: false,
    createdAt: 1,
    scope: 'triage' as const,
  };
  const threadOps = w.engine.services.threadOps as unknown as { get: (ids: string[]) => unknown };
  threadOps.get = (ids: string[]) => ({
    list: ids.includes('mail1') ? [mail] : [],
    notFound: ids.filter(id => id !== 'mail1'),
  });
  const got = await w.call('Operation/get', { opIds: ['h2', 'mail1', 'nope', 'h1'] });
  assert.deepEqual(
    got.list.map(o => o.opId),
    ['h2', 'mail1', 'h1'],
  );
  assert.deepEqual(got.notFound, ['nope']);
});
