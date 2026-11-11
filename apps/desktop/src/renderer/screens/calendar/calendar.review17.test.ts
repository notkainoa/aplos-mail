/**
 * The review17 fixes: held-write gaps two reviewers found over the review16 follow-ups. The tests
 * model the REAL data layer (`data/operations.ts`, `data/hooks.ts`): `subscribeOperation` notifies
 * once synchronously at subscribe with the current view (a journaled record exists from issue, so
 * the first view is defined with `remote: null`; the `Operation` row lands later), `Operations.add`
 * forgets the oldest record past 200, and a forgotten record's next snapshot is `undefined`.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSession } from '@aplos/contract/client';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { setClock, subscribeOperation, undoStack } from '../../data';
import { connectDataLayer } from '../../data/connect';
import { harnessClock } from '../../data/clock';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import type { EventChange } from '@aplos/contract';
import type { OperationView, Receipt } from '../../data';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { runCalendarEffect, type EffectPorts } from './effects';
import type { CalendarEffect } from './calendar.model';
import { NOW, ports, resetWrites, settle, testUi } from './calendar.testkit';

const DINNER = 'demo-personal:ev-dinner'; // the stand-in's guested event: every write to it is held

const task = () => new Promise<void>(resolve => setImmediate(resolve));

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

/** The receipt a held write gets: undoable behind `undoUntil` (the harness's frozen NOW + 60 s). */
const heldReceipt = () => receipt({ undoable: true, undoUntil: NOW + 60_000 });

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

/** A `watchOperation` port that hands every registered listener to the test. When `first` is set
 * the listener is called with it at subscribe — the real `subscribeOperation` notifies once with
 * the current view (a record that has not landed yet answers `undefined`). */
function watchStub(first?: { readonly view: OperationView | undefined }) {
  const listeners = new Map<string, (view: OperationView | undefined) => void>();
  const port: NonNullable<EffectPorts['watchOperation']> = (opId, listener) => {
    if (first) listener(first.view);
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

/** A `notify: true` write on the guested event: held once the engine sees it, one overlay entry. */
const guestedFx = (title: string): CalendarEffect => ({
  kind: 'eventSet',
  change: {
    type: 'update',
    id: DINNER,
    scope: 'occurrence',
    fields: { title },
  },
  optimistic: { id: DINNER, patch: { title } },
  notify: true,
  toast: {
    kind: 'info',
    message: `Changed ${title}`,
    held: `Changing ${title}`,
    undoable: true,
  },
  undoLabel: `Changed ${title}`,
  failure: `Couldn’t change ${title}.`,
});

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

/** `ports()` plus the real `subscribeOperation` watch. */
const watchedPorts = (): EffectPorts => ({
  ...ports(),
  watchOperation: (opId, listener) => subscribeOperation(opId, listener),
});

const failedToast = () => getToasts().find(t => t.id.endsWith(':failed'));
const toastFor = (opId: string) => getToasts().find(t => t.id === opId);

test('review17: a forgotten op rolls back, frees the event and closes the held Undo toast', async () => {
  const env = await bootRecorded();
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(guestedFx('one'), watchedPorts(), ui);
    // Enough microtasks for the receipt and the subscribe, but no scheduler flush: the
    // `Operation` row has not landed, so subscribeOperation's first notify was `remote: null`
    // and lastRemote is null — the dedup trap the reviewers found.
    await task();
    await task();
    const peek = undoStack.peek();
    assert.ok(peek?.kind === 'operation', 'the held write joined the undo stack');
    const opId = peek.opId;
    assert.equal(
      env.connection.layer.operations.view(opId)?.remote,
      null,
      'no remote frame landed yet — lastRemote is null',
    );
    assert.ok(toastFor(opId)?.undoable, 'the held Undo toast is up while the hold waits');
    // The store then forgets the record (Operations.add evicts at 200): the next view is
    // `undefined` — the write must still roll back here, not early-return on `null === null`.
    env.connection.layer.operations.forget(opId);
    assert.deepEqual(ui.dropped, [DINNER], 'the overlay rolls back rather than ride the grid');
    assert.equal(toastFor(opId), undefined, 'the held Undo toast closes with the rollback');
    // The event is writable again: a second write submits — never a stale holdPending fail-fast.
    const spy = eventSetSpy({ receipt: heldReceipt() });
    runCalendarEffect(guestedFx('two'), { ...watchedPorts(), eventSet: spy.port }, testUi());
    await task();
    assert.equal(spy.calls.length, 1, 'the forgotten hold freed its target');
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review17: an op that has not arrived yet is not forgotten — the watch stays', async () => {
  await bootRecorded();
  resetToasts();
  try {
    // The record has not reached the store when the watch subscribes: the first view is
    // `undefined`, which is NOT a forgotten op — nothing may roll back, and a later frame must
    // still reach the watch.
    const watch = watchStub({ view: undefined });
    const spy = eventSetSpy({ receipt: heldReceipt() });
    const ui = testUi();
    runCalendarEffect(
      guestedFx('one'),
      { ...ports(), eventSet: spy.port, watchOperation: watch.port },
      ui,
    );
    await task();
    assert.deepEqual(ui.dropped, [], 'a not-yet-arrived op keeps its overlay');
    watch.fire(
      opView({
        remote: 'failed',
        error: { type: 'unavailable', message: 'engine words', reasonCode: 'calendar.late' },
      }),
    );
    assert.ok(failedToast(), 'the watch lived to see the op-level failure');
  } finally {
    resetWrites();
    resetToasts();
  }
});
