/**
 * The review13 tests (held writes, providers' 2026-11-11 NOTICE): after a write's receipt its
 * operation is watched through `queued` → `syncing` → `synced` | `failed` | `cancelled`. The
 * overlay holds while it waits, settles on `synced`, rolls back on `failed` (the reasonCode
 * sentence; Retry is the operation's own `Operation/retry`, never a re-run) and on `cancelled`
 * (quietly). A held create's tmp entry stays until the real row lands or the operation ends. And a
 * refused undo says "That change has already been sent."
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationView, Receipt } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import type { CalendarEffect } from './calendar.model';
import { operationUpdate, runCalendarEffect, type EffectPorts, type WatchedWrite } from './effects';
import { boot, NOW, ports, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const actOk = () => ({
  opId: 'op-1',
  receipt: Promise.resolve(receipt()),
});

const view = (over: Partial<OperationView> = {}): OperationView => ({
  opId: 'op-1',
  state: 'confirmed',
  remote: null,
  action: null,
  targets: [],
  selector: null,
  error: null,
  undoable: true,
  undoUntil: null,
  retry: () => actOk(),
  ...over,
});

const watch = (over: Partial<WatchedWrite> = {}): WatchedWrite => ({
  opId: 'op-1',
  entryIds: ['tmp-1'],
  at: { dbEpoch: 'e', seq: 9 },
  held: true,
  addedIds: [],
  failure: 'Couldn’t move Standup.',
  ...over,
});

const NONE = new Set<string>();
const task = () => new Promise<void>(resolve => setImmediate(resolve));

test('review13: queued and syncing hold the overlay; synced settles it', () => {
  resetToasts();
  try {
    const ui = testUi();
    const w = watch();
    for (const remote of [null, 'queued', 'syncing'] as const) {
      assert.equal(operationUpdate(w, view({ remote }), ui, NONE, ports()), 'watching');
      assert.deepEqual(ui.dropped, []);
    }
    // A held write skipped the receipt settle (its `appliedState` was already reached): `synced`
    // settles every entry — a create's tmp entry with it (review14).
    assert.equal(operationUpdate(w, view({ remote: 'synced' }), ui, NONE, ports()), 'done');
    assert.deepEqual(ui.applied, ['tmp-1']);
    const ui2 = testUi();
    assert.equal(
      operationUpdate(
        watch({ addedIds: ['tmp-1'] }),
        view({ remote: 'synced' }),
        ui2,
        NONE,
        ports(),
      ),
      'done',
    );
    assert.deepEqual(
      ui2.applied,
      ['tmp-1'],
      'the held create settles its tmp entry against the receipt’s state',
    );
  } finally {
    resetToasts();
  }
});

test('review13: a late failure rolls back and Retry is the operation’s own, never a re-run', async () => {
  resetToasts();
  try {
    const ui = testUi();
    const w = watch();
    let retries = 0;
    const failed = view({
      remote: 'failed',
      error: {
        type: 'unavailable',
        message: 'This change was not sent in time.',
        reasonCode: 'calendar.late',
      },
      retry: () => {
        retries += 1;
        return actOk();
      },
    });
    assert.equal(operationUpdate(w, failed, ui, NONE, ports()), 'done');
    assert.deepEqual(ui.dropped, ['tmp-1']);
    const toast = getToasts().find(t => t.id === 'op-1:failed');
    assert.equal(
      toast?.message,
      "This change wasn't sent in time. Check the event, then try again.",
    );
    assert.ok(
      toast?.actions?.some(a => a.id === 'retry'),
      'Retry is offered',
    );
    runToastAction('op-1:failed', 'retry');
    await task();
    assert.equal(retries, 1, 'Operation/retry ran exactly once on the same opId');
    assert.ok(
      ui.watched.some(x => x.opId === w.opId),
      'the watch was put back so a second failure surfaces',
    );
  } finally {
    resetToasts();
  }
});

test('review13: an uncertain operation failure keeps no Retry', () => {
  resetToasts();
  try {
    const ui = testUi();
    operationUpdate(
      watch(),
      view({
        remote: 'failed',
        error: {
          type: 'unavailable',
          message: 'lost',
          reasonCode: 'calendar.uncertain',
        },
      }),
      ui,
      NONE,
      ports(),
    );
    const toast = getToasts().find(t => t.id === 'op-1:failed');
    assert.equal(
      toast?.message,
      "We couldn't confirm that went through. Check your calendar before trying again.",
    );
    assert.equal(toast?.actions, undefined, 'a lost answer never offers a blind Retry');
  } finally {
    resetToasts();
  }
});

test('review13: cancelled drops the entry quietly', () => {
  resetToasts();
  try {
    const ui = testUi();
    assert.equal(
      operationUpdate(watch(), view({ remote: 'cancelled' }), ui, NONE, ports()),
      'done',
    );
    assert.deepEqual(ui.dropped, ['tmp-1']);
    assert.equal(getToasts().length, 0, 'the Undo toast already told the owner');
  } finally {
    resetToasts();
  }
});

test('review13: a held create’s tmp entry drops the moment the real row lands', () => {
  resetToasts();
  try {
    const ui = testUi();
    const w = watch({ entryIds: ['tmp-1'], addedIds: ['tmp-1'] });
    // Still queued: nothing happens while the real row is absent.
    assert.equal(
      operationUpdate(w, view({ remote: 'queued', targets: ['event-real'] }), ui, NONE, ports()),
      'watching',
    );
    assert.deepEqual(ui.dropped, []);
    // The real row lands in the window while the send is still queued: the tmp drops at once.
    assert.equal(
      operationUpdate(
        w,
        view({ remote: 'queued', targets: ['event-real'] }),
        ui,
        new Set(['event-real']),
      ),
      'watching',
    );
    assert.deepEqual(ui.dropped, ['tmp-1'], 'no ghost duplicate beside the real row');
  } finally {
    resetToasts();
  }
});

test('review13: a held create skips the receipt settle and keeps watching', async () => {
  await boot();
  resetToasts();
  try {
    const ui = testUi();
    const create: CalendarEffect = {
      kind: 'eventSet',
      change: {
        type: 'create',
        calendarId: 'work',
        fields: {
          title: 'Lunch',
          start: { type: 'date', date: '2026-10-30' },
          end: { type: 'date', date: '2026-10-31' },
          allDay: true,
        },
      },
      optimistic: {
        id: 'tmp-new',
        add: { id: 'tmp-new' } as never,
      },
      toast: { kind: 'info', message: 'Added Lunch', held: 'Adding Lunch', undoable: true },
      undoLabel: 'Added Lunch',
      failure: 'Couldn’t add Lunch.',
    };
    const p: EffectPorts = {
      ...ports(),
      eventSet: () =>
        Promise.resolve({
          receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
        }),
    };
    runCalendarEffect(create, p, ui);
    await task();
    assert.deepEqual(ui.applied, [], 'no settle: the real row is not committed until the send');
    assert.equal(ui.watched.length, 1);
    assert.deepEqual(ui.watched[0]?.addedIds, ['tmp-new']);
  } finally {
    resetToasts();
  }
});

test('review13: a refused undo says "That change has already been sent."', async () => {
  resetToasts();
  try {
    const ui = testUi();
    const p: EffectPorts = {
      ...ports(),
      eventSet: () => Promise.resolve({ receipt: receipt({ undoable: true }) }),
      operationUndo: () => ({
        opId: 'op-1',
        receipt: Promise.reject({
          type: 'conflict',
          message: 'This change has already been sent.',
        }),
      }),
    };
    const fx: CalendarEffect = {
      kind: 'eventSet',
      change: { type: 'update', id: 'dental', scope: 'occurrence', fields: { title: 'X' } },
      optimistic: { id: 'dental', patch: { title: 'X' } },
      toast: { kind: 'info', message: 'Changed X', held: 'Changing X', undoable: true },
      undoLabel: 'Changed X',
      failure: 'Couldn’t change X.',
    };
    runCalendarEffect(fx, p, ui);
    await task();
    const toast = getToasts().find(t => t.undoable);
    assert.ok(toast);
    assert.equal(toast.actions?.[0]?.keysFrom, 'app.undo', 'the Z keycap still shows');
    runToastAction(toast.id, 'undo');
    await task();
    const notice = getToasts().find(t => t.id.endsWith(':undo-failed'));
    assert.equal(notice?.message, 'That change has already been sent.');
  } finally {
    resetToasts();
  }
});

test('review13: the stand-in holds a guest write; undo cancels it and the sync lands clean', async () => {
  const { connection, engine, flush } = await boot();
  const { layer } = connection;
  resetToasts();
  try {
    // The demo scenario has an event with guests: the stand-in holds its writes (`undoUntil`).
    const guest = engine.fixture.store.all('Event').find(e => e.attendees.some(a => !a.self));
    assert.ok(guest, 'the demo scenario has an event with guests');
    const ui = testUi();
    const fx: CalendarEffect = {
      kind: 'eventSet',
      change: {
        type: 'update',
        id: guest.id,
        scope: 'occurrence',
        fields: { title: 'Sync review' },
      },
      optimistic: { id: guest.id, patch: { title: 'Sync review' } },
      toast: {
        kind: 'info',
        message: 'Changed Sync review',
        held: 'Changing Sync review',
        undoable: true,
      },
      undoLabel: 'Changed Sync review',
      failure: 'Couldn’t change Sync review.',
    };
    runCalendarEffect(fx, ports(), ui);
    await flush();
    assert.equal(ui.watched.length, 1, 'the accepted write is being watched');
    const w = ui.watched[0]!;
    const op = layer.operations.view(w.opId);
    assert.ok(op, 'the operation record exists');
    // The remote row lands through Operation/get: queued under the hold.
    assert.equal(op.remote, 'queued');
    assert.equal(operationUpdate(w, op, ui, NONE, ports()), 'watching');
    // Undo inside the window cancels the held write at the provider queue.
    const toast = getToasts().find(t => t.undoable);
    assert.ok(toast);
    runToastAction(toast.id, 'undo');
    await flush();
    const cancelled = layer.operations.view(w.opId);
    assert.equal(cancelled?.remote, 'cancelled');
    assert.equal(operationUpdate(w, cancelled, ui, NONE, ports()), 'done');
    assert.deepEqual(ui.dropped, [guest.id], 'the optimistic patch rolled back');
    // A second held write, let to sync, settles on its own.
    const ui2 = testUi();
    runCalendarEffect(fx, ports(), ui2);
    await flush();
    const w2 = ui2.watched[0]!;
    engine.fixture.clock.advance(1_000);
    await flush();
    const synced = layer.operations.view(w2.opId);
    assert.equal(synced?.remote, 'synced');
    assert.equal(operationUpdate(w2, synced, ui2, NONE, ports()), 'done');
    assert.deepEqual(ui2.applied, [guest.id]);
  } finally {
    resetToasts();
  }
});
