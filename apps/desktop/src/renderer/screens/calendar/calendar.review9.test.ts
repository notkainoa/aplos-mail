/**
 * The review9 tests: the remaining refused-write kinds get plain sentences instead of the generic
 * fallback — a read-only calendar says so, the times refusals bring the saved draft back to the
 * editor (never the store's older copy), a dead grant (`needsReauth` / `auth.expired`) offers Sign
 * in again through the same sheet the sidebar's account row opens and never retries, and a
 * `notImplemented` write says editing isn't available yet. Every one rolls the overlay back.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedError } from '@aplos/contract';
import { OperationFailedError } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { draftFromEvent, update, type CalendarEffect } from './calendar.model';
import { cancelPendingRetries, runCalendarEffect, type EffectPorts } from './effects';
import { ctxFor, ports, S, testUi } from './calendar.testkit';

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const failedToast = () => [...getToasts()].reverse().find(t => t.id.endsWith(':failed'));
const reconnectToast = () => getToasts().find(t => t.id.startsWith('reconnect:'));

const rejectEventSet = (
  body: { type: string; reasonCode?: string; retryAfterMs?: number } | Error,
): EffectPorts => ({
  ...ports(),
  eventSet: () =>
    Promise.reject(
      body instanceof Error
        ? body
        : new OperationFailedError('op-x', {
            type: body.type,
            message: 'engine words',
            ...(body.reasonCode !== undefined ? { reasonCode: body.reasonCode } : {}),
            ...(body.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
          }),
    ),
});

const moveFx: CalendarEffect = {
  kind: 'eventSet',
  change: {
    type: 'update',
    id: 'dental',
    scope: 'occurrence',
    fields: { title: 'Moved cleaning' },
  },
  optimistic: { id: 'dental', patch: { title: 'Moved cleaning' } },
  toast: { kind: 'info', message: 'Moved Moved', held: 'Moving Moved', undoable: true },
  undoLabel: 'Moved Moved',
  failure: 'Couldn’t move Northwind Dental.',
  accountId: 'acct-alex',
};

/** An editor save on `dental` whose title was retyped: its `eventSet` effect carries the draft. */
function editorSave() {
  const ctx = ctxFor();
  const draft = { ...draftFromEvent(ctx.events.get('dental')!), title: 'Cleaning' };
  const save = update(S({ editor: draft }), { type: 'editorSave' }, ctx);
  const fx = save.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet');
  return { ctx, draft, fx };
}

test('review9: a read-only calendar refuses plainly, no Retry, overlay rolls back', async () => {
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(
      moveFx,
      rejectEventSet({ type: 'unsupported', reasonCode: 'calendar.readOnly' }),
      ui,
    );
    await nextTick();
    const toast = failedToast();
    assert.equal(toast?.message, "This calendar doesn't accept changes.");
    assert.equal(toast?.actions, undefined, 'a refusal that cannot change offers no Retry');
    assert.deepEqual(ui.dropped, ['dental'], 'the optimistic overlay rolls back as always');
  } finally {
    resetToasts();
  }
});

test('review9: the times refusals re-open the editor on the saved draft, not the newer copy', async () => {
  for (const reasonCode of ['event.allDayMismatch', 'event.timesRequired']) {
    resetToasts();
    try {
      const { ctx, draft, fx } = editorSave();
      assert.deepEqual(fx.draft, draft, 'the save’s write carries its draft');

      let cur = S(); // the editor closed when the write went out
      const ui = testUi();
      ui.restoreEditor = (d, note) => {
        const t = update(cur, { type: 'restoreEditor', draft: d, note }, ctx);
        cur = t.state;
        return t.handled;
      };
      runCalendarEffect(fx, rejectEventSet({ type: 'validation', reasonCode }), ui);
      await nextTick();
      assert.deepEqual(
        cur.editor,
        {
          ...draft,
          error: "Those times didn't fit the event. Check the start and end, then try again.",
        },
        `${reasonCode}: the typed draft is back, worded`,
      );
      assert.deepEqual(ui.reopened, [], `${reasonCode}: never re-opened on the newer copy`);
      assert.equal(failedToast(), undefined, `${reasonCode}: the line lands once, on the editor`);
      assert.deepEqual(ui.dropped, ['dental'], `${reasonCode}: the overlay still rolls back`);

      // An editor already open owns its draft: the sentence falls back to the toast (review8 2).
      resetToasts();
      const other = { ...draftFromEvent(ctx.events.get('focus')!), title: 'Typed edits' };
      cur = S({ editor: other });
      runCalendarEffect(fx, rejectEventSet({ type: 'validation', reasonCode }), ui);
      await nextTick();
      assert.deepEqual(cur.editor, other, `${reasonCode}: an open draft is never swapped out`);
      assert.equal(
        failedToast()?.message,
        "Those times didn't fit the event. Check the start and end, then try again.",
      );
      assert.equal(failedToast()?.actions?.some(a => a.id === 'retry') ?? false, false);
    } finally {
      resetToasts();
    }
  }
});

test('review9: a times refusal with no draft shows the sentence and no Retry', async () => {
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(
      moveFx,
      rejectEventSet({ type: 'validation', reasonCode: 'event.timesRequired' }),
      ui,
    );
    await nextTick();
    const toast = failedToast();
    assert.equal(
      toast?.message,
      "Those times didn't fit the event. Check the start and end, then try again.",
    );
    assert.equal(toast?.actions, undefined);
    assert.deepEqual(ui.restored, [], 'a move has no draft to restore');
    assert.deepEqual(ui.dropped, ['dental']);
  } finally {
    resetToasts();
  }
});

test('review9: a dead grant offers Sign in again through the reconnect port — never a retry', async () => {
  const real = global.setTimeout;
  const delays: number[] = [];
  // @ts-expect-error test shim records the delay without waiting
  global.setTimeout = (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return 0;
  };
  try {
    for (const body of [
      { type: 'needsReauth', reasonCode: 'auth.expired' },
      { type: 'needsReauth' },
      { type: 'forbidden', reasonCode: 'auth.expired', retryAfterMs: 2_000 },
    ]) {
      resetToasts();
      let reconnected: string | undefined;
      let calls = 0;
      const p: EffectPorts = {
        ...rejectEventSet(body),
        reconnect: accountId => {
          calls += 1;
          reconnected = accountId;
        },
      };
      const ui = testUi();
      runCalendarEffect(moveFx, p, ui);
      await nextTick();
      const toast = reconnectToast();
      assert.ok(toast, `${JSON.stringify(body)}: the sign-in notice is up`);
      assert.equal(toast?.message, 'Sign in to Google again to change events.');
      assert.deepEqual(
        toast?.actions?.map(a => a.label),
        ['Sign in again'],
      );
      runToastAction(toast!.id, 'reconnect');
      assert.equal(calls, 1, 'Sign in again runs the reconnect port once');
      assert.equal(reconnected, 'acct-alex', 'it opens on the write’s own account');
      assert.equal(failedToast(), undefined, 'no second failure notice');
      assert.deepEqual(ui.dropped, ['dental'], 'the overlay still rolls back');
      assert.deepEqual(delays, [], 'never auto-retried — a dead grant stays dead');
    }
    // No account behind the write: the line alone, never a dead button (review7 8).
    resetToasts();
    runCalendarEffect(
      { ...moveFx, accountId: undefined },
      rejectEventSet({ type: 'needsReauth' }),
      testUi(),
    );
    await nextTick();
    const bare = getToasts().find(t => t.id === 'reconnect:unknown');
    assert.ok(bare);
    assert.equal(bare?.actions, undefined);
  } finally {
    global.setTimeout = real;
    cancelPendingRetries();
    resetToasts();
  }
});

test('review9: notImplemented says editing isn’t available yet — no Retry, overlay rolls back', async () => {
  resetToasts();
  try {
    for (const error of [
      { type: 'notImplemented' },
      new NotImplementedError('Event/set'),
    ] as const) {
      const ui = testUi();
      runCalendarEffect(moveFx, rejectEventSet(error), ui);
      await nextTick();
      const toast = failedToast();
      assert.equal(toast?.message, "Editing isn't available yet. Nothing was changed.");
      assert.equal(toast?.actions, undefined, 'a retry cannot help a write that is not built');
      assert.deepEqual(ui.dropped, ['dental']);
    }
  } finally {
    resetToasts();
  }
});
