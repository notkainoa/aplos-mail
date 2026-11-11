/**
 * The review14 fixes, one test each. Unlike review13's fixture runs these model the REAL engine
 * (`packages/engine` holds.ts / methods/event.ts): `Event/set` is held ONLY when `notify === true`
 * and only then records an `Operation` row — a guest-less write answers `undoable: false` and
 * `Operation/get` says notFound; a held write's receipt `appliedState` is already reached (the hold
 * commit never moves `seq`), so the overlay settles at `synced`, not at the receipt; a held create's
 * `Operation.targets` is the calendar id, never the new event's.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventChange } from '@aplos/contract';
import type { OperationView, Receipt } from '../../data';
import { pushToast } from '../../shell';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { draftFromEvent, update, type CalendarEffect } from './calendar.model';
import { notifiesGuests } from './model/transitions';
import { operationUpdate, runCalendarEffect, type EffectPorts, type WatchedWrite } from './effects';
import { undoFailureMessage, writeFailureOf } from './writeErrors';
import { boot, ctxFor, NOW, ports, S, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const task = () => new Promise<void>(resolve => setImmediate(resolve));

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

/** A held write's watch, the way `runWrite` hands it to HeldWrites. */
const watch = (over: Partial<WatchedWrite> = {}): WatchedWrite => ({
  opId: 'op-1',
  entryIds: ['ev-1'],
  at: { dbEpoch: 'e', seq: 9 },
  held: true,
  addedIds: [],
  failure: 'Couldn’t move Standup.',
  ...over,
});

const moveFx = (notify: boolean): CalendarEffect => ({
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
});

const eventSetSpy = (out: { receipt: Receipt }) => {
  const calls: Array<{ change: EventChange; notify?: boolean }> = [];
  const port: EffectPorts['eventSet'] = args => {
    calls.push(args);
    return Promise.resolve(out);
  };
  return { calls, port };
};

test('review14: notify: true goes on Event/set exactly when guests are emailed', async () => {
  await boot();
  resetToasts();
  try {
    // The model flags a drag, a save and a delete of an event with guests — never a guest-less one.
    const ctx = ctxFor();
    const climb = ctx.events.get('climb')!;
    assert.ok(
      climb.attendees.some(a => !a.self),
      'climb has a guest besides the owner',
    );
    const moved = update(
      S(),
      { type: 'move', id: 'climb', start: '2026-10-29T18:30', end: '2026-10-29T20:00' },
      ctx,
    );
    const moveOut = moved.effects.find(f => f.kind === 'eventSet');
    assert.ok(moveOut?.kind === 'eventSet' && moveOut.notify === true, 'a drag on a guest event');
    const saved = update(
      S({ editor: { ...draftFromEvent(ctx.events.get('design')!), title: 'Design review v2' } }),
      { type: 'editorSave' },
      ctx,
    );
    const saveFx = saved.effects.find(f => f.kind === 'eventSet');
    assert.ok(saveFx?.kind === 'eventSet' && saveFx.notify === true, 'a save on a guest event');
    const deleted = update(S({ selectedId: 'climb' }), { type: 'delete' }, ctx);
    const deleteFx = deleted.effects.find(f => f.kind === 'eventSet');
    assert.ok(
      deleteFx?.kind === 'eventSet' && deleteFx.notify === true,
      'a delete of a guest event',
    );
    const solo = update(S({ selectedId: 'dental' }), { type: 'delete' }, ctx);
    const soloFx = solo.effects.find(f => f.kind === 'eventSet');
    assert.ok(soloFx?.kind === 'eventSet' && soloFx.notify !== true, 'guest-less stays unset');
    // A create notifies only when it carries attendees (the editor's never do).
    const withGuests = {
      type: 'create' as const,
      calendarId: 'work',
      fields: {
        title: 'Kickoff',
        start: { type: 'date' as const, date: '2026-10-30' },
        end: { type: 'date' as const, date: '2026-10-31' },
        allDay: true,
        attendees: [{ address: 'mina@example.com' }],
      },
    };
    assert.equal(notifiesGuests(withGuests), true);
    assert.equal(
      notifiesGuests({ ...withGuests, fields: { ...withGuests.fields, attendees: [] } }),
      false,
    );

    // The port gets `notify: true` — never `false` (that would tell Google NOT to email guests).
    const heldSpy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    const ui1 = testUi();
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: heldSpy.port }, ui1);
    await task();
    assert.equal(heldSpy.calls.length, 1);
    assert.equal(heldSpy.calls[0]?.notify, true);
    const plainSpy = eventSetSpy({ receipt: receipt({ undoable: false }) });
    const ui2 = testUi();
    runCalendarEffect(moveFx(false), { ...ports(), eventSet: plainSpy.port }, ui2);
    await task();
    assert.equal(plainSpy.calls.length, 1);
    assert.equal(
      plainSpy.calls[0]?.notify,
      undefined,
      'unset, so the provider keeps its own notify default',
    );
  } finally {
    resetToasts();
  }
});

test('review14: a held non-create write keeps its overlay until synced, not the receipt', async () => {
  await boot();
  resetToasts();
  try {
    // The real engine's held receipt: `appliedState` is ALREADY reached (the hold commit never
    // moves `seq`), so settling there would snap the change back for the whole hold.
    const spy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    const ui = testUi();
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: spy.port }, ui);
    await task();
    assert.deepEqual(
      ui.applied,
      [],
      'no receipt settle: the overlay holds for the whole undo window',
    );
    const w = ui.watched[0]!;
    assert.equal(w.held, true);
    for (const remote of ['queued', 'syncing'] as const)
      assert.equal(operationUpdate(w, view({ remote }), ui, ports()), 'watching');
    assert.equal(operationUpdate(w, view({ remote: 'synced' }), ui, ports()), 'done');
    // The op frame lands before the throttled window rerun: the overlay drops on the next
    // window frame, not at `synced` itself (review15).
    ui.frame();
    assert.deepEqual(ui.applied, ['climb'], 'the send’s commit is in, the overlay settles');
  } finally {
    resetToasts();
  }
});

test('review14: an unheld write registers no watch — the real engine has no Operation for it', async () => {
  await boot();
  resetToasts();
  try {
    const spy = eventSetSpy({ receipt: receipt({ undoable: false }) });
    const ui = testUi();
    runCalendarEffect(moveFx(false), { ...ports(), eventSet: spy.port }, ui);
    await task();
    assert.deepEqual(ui.applied, ['climb'], 'the write settles at its receipt');
    assert.equal(ui.watched.length, 0, 'Operation/get would answer notFound: nothing to watch');
    // `undoable: false` hides too: an RSVP receipt that was not held.
    const rsvpUi = testUi();
    runCalendarEffect(
      {
        kind: 'rsvp',
        id: 'q4',
        response: 'accepted',
        scope: 'occurrence',
        optimistic: { id: 'q4', patch: {} },
        answer: 'yes',
        failure: 'Couldn’t send the reply.',
      },
      { ...ports(), eventRsvp: () => Promise.resolve(receipt({ undoable: false })) },
      rsvpUi,
    );
    await task();
    assert.equal(rsvpUi.watched.length, 0);
    // And an undoable receipt still watches: the engine journaled an operation for it.
    const undoableUi = testUi();
    runCalendarEffect(
      {
        kind: 'planDismiss',
        planId: 'launch',
        optimistic: { id: 'launch', remove: true },
      },
      { ...ports(), planDismiss: () => Promise.resolve(receipt({ undoable: true })) },
      undoableUi,
    );
    await task();
    assert.equal(undoableUi.watched.length, 1);
  } finally {
    resetToasts();
  }
});

test('review14: a retried watch ignores the stale failed row until a newer state lands', async () => {
  resetToasts();
  try {
    const ui = testUi();
    let retries = 0;
    const stale = view({
      remote: 'failed',
      error: {
        type: 'unavailable',
        message: 'not sent',
        reasonCode: 'calendar.late',
      },
      retry: () => {
        retries += 1;
        return { opId: 'op-1', receipt: Promise.resolve(receipt()) };
      },
    });
    const w = watch();
    assert.equal(operationUpdate(w, stale, ui, ports()), 'done');
    runToastAction('op-1:failed', 'retry');
    await task();
    assert.equal(retries, 1);
    const rewatched = ui.watched[ui.watched.length - 1]!;
    // The same `failed` row still answers Operation/get until the next flush: keep watching,
    // never re-show the failure the owner just retried.
    assert.equal(operationUpdate(rewatched, stale, ui, ports()), 'watching');
    assert.equal(
      getToasts().some(t => t.id === 'op-1:failed'),
      false,
      'the late toast did not pop straight back',
    );
    // A genuinely newer frame is handled normally — synced settles, a fresh failure surfaces.
    assert.equal(operationUpdate(rewatched, view({ remote: 'synced' }), ui, ports()), 'done');
    const again = view({
      remote: 'failed',
      error: { type: 'unavailable', message: 'not sent', reasonCode: 'calendar.late' },
    });
    assert.equal(operationUpdate(rewatched, again, ui, ports()), 'done');
    assert.ok(
      getToasts().some(t => t.id === 'op-1:failed'),
      'a second failure still surfaces',
    );
  } finally {
    resetToasts();
  }
});

test('review14: an operation failure runs the write’s own follow-ups (reopen, close, grant)', async () => {
  resetToasts();
  try {
    const ui = testUi();
    // calendar.conflict re-opens the editor on the newer copy, exactly as a submit-time refusal.
    assert.equal(
      operationUpdate(
        watch({ reopenEditorId: 'ev-1' }),
        view({
          remote: 'failed',
          error: {
            type: 'conflict',
            message: 'changed',
            reasonCode: 'calendar.conflict',
          },
        }),
        ui,
        ports(),
      ),
      'done',
    );
    assert.deepEqual(ui.reopened, [
      {
        id: 'ev-1',
        note: "This event changed somewhere else. Your changes weren't saved.",
      },
    ]);
    assert.equal(
      getToasts().some(t => t.id === 'op-1:failed'),
      false,
      'the editor’s own line carries the sentence, no second toast',
    );
    // calendar.eventGone closes the detail.
    operationUpdate(
      watch({ goneEventId: 'ev-1' }),
      view({
        remote: 'failed',
        error: { type: 'notFound', message: 'gone', reasonCode: 'calendar.eventGone' },
      }),
      ui,
      ports(),
    );
    assert.deepEqual(ui.closedFor, ['ev-1']);
    // A times refusal keeps the typed draft.
    const draft = draftFromEvent(ctxFor().events.get('dental')!);
    operationUpdate(
      watch({ draft }),
      view({
        remote: 'failed',
        error: {
          type: 'validation',
          message: 'times',
          reasonCode: 'event.allDayMismatch',
        },
      }),
      ui,
      ports(),
    );
    assert.equal(ui.restored.length, 1);
    assert.equal(ui.restored[0]?.draft, draft);
    // A dead grant offers Sign in again; a missing write scope offers Enable editing.
    operationUpdate(
      watch({ accountId: 'acct' }),
      view({
        remote: 'failed',
        error: { type: 'needsReauth', message: 'grant dead' },
      }),
      ui,
      ports(),
    );
    assert.ok(
      getToasts().some(t => t.id === 'reconnect:acct'),
      'the reconnect notice, not a bare failure',
    );
    // And the watch itself carries the follow-up fields from the accepted write.
    const save = update(
      S({
        editor: {
          ...draftFromEvent(ctxFor().events.get('dental')!),
          title: 'Cleaning again',
        },
      }),
      { type: 'editorSave' },
      ctxFor(),
    );
    const fx = save.effects.find(f => f.kind === 'eventSet')!;
    const spy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    const ui2 = testUi();
    runCalendarEffect(fx, { ...ports(), eventSet: spy.port }, ui2);
    await task();
    assert.equal(ui2.watched[0]?.reopenEditorId, 'dental');
    assert.equal(ui2.watched[0]?.goneEventId, 'dental');
    assert.ok(ui2.watched[0]?.draft !== undefined);
  } finally {
    resetToasts();
  }
});

test('review14: the Undo toast is dismissed on every terminal operation state', () => {
  resetToasts();
  try {
    const ui = testUi();
    for (const remote of ['failed', 'cancelled', 'conflict', 'synced'] as const) {
      resetToasts();
      pushToast({ id: 'op-1', kind: 'info', message: 'Moving Standup', undoable: true });
      const error =
        remote === 'failed' || remote === 'conflict'
          ? {
              error: {
                type: 'unavailable' as const,
                message: 'x',
                reasonCode: 'calendar.late' as const,
              },
            }
          : {};
      assert.equal(operationUpdate(watch(), view({ remote, ...error }), ui, ports()), 'done');
      assert.equal(
        getToasts().some(t => t.id === 'op-1'),
        false,
        `${remote}: the original Undo toast is gone — one toast per operation`,
      );
    }
  } finally {
    resetToasts();
  }
});

test('review14: a forgotten operation record rolls its overlay back, no ghost', () => {
  resetToasts();
  try {
    const ui = testUi();
    const w = watch({ entryIds: ['tmp-1'], addedIds: ['tmp-1'] });
    // `useOperation` answers undefined once the store forgets the record: the tmp entry (or the
    // held patch) must roll back here, not ride the grid forever.
    assert.equal(operationUpdate(w, undefined, ui, ports()), 'done');
    assert.deepEqual(ui.dropped, ['tmp-1']);
  } finally {
    resetToasts();
  }
});

test('review14: an already-undone undo refusal gets its own sentence', () => {
  // The engine answers conflict with either of two sentences (holds.ts): "was already undone" for
  // a second press, "has been sent" once the window closed. Each must read differently — telling
  // the owner a cancelled change "has already been sent" is simply false.
  assert.equal(
    undoFailureMessage({ type: 'conflict', message: 'This change was already undone.' }),
    'That change was already undone.',
  );
  assert.equal(
    undoFailureMessage({
      type: 'conflict',
      message: 'This change has been sent, so it cannot be undone.',
    }),
    'That change has already been sent.',
  );
});

test('review14: holdPending names Undo and the hold, not a guessed delay', () => {
  // The earlier hold lasts 5–30 s, so "a few seconds" under-read it and hid the way out: the copy
  // now offers Undo or waiting out the first send. Retry stays safe — nothing was accepted.
  const f = writeFailureOf(
    { type: 'conflict', message: 'held', reasonCode: 'calendar.holdPending' },
    'Couldn’t change Renamed.',
  );
  assert.equal(
    f.message,
    "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
  );
  assert.equal(f.retry, 'now');
});
