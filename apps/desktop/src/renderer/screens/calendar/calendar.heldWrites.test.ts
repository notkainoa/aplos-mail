/**
 * Held calendar writes (the providers' 2026-11-10 shapes): a write guests are told about is held until
 * `undoUntil`, then the provider answers as an `operation` frame, not as the call's rejection.
 *
 * - `calendar.late` (the hold missed its window) and `calendar.holdPending` (an earlier change is still
 *   waiting) map through `writeFailureOf`: plain sentences, `keepDraft` for the pending refusal, and an
 *   'operation' retry kind for the late hold — `Operation/retry` on the same op id, never the write again.
 * - A `failed` operation frame rolls the optimistic overlay back like a rejection and pushes the mapped
 *   sentence once; `cancelled` (the owner's Undo inside the window) rolls back quietly; `synced` after a
 *   retried failure takes the failure toast down.
 * - Undo after the window (keyboard Z, the screen's `app.undo`) says "That change was already sent."
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSession } from '@aplos/contract/client';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { api, OperationFailedError, setClock, subscribeOperation, undoStack } from '../../data';
import { connectDataLayer } from '../../data/connect';
import { harnessClock } from '../../data/clock';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { draftFromEvent, update, type CalendarEffect } from './calendar.model';
import { runCalendarEffect, undoLastCalendarChange, type EffectPorts } from './effects';
import { writeFailureOf } from './writeErrors';
import { boot, ctxFor, ports, S, settle, testUi } from './calendar.testkit';
import { EMPTY_OVERLAY, overlayDrop, overlayWith, type Overlay } from './model/entries';
import type { EffectUi } from './effects';

const DINNER = 'demo-personal:ev-dinner'; // the stand-in's guested event: every write to it is held

/** The write the tests run on the guested event: one overlay entry, one held toast. */
const dinnerFx: CalendarEffect = {
  kind: 'eventSet',
  change: {
    type: 'update',
    id: DINNER,
    scope: 'occurrence',
    fields: { title: 'Dinner moved' },
  },
  optimistic: { id: DINNER, patch: { title: 'Dinner moved' } },
  toast: {
    kind: 'info',
    message: 'Changed Dinner with Sam',
    held: 'Changing Dinner with Sam',
    undoable: true,
  },
  undoLabel: 'Changed Dinner with Sam',
  failure: 'Couldn’t change Dinner with Sam.',
};

/** `boot()` with every engine call recorded, plus the fixture control channel. */
async function bootRecorded() {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const inner = engine.connect();
  const calls: { method: string; args: unknown }[] = [];
  const session: EngineSession = {
    call(method, args, callOptions) {
      calls.push({ method, args });
      return inner.call(method, args, callOptions);
    },
    subscribe: listener => inner.subscribe(listener),
    close: () => inner.close(),
  };
  const connection = connectDataLayer({
    session,
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  setClock(harnessClock);
  const flush = async () => settle(scheduler.flush);
  await flush();
  return { connection, flush, engine, calls, control: fixtureControl(engine) };
}

/** `ports()` plus the operation watch stub tests do not need. */
const watchedPorts = (): EffectPorts => ({
  ...ports(),
  watchOperation: (opId, listener) => subscribeOperation(opId, listener),
});

const heldFailure = (reasonCode: string) => ({
  mode: 'afterReceipt' as const,
  type: 'unavailable',
  message: 'engine words',
  reasonCode,
  afterMs: 500,
});

const failedToast = () => getToasts().find(t => t.id.endsWith(':failed'));
const toastFor = (opId: string) => getToasts().find(t => t.id === opId);

test('heldWrites: calendar.late and calendar.holdPending map to their sentences and retry kinds', () => {
  const late = writeFailureOf(
    new OperationFailedError('op-l', {
      type: 'unavailable',
      message: 'engine words',
      reasonCode: 'calendar.late',
    }),
    'Fallback.',
  );
  assert.equal(
    late.message,
    "That change wasn't sent in time. Check the event, then send it again.",
  );
  assert.equal(late.retry, 'operation');
  const pending = writeFailureOf(
    new OperationFailedError('op-p', {
      type: 'conflict',
      message: 'engine words',
      reasonCode: 'calendar.holdPending',
    }),
    'Fallback.',
  );
  assert.equal(
    pending.message,
    "Your earlier change to this event hasn't been sent yet. Wait a moment, or undo it.",
  );
  assert.equal(pending.retry, 'none');
  assert.equal(pending.keepDraft, true);
});

test('heldWrites: a holdPending refusal keeps the editor draft and a plain write shows no Retry', async () => {
  resetToasts();
  try {
    // An editor save: the sentence lands on the re-opened draft, typed work kept — never a toast too.
    const save = update(
      S({ editor: { ...draftFromEvent(ctxFor().events.get('dental')!), title: 'Cleaning' } }),
      { type: 'editorSave' },
      ctxFor(),
    );
    const fx = save.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.draft);
    const rejecting: EffectPorts = {
      ...ports(),
      eventSet: () =>
        Promise.reject(
          new OperationFailedError('op-x', {
            type: 'conflict',
            message: 'engine words',
            reasonCode: 'calendar.holdPending',
          }),
        ),
    };
    const ui = testUi();
    runCalendarEffect(fx, rejecting, ui);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ui.restored, [
      {
        draft: fx.draft,
        note: "Your earlier change to this event hasn't been sent yet. Wait a moment, or undo it.",
      },
    ]);
    assert.equal(failedToast(), undefined, 'no failure toast beside the re-opened draft');
    assert.deepEqual(ui.dropped, ['dental']);
  } finally {
    resetToasts();
  }
  resetToasts();
  try {
    // A drag, a menu write: no draft to keep — the sentence in a toast, no Retry.
    const ui = testUi();
    runCalendarEffect(
      dinnerFx,
      {
        ...ports(),
        eventSet: () =>
          Promise.reject(
            new OperationFailedError('op-x', {
              type: 'conflict',
              message: 'engine words',
              reasonCode: 'calendar.holdPending',
            }),
          ),
      },
      ui,
    );
    await new Promise(resolve => setImmediate(resolve));
    const toast = failedToast();
    assert.equal(
      toast?.message,
      "Your earlier change to this event hasn't been sent yet. Wait a moment, or undo it.",
    );
    assert.equal(toast?.actions, undefined, 'no Retry while the earlier change is still queued');
    assert.deepEqual(ui.dropped, [DINNER]);
  } finally {
    resetToasts();
  }
});

/** A held write on the guested event through the real stand-in; its operation id once confirmed. */
async function heldWrite(fail?: ReturnType<typeof heldFailure>) {
  const env = await bootRecorded();
  resetToasts();
  if (fail) env.engine.fixture.failures.push(fail);
  const ui = testUi();
  runCalendarEffect(dinnerFx, watchedPorts(), ui);
  await env.flush();
  const peek = undoStack.peek();
  assert.ok(peek?.kind === 'operation', 'the held write joined the undo stack');
  return { ...env, ui, opId: peek.opId };
}

test('heldWrites: a hold that fails after the receipt shows the late sentence and rolls back', async () => {
  const { control, flush, ui, opId } = await heldWrite(heldFailure('calendar.late'));
  try {
    assert.ok(toastFor(opId)?.undoable, 'the Undo toast is up while the hold waits');
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const toast = failedToast();
    assert.equal(
      toast?.message,
      "That change wasn't sent in time. Check the event, then send it again.",
    );
    assert.ok(
      toast?.actions?.some(a => a.id === 'retry'),
      'Retry is offered',
    );
    assert.equal(toastFor(opId), undefined, 'the held toast is gone');
    assert.deepEqual(ui.dropped, [DINNER], 'the overlay rolls back like a rejection');
  } finally {
    resetToasts();
  }
});

test('heldWrites: Retry runs Operation/retry on the same op id, never the write again', async () => {
  const { control, flush, calls, opId } = await heldWrite(heldFailure('calendar.late'));
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const sets = calls.filter(c => c.method === 'Event/set').length;
    const toast = failedToast();
    assert.ok(toast?.actions?.some(a => a.id === 'retry'));
    runToastAction(toast!.id, 'retry');
    await flush();
    const retries = calls.filter(c => c.method === 'Operation/retry');
    assert.equal(retries.length, 1, 'one Operation/retry');
    assert.equal((retries[0]!.args as { opId: string }).opId, opId, 'the same op id is retried');
    assert.equal(
      calls.filter(c => c.method === 'Event/set').length,
      sets,
      'the write is never re-issued',
    );
  } finally {
    resetToasts();
  }
});

test('heldWrites: a retried hold that then syncs takes the failure toast down', async () => {
  const { control, flush, ui } = await heldWrite(heldFailure('calendar.late'));
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    runToastAction(failedToast()!.id, 'retry');
    await control.advanceClock({ ms: 1_000 });
    await flush();
    assert.equal(failedToast(), undefined, 'the failure toast is gone once the retry syncs');
    assert.equal(getToasts().length, 0, 'nothing else lingers');
    assert.deepEqual(
      ui.dropped,
      [DINNER],
      'the overlay stays rolled back; real rows arrive via windows',
    );
  } finally {
    resetToasts();
  }
});

test('heldWrites: repeated failed frames push exactly one toast per failed operation', async () => {
  const { control, flush, engine, opId } = await heldWrite(heldFailure('calendar.late'));
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    assert.ok(failedToast());
    // The same failure reaches the surface again (a second session's read, a replay): no second toast.
    const op = engine.fixture.ops.get(opId)?.operation;
    assert.ok(op);
    await control.replay({ frames: [{ frame: 'operation', operation: op }] });
    await flush();
    assert.equal(
      getToasts().filter(t => t.id.endsWith(':failed')).length,
      1,
      'still one toast for the one failed operation',
    );
  } finally {
    resetToasts();
  }
});

test('heldWrites: Undo inside the window cancels quietly — rollback, no failure toast', async () => {
  const { flush, ui, opId } = await heldWrite();
  try {
    const undo = api.operation.undo({ opId });
    await undo.receipt;
    await flush();
    assert.deepEqual(ui.dropped, [DINNER], 'the edit rolls back to before the change');
    assert.equal(failedToast(), undefined, 'an owner’s undo is never a failure');
    assert.equal(getToasts().length, 0, 'the held toast closed with the cancel');
  } finally {
    resetToasts();
  }
});

test('heldWrites: Undo after the window says "That change was already sent"', async () => {
  const { engine, flush } = await heldWrite();
  try {
    // The hold went out behind the owner's back: the undo answers conflict.
    engine.fixture.failures.push({
      mode: 'reject',
      type: 'conflict',
      message: 'This change has been sent, so it cannot be undone.',
      afterMs: 0,
    });
    undoLastCalendarChange();
    await flush();
    const refusal = getToasts().find(t => t.id.endsWith(':undo'));
    assert.equal(refusal?.message, 'That change was already sent.');
  } finally {
    resetToasts();
  }
});

test('heldWrites: a late failure through the real stand-in carries reasonCode on the frame', async () => {
  // Boot's own connection (no call recording needed): the failure sentence proves the
  // `operation` frame's `error.reasonCode` reached `writeFailureOf`.
  const { flush, engine } = await boot();
  resetToasts();
  try {
    engine.fixture.failures.push(heldFailure('calendar.conflict'));
    const ui = testUi();
    runCalendarEffect(dinnerFx, watchedPorts(), ui);
    await flush();
    const control = fixtureControl(engine);
    await control.advanceClock({ ms: 1_000 });
    await flush();
    assert.equal(
      failedToast()?.message,
      "This event changed somewhere else. Your changes weren't saved.",
      'a provider conflict after the receipt maps like a rejection',
    );
    assert.deepEqual(ui.dropped, [DINNER]);
  } finally {
    resetToasts();
  }
});

/**
 * An `EffectUi` bound to the real overlay functions, as CalendarScreen's `useState<Overlay>` is —
 * the point of the stacked-writes tests is the merged patch, which a recording `testUi` cannot show.
 */
function overlayUi() {
  let overlay: Overlay = EMPTY_OVERLAY;
  const ui: EffectUi = {
    optimistic: (writeId, change) => {
      overlay = overlayWith(overlay, writeId, change);
    },
    settle: () => undefined,
    rollback: (id, writeId) => {
      overlay = overlayDrop(overlay, writeId, id);
    },
    shown: () => undefined,
    shownSettled: () => undefined,
    shownFailed: () => undefined,
    focus: () => undefined,
    reopenEditor: () => false,
    restoreEditor: () => false,
    closeDetail: () => undefined,
  };
  return { ui, overlay: () => overlay };
}

const titledFx = (title: string): CalendarEffect => ({
  ...dinnerFx,
  change: { type: 'update', id: DINNER, scope: 'occurrence', fields: { title } },
  optimistic: { id: DINNER, patch: { title } },
});

test('stackedWrites: a refused second write leaves the first write’s overlay intact', async () => {
  const { flush } = await bootRecorded();
  resetToasts();
  const { ui, overlay } = overlayUi();
  try {
    // A's held write lands optimistically and waits out the undo window.
    runCalendarEffect(titledFx('A first'), watchedPorts(), ui);
    await flush();
    assert.equal(overlay().patch.get(DINNER)?.title, 'A first');
    // B on the same event is refused (A's hold is still waiting): B's own contribution rolls back,
    // A's pending patch must not go with it.
    const refusing: EffectPorts = {
      ...watchedPorts(),
      eventSet: () =>
        Promise.reject(
          new OperationFailedError('op-b', {
            type: 'conflict',
            message: 'engine words',
            reasonCode: 'calendar.holdPending',
          }),
        ),
    };
    runCalendarEffect(titledFx('B second'), refusing, ui);
    await flush();
    assert.equal(
      overlay().patch.get(DINNER)?.title,
      'A first',
      'B’s rollback drops only B’s patch — A’s held change still shows',
    );
  } finally {
    resetToasts();
  }
});

test('stackedWrites: the first write’s cancelled frame leaves the second write’s overlay intact', async () => {
  const { flush } = await bootRecorded();
  resetToasts();
  const { ui, overlay } = overlayUi();
  try {
    runCalendarEffect(titledFx('A first'), watchedPorts(), ui);
    await flush();
    const opA = undoStack.peek();
    assert.ok(opA?.kind === 'operation');
    // B is still in flight (its call has not answered) when A's hold is cancelled.
    let releaseB: ((receipt: never) => void) | undefined;
    const holding: EffectPorts = {
      ...watchedPorts(),
      eventSet: () => new Promise(resolve => (releaseB = resolve as typeof releaseB)),
    };
    runCalendarEffect(titledFx('B second'), holding, ui);
    await api.operation.undo({ opId: opA.opId }).receipt;
    await flush();
    assert.equal(
      overlay().patch.get(DINNER)?.title,
      'B second',
      'A’s rollback drops only A’s patch — B’s in-flight change still shows',
    );
    assert.ok(releaseB);
  } finally {
    resetToasts();
  }
});

test('stackedWrites: writes on one event roll back cleanly in any order', async () => {
  const { flush } = await bootRecorded();
  resetToasts();
  const { ui, overlay } = overlayUi();
  try {
    runCalendarEffect(titledFx('A first'), watchedPorts(), ui);
    await flush();
    const opA = undoStack.peek();
    assert.ok(opA?.kind === 'operation');
    // B still in flight; C refused outright. C's rollback drops C only.
    const refusing: EffectPorts = {
      ...watchedPorts(),
      eventSet: () =>
        Promise.reject(
          new OperationFailedError('op-c', {
            type: 'conflict',
            message: 'engine words',
            reasonCode: 'calendar.holdPending',
          }),
        ),
    };
    let releaseB: ((receipt: never) => void) | undefined;
    const holding: EffectPorts = {
      ...watchedPorts(),
      eventSet: () => new Promise(resolve => (releaseB = resolve as typeof releaseB)),
    };
    runCalendarEffect(titledFx('B second'), holding, ui);
    runCalendarEffect(titledFx('C third'), refusing, ui);
    await flush();
    assert.equal(overlay().patch.get(DINNER)?.title, 'B second', 'C dropped, B still pending');
    // B refuses as well: now only A's held change shows.
    releaseB?.(
      Promise.reject(
        new OperationFailedError('op-b', {
          type: 'conflict',
          message: 'engine words',
          reasonCode: 'calendar.holdPending',
        }),
      ) as never,
    );
    await flush();
    assert.equal(overlay().patch.get(DINNER)?.title, 'A first', 'B dropped, A still pending');
    // Then A's own cancel: nothing is left.
    await api.operation.undo({ opId: opA.opId }).receipt;
    await flush();
    assert.equal(overlay().patch.get(DINNER), undefined, 'every write rolled back: no patch left');
  } finally {
    resetToasts();
  }
});
