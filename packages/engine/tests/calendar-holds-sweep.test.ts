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
  return { call, calls, clock, store };
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
