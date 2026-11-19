/**
 * The review7 tests: the write gate asks only Google, non-demo accounts and knows the umbrella
 * `calendar` grant; a gated editor save keeps its draft; the update save's optimistic patch carries
 * `allDay`; `calendar.eventGone` closes only its own detail; `calendar.conflict` reads once (the
 * re-opened editor's line, or the toast when no editor can open — and no second notice from the
 * reopen path); 'Turn on editing' shows only where enabling would let the owner change the event;
 * an unknown code on a create or a reply offers no blind Retry; every write spec names its account
 * (Enable editing is never a dead action); and a delayed retry is cancelled when its notice leaves
 * the stack or the screen unmounts.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationFailedError, type Account } from '../../data';
import { getToasts, removeToast, resetToasts, runToastAction } from '../../shell/store-toast';
import { CALENDAR_EVENTS_SCOPE, CALENDAR_SCOPE, editingOn } from './accountCalendarState';
import {
  detailIsFor,
  draftFromEvent,
  planEntryId,
  update,
  viewModel,
  type CalendarEffect,
} from './calendar.model';
import { cancelPendingRetries, runCalendarEffect, type EffectPorts } from './effects';
import { ctxFor, ports, S, testUi } from './calendar.testkit';
import { demoWorld } from './CalendarStates';

const ALEX = demoWorld.accounts[0];
const alexRead = { ...ALEX, grantedScopes: [] as string[] };
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const lastToast = () => getToasts()[getToasts().length - 1];
const failedToast = () => [...getToasts()].reverse().find(t => t.id.endsWith(':failed'));

const account = (over: Partial<Account>): Account => ({ ...ALEX, ...over });

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

test('review7: the write gate never asks a non-Google or a demo account', () => {
  for (const over of [
    { provider: 'microsoft', grantedScopes: [] as string[] },
    { provider: 'imap', grantedScopes: [] as string[] },
    { provider: 'jmap', grantedScopes: [] as string[] },
    { demo: true, grantedScopes: [] as string[] },
  ]) {
    const ctx = ctxFor(undefined, undefined, undefined, undefined, [account(over)]);
    const t = update(
      S(),
      { type: 'move', id: 'dental', start: '2026-10-29T11:00', end: '2026-10-29T12:00' },
      ctx,
    );
    assert.equal(
      t.effects.some(fx => fx.kind === 'editingNotice'),
      false,
      `${JSON.stringify(over)} is never gated`,
    );
    assert.ok(
      t.effects.some(fx => fx.kind === 'eventSet'),
      `${JSON.stringify(over)} writes`,
    );
  }
  // A Google account without the scope still gets the notice.
  const gated = update(
    S(),
    { type: 'move', id: 'dental', start: '2026-10-29T11:00', end: '2026-10-29T12:00' },
    ctxFor(undefined, undefined, undefined, undefined, [alexRead]),
  );
  assert.ok(gated.effects.some(fx => fx.kind === 'editingNotice'));
});

test('review7: the umbrella calendar grant counts as editing on', () => {
  assert.equal(editingOn({ ...ALEX, grantedScopes: [CALENDAR_SCOPE] }), true);
  assert.equal(editingOn({ ...ALEX, grantedScopes: [CALENDAR_EVENTS_SCOPE] }), true);
  assert.equal(editingOn({ ...ALEX, grantedScopes: [] }), false);
  // And the gate lets an umbrella-granted write through.
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [
    account({ grantedScopes: [CALENDAR_SCOPE] }),
  ]);
  const t = update(
    S(),
    { type: 'move', id: 'dental', start: '2026-10-29T11:00', end: '2026-10-29T12:00' },
    ctx,
  );
  assert.ok(t.effects.some(fx => fx.kind === 'eventSet'));
});

test('review7: a gated editor save keeps the editor and its draft', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  const dental = ctx.events.get('dental')!;
  const draft = { ...draftFromEvent(dental), title: 'Cleaning' };
  const t = update(S({ editor: draft }), { type: 'editorSave' }, ctx);
  assert.ok(
    t.effects.some(fx => fx.kind === 'editingNotice'),
    'the calm notice',
  );
  assert.ok(!t.effects.some(fx => fx.kind === 'eventSet'), 'no doomed write');
  assert.deepEqual(t.state.editor, draft, 'the typed draft is not thrown away');
});

test('review7: the update save’s optimistic patch carries allDay', () => {
  const dental = ctxFor().events.get('dental')!;
  const on = update(
    S({ editor: { ...draftFromEvent(dental), allDay: true } }),
    { type: 'editorSave' },
    ctxFor(),
  );
  const fxOn = on.effects.find(f => f.kind === 'eventSet');
  assert.ok(fxOn && fxOn.kind === 'eventSet');
  assert.equal(fxOn.optimistic.patch?.allDay, true);
  assert.equal(fxOn.optimistic.patch?.start, '2026-10-29T00:00:00');
  // Toggling it off patches false, so the strip stops claiming the event at once.
  const allDayEvent = {
    ...dental,
    allDay: true,
    start: { type: 'date' as const, date: '2026-10-29' },
    end: { type: 'date' as const, date: '2026-10-30' },
  };
  const off = update(
    S({ editor: { ...draftFromEvent(allDayEvent), allDay: false } }),
    { type: 'editorSave' },
    ctxFor([allDayEvent]),
  );
  const fxOff = off.effects.find(f => f.kind === 'eventSet');
  assert.ok(fxOff && fxOff.kind === 'eventSet');
  assert.equal(fxOff.optimistic.patch?.allDay, false);
});

test('review7: calendar.eventGone names the write’s event, and the detail closes only for it', async () => {
  // The predicate the container gates the close on.
  assert.equal(detailIsFor(S({ detailId: 'dental' }), 'dental'), true);
  assert.equal(detailIsFor(S({ detailId: 'focus' }), 'dental'), false);
  assert.equal(
    detailIsFor(S({ rsvp: { eventId: 'dental', answer: 'yes', changing: false } }), 'dental'),
    true,
    'an RSVP choice on the gone event is its surface too',
  );
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(moveFx, rejectEventSet('calendar.eventGone'), ui);
    await nextTick();
    assert.deepEqual(ui.dropped, ['dental'], 'the overlay still rolls back');
    assert.deepEqual(ui.closedFor, ['dental'], 'the effect names its own event for the close');
  } finally {
    resetToasts();
  }
});

test('review7: calendar.conflict reads once — the editor’s line, or the toast', async () => {
  resetToasts();
  try {
    const save = update(
      S({ editor: { ...draftFromEvent(ctxFor().events.get('dental')!), title: 'Cleaning' } }),
      { type: 'editorSave' },
      ctxFor(),
    );
    const fx = save.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.reopenEditorId === 'dental');
    const ui = testUi();
    runCalendarEffect(fx, rejectEventSet('calendar.conflict'), ui);
    await nextTick();
    assert.deepEqual(ui.reopened, [
      { id: 'dental', note: "This event changed somewhere else. Your changes weren't saved." },
    ]);
    assert.equal(failedToast(), undefined, 'no second copy of the sentence as a failure toast');
    // When the editor cannot re-open the toast carries it instead — still exactly once.
    const ui2 = testUi();
    ui2.reopenOpens = false;
    runCalendarEffect(fx, rejectEventSet('calendar.conflict'), ui2);
    await nextTick();
    assert.equal(
      failedToast()?.message,
      "This event changed somewhere else. Your changes weren't saved.",
    );
  } finally {
    resetToasts();
  }
});

test('review7: the reopen path raises no locked or editing-gate notice of its own', () => {
  // The event can be edited: the editor re-opens with the sentence on its own line, nothing else.
  const ok = update(
    S({ detailId: 'focus' }),
    { type: 'reopenEditor', eventId: 'dental', note: 'conflict words' },
    ctxFor(),
  );
  assert.equal(ok.handled, true);
  assert.equal(ok.state.editor?.eventId, 'dental');
  assert.equal(ok.state.editor?.error, 'conflict words');
  assert.deepEqual(ok.effects, []);
  // On a no-grant account the reopen cannot open the editor — and emits no second notice.
  const gated = update(
    S(),
    { type: 'reopenEditor', eventId: 'dental', note: 'conflict words' },
    ctxFor(undefined, undefined, undefined, undefined, [alexRead]),
  );
  assert.equal(gated.handled, false);
  assert.equal(gated.state.editor, null);
  assert.deepEqual(gated.effects, [], 'no editingNotice doubling the conflict sentence');
});

test('review7: Turn on editing shows only where enabling would change the event', () => {
  const halloween = demoWorld.halloween;
  const holidays = demoWorld.holidays;
  const ctx = ctxFor([halloween], [], [...demoWorld.calendars, holidays], undefined, [alexRead]);
  // On a read-only calendar with no write an invite's reply would allow: no standing nag.
  assert.equal(viewModel(S({ detailId: 'halloween' }), ctx).editing, null);
  // An event that permits no write at all on a writable calendar: no nag either.
  const locked = { ...ctxFor().events.get('dental')!, can: halloween.can };
  assert.equal(
    viewModel(
      S({ detailId: 'dental' }),
      ctxFor([locked], undefined, undefined, undefined, [alexRead]),
    ).editing,
    null,
  );
  // Your own event on the no-grant account keeps the line, and so does an invite you can answer.
  assert.deepEqual(
    viewModel(
      S({ detailId: 'dental' }),
      ctxFor(undefined, undefined, undefined, undefined, [alexRead]),
    ).editing,
    { accountId: 'acct-alex' },
  );
  assert.deepEqual(
    viewModel(S({ detailId: 'q4' }), ctxFor(undefined, undefined, undefined, undefined, [alexRead]))
      .editing,
    { accountId: 'acct-alex' },
    'the reply is still a write the grant would unlock',
  );
});

test('review7: an unknown code offers no blind Retry on a create or a reply', async () => {
  resetToasts();
  try {
    const createFx: CalendarEffect = {
      kind: 'eventSet',
      change: {
        type: 'create',
        calendarId: 'work',
        fields: {
          title: 'Lunch',
          start: { type: 'utc', utc: 1 },
          end: { type: 'utc', utc: 2 },
          allDay: false,
        },
      },
      optimistic: { id: 'new:1' },
      undoLabel: 'Added Lunch',
      failure: 'Couldn’t add Lunch.',
      accountId: 'acct-alex',
    };
    runCalendarEffect(createFx, rejectEventSet('calendar.mystery'), testUi());
    await nextTick();
    assert.equal(
      failedToast()?.message,
      'Couldn’t add Lunch. Check your calendar before trying again.',
    );
    assert.equal(failedToast()?.actions, undefined, 'no blind retry of a create');

    const rsvpFx: CalendarEffect = {
      kind: 'rsvp',
      id: 'q4',
      response: 'accepted',
      scope: 'occurrence',
      answer: 'yes',
      organizer: 'Priya',
      optimistic: { id: 'q4', patch: { myReply: 'yes', unanswered: false } },
      failure: 'Couldn’t send your reply to Q4 review.',
      accountId: 'acct-alex',
    };
    const p: EffectPorts = {
      ...ports(),
      eventRsvp: () =>
        Promise.reject(
          new OperationFailedError('op-r', {
            type: 'unavailable',
            message: 'engine words',
            reasonCode: 'calendar.mystery',
          }),
        ),
    };
    runCalendarEffect(rsvpFx, p, testUi());
    await nextTick();
    assert.equal(
      failedToast()?.message,
      'Couldn’t send your reply to Q4 review. Check your calendar before trying again.',
    );
    assert.equal(failedToast()?.actions, undefined, 'no blind retry of a reply');
  } finally {
    resetToasts();
  }
});

test('review7: planConfirm and eventHide name their account; an unknown one offers no action', async () => {
  // The reducer stamps the write's account on every spec.
  const confirm = update(S({ detailId: planEntryId('launch') }), { type: 'confirmPlan' }, ctxFor());
  const confirmFx = confirm.effects.find(f => f.kind === 'planConfirm');
  assert.ok(confirmFx && confirmFx.kind === 'planConfirm');
  assert.equal(confirmFx.accountId, 'acct-alex');
  const hide = update(S({ detailId: 'dental' }), { type: 'menu', item: 'hide' }, ctxFor());
  const hideFx = hide.effects.find(f => f.kind === 'eventHide');
  assert.ok(hideFx && hideFx.kind === 'eventHide');
  assert.equal(hideFx.accountId, 'acct-alex');

  resetToasts();
  try {
    let enabled: string | undefined;
    const p: EffectPorts = {
      ...ports(),
      planConfirm: () =>
        Promise.reject(
          new OperationFailedError('op-p', {
            type: 'permission',
            message: 'the grant lacks calendar.events',
            reasonCode: 'permission.calendarWrite',
          }),
        ),
      enableEditing: id => {
        enabled = id;
        return Promise.resolve();
      },
    };
    runCalendarEffect(confirmFx, p, testUi());
    await nextTick();
    const toast = lastToast();
    assert.equal(toast?.actions?.[0]?.label, 'Enable editing');
    runToastAction(toast!.id, 'enable');
    await nextTick();
    assert.equal(enabled, 'acct-alex', 'Enable editing reaches the write’s own account');

    // An editingNotice with no account behind it is a quiet line, never a dead button.
    runCalendarEffect({ kind: 'editingNotice' }, ports(), testUi());
    const bare = getToasts().find(t => t.id === 'editing:unknown');
    assert.ok(bare, 'the notice still shows');
    assert.equal(bare?.actions, undefined);
  } finally {
    resetToasts();
  }
});

test('review7: a delayed retry dies with its notice and on unmount', async () => {
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
    const toast = failedToast();
    assert.ok(toast, 'the refusal toast is up');
    assert.equal(pending.length, 1, 'the delayed retry is armed with the notice');
    removeToast(toast!.id);
    pending[0]();
    assert.equal(calls, 1, 'a dismissed notice never fires the write');

    runCalendarEffect(moveFx, p, testUi());
    await nextTick();
    assert.equal(calls, 2, 'the second write attempt itself ran');
    assert.equal(pending.length, 2);
    cancelPendingRetries();
    pending[1]();
    assert.equal(calls, 2, 'the screen going away never fires the write');
  } finally {
    global.setTimeout = real;
    cancelPendingRetries();
    resetToasts();
  }
});
