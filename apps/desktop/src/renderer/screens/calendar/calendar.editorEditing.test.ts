/**
 * Read-only grant (editing off): the editor says so before anything is typed (`vm.editor.editing`), the notice that
 * still appears after a refused write wears the lock and never the confirming check, and an account with editing on
 * (or a switch to a calendar on one) carries no notice.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/calendar.editorEditing.test.ts'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { CALENDAR_EVENTS_SCOPE, EDITING_COPY } from './accountCalendarState';
import { draftFromEvent, update } from './calendar.model';
import { runCalendarEffect } from './effects';
import { ctxFor, ports, S, testUi } from './calendar.testkit';
import { demoWorld } from './CalendarStates';
import { viewModel } from './model/view';

const ALEX = demoWorld.accounts[0];
const alexRead = { ...ALEX, grantedScopes: [] as string[] };
const alexEdit = { ...ALEX, grantedScopes: [CALENDAR_EVENTS_SCOPE] };

test('a new event on a read-only account: the editor carries the editing notice from the start', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  const opened = update(S(), { type: 'newEvent' }, ctx);
  assert.ok(opened.state.editor, 'the editor opens');
  const vm = viewModel(opened.state, ctx);
  assert.deepEqual(vm.editor?.editing, { accountId: 'acct-alex' });
});

test('an existing event on a read-only account: the same notice, from the event’s own account', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexRead]);
  const draft = draftFromEvent(ctx.events.get('dental')!);
  const vm = viewModel(S({ editor: draft }), ctx);
  assert.deepEqual(vm.editor?.editing, { accountId: 'acct-alex' });
});

test('editing on: no notice in the editor', () => {
  const ctx = ctxFor(undefined, undefined, undefined, undefined, [alexEdit]);
  const opened = update(S(), { type: 'newEvent' }, ctx);
  assert.equal(viewModel(opened.state, ctx).editor?.editing, null);
});

test('the refused-save notice wears the lock, not the success check', () => {
  resetToasts();
  try {
    runCalendarEffect({ kind: 'editingNotice', accountId: 'acct-alex' }, ports(), testUi());
    const toast = getToasts().find(t => t.message === EDITING_COPY.notice);
    assert.ok(toast);
    assert.equal(toast.kind, 'locked');
  } finally {
    resetToasts();
  }
});
