/**
 * The review5 regression tests (see calendar.test.ts for the shared suite): the series-scope rule the engine
 * DECIDED on 2026-11-04 (DECISIONS.md) — `Event/set {update, id: occurrenceId, scope:'series', fields}` carries the
 * fields the user sees (the dragged occurrence's new absolute times) and the engine maps them to a wall-clock
 * shift of the master; the UI never computes the master's times, and the optimistic overlay mirrors the shift on
 * every loaded occurrence until the window settles.
 * Run: `cd apps/desktop && TZ=America/Los_Angeles npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDateTime } from '../../data';
import { resetToasts } from '../../shell/store-toast';
import {
  draftFromEvent,
  localMs,
  patchDraft,
  shiftInZone,
  update,
  viewModel,
  wallDeltaMs,
} from './calendar.model';
import { runCalendarEffect } from './effects';
import { ctxFor, nextTask, ports, S, testUi } from './calendar.testkit';

const DAY = 24 * 60 * 60_000;
const standupAt = (day: string) => `standup@${localMs(day, '11:00')}`;

test('review5: a time move on a repeating event offers This event and All events, master not loaded', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  // The events window holds occurrences only (seriesId 'standup', no master row), like the real window.
  assert.ok(occ.seriesId !== undefined && !ctx.events.has(occ.seriesId));
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'move', id: occ.id, start: '2026-10-28T12:00:00', end: '2026-10-28T12:15:00' },
    ctx,
  );
  assert.equal(ask.state.scope?.action, 'move');
  assert.equal(viewModel(ask.state, ctx).scope?.entryId, occ.id);
  // "All events" is always offered: choosing it writes, never warns about the missing master.
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  assert.ok(chosen.effects.some(fx => fx.kind === 'eventSet'));
  assert.equal(
    chosen.effects.some(fx => fx.kind === 'notice'),
    false,
  );
});

test('review5: All events writes the occurrence id, scope series and the new absolute times', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'move', id: occ.id, start: '2026-10-28T12:00:00', end: '2026-10-28T12:15:00' },
    ctx,
  );
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind === 'eventSet' && fx.change.type === 'update') {
    // Exactly what the user sees: this occurrence's new absolute times; the master is never computed.
    assert.equal(fx.change.id, occ.id);
    assert.equal(fx.change.scope, 'series');
    assert.deepEqual(fx.change.fields, {
      start: { type: 'utc', utc: localMs('2026-10-28', '12:00') },
      end: { type: 'utc', utc: localMs('2026-10-28', '12:15') },
    });
  }
});

test('review5: the overlay shifts every loaded occurrence by the wall-clock delta over the DST fall-back', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  // Wednesday 11:00 PDT dragged to Wednesday 11:00 PST: +7 days on the wall clock (+7d +1h in ms,
  // since the clocks fall back on November 1). A wall-clock delta keeps every occurrence at 11:00 local.
  const delta = wallDeltaMs(
    occ.start,
    { type: 'utc', utc: localMs('2026-11-04', '11:00') },
    'America/Los_Angeles',
  );
  assert.equal(delta, 7 * DAY);
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'move', id: occ.id, start: '2026-11-04T11:00:00', end: '2026-11-04T11:15:00' },
    ctx,
  );
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet');
  if (fx.kind !== 'eventSet') return;
  const patches = new Map([
    [fx.optimistic.id, fx.optimistic.patch ?? {}],
    ...(fx.optimistic.more ?? []).map(m => [m.id, m.patch ?? {}] as const),
  ]);
  // Every loaded row of the series is patched — the dragged row to its drop spot, each sibling by +7d wall.
  const loaded = [...ctx.events.values()].filter(e => e.seriesId === 'standup');
  assert.equal(patches.size, loaded.length);
  const at = (day: string, time: string) => toIsoDateTime(localMs(day, time));
  assert.equal(patches.get(occ.id)?.start, at('2026-11-04', '11:00'));
  // The DST claims: October occurrences land after the fall-back at the same local hour (-08:00, not 12:00).
  assert.equal(patches.get(standupAt('2026-10-26'))?.start, at('2026-11-02', '11:00'));
  assert.equal(patches.get(standupAt('2026-10-26'))?.end, at('2026-11-02', '11:15'));
  assert.equal(patches.get(standupAt('2026-10-27'))?.start, at('2026-11-03', '11:00'));
  assert.equal(patches.get(standupAt('2026-10-29'))?.start, at('2026-11-05', '11:00'));
  // November occurrences shift plain weeks inside PST.
  assert.equal(patches.get(standupAt('2026-11-03'))?.start, at('2026-11-10', '11:00'));
  assert.equal(patches.get(standupAt('2026-11-09'))?.start, at('2026-11-16', '11:00'));
});

test('review5: shiftInZone keeps the local hour across the fall-back for utc, floating and date', () => {
  const utc = { type: 'utc', utc: localMs('2026-10-31', '10:00') } as const; // 10:00 PDT
  const moved = shiftInZone(utc, 7 * DAY, 'America/Los_Angeles');
  // +7d on the wall clock is +7d +1h on the instant line: 10:00 PDT to 10:00 PST.
  assert.deepEqual(moved, { type: 'utc', utc: localMs('2026-11-07', '10:00') });
  const floating = {
    type: 'floating',
    local: '2026-10-31T10:00',
    timeZone: 'America/Los_Angeles',
  } as const;
  assert.deepEqual(shiftInZone(floating, 7 * DAY), {
    type: 'floating',
    local: '2026-11-07T10:00',
    timeZone: 'America/Los_Angeles',
  });
  assert.deepEqual(shiftInZone({ type: 'date', date: '2026-10-31' }, 7 * DAY), {
    type: 'date',
    date: '2026-11-07',
  });
});

test('review5: a series resize shifts every loaded occurrence’s end only', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'resize', id: occ.id, end: '2026-10-28T11:45:00' },
    ctx,
  );
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  // A longer end makes every occurrence longer (DECISIONS): only the end field goes out.
  assert.equal(fx.change.scope, 'series');
  assert.deepEqual(fx.change.fields, {
    end: { type: 'utc', utc: localMs('2026-10-28', '11:45') },
  });
  const sib = fx.optimistic.more?.find(m => m.id === standupAt('2026-10-26'));
  assert.equal(sib?.patch?.start, undefined);
  assert.equal(sib?.patch?.end, toIsoDateTime(localMs('2026-10-26', '11:45')));
});

test('review5: an editor time change offers All events and writes the occurrence’s new times', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  // Move the start 11:00 → 12:00; patchDraft keeps the 15-minute length.
  const draft = patchDraft(draftFromEvent(occ), { start: '12:00' });
  const ask = update(S({ editor: draft, selectedId: occ.id }), { type: 'editorSave' }, ctx);
  assert.equal(ask.state.scope?.action, 'change');
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.equal(fx.change.id, occ.id);
  assert.equal(fx.change.scope, 'series');
  assert.deepEqual(fx.change.fields, {
    start: { type: 'utc', utc: localMs('2026-10-28', '12:00') },
    end: { type: 'utc', utc: localMs('2026-10-28', '12:15') },
  });
  // +1 hour wall-clock on every loaded sibling.
  const sib = fx.optimistic.more?.find(m => m.id === standupAt('2026-10-27'));
  assert.equal(sib?.patch?.start, toIsoDateTime(localMs('2026-10-27', '12:00')));
  assert.equal(sib?.patch?.end, toIsoDateTime(localMs('2026-10-27', '12:15')));
});

test('review5: a refused series move rolls back every patched occurrence', async () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'move', id: occ.id, start: '2026-10-28T12:00:00', end: '2026-10-28T12:15:00' },
    ctx,
  );
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet');
  if (fx.kind !== 'eventSet') return;
  const ui = testUi();
  try {
    runCalendarEffect(fx, { ...ports(), eventSet: () => Promise.reject(new Error('refused')) }, ui);
    await nextTask();
    await nextTask();
    const covered = [fx.optimistic.id, ...(fx.optimistic.more ?? []).map(m => m.id)];
    assert.deepEqual(ui.dropped.slice().sort(), covered.slice().sort());
  } finally {
    resetToasts();
  }
});

test('review5: This event on a time move keeps scope occurrence and touches only the one entry', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(standupAt('2026-10-28'))!;
  const ask = update(
    S({ selectedId: occ.id }),
    { type: 'move', id: occ.id, start: '2026-10-28T12:00:00', end: '2026-10-28T12:15:00' },
    ctx,
  );
  const chosen = update(ask.state, { type: 'scope', scope: 'occurrence' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.equal(fx.change.scope, 'occurrence');
  assert.equal(fx.change.id, occ.id);
  assert.deepEqual(fx.change.fields, {
    start: { type: 'utc', utc: localMs('2026-10-28', '12:00') },
    end: { type: 'utc', utc: localMs('2026-10-28', '12:15') },
  });
  assert.equal(fx.optimistic.more, undefined);
});
