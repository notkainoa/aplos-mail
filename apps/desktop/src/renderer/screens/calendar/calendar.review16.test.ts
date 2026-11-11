/**
 * The review16 fixes: what the second held-writes thread (PR #476's review12–15) still has over the
 * merged per-write overlay + `watchWrite` architecture (PR #474). The tests model the REAL engine
 * (`packages/engine` methods/event.ts, calendar/holds.ts): `Event/set` is held ONLY when
 * `notify === true` and only then journals an `Operation` — a guest-less write answers
 * `undoable: false` and `Operation/get` says notFound; a held write's receipt `appliedState` is
 * already reached (the hold's own commit never moves `seq`), so the overlay settles at `synced`,
 * then on the window frame after (reruns are throttled); a forgotten op must roll its overlay back.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventChange } from '@aplos/contract';
import { OperationFailedError, type OperationView, type Receipt } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import {
  draftFromEvent,
  EMPTY_OVERLAY,
  overlayDrop,
  overlayWith,
  update,
  type CalendarEffect,
  type OptimisticChange,
  type Overlay,
} from './calendar.model';
import * as transitions from './model/transitions';
import { calendarUndoRefused, runCalendarEffect, type EffectPorts } from './effects';
import { writeFailureOf } from './writeErrors';
import { boot, ctxFor, NOW, ports, S, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const task = () => new Promise<void>(resolve => setImmediate(resolve));

const opView = (over: Partial<OperationView> = {}): OperationView => ({
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

/** A `watchOperation` port that hands every registered listener to the test. */
function watchStub() {
  const listeners = new Map<string, (view: OperationView | undefined) => void>();
  const port: NonNullable<EffectPorts['watchOperation']> = (opId, listener) => {
    listeners.set(opId, listener);
    return () => listeners.delete(opId);
  };
  const fire = (view: OperationView | undefined) => {
    for (const listener of [...listeners.values()]) listener(view);
  };
  return { port, listeners, fire };
}

const eventSetSpy = (out: { receipt: Receipt } | { error: unknown }) => {
  const calls: Array<{ change: EventChange; notify?: boolean }> = [];
  const port: EffectPorts['eventSet'] = args => {
    calls.push(args);
    return 'error' in out ? Promise.reject(out.error) : Promise.resolve(out);
  };
  return { calls, port };
};

type EventSetFx = Extract<CalendarEffect, { kind: 'eventSet' }>;

/** A write that emails guests on 'climb' — held on the real engine once `notify` reaches it. */
const moveFx = (over: Partial<EventSetFx> = {}): EventSetFx =>
  ({
    kind: 'eventSet',
    change: {
      type: 'update',
      id: 'climb',
      scope: 'occurrence',
      fields: { title: 'Climbing, moved' },
    },
    optimistic: { id: 'climb', patch: { title: 'Climbing, moved' } },
    notify: true,
    toast: {
      kind: 'info',
      message: 'Moved Climbing',
      held: 'Moving Climbing',
      undoable: true,
    },
    undoLabel: 'Moved Climbing',
    failure: 'Couldn’t move Climbing.',
    ...over,
  }) as EventSetFx;

const failedToast = () => getToasts().find(t => t.id.endsWith(':failed'));

/** The receipt a held write gets: undoable behind `undoUntil` (the harness's frozen NOW + 60 s). */
const heldReceipt = () => receipt({ undoable: true, undoUntil: NOW + 60_000 });

test('review16: notify: true goes on Event/set exactly when guests are emailed', async () => {
  await boot();
  resetToasts();
  try {
    const notifyOf = (fx: CalendarEffect | undefined) =>
      (fx as { notify?: boolean } | undefined)?.notify;
    const ctx = ctxFor();
    // The model flags a drag, a save and a delete of an event with guests — never a guest-less one.
    const moved = update(
      S(),
      { type: 'move', id: 'climb', start: '2026-10-29T18:30', end: '2026-10-29T20:00' },
      ctx,
    );
    assert.equal(
      notifyOf(moved.effects.find(f => f.kind === 'eventSet')),
      true,
      'a drag on a guested event',
    );
    const saved = update(
      S({ editor: { ...draftFromEvent(ctx.events.get('design')!), title: 'Design review v2' } }),
      { type: 'editorSave' },
      ctx,
    );
    assert.equal(
      notifyOf(saved.effects.find(f => f.kind === 'eventSet')),
      true,
      'a save on a guested event',
    );
    const deleted = update(S({ selectedId: 'climb' }), { type: 'delete' }, ctx);
    assert.equal(
      notifyOf(deleted.effects.find(f => f.kind === 'eventSet')),
      true,
      'a delete of a guested event',
    );
    const solo = update(S({ selectedId: 'dental' }), { type: 'delete' }, ctx);
    assert.notEqual(
      notifyOf(solo.effects.find(f => f.kind === 'eventSet')),
      true,
      'a guest-less delete stays unset',
    );
    // A create notifies only when it carries attendees (the editor's never do).
    const notifiesGuests = (
      transitions as {
        notifiesGuests?: (change: EventChange, original?: never) => boolean;
      }
    ).notifiesGuests;
    const create: EventChange = {
      type: 'create',
      calendarId: 'work',
      fields: {
        title: 'Kickoff',
        start: { type: 'date', date: '2026-10-30' },
        end: { type: 'date', date: '2026-10-31' },
        allDay: true,
        attendees: [{ address: 'mina@example.com' }],
      },
    };
    assert.equal(notifiesGuests?.(create), true, 'a create carrying attendees');
    assert.equal(
      notifiesGuests?.({
        ...create,
        fields: { ...create.fields, attendees: [] },
      } as EventChange),
      false,
      'a guest-less create',
    );
    // The port gets `notify: true` — never `false` (that would tell Google NOT to email guests).
    const heldSpy = eventSetSpy({ receipt: heldReceipt() });
    runCalendarEffect(moveFx(), { ...ports(), eventSet: heldSpy.port }, testUi());
    await task();
    assert.equal(heldSpy.calls.length, 1);
    assert.equal(heldSpy.calls[0]?.notify, true);
    const plainSpy = eventSetSpy({ receipt: receipt({ undoable: false }) });
    runCalendarEffect(
      moveFx({ notify: undefined }),
      { ...ports(), eventSet: plainSpy.port },
      testUi(),
    );
    await task();
    assert.equal(
      plainSpy.calls[0]?.notify,
      undefined,
      'unset, so the provider keeps its own notify default',
    );
  } finally {
    resetToasts();
  }
});

test('review16: a held write skips the receipt settle and keeps its layer until the frame after synced', async () => {
  await boot();
  resetToasts();
  try {
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(moveFx(), { ...ports(), eventSet: spy.port, watchOperation: watch.port }, ui);
    await task();
    // The hold's own commit never moves `seq`: `appliedState` is already reached — settling here
    // would snap the change back for the whole undo window.
    assert.deepEqual(ui.applied, [], 'no receipt settle for a held write');
    watch.fire(opView({ remote: 'queued' }));
    watch.fire(opView({ remote: 'syncing' }));
    assert.deepEqual(ui.applied, [], 'queued/syncing keep the layer');
    // The `synced` op frame lands ahead of the throttled window rerun (WINDOW_INTERVAL_MS): the
    // layer drops on the NEXT frame, not at once — else the event snaps back for ~250 ms.
    watch.fire(opView({ remote: 'synced', undoUntil: NOW + 60_000 }));
    assert.deepEqual(ui.applied, [], 'synced settles through the next window frame, not at once');
    assert.deepEqual(ui.pendingFrame, ['climb'], 'the layer waits for the next frame');
    assert.deepEqual(ui.dropped, [], 'nothing rolled back');
  } finally {
    resetToasts();
  }
});

test('review16: a zero-second undo window still counts as held', async () => {
  await boot();
  resetToasts();
  try {
    const watch = watchStub();
    // The owner's undo-send of 0 s still queues a hold whose `undoUntil` lands AT now: a clock
    // compare reads it unheld — the receipt's `undoable` is the truth.
    const spy = eventSetSpy({ receipt: receipt({ undoable: true, undoUntil: NOW }) });
    const ui = testUi();
    runCalendarEffect(moveFx(), { ...ports(), eventSet: spy.port, watchOperation: watch.port }, ui);
    await task();
    assert.deepEqual(ui.applied, [], 'a queued hold never settles at its receipt');
    const toast = getToasts().find(t => t.undoable);
    assert.equal(toast?.message, 'Moving Climbing', 'held wording while the hold is queued');
    watch.fire(opView({ remote: 'cancelled' }));
  } finally {
    resetToasts();
  }
});

test('review16: an unheld write registers no watch — the real engine has no Operation for it', async () => {
  await boot();
  resetToasts();
  try {
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: receipt({ undoable: false }) });
    const ui = testUi();
    runCalendarEffect(
      moveFx({ notify: undefined }),
      { ...ports(), eventSet: spy.port, watchOperation: watch.port },
      ui,
    );
    await task();
    assert.deepEqual(ui.applied, ['climb'], 'a write-through settles at its receipt');
    assert.equal(watch.listeners.size, 0, 'Operation/get would answer notFound: nothing to watch');
    // An undoable receipt still watches: the engine journaled an operation for it.
    const watch2 = watchStub();
    const ui2 = testUi();
    runCalendarEffect(
      { kind: 'planDismiss', planId: 'launch', optimistic: { id: 'launch', remove: true } },
      {
        ...ports(),
        planDismiss: () => Promise.resolve(receipt({ undoable: true })),
        watchOperation: watch2.port,
      },
      ui2,
    );
    await task();
    assert.equal(watch2.listeners.size, 1, 'a journaled op is followed');
    watch2.fire(opView({ remote: 'applied' }));
  } finally {
    resetToasts();
  }
});

test('review16: a forgotten operation record rolls its overlay back, never a ghost', async () => {
  await boot();
  resetToasts();
  try {
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(moveFx(), { ...ports(), eventSet: spy.port, watchOperation: watch.port }, ui);
    await task();
    // `useOperation` answers undefined once the store forgets the record: the held patch (or a
    // create's tmp entry) must roll back here, not ride the grid forever.
    watch.fire(undefined);
    assert.deepEqual(ui.dropped, ['climb']);
    // The watch ended with it: a later frame does nothing.
    watch.fire(opView({ remote: 'failed' }));
    assert.equal(failedToast(), undefined);
  } finally {
    resetToasts();
  }
});

test('review16: an operation-level failure stays until dealt with and retries only by hand', async () => {
  await boot();
  resetToasts();
  const retries: string[] = [];
  try {
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(
      moveFx(),
      {
        ...ports(),
        eventSet: spy.port,
        watchOperation: watch.port,
        operationRetry: ({ opId }) => {
          retries.push(opId);
          return Promise.resolve(receipt());
        },
      },
      ui,
    );
    await task();
    // The provider refused AFTER the receipt, carrying a retryAfterMs: nothing may re-fire on a
    // timer — the write emails guests, so only a click may send `Operation/retry`.
    watch.fire(
      opView({
        remote: 'failed',
        error: {
          type: 'unavailable',
          message: 'provider unreachable',
          reasonCode: 'calendar.unavailable',
          retryAfterMs: 1,
        },
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(retries.length, 0, 'no timer re-sends a notifying write');
    const toast = failedToast();
    assert.equal(
      toast?.message,
      "Couldn't reach Google Calendar. The change hasn't been sent yet.",
      'the write was accepted — only its send is owed',
    );
    assert.equal(toast?.persistent, true, 'a failure the owner must answer never times out');
    assert.deepEqual(
      toast?.actions?.map(a => a.label),
      ['Retry'],
    );
    runToastAction(toast!.id, 'retry');
    assert.equal(retries.length, 1, 'the click runs Operation/retry on the same op id');
  } finally {
    resetToasts();
  }
});

test('review16: a submit-time calendar.late shows its sentence with no action', async () => {
  await boot();
  resetToasts();
  try {
    // `calendar.late` means "the OPERATION missed its window" — a submit-time refusal accepted
    // nothing, so there is no operation to retry: the sentence lands alone (a click would re-run
    // `Event/set` with a fresh opId and re-notify guests).
    const spy = eventSetSpy({
      error: new OperationFailedError('op-x', {
        type: 'conflict',
        message: "That change wasn't sent in time. Check the event, then send it again.",
        reasonCode: 'calendar.late',
      }),
    });
    const ui = testUi();
    runCalendarEffect(moveFx(), { ...ports(), eventSet: spy.port }, ui);
    await task();
    assert.equal(spy.calls.length, 1);
    const toast = failedToast();
    assert.equal(
      toast?.message,
      "That change wasn't sent in time. Check the event, then send it again.",
    );
    assert.deepEqual(toast?.actions ?? [], [], 'no operation exists to retry — no action');
  } finally {
    resetToasts();
  }
});

test('review16: a second write on a still-held event fails fast, before the overlay', async () => {
  await boot();
  resetToasts();
  // The overlay is bound to the real per-write functions so the assertion can read WHAT merged —
  // a refusal under the second write's own opId must leave the first write's layer standing.
  let overlay: Overlay = EMPTY_OVERLAY;
  const ui = {
    ...testUi(),
    optimistic: (writeId: string, change: OptimisticChange) => {
      overlay = overlayWith(overlay, writeId, change);
    },
    rollback: (id: string, writeId: string) => {
      overlay = overlayDrop(overlay, writeId, id);
    },
  };
  const watch = watchStub();
  try {
    // The first drag is held (guests are told only when its undo window ends).
    const spy1 = eventSetSpy({ receipt: heldReceipt() });
    runCalendarEffect(
      moveFx(),
      { ...ports(), eventSet: spy1.port, watchOperation: watch.port },
      ui,
    );
    await task();
    watch.fire(opView({ remote: 'queued' }));
    // Dragging it again inside the window would get `calendar.holdPending` from the engine — the
    // screen refuses first: nothing submitted, no patch merged over the still-held first's.
    const spy2 = eventSetSpy({ receipt: receipt() });
    runCalendarEffect(
      moveFx({
        change: {
          type: 'update',
          id: 'climb',
          scope: 'occurrence',
          fields: { title: 'Twice' },
        },
        optimistic: { id: 'climb', patch: { title: 'Twice' } },
      }),
      { ...ports(), eventSet: spy2.port, watchOperation: watch.port },
      ui,
    );
    await task();
    assert.equal(spy2.calls.length, 0, 'nothing is submitted to be refused');
    assert.equal(
      overlay.patch.get('climb')?.title,
      'Climbing, moved',
      'the held write’s layer is untouched — never merged over, never rolled back',
    );
    assert.equal(overlay.writes.size, 1, 'only the held write’s layer exists');
    assert.equal(
      failedToast()?.message,
      "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
    );
  } finally {
    // Free the held target for the tests that follow.
    watch.fire(opView({ remote: 'synced' }));
    resetToasts();
  }
});

test('review16: holdPending copy names Undo and the hold, and keeps a safe Retry', () => {
  // The earlier hold lasts 5–30 s, so "wait a moment" under-read it and hid the way out: the copy
  // offers Undo or waiting out the first send. Retry stays — a submit-time refusal accepted
  // nothing, so re-running the write is safe.
  const failure = writeFailureOf(
    { error: { type: 'conflict', message: 'held', reasonCode: 'calendar.holdPending' } },
    'Couldn’t change Renamed.',
  );
  assert.equal(
    failure.message,
    "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
  );
  assert.equal(failure.retry, 'now');
});

test('review16: a second Undo says "already undone", not "already sent"', async () => {
  await boot();
  resetToasts();
  try {
    // The engine answers `conflict` in two cases (holds.ts): "was already undone" for a second
    // press, "has been sent" once the window closed — each must read differently.
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(moveFx(), { ...ports(), eventSet: spy.port }, ui);
    await task();
    const opId = getToasts().find(t => t.undoable)?.id;
    assert.ok(opId, 'the held write pushed its Undo toast');
    calendarUndoRefused(opId, {
      error: { type: 'conflict', message: 'This change was already undone.' },
    });
    assert.equal(
      getToasts().find(t => t.id === `${opId}:undo`)?.message,
      'That change was already undone.',
    );
    calendarUndoRefused(opId, {
      error: { type: 'conflict', message: 'This change has been sent, so it cannot be undone.' },
    });
    const refusals = getToasts().filter(t => t.id === `${opId}:undo`);
    assert.equal(refusals[refusals.length - 1]?.message, 'That change was already sent.');
  } finally {
    resetToasts();
  }
});

// ---------------------------------------------------------------------------
// Already covered by the merged architecture — these lock the behaviour in.
// ---------------------------------------------------------------------------

test('review16: an operation-level failure runs the write’s own follow-ups (reopen, close, grant)', async () => {
  await boot();
  resetToasts();
  try {
    // calendar.conflict re-opens the editor on the newer copy, exactly as a submit-time refusal.
    const draft = draftFromEvent(ctxFor().events.get('climb')!);
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(
      moveFx({ reopenEditorId: 'climb', draft }),
      { ...ports(), eventSet: spy.port, watchOperation: watch.port },
      ui,
    );
    await task();
    watch.fire(
      opView({
        remote: 'failed',
        error: {
          type: 'conflict',
          message: 'changed',
          reasonCode: 'calendar.conflict',
        },
      }),
    );
    assert.deepEqual(ui.reopened, [
      {
        id: 'climb',
        note: "This event changed somewhere else. Your changes weren't saved.",
      },
    ]);
    assert.equal(failedToast(), undefined, 'the editor’s own line carries the sentence');
    // calendar.eventGone closes the detail (the spec's goneEventId is the change's own id).
    const watch2 = watchStub();
    const spy2 = eventSetSpy({ receipt: heldReceipt() });
    const ui2 = testUi();
    runCalendarEffect(
      moveFx(),
      { ...ports(), eventSet: spy2.port, watchOperation: watch2.port },
      ui2,
    );
    await task();
    watch2.fire(
      opView({
        remote: 'failed',
        error: { type: 'notFound', message: 'gone', reasonCode: 'calendar.eventGone' },
      }),
    );
    assert.deepEqual(ui2.closedFor, ['climb']);
    watch2.fire(opView({ remote: 'cancelled' }));
  } finally {
    resetToasts();
  }
});

test('review16: a stale failed row after Retry never re-fires the toast, but a second failure surfaces', async () => {
  await boot();
  resetToasts();
  const retries: string[] = [];
  try {
    const watch = watchStub();
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(
      moveFx(),
      {
        ...ports(),
        eventSet: spy.port,
        watchOperation: watch.port,
        operationRetry: ({ opId }) => {
          retries.push(opId);
          return Promise.resolve(receipt());
        },
      },
      ui,
    );
    await task();
    const stale = opView({
      remote: 'failed',
      error: { type: 'unavailable', message: 'not sent', reasonCode: 'calendar.late' },
    });
    watch.fire(stale);
    assert.ok(failedToast(), 'the failure is up');
    runToastAction(failedToast()!.id, 'retry');
    assert.equal(retries.length, 1);
    // The same `failed` row still answers until the next flush: keep watching, never re-show it.
    watch.fire(stale);
    assert.equal(failedToast(), undefined, 'the late toast did not pop straight back');
    // A genuinely newer failure still surfaces once the retried op moves on.
    watch.fire(opView({ remote: 'queued' }));
    watch.fire(
      opView({
        remote: 'failed',
        error: { type: 'unavailable', message: 'not sent', reasonCode: 'calendar.late' },
      }),
    );
    assert.ok(failedToast(), 'a second failure still surfaces');
    watch.fire(opView({ remote: 'cancelled' }));
  } finally {
    resetToasts();
  }
});

test('review16: no live Undo verb survives any terminal op state', async () => {
  await boot();
  try {
    for (const remote of ['failed', 'cancelled', 'conflict', 'synced'] as const) {
      resetToasts();
      const watch = watchStub();
      const spy = eventSetSpy({ receipt: heldReceipt() });
      const ui = testUi();
      runCalendarEffect(
        moveFx(),
        { ...ports(), eventSet: spy.port, watchOperation: watch.port },
        ui,
      );
      await task();
      const opId = getToasts().find(t => t.undoable)?.id;
      assert.ok(opId, 'the held write pushed its Undo toast');
      watch.fire(
        opView({
          remote,
          undoUntil: remote === 'synced' ? NOW + 60_000 : null,
          error:
            remote === 'failed' || remote === 'conflict'
              ? { type: 'unavailable', message: 'x', reasonCode: 'calendar.late' }
              : null,
        }),
      );
      const left = getToasts().find(t => t.id === opId);
      assert.notEqual(left?.undoable, true, `${remote}: no Undo verb outlives the terminal state`);
    }
  } finally {
    resetToasts();
  }
});
