/**
 * The review6 tests: the real stand-in applies the 2026-11-04 series rule (DECISIONS, engine #290) —
 * `Event/set {update, id: occurrenceId, scope:'series', fields}` takes the fields the user sees on the dragged
 * occurrence and shifts every stored row of the series by the wall-clock delta in the series' zone. These tests
 * seed a weekly series the demo world lacks, drive the screen's own `update` + `runCalendarEffect` against a
 * booted fixture engine through `api.event.set`, and read the settled window back: every occurrence at the same
 * local hour across the Nov 1 2026 fall-back, the master and the exception row following, the overlay settled
 * without ghost rows — and scope 'this' still moving only the one occurrence.
 *
 * Seeding: `Event/set` create cannot write `seriesId`, `recurring`, `originalStart` or `recurrence` (they are not
 * `EventFields`), and the control channel's `calendarChange` only patches a row that exists — so the series rows
 * are loaded through `Store.seed`, the same call `buildScenario` and `scheduleLater(seeding)` use for demo data.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventTime } from '@aplos/contract';
import type { FixtureEngine } from '@aplos/contract-fixture';
import { toIsoDateTime, type Event } from '../../data';
import { resetToasts } from '../../shell/store-toast';
import { draftFromEvent, localMs, patchDraft, update } from './calendar.model';
import { runCalendarEffect } from './effects';
import { boot, ctxFor, ports, S, testUi } from './calendar.testkit';

const ZONE = 'America/Los_Angeles';
const SID = 'demo-work:ev-sync';
const CAL = 'demo-work:cal-team';
// Occurrence ids are `<seriesId>@<recurrenceId>` (UTC YYYYMMDDTHHMMSSZ), opaque to the stand-in (ADR-20).
const OCC = {
  oct21: `${SID}@20261021T180000Z`,
  oct28: `${SID}@20261028T180000Z`,
  nov4: `${SID}@20261104T190000Z`,
  nov11: `${SID}@20261111T190000Z`,
  moved: `${SID}@20261014T180000Z`, // the October 14 slot, moved to October 15
};
const RANGE = { from: localMs('2026-10-12', '00:00'), to: localMs('2026-11-20', '00:00') };

const at = (day: string, time: string): EventTime => ({ type: 'utc', utc: localMs(day, time) });
const SELF = {
  address: 'alex@studio.example',
  name: 'Alex Morgan',
  response: 'accepted',
  organizer: true,
  self: true,
} as const;

function row(
  id: string,
  day: string,
  start: string,
  end: string,
  extra: Partial<Event> = {},
): Event {
  return {
    id,
    rev: 1,
    accountId: 'demo-work',
    calendarId: CAL,
    recurring: true,
    exception: false,
    title: 'Sync',
    start: at(day, start),
    end: at(day, end),
    allDay: false,
    timeZone: ZONE,
    organizer: { ...SELF },
    attendees: [],
    myResponse: 'accepted',
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
    ...extra,
  };
}

/** A weekly Wednesday-ish 11:00 series: the master, four occurrences and one moved (exception) slot. */
function seedSeries(engine: FixtureEngine): void {
  const recurrence = { rrule: 'FREQ=WEEKLY', text: 'Weekly' };
  const rows = [
    row(SID, '2026-10-07', '11:00', '11:15', { recurrence }),
    ...[
      ['2026-10-21', OCC.oct21],
      ['2026-10-28', OCC.oct28],
      ['2026-11-04', OCC.nov4],
      ['2026-11-11', OCC.nov11],
    ].map(([day, id]) =>
      row(id!, day!, '11:00', '11:15', {
        seriesId: SID,
        originalStart: at(day!, '11:00'),
        recurrence,
      }),
    ),
    row(OCC.moved, '2026-10-15', '14:00', '14:15', {
      seriesId: SID,
      exception: true,
      originalStart: at('2026-10-14', '11:00'),
      recurrence,
    }),
  ];
  for (const e of rows) engine.fixture.store.seed('Event', e);
}

type Client = Awaited<ReturnType<typeof boot>>['connection']['layer']['client']['api'];

/** The events window's rows plus the master (outside the range), read back through the real data layer. */
async function eventsIn(client: Client): Promise<readonly Event[]> {
  const ids = (await client.view.query({ spec: { kind: 'events', ...RANGE } })).ids;
  return (await client.event.get({ ids })).list;
}

async function ctxFromWindow(client: Client) {
  const [events, calendars] = await Promise.all([
    eventsIn(client),
    client.calendar.get({ accountId: 'demo-work' }).then(r => r.list),
  ]);
  return ctxFor(events, [], calendars);
}

const startUtc = (e: Event | undefined): number | undefined =>
  e?.start.type === 'utc' ? e.start.utc : undefined;
const endUtc = (e: Event | undefined): number | undefined =>
  e?.end.type === 'utc' ? e.end.utc : undefined;

test('review6: All events on the real stand-in shifts every row by the wall-clock delta', async () => {
  const { connection, flush, engine } = await boot();
  seedSeries(engine);
  resetToasts();
  try {
    const client = connection.layer.client.api;
    const ctx = await ctxFromWindow(client);
    const occ = ctx.events.get(OCC.oct28)!;
    assert.ok(occ.recurring && occ.seriesId === SID, 'the seeded occurrence is in the window');

    // The Wednesday 11:00 PDT occurrence dragged a week forward to 11:00 PST: +7 days on the wall clock, across
    // the November 1 fall-back. The screen asks the scope, then writes the occurrence id and the new times.
    const ask = update(
      S({ selectedId: occ.id }),
      { type: 'move', id: occ.id, start: '2026-11-04T11:00:00', end: '2026-11-04T11:15:00' },
      ctx,
    );
    assert.equal(ask.state.scope?.action, 'move');
    const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
    const fx = chosen.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
    assert.equal(fx.change.id, occ.id);
    assert.equal(fx.change.scope, 'series');

    const ui = testUi();
    runCalendarEffect(fx, ports(), ui);
    await flush();

    const settled = new Map((await eventsIn(client)).map(e => [e.id, e]));
    // Every stored row moved +7 days on the wall clock: each still sits at its local hour.
    assert.equal(startUtc(settled.get(OCC.oct21)), localMs('2026-10-28', '11:00'));
    assert.equal(startUtc(settled.get(OCC.oct28)), localMs('2026-11-04', '11:00'));
    assert.equal(endUtc(settled.get(OCC.oct28)), localMs('2026-11-04', '11:15'));
    assert.equal(startUtc(settled.get(OCC.nov4)), localMs('2026-11-11', '11:00'));
    assert.equal(startUtc(settled.get(OCC.nov11)), localMs('2026-11-18', '11:00'));
    // The exception row follows the same shift, its originalStart moved with it.
    assert.equal(startUtc(settled.get(OCC.moved)), localMs('2026-10-22', '14:00'));
    assert.deepEqual(settled.get(OCC.moved)?.originalStart, at('2026-10-21', '11:00'));
    // The master (outside the window) took the same shift: October 7 → October 14 at 11:00 PDT.
    const master = (await client.event.get({ ids: [SID] })).list[0];
    assert.deepEqual(master?.start, at('2026-10-14', '11:00'));
    // No occurrence is left behind or duplicated: the same five series rows, all still in the window.
    assert.equal(
      [...settled.values()].filter(e => e.seriesId === SID).length,
      Object.keys(OCC).length,
    );

    // The overlay covered exactly the loaded series rows, agreed with the store, and settled — no ghosts.
    const covered = [fx.optimistic.id, ...(fx.optimistic.more ?? []).map(m => m.id)];
    assert.deepEqual(new Set(covered), new Set(Object.values(OCC)));
    const patchOf = new Map([
      [fx.optimistic.id, fx.optimistic.patch],
      ...(fx.optimistic.more ?? []).map(m => [m.id, m.patch] as const),
    ]);
    for (const [id, patch] of patchOf) {
      const e = settled.get(id)!;
      if (patch?.start) assert.equal(toIsoDateTime(startUtc(e)!), patch.start, id);
      if (patch?.end) assert.equal(toIsoDateTime(endUtc(e)!), patch.end, id);
    }
    assert.deepEqual([...ui.applied].sort(), [...covered].sort());
    assert.deepEqual(ui.dropped, []);
  } finally {
    resetToasts();
  }
});

test('review6: This event moves only the dragged occurrence on the real stand-in', async () => {
  const { connection, flush, engine } = await boot();
  seedSeries(engine);
  resetToasts();
  try {
    const client = connection.layer.client.api;
    const ctx = await ctxFromWindow(client);
    const occ = ctx.events.get(OCC.oct28)!;
    const ask = update(
      S({ selectedId: occ.id }),
      { type: 'move', id: occ.id, start: '2026-10-28T14:00:00', end: '2026-10-28T14:15:00' },
      ctx,
    );
    const chosen = update(ask.state, { type: 'scope', scope: 'occurrence' }, ctx);
    const fx = chosen.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
    assert.equal(fx.change.scope, 'occurrence');
    assert.equal(fx.optimistic.more, undefined);

    const ui = testUi();
    runCalendarEffect(fx, ports(), ui);
    await flush();

    const rows = new Map(
      (await client.event.get({ ids: [...Object.values(OCC), SID] })).list.map(e => [e.id, e]),
    );
    assert.deepEqual(rows.get(OCC.oct28)?.start, at('2026-10-28', '14:00'));
    assert.equal(
      rows.get(OCC.oct28)?.exception,
      true,
      'the stand-in marks an occurrence-scope edit an exception',
    );
    // Everything else of the series kept its slot, the master included.
    assert.deepEqual(rows.get(OCC.oct21)?.start, at('2026-10-21', '11:00'));
    assert.deepEqual(rows.get(OCC.nov4)?.start, at('2026-11-04', '11:00'));
    assert.deepEqual(rows.get(OCC.nov11)?.start, at('2026-11-11', '11:00'));
    assert.deepEqual(rows.get(OCC.moved)?.start, at('2026-10-15', '14:00'));
    assert.deepEqual(rows.get(SID)?.start, at('2026-10-07', '11:00'));
    assert.deepEqual(ui.applied, [occ.id]);
    assert.deepEqual(ui.dropped, []);
  } finally {
    resetToasts();
  }
});

test('review6: a series title save writes every row, and the overlay covers it', async () => {
  const { connection, flush, engine } = await boot();
  seedSeries(engine);
  resetToasts();
  try {
    const client = connection.layer.client.api;
    const ctx = await ctxFromWindow(client);
    const occ = ctx.events.get(OCC.oct28)!;
    const draft = patchDraft(draftFromEvent(occ), { title: 'Sync-up' });
    const ask = update(S({ editor: draft, selectedId: occ.id }), { type: 'editorSave' }, ctx);
    assert.equal(ask.state.scope?.action, 'change');
    const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
    const fx = chosen.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
    assert.equal(fx.change.scope, 'series');
    assert.equal(fx.change.fields.title, 'Sync-up');
    // The engine copies the changed text fields to the whole series; the overlay mirrors that at once.
    const covered = new Set([fx.optimistic.id, ...(fx.optimistic.more ?? []).map(m => m.id)]);
    assert.deepEqual(covered, new Set(Object.values(OCC)));
    for (const m of fx.optimistic.more ?? []) assert.equal(m.patch?.title, 'Sync-up');

    const ui = testUi();
    runCalendarEffect(fx, ports(), ui);
    await flush();

    for (const e of (await client.event.get({ ids: [...Object.values(OCC), SID] })).list)
      assert.equal(e.title, 'Sync-up', `${e.id} follows the series title`);
    assert.deepEqual([...ui.applied].sort(), [...covered].sort());
    assert.deepEqual(ui.dropped, []);
  } finally {
    resetToasts();
  }
});
