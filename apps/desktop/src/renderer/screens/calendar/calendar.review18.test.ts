/**
 * The review18 fixes: held-write failure gaps a reviewer found over the review17 follow-ups.
 *
 * - A held write that fails AFTER the receipt with a grant error (`needsReauth` / `auth.expired`,
 *   `permission.calendarWrite`) is a failure the owner must answer: the persistent op toast says
 *   the change is still owed and keeps the grant verb (Sign in again / Enable editing) beside
 *   Retry — `Operation/retry` on the same op id. Submit-time behaviour is unchanged.
 * - `retireFailedOps` moves from submit to receipt acceptance: a rejected new write must leave
 *   the event's older failure toast — and its armed Retry — untouched.
 * - A refused `Operation/retry` shows Dismiss only for terminal refusals (conflict, notFound);
 *   transient ones (unavailable, unknown) keep Retry.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSession } from '@aplos/contract/client';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { OperationFailedError, setClock, subscribeOperation, undoStack } from '../../data';
import { connectDataLayer } from '../../data/connect';
import { harnessClock } from '../../data/clock';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { runCalendarEffect, type EffectPorts } from './effects';
import type { CalendarEffect } from './calendar.model';
import { ports, resetWrites, settle, testUi } from './calendar.testkit';

const DINNER = 'demo-personal:ev-dinner'; // the stand-in's guested event: every write to it is held

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

/** A `notify: true` write on the guested event, carrying the account that owns the grant. */
const guestedFx = (title: string, accountId = 'demo-personal'): CalendarEffect => ({
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
  accountId,
});

const lateFailure = () => ({
  mode: 'afterReceipt' as const,
  type: 'unavailable',
  message: 'engine words',
  reasonCode: 'calendar.late',
  afterMs: 500,
});

const failedToast = () => getToasts().find(t => t.id.endsWith(':failed'));
const toastFor = (id: string) => getToasts().find(t => t.id === id);

/** A held write on the guested event through the real stand-in; its operation id once confirmed. */
async function heldWrite(fail?: {
  mode: 'reject' | 'afterReceipt';
  type: string;
  message: string;
  reasonCode?: string;
  afterMs?: number;
}) {
  const env = await bootRecorded();
  resetToasts();
  if (fail) env.engine.fixture.failures.push({ afterMs: 0, ...fail });
  const ui = testUi();
  runCalendarEffect(guestedFx('one'), watchedPorts(), ui);
  await env.flush();
  const peek = undoStack.peek();
  assert.ok(peek?.kind === 'operation', 'the held write joined the undo stack');
  return { ...env, ui, opId: peek.opId };
}

test('review18: an auth.expired failure after the receipt — persistent toast, Sign in again beside Retry', async () => {
  const { control, flush, opId } = await heldWrite({
    mode: 'afterReceipt',
    type: 'needsReauth',
    message: 'grant expired',
    reasonCode: 'auth.expired',
    afterMs: 500,
  });
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const toast = failedToast();
    // The write was ACCEPTED: the engine still holds the failed change, so this is a failure
    // the owner must answer — persistent, says the change is owed, and keeps the grant verb
    // beside Retry (Operation/retry on the same op id). Never a 4 s notice that fades while
    // the failed hold stays in the engine.
    assert.equal(toast?.persistent, true, 'a failure the owner must answer never times out');
    assert.equal(
      toast?.message,
      'Sign in to Google again to send this change.',
      'the sentence says the change is still owed',
    );
    assert.deepEqual(
      toast?.actions?.map(a => a.id),
      ['reconnect', 'retry', 'dismiss'],
      'Sign in again beside Retry and Dismiss',
    );
    assert.equal(toastFor(opId), undefined, 'the held Undo toast is gone');
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: a permission.calendarWrite failure after the receipt — Enable editing beside Retry', async () => {
  const { control, flush } = await heldWrite({
    mode: 'afterReceipt',
    type: 'permission',
    message: 'missing scope',
    reasonCode: 'permission.calendarWrite',
    afterMs: 500,
  });
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const toast = failedToast();
    assert.equal(toast?.persistent, true);
    assert.equal(toast?.message, 'Turn on editing to send this change.');
    assert.deepEqual(
      toast?.actions?.map(a => a.id),
      ['enable', 'retry', 'dismiss'],
      'Enable editing beside Retry and Dismiss',
    );
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: the grant verb on the op toast runs the account action', async () => {
  const env = await bootRecorded();
  resetToasts();
  env.engine.fixture.failures.push({
    mode: 'afterReceipt',
    type: 'needsReauth',
    message: 'grant expired',
    reasonCode: 'auth.expired',
    afterMs: 500,
  });
  const signedIn: string[] = [];
  const spyPorts: EffectPorts = {
    ...watchedPorts(),
    reconnect: accountId => signedIn.push(accountId),
  };
  try {
    runCalendarEffect(guestedFx('one'), spyPorts, testUi());
    await env.flush();
    await env.control.advanceClock({ ms: 1_000 });
    await env.flush();
    const toast = failedToast();
    assert.ok(toast?.actions?.some(a => a.id === 'reconnect'));
    runToastAction(toast!.id, 'reconnect');
    assert.deepEqual(signedIn, ['demo-personal'], 'Sign in again opens the reconnect sheet');
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: a rejected new write keeps the event’s older failure toast and its armed Retry', async () => {
  const { control, flush, calls, opId } = await heldWrite(lateFailure());
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const stale = failedToast();
    assert.ok(stale?.persistent, 'the failed hold is up');
    // The owner edits the event again but THIS write is rejected: the old failure must survive
    // — retiring it at submit would leave the owner with neither the new write nor the old
    // failure's Retry.
    const rejecting: EffectPorts = {
      ...watchedPorts(),
      eventSet: () =>
        Promise.reject(
          new OperationFailedError('op-b', {
            type: 'unavailable',
            message: 'engine busy',
          }),
        ),
    };
    runCalendarEffect(guestedFx('two'), rejecting, testUi());
    await flush();
    assert.ok(toastFor(stale!.id), 'the old failure toast survives the rejected new write');
    // Its Retry is still armed: the click runs Operation/retry on the old op id.
    const retries = () => calls.filter(c => c.method === 'Operation/retry');
    runToastAction(stale!.id, 'retry');
    await flush();
    assert.equal(retries().length, 1, 'the armed Retry still fires');
    assert.equal((retries()[0]!.args as { opId: string }).opId, opId);
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: an accepted new write retires the event’s older failure toast', async () => {
  const { control, flush } = await heldWrite(lateFailure());
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const stale = failedToast();
    assert.ok(stale?.persistent, 'the failed hold is up');
    // The new write IS accepted: the stale failure is retired exactly as before.
    runCalendarEffect(guestedFx('two'), watchedPorts(), testUi());
    await flush();
    assert.equal(
      toastFor(stale!.id),
      undefined,
      'the stale failure toast is gone once the new write lands',
    );
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: a terminal refusal of Operation/retry offers Dismiss only', async () => {
  const { control, flush, engine, opId } = await heldWrite(lateFailure());
  try {
    await control.advanceClock({ ms: 1_000 });
    await flush();
    const toast = failedToast();
    assert.ok(toast?.persistent);
    // The op left 'failed' behind the toast's back (a provider-side retry synced it): the
    // engine answers the stale click with its own conflict. A Retry that can never succeed is
    // worse than none — the refusal toast gets Dismiss only.
    const rec = engine.fixture.ops.get(opId);
    assert.ok(rec);
    rec.operation = { ...rec.operation, state: 'synced' };
    runToastAction(toast!.id, 'retry');
    await flush();
    const again = failedToast();
    assert.equal(again?.message, 'Only a failed change can be retried.', 'the refusal sentence');
    assert.equal(again?.persistent, true);
    assert.deepEqual(
      again?.actions?.map(a => a.id),
      ['dismiss'],
      'a terminal refusal does not re-offer Retry',
    );
  } finally {
    resetWrites();
    resetToasts();
  }
});

test('review18: a transient refusal of Operation/retry keeps Retry', async () => {
  const env = await bootRecorded();
  resetToasts();
  env.engine.fixture.failures.push(lateFailure());
  try {
    // The toast's Retry closes over the write's ports: this port's Operation/retry answers a
    // transient 'unavailable' — the engine is briefly unreachable — so the owner may try again.
    const refusing: EffectPorts = {
      ...watchedPorts(),
      operationRetry: () =>
        Promise.reject(
          new OperationFailedError('op-r', {
            type: 'unavailable',
            message: 'engine busy',
          }),
        ),
    };
    runCalendarEffect(guestedFx('one'), refusing, testUi());
    await env.flush();
    await env.control.advanceClock({ ms: 1_000 });
    await env.flush();
    const toast = failedToast();
    assert.ok(toast?.persistent);
    runToastAction(toast!.id, 'retry');
    await env.flush();
    const again = failedToast();
    assert.equal(again?.persistent, true, 'the refused retry keeps its surface');
    assert.deepEqual(
      again?.actions?.map(a => a.id),
      ['retry', 'dismiss'],
      'a transient refusal keeps Retry beside Dismiss',
    );
  } finally {
    resetWrites();
    resetToasts();
  }
});
