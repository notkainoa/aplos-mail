import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { accountWrite, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const engine = await createEngine({ store, clock, log });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  return { store, engine, call, clock, file };
}

const GEVENT = JSON.stringify({
  summary: 'Standup',
  start: { dateTime: '2026-10-27T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-10-27T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
  status: 'confirmed',
  attendees: [{ email: 'owner@mail.example', self: true, responseStatus: 'accepted' }],
  organizer: { email: 'owner@mail.example', self: true },
});

function seed(w: Awaited<ReturnType<typeof world>>) {
  w.store.commit({ opId: 'a', origin: 'local', writes: [{ ...accountWrite }] });
  w.store.commit({
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
        primary: true,
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
            startUtc: Date.UTC(2026, 9, 27, 17, 0),
            endUtc: Date.UTC(2026, 9, 27, 17, 30),
            allDay: false,
            data: GEVENT,
          },
        ],
      },
    ],
  });
}

test('Calendar/get lists stored calendars; Calendar/set toggles shown', async () => {
  const w = await world();
  seed(w);
  const { list } = await w.call('Calendar/get', {});
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'acct-1:primary');
  assert.equal(list[0]!.shown, true);
  const { calendar } = await w.call('Calendar/set', {
    opId: 'set1',
    id: 'acct-1:primary',
    shown: false,
  });
  assert.equal(calendar.shown, false);
});

test('Event/get projects a Google data row; hidden rows carry hidden', async () => {
  const w = await world();
  seed(w);
  const { list } = await w.call('Event/get', { ids: ['acct-1:primary/ev1'] });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.title, 'Standup');
  assert.equal(list[0]!.sync, 'synced');
  await w.call('Event/hide', { opId: 'h1', ids: ['acct-1:primary/ev1'], hidden: true });
  const after = await w.call('Event/get', { ids: ['acct-1:primary/ev1'] });
  assert.equal(after.list[0]!.hidden, true);
});

test('events view: stored singles appear in range; hidden drops out; plans is empty', async () => {
  const w = await world();
  seed(w);
  const win = await w.call('View/watch', {
    spec: { kind: 'events', from: Date.UTC(2026, 9, 26), to: Date.UTC(2026, 9, 29) },
  });
  assert.deepEqual(win.rowType, 'Event');
  assert.deepEqual(win.ids, ['acct-1:primary/ev1']);
  await w.call('Event/hide', { opId: 'h2', ids: ['acct-1:primary/ev1'], hidden: true });
  const win2 = await w.call('View/watch', {
    spec: { kind: 'events', from: Date.UTC(2026, 9, 26), to: Date.UTC(2026, 9, 29) },
  });
  assert.deepEqual(win2.ids, []);
  const plans = await w.call('View/watch', { spec: { kind: 'plans' } });
  assert.deepEqual(plans.ids, []);
  await assert.rejects(
    w.call('View/watch', { spec: { kind: 'events', from: 0, to: 86_400_000 * 70 } }),
    /62 days/,
  );
});

const GMASTER = JSON.stringify({
  summary: 'Weekly sync',
  start: { dateTime: '2026-10-27T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-10-27T11:00:00-07:00', timeZone: 'America/Los_Angeles' },
  status: 'confirmed',
});
const GOVERRIDE = JSON.stringify({
  summary: 'Weekly sync (moved)',
  start: { dateTime: '2026-11-03T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-11-03T15:00:00-08:00', timeZone: 'America/Los_Angeles' },
  status: 'confirmed',
});

test('master + override: view emits master@recId; Event/get round-trips the override row', async () => {
  const w = await world();
  w.store.commit({ opId: 'a', origin: 'local', writes: [{ ...accountWrite }] });
  w.store.commit({
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
        primary: true,
        selected: true,
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev2',
        rows: [
          {
            status: 'confirmed',
            recurrence: { rrule: ['RRULE:FREQ=WEEKLY'] },
            startUtc: Date.UTC(2026, 9, 27, 17, 0),
            endUtc: Date.UTC(2026, 9, 27, 18, 0),
            allDay: false,
            data: GMASTER,
          },
        ],
      },
      {
        kind: 'event',
        accountId: 'acct-1',
        calendarRemoteId: 'primary',
        remoteId: 'ev2_20261103T180000Z',
        rows: [
          {
            recurrenceId: '20261103T180000Z',
            masterRemoteId: 'ev2',
            status: 'confirmed',
            startUtc: Date.UTC(2026, 10, 3, 22, 0),
            endUtc: Date.UTC(2026, 10, 3, 23, 0),
            allDay: false,
            data: GOVERRIDE,
          },
        ],
      },
    ],
  });
  const win = await w.call('View/watch', {
    spec: { kind: 'events', from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 8) },
  });
  const occId = 'acct-1:primary/ev2@20261103T180000Z';
  assert.deepEqual(win.ids, [occId]);
  // The override row projects its own fields (moved title + start), originalStart is the key.
  const { list } = await w.call('Event/get', { ids: [occId] });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.title, 'Weekly sync (moved)');
  assert.equal(list[0]!.seriesId, 'acct-1:primary/ev2');
  assert.equal(list[0]!.exception, true);
  // Event/hide on the occurrence id lands on the resource (master) remote.
  await w.call('Event/hide', { opId: 'h9', ids: [occId], hidden: true });
  const after = await w.call('Event/get', { ids: [occId] });
  assert.equal(after.list[0]!.hidden, true);
});
