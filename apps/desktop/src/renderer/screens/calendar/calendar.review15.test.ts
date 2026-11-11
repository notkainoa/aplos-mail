/**
 * The review15 fixes, one test each, all modelling the REAL engine (`packages/engine`
 * calendar/holds.ts, views/windows.ts): a held write's receipt is undoable behind `undoUntil`
 * (a 0 s undo window included — the hold is queued all the same), its `appliedState` is already
 * reached (the hold commit never moves `seq`), and a second hold on the same target is refused
 * `calendar.holdPending` while the first is `queued` or `syncing`. The optimistic overlay is
 * layered per write, so a refused write drops only what it added; a held write's layer outlives
 * the `synced` op frame until the next window frame (reruns are throttled), bounded so a lost
 * frame cannot ghost it. Operation-level failures stay until dealt with, their Retry is manual
 * and the operation's own — never an auto-fired re-send of a guest-notifying write.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventChange } from '@aplos/contract';
import type { OperationView, Receipt } from '../../data';
import { getToasts, resetToasts } from '../../shell/store-toast';
import type { CalendarEffect } from './calendar.model';
import { operationUpdate, runCalendarEffect, type EffectPorts } from './effects';
import { boot, NOW, ports, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const task = () => new Promise<void>(resolve => setImmediate(resolve));

type EventSetFx = Extract<CalendarEffect, { kind: 'eventSet' }>;

const moveFx = (notify: boolean, over: Partial<EventSetFx> = {}): EventSetFx => ({
  kind: 'eventSet',
  change: {
    type: 'update',
    id: 'climb',
    scope: 'occurrence',
    fields: { title: 'Climbing, moved' },
  },
  optimistic: { id: 'climb', patch: { title: 'Climbing, moved' } },
  ...(notify ? { notify: true } : {}),
  toast: { kind: 'info', message: 'Moved Climbing', held: 'Moving Climbing', undoable: true },
  undoLabel: 'Moved Climbing',
  failure: 'Couldn’t move Climbing.',
  ...over,
});

const eventSetSpy = (out: { receipt: Receipt } | { error: unknown }) => {
  const calls: Array<{ change: EventChange; notify?: boolean }> = [];
  const port: EffectPorts['eventSet'] = args => {
    calls.push(args);
    return 'error' in out ? Promise.reject(out.error) : Promise.resolve(out);
  };
  return { calls, port };
};

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
  retry: () => ({ opId: 'op-1', receipt: Promise.resolve(receipt()) }),
  ...over,
});

test('review15: a zero-second undo window still counts as held', async () => {
  await boot();
  resetToasts();
  try {
    // The owner's undo-send of 0 s queues a hold whose `undoUntil` lands AT now: a clock compare
    // reads it unheld, so the receipt settle ran at the hold-time state (the overlay dropped at
    // once) and the toast claimed 'sent' while the write still queued. The receipt is the truth.
    const ui = testUi();
    const spy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW }),
    });
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: spy.port }, ui);
    await task();
    assert.deepEqual(ui.applied, [], 'a queued hold never settles at its receipt');
    const w = ui.watched[0]!;
    assert.equal(w.held, true, 'the watch knows the write is held');
    const toast = getToasts().find(t => t.undoable);
    assert.equal(toast?.message, 'Moving Climbing', 'held wording while the hold is queued');
  } finally {
    resetToasts();
  }
});

test('review15: a second write on a still-held event fails fast, before the overlay', async () => {
  await boot();
  resetToasts();
  try {
    const ui = testUi();
    // The first drag is held (guests are told only when its undo window ends).
    const spy1 = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: spy1.port }, ui);
    await task();
    assert.equal(ui.watched.length, 1, 'the first write is held and watched');
    // Drag it again inside the undo window: the engine would answer `calendar.holdPending`
    // (a `queued` record on the same target), so the screen refuses first — no submit, and the
    // held write's patch is never merged then rolled back with the second's.
    const spy2 = eventSetSpy({ receipt: receipt() });
    runCalendarEffect(
      moveFx(true, {
        change: { type: 'update', id: 'climb', scope: 'occurrence', fields: { title: 'Twice' } },
        optimistic: { id: 'climb', patch: { title: 'Twice' } },
      }),
      { ...ports(), eventSet: spy2.port },
      ui,
    );
    await task();
    assert.equal(spy2.calls.length, 0, 'nothing is submitted to be refused');
    assert.deepEqual(ui.dropped, [], 'no rollback ran');
    assert.deepEqual(
      ui.patchFor('climb'),
      { title: 'Climbing, moved' },
      'the held write’s patch stays exactly as held',
    );
    const toast = getToasts().find(t => t.id.endsWith(':failed'));
    assert.equal(
      toast?.message,
      "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
    );
  } finally {
    resetToasts();
  }
});

test('review15: a refused second write rolls back only its own layer', async () => {
  await boot();
  resetToasts();
  try {
    const ui = testUi();
    // The first drag is held; its op then synced, freeing the target — but a hold the screen
    // forgot (a restart, another device) can still refuse the next write engine-side, so the
    // two writes' patches must not share a rollback key.
    const spy1 = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: spy1.port }, ui);
    await task();
    const w1 = ui.watched[0]!;
    assert.equal(operationUpdate(w1, view({ remote: 'synced' }), ui, ports()), 'done');
    const spy2 = eventSetSpy({
      error: {
        type: 'conflict',
        message:
          'Your earlier change to this event has not been sent yet. Undo it, or wait a moment and try again.',
        reasonCode: 'calendar.holdPending',
      },
    });
    runCalendarEffect(
      moveFx(true, {
        change: { type: 'update', id: 'climb', scope: 'occurrence', fields: { title: 'Twice' } },
        optimistic: { id: 'climb', patch: { title: 'Twice' } },
      }),
      { ...ports(), eventSet: spy2.port },
      ui,
    );
    await task();
    assert.equal(spy2.calls.length, 1, 'the freed target let the write through to the engine');
    assert.deepEqual(
      ui.patchFor('climb'),
      { title: 'Climbing, moved' },
      'the earlier held patch survives the second write’s refusal',
    );
    assert.deepEqual(ui.dropped, ['climb'], 'only the refused write’s own layer rolled back');
  } finally {
    resetToasts();
  }
});

test('review15: a held write’s layer outlives synced until the next window frame', async () => {
  await boot();
  resetToasts();
  try {
    const ui = testUi();
    const spy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: spy.port }, ui);
    await task();
    const w = ui.watched[0]!;
    // The `synced` op frame lands while the throttled window rerun is still pending: settling at
    // the receipt's (already-reached) state here drops the layer before the real row carries the
    // send — the event snaps back for up to ~250 ms. It must wait out the next frame.
    assert.equal(operationUpdate(w, view({ remote: 'synced' }), ui, ports()), 'done');
    assert.deepEqual(ui.applied, [], 'no settle yet: the window has not rerun');
    assert.deepEqual(ui.pendingFrame.size, 1, 'the layer waits for the next frame');
    assert.deepEqual(
      ui.patchFor('climb'),
      { title: 'Climbing, moved' },
      'the overlay still shows the held change',
    );
    // The rerun lands with the send's commit: the real row carries the change, the layer drops.
    ui.frame();
    assert.deepEqual(ui.applied, ['climb'], 'the write settled on the newer frame');
    assert.equal(ui.patchFor('climb'), undefined, 'the real row has arrived — the layer is gone');
  } finally {
    resetToasts();
  }
});
