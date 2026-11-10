/**
 * The review8 tests: a delayed retry that fired on its own spends the notice's Retry too — a later
 * click can never duplicate the write, and a clicked Retry disarms the timer it replaces; a
 * `calendar.conflict` arriving while an editor is open never replaces that draft (the notice falls
 * back to the toast); and a lost answer on a plan confirm offers no blind Retry, since confirming
 * creates the event.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationFailedError } from '../../data';
import { getToasts, removeToast, resetToasts, runToastAction } from '../../shell/store-toast';
import {
  draftFromEvent,
  newDraft,
  planEntryId,
  update,
  type CalendarEffect,
} from './calendar.model';
import { cancelPendingRetries, runCalendarEffect, type EffectPorts } from './effects';
import { ctxFor, NOW, ports, S, testUi, THU } from './calendar.testkit';

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const failedToast = () => [...getToasts()].reverse().find(t => t.id.endsWith(':failed'));

const rejectEventSet = (reasonCode: string, retryAfterMs?: number): EffectPorts => ({
  ...ports(),
  eventSet: () =>
    Promise.reject(
      new OperationFailedError('op-x', {
        type: 'unavailable',
        message: 'engine words',
        reasonCode,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
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

test('review8: a delayed retry is single-shot — the timer spends Retry, a click disarms the timer', async () => {
  resetToasts();
  const real = global.setTimeout;
  const pending: Array<() => void> = [];
  // @ts-expect-error test shim captures the retry instead of scheduling it
  global.setTimeout = (fn: () => void) => {
    pending.push(fn);
    return 0;
  };
  let calls = 0;
  const p: EffectPorts = {
    ...ports(),
    eventSet: () => {
      calls += 1;
      return Promise.reject(
        new OperationFailedError('op-x', {
          type: 'unavailable',
          message: 'engine words',
          reasonCode: 'calendar.unavailable',
          retryAfterMs: 2_000,
        }),
      );
    },
  };
  try {
    runCalendarEffect(moveFx, p, testUi());
    await nextTick();
    const first = failedToast();
    assert.ok(first, 'the refusal toast is up');
    assert.equal(pending.length, 1, 'the delayed retry is armed');
    // The wait elapses and the retry fires by itself: the notice goes down with it.
    pending[0]();
    await nextTick();
    assert.equal(calls, 2, 'the timer ran the retry once');
    assert.equal(
      getToasts().some(t => t.id === first.id),
      false,
      'the fired notice leaves the stack',
    );
    // The Retry that notice used to offer can never fire a second write.
    runToastAction(first.id, 'retry');
    await nextTick();
    assert.equal(calls, 2, 'a spent retry never duplicates the write');

    // The other direction: a clicked Retry cancels the timer it replaces.
    const second = failedToast();
    assert.ok(second, 'the retried write has its own refusal up');
    const armed = pending[pending.length - 1];
    runToastAction(second.id, 'retry');
    await nextTick();
    assert.equal(calls, 3, 'the click wrote once');
    armed();
    await nextTick();
    assert.equal(calls, 3, 'the disarmed timer never fires');
  } finally {
    global.setTimeout = real;
    cancelPendingRetries();
    resetToasts();
  }
});

test('review8: a late conflict never replaces an open editor — the toast carries the sentence', async () => {
  resetToasts();
  try {
    const ctx = ctxFor();
    const save = update(
      S({ editor: { ...draftFromEvent(ctx.events.get('dental')!), title: 'Cleaning' } }),
      { type: 'editorSave' },
      ctx,
    );
    const fx = save.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.reopenEditorId === 'dental');

    // The owner has since opened the editor on another event and typed into it.
    const draft = { ...draftFromEvent(ctx.events.get('focus')!), title: 'Typed edits' };
    let cur = S({ editor: draft });
    const ui = testUi();
    ui.reopenEditor = (eventId: string, note: string) => {
      const t = update(cur, { type: 'reopenEditor', eventId, note }, ctx);
      cur = t.state;
      return t.handled;
    };
    runCalendarEffect(fx, rejectEventSet('calendar.conflict'), ui);
    await nextTick();
    assert.deepEqual(cur.editor, draft, 'the open draft is untouched');
    assert.equal(
      failedToast()?.message,
      "This event changed somewhere else. Your changes weren't saved.",
      'the conflict falls back to its toast',
    );
    removeToast(failedToast()!.id);

    // A fresh new-event draft is just as safe.
    const fresh = S({ editor: newDraft(THU, NOW, ctx.entries, 'work') });
    const kept = update(fresh, { type: 'reopenEditor', eventId: 'dental', note: 'x' }, ctx);
    assert.equal(kept.handled, false);
    assert.equal(kept.state.editor?.mode, 'new', 'the new draft stays too');

    // With no editor open the same conflict still re-opens on the newer copy.
    cur = S();
    runCalendarEffect(fx, rejectEventSet('calendar.conflict'), ui);
    await nextTick();
    assert.equal(cur.editor?.eventId, 'dental');
    assert.equal(
      cur.editor?.error,
      "This event changed somewhere else. Your changes weren't saved.",
    );
    assert.equal(failedToast(), undefined, 'no toast doubling the editor’s own line');
  } finally {
    resetToasts();
  }
});

test('review8: a lost answer on a plan confirm offers no blind Retry', async () => {
  resetToasts();
  try {
    const confirm = update(
      S({ detailId: planEntryId('launch') }),
      { type: 'confirmPlan' },
      ctxFor(),
    );
    const fx = confirm.effects.find(f => f.kind === 'planConfirm');
    assert.ok(fx && fx.kind === 'planConfirm');
    const p: EffectPorts = {
      ...ports(),
      planConfirm: () =>
        Promise.reject(
          new OperationFailedError('op-p', {
            type: 'unavailable',
            message: 'engine words',
            reasonCode: 'calendar.mystery',
          }),
        ),
    };
    runCalendarEffect(fx, p, testUi());
    await nextTick();
    assert.equal(
      failedToast()?.message,
      'Couldn’t add it to the calendar. Check your calendar before trying again.',
    );
    assert.equal(
      failedToast()?.actions,
      undefined,
      'confirming creates the event — a blind retry could duplicate it',
    );
  } finally {
    resetToasts();
  }
});
