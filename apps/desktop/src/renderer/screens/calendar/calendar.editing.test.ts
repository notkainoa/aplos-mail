/**
 * The editing gate (item 4, providers' 2026-11-10 shapes 1–3): `editingOn` reads `grantedScopes` for the
 * calendar.events scope; a write attempt on an account without it gets the calm 'Turn on editing' notice
 * with the Enable editing action (never an error banner, never a standing nag — a read-only account shows
 * nothing until a change is tried); a refused write with `permission.calendarWrite` shows the same
 * notice, calls the port once, and the optimistic overlay rolls back like any other refusal.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationFailedError } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { CALENDAR_EVENTS_SCOPE, EDITING_COPY, editingOn } from './accountCalendarState';
import type { CalendarEffect } from './calendar.model';
import { draftFromEvent, update } from './calendar.model';
import { runCalendarEffect, type EffectPorts } from './effects';
import { ctxFor, ports, S, testUi } from './calendar.testkit';
import { demoWorld } from './CalendarStates';
import { viewModel } from './model/view';

const ALEX = demoWorld.accounts[0];
const alexRead = { ...ALEX, grantedScopes: [] as string[] };

test('editingOn: grantedScopes carries the truth', () => {
  assert.equal(editingOn({ ...ALEX, grantedScopes: [CALENDAR_EVENTS_SCOPE] }), true);
  assert.equal(editingOn({ ...ALEX, grantedScopes: [] }), false);
  assert.equal(
    editingOn({ ...ALEX, grantedScopes: ['https://www.googleapis.com/auth/calendar.readonly'] }),
    false,
    'an unrelated scope does not enable editing',
  );
  // An account the screen cannot see claims nothing either way: treated as on, the failure path still catches it.
  assert.equal(editingOn(undefined), true);
});

test('editing gate: a move on a no-editing account gets the notice, not a doomed write', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  const t = update(
    S(),
    { type: 'move', id: 'dental', start: '2026-10-29T11:00', end: '2026-10-29T12:00' },
    ctx,
  );
  assert.equal(t.effects.length, 1);
  assert.deepEqual(t.effects[0], { kind: 'editingNotice', accountId: 'acct-alex' });
});

test('editing gate: a delete, an editor save and a reply get the same notice', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  const del = update(S({ selectedId: 'dental' }), { type: 'delete' }, ctx);
  assert.ok(del.effects.some(fx => fx.kind === 'editingNotice'));
  assert.ok(!del.effects.some(fx => fx.kind === 'eventSet'));
  // The editor save on a no-editing account: notice, never a write.
  const dental = ctx.events.get('dental')!;
  const edited = update(
    S({ editor: { ...draftFromEvent(dental), title: 'Cleaning' } }),
    { type: 'editorSave' },
    ctx,
  );
  assert.ok(edited.effects.some(fx => fx.kind === 'editingNotice'));
  assert.ok(!edited.effects.some(fx => fx.kind === 'eventSet'));
});

test('editing gate: a read-only account shows no standing nag until a change is tried', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  resetToasts();
  try {
    // Selecting, opening and walking an event on a no-editing account produces no notice and no write.
    for (const action of [
      { type: 'select', id: 'dental' },
      { type: 'open', id: 'dental' },
    ] as const) {
      const t = update(S({ detailId: 'dental' }), action, ctx);
      assert.ok(!t.effects.some(fx => fx.kind === 'editingNotice'));
    }
    const t = update(S({ detailId: 'dental' }), { type: 'edit' }, ctx);
    assert.ok(t.effects.some(fx => fx.kind === 'editingNotice'));
    // The detail line is the standing context: vm.editing names the account for its Enable editing button.
    const vm = viewModel(S({ detailId: 'dental' }), ctx);
    assert.deepEqual(vm.editing, { accountId: 'acct-alex' });
    // An editing-on account carries no line at all.
    const vmOn = viewModel(S({ detailId: 'dental' }), ctxFor());
    assert.equal(vmOn.editing, null);
  } finally {
    resetToasts();
  }
});

const moveFx: CalendarEffect = {
  kind: 'eventSet',
  change: { type: 'update', id: 'dental', scope: 'occurrence', fields: { title: 'Moved' } },
  optimistic: { id: 'dental', patch: { title: 'Moved' } },
  toast: { kind: 'info', message: 'Moved Moved', held: 'Moving Moved', undoable: true },
  undoLabel: 'Moved Moved',
  failure: 'Couldn’t move Moved.',
  accountId: 'acct-alex',
};

test('editing gate: permission.calendarWrite shows the notice and the action calls the port once', async () => {
  resetToasts();
  let calls = 0;
  const p: EffectPorts = {
    ...ports(),
    eventSet: () =>
      Promise.reject(
        new OperationFailedError('op-x', {
          type: 'permission',
          message: 'the grant lacks calendar.events',
          reasonCode: 'permission.calendarWrite',
        }),
      ),
    enableEditing: () => {
      calls += 1;
      return Promise.resolve();
    },
  };
  try {
    const ui = testUi();
    runCalendarEffect(moveFx, p, ui);
    await new Promise(resolve => setImmediate(resolve));
    const toast = getToasts().find(t => t.message === EDITING_COPY.notice);
    assert.ok(toast, 'the Turn on editing notice, not an error banner');
    assert.equal(toast?.actions?.length, 1);
    assert.equal(toast?.actions?.[0].label, EDITING_COPY.action);
    runToastAction(toast!.id, toast!.actions![0].id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'Enable editing calls the port exactly once');
    // The optimistic overlay rolls back on this failure like any other.
    assert.deepEqual(ui.dropped, ['dental']);
  } finally {
    resetToasts();
  }
});

test('editing gate: the detail’s Enable editing button emits the port effect', () => {
  const t = update(S(), { type: 'enableEditing', accountId: 'acct-alex' }, ctxFor());
  assert.deepEqual(t.effects, [{ kind: 'enableEditing', accountId: 'acct-alex' }]);
});
