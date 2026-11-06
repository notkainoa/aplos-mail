/**
 * The review3 tests: the shell's sidebar slot wired through `useSidebarSlot`, and Hide in Aplos through
 * `api.event.hide` (both landed in PR #271's surface; this lane now uses them). Node, no DOM:
 * `cd apps/desktop && TZ=America/Los_Angeles npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, HARNESS_NOW_MS } from '../../data';
import {
  getToasts,
  resetToasts,
  runToastAction,
  setToastUndoRunner,
} from '../../shell/store-toast';
import { getSidebarSlot, setSidebarSlot } from '../../shell/store-sidebar';
import { undoToastOperation } from '../../shell/KeysProviders';
import { detailMenu, update, type CalendarAction, type CalendarEffect } from './calendar.model';
import { runCalendarEffect } from './effects';
import { calendarSidebar } from './sidebar';
import { boot, ctxFor, ports, S, testUi, THU } from './calendar.testkit';

const DAY = 86_400_000;

test('review3: the screen publishes its slot through useSidebarSlot, not a prop', () => {
  // No DOM in node, so the hook cannot be mounted; this is the call sequence it makes: set on mount and on every
  // slot change with the same owner (a useRef box), null on unmount (shell/index.ts useSidebarSlot).
  const src = readFileSync(new URL('./CalendarScreen.tsx', import.meta.url), 'utf8');
  assert.match(src, /useSidebarSlot\(sidebar\)/);
  assert.equal(src.includes('renderSidebar'), false, 'the prop path is gone');

  const ctx = ctxFor();
  const slot = calendarSidebar({
    state: S(),
    calendars: ctx.calendars,
    entries: ctx.entries,
    today: THU,
    weekStartsOn: 0,
    dispatch: () => undefined,
    accounts: [],
    accountsLoaded: true,
    calendarsLoaded: true,
    onAccessAction: () => undefined,
  });
  assert.ok(slot.miniMonth && slot.calendars, 'the slot carries both parts the Sidebar draws');
  const owner = {};
  try {
    setSidebarSlot(owner, slot);
    assert.equal(getSidebarSlot(), slot, 'set while mounted');
    setSidebarSlot(owner, slot);
    assert.equal(getSidebarSlot(), slot, 'a re-render replaces it in place');
  } finally {
    setSidebarSlot(owner, null);
  }
  assert.equal(getSidebarSlot(), null, 'cleared on unmount');
});

test('review3: a toggle, a solo and the mini month through the slot run the model actions', () => {
  const ctx = ctxFor();
  let state = S();
  const effects: CalendarEffect[] = [];
  const dispatch = (action: CalendarAction) => {
    const t = update(state, action, ctx);
    state = t.state;
    effects.push(...t.effects);
  };
  const slot = () =>
    calendarSidebar({
      state,
      calendars: ctx.calendars,
      entries: ctx.entries,
      today: THU,
      weekStartsOn: 0,
      dispatch,
      accounts: [],
      accountsLoaded: true,
      calendarsLoaded: true,
      onAccessAction: () => undefined,
    });

  // A click in the Calendars list is the same write a key toggle plans: one calendarSet, one Undo toast.
  slot().calendars!.onToggle('personal');
  const writes = effects.filter(
    (fx): fx is Extract<CalendarEffect, { kind: 'calendarSet' }> => fx.kind === 'calendarSet',
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.shown, false);
  assert.equal(writes[0]!.toast?.undoable, true);

  // ⌥-click solos one calendar without a write; the mini month pages and picks into the same reducer.
  slot().calendars!.onSolo('work');
  assert.equal(state.solo, 'work');
  slot().miniMonth.onMonthChange('2026-11');
  assert.equal(state.miniMonth, '2026-11');
  slot().miniMonth.onPick('2026-10-28');
  assert.equal(state.anchor, '2026-10-28');
  assert.equal(state.miniMonth, null, 'a pick re-syncs the mini month to the anchor');
});

test('review3: Hide in Aplos is on every persisted entry’s ⋯ menu and plans the hide effect', () => {
  const ctx = ctxFor();
  const own = ctx.entries.find(e => e.id === 'dental')!;
  assert.ok(
    detailMenu(own, ctx).some(m => 'id' in m && m.id === 'hide'),
    'no capability gate',
  );
  const t = update(
    S({ selectedId: 'dental', detailId: 'dental' }),
    { type: 'menu', item: 'hide' },
    ctx,
  );
  const fx = t.effects.find(f => f.kind === 'eventHide');
  assert.ok(fx && fx.kind === 'eventHide');
  assert.equal(fx.id, 'dental');
  assert.deepEqual(fx.optimistic, { id: 'dental', remove: true });
  assert.equal(fx.toast.undoable, true);
  assert.equal(fx.toast.message, 'Hidden in Aplos');
});

test('review3: Hide in Aplos calls api.event.hide with hidden:true and its Undo toast restores', async () => {
  const { connection, flush } = await boot();
  resetToasts();
  setToastUndoRunner(undoToastOperation);
  try {
    const client = connection.layer.client.api;
    const window = await client.view.query({
      spec: { kind: 'events', from: HARNESS_NOW_MS - 7 * DAY, to: HARNESS_NOW_MS + 14 * DAY },
    });
    const id = window.ids[0];
    assert.ok(id, 'the demo week has an event to hide');
    const sent: Array<{ opId: string; ids: string[]; hidden: boolean }> = [];
    runCalendarEffect(
      {
        kind: 'eventHide',
        id,
        optimistic: { id, remove: true },
        toast: { kind: 'info', message: 'Hidden in Aplos', undoable: true },
      },
      {
        ...ports(),
        // What livePorts binds: the real `api.event.hide`, spied on for the assertion.
        eventHide: args => {
          sent.push(args);
          return api.event.hide(args);
        },
      },
      testUi(),
    );
    await flush();
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0], opId: '' }, { opId: '', ids: [id], hidden: true });
    assert.equal((await client.event.get({ ids: [id] })).list[0]?.hidden, true);

    // The write's own toast carries the Undo; pressing it undoes this opId, not the newest change.
    const toast = getToasts().find(t => t.undoable && t.message === 'Hidden in Aplos');
    assert.ok(toast);
    assert.equal(toast.id, sent[0]!.opId);
    runToastAction(toast.id, 'undo');
    await flush();
    assert.equal(
      (await client.event.get({ ids: [id] })).list[0]?.hidden,
      undefined,
      'the engine put the event back',
    );
  } finally {
    resetToasts();
    setToastUndoRunner(null);
  }
});
