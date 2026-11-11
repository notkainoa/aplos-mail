/**
 * The review11 tests: an update writes in the event's OWN zone — the series zone the engine moves a
 * series in, refusing a floating change stamped in any other (`calendar.floatingSeries`) — never the
 * calendar's. An editor save and a drag move on a Tokyo series sitting on an LA calendar send floating
 * times stamped 'Asia/Tokyo' with the wall-clock move the owner made; a single event in another zone
 * keeps it on edit; a zone-less event falls back to its calendar's; a create takes the target
 * calendar's; and the 'all events' overlay shifts siblings in that same zone.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDateTime, type Calendar, type Event } from '../../data';
import {
  draftFromEvent,
  localMs,
  newDraft,
  patchDraft,
  update,
  wallDeltaMs,
} from './calendar.model';
import { ctxFor, NOW, S, THU } from './calendar.testkit';
import { demoWorld } from './CalendarStates';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const HOUR = 3_600_000;

/** A demo calendar carrying a zone (the demo ones carry none). */
const zonedCal = (id: string, name: string, timeZone: string): Calendar => ({
  ...demoWorld.calendars.find(c => c.id === 'work')!,
  id,
  name,
  timeZone,
});

const LA_CAL = zonedCal('la-cal', 'Work', LA);
const TKO_CAL = zonedCal('tko-cal', 'Tokyo', TOKYO);

/** A timed event whose wall clock runs on `zone` (or names none), on `calendarId`. */
const timedEvent = (
  id: string,
  calendarId: string,
  day: string,
  zone: string | undefined,
  extra: Partial<Event> = {},
): Event => ({
  id,
  rev: 1,
  accountId: 'acct-alex',
  calendarId,
  recurring: false,
  exception: false,
  title: 'Tokyo sync',
  start: { type: 'floating', local: `${day}T09:00`, ...(zone ? { timeZone: zone } : {}) },
  end: { type: 'floating', local: `${day}T09:30`, ...(zone ? { timeZone: zone } : {}) },
  allDay: false,
  ...(zone ? { timeZone: zone } : {}),
  attendees: [],
  status: 'confirmed',
  can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
  sync: 'synced',
  ...extra,
});

const SERIES = { recurring: true, seriesId: 'tokyo-weekly' } as const;
/** 09:00 Tokyo on the 28th shows as October 27 17:00 on the LA grid. */
const tokyo1 = () => timedEvent('tokyo@1', 'la-cal', '2026-10-28', TOKYO, SERIES);
/** 09:00 Tokyo on the 31st shows as October 30 17:00. */
const tokyo2 = () => timedEvent('tokyo@2', 'la-cal', '2026-10-31', TOKYO, SERIES);

test('review11: a series save writes floating times in the series’ own zone, not the calendar’s', () => {
  const e1 = tokyo1();
  const ctx = ctxFor([e1, tokyo2()], [], [LA_CAL]);
  // The occurrence shows 17:00–17:30 on the LA grid; the owner retypes 18:00 and picks All events.
  const draft = patchDraft(draftFromEvent(e1), { start: '18:00' });
  const ask = update(S({ editor: draft, selectedId: e1.id }), { type: 'editorSave' }, ctx);
  assert.equal(ask.state.scope?.action, 'change');
  const fx = update(ask.state, { type: 'scope', scope: 'series' }, ctx).effects.find(
    f => f.kind === 'eventSet',
  );
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.equal(fx.change.id, e1.id);
  assert.equal(fx.change.scope, 'series');
  // 18:00 PDT is 10:00 the next day on the Tokyo wall clock the engine rebases the master in.
  assert.deepEqual(fx.change.fields.start, {
    type: 'floating',
    local: '2026-10-28T10:00',
    timeZone: 'Asia/Tokyo',
  });
  assert.deepEqual(fx.change.fields.end, {
    type: 'floating',
    local: '2026-10-28T10:30',
    timeZone: 'Asia/Tokyo',
  });
  // The wall-clock move the owner made survives — +1 hour on the series' own clock.
  const { start } = fx.change.fields;
  assert.ok(start);
  assert.equal(wallDeltaMs(e1.start, start, 'Asia/Tokyo'), HOUR);
  // The overlay drops the occurrence where the owner put it — the same instant.
  assert.equal(fx.optimistic.patch?.start, toIsoDateTime(localMs('2026-10-27', '18:00')));
});

test('review11: a drag move on the same series writes the series’ zone too', () => {
  const e1 = tokyo1();
  const ctx = ctxFor([e1, tokyo2()], [], [LA_CAL]);
  const ask = update(
    S({ selectedId: e1.id }),
    { type: 'move', id: e1.id, start: '2026-10-27T18:00:00', end: '2026-10-27T18:30:00' },
    ctx,
  );
  assert.equal(ask.state.scope?.action, 'move');
  const fx = update(ask.state, { type: 'scope', scope: 'series' }, ctx).effects.find(
    f => f.kind === 'eventSet',
  );
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.equal(fx.change.scope, 'series');
  assert.deepEqual(fx.change.fields.start, {
    type: 'floating',
    local: '2026-10-28T10:00',
    timeZone: 'Asia/Tokyo',
  });
  assert.deepEqual(fx.change.fields.end, {
    type: 'floating',
    local: '2026-10-28T10:30',
    timeZone: 'Asia/Tokyo',
  });
});

test('review11: an all-day series re-timed writes the series’ zone, not the calendar’s', () => {
  const offsite: Event = {
    id: 'tokyo-offsite',
    rev: 1,
    accountId: 'acct-alex',
    calendarId: 'la-cal',
    seriesId: 'tokyo-offsite',
    recurring: true,
    exception: false,
    title: 'Offsite',
    start: { type: 'date', date: '2026-10-28' },
    end: { type: 'date', date: '2026-10-29' },
    allDay: true,
    timeZone: 'Asia/Tokyo',
    attendees: [],
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
  };
  const ctx = ctxFor([offsite], [], [LA_CAL]);
  const draft = { ...draftFromEvent(offsite), allDay: false, start: '10:00', end: '11:00' };
  const ask = update(S({ editor: draft, selectedId: offsite.id }), { type: 'editorSave' }, ctx);
  const fx = update(ask.state, { type: 'scope', scope: 'series' }, ctx).effects.find(
    f => f.kind === 'eventSet',
  );
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  if (fx.change.fields.start?.type === 'floating')
    assert.equal(fx.change.fields.start.timeZone, 'Asia/Tokyo');
  else assert.fail('a timed write on the series stays floating, in the series’ zone');
});

test('review11: a non-repeating event in another zone keeps its own zone on edit', () => {
  const single = timedEvent('tokyo-single', 'la-cal', '2026-10-28', TOKYO);
  const ctx = ctxFor([single], [], [LA_CAL]);
  const draft = patchDraft(draftFromEvent(single), { start: '18:00' });
  const fx = update(
    S({ editor: draft, selectedId: single.id }),
    { type: 'editorSave' },
    ctx,
  ).effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.equal(fx.change.scope, 'occurrence');
  if (fx.change.fields.start?.type === 'floating')
    assert.equal(fx.change.fields.start.timeZone, 'Asia/Tokyo');
  else assert.fail('the edited time keeps the event’s own zone');
});

test('review11: a zone-less event falls back to its calendar’s zone', () => {
  const plain = timedEvent('plain', 'tko-cal', '2026-10-29', undefined);
  const ctx = ctxFor([plain], [], [TKO_CAL]);
  const draft = patchDraft(draftFromEvent(plain), { start: '10:00' });
  const fx = update(
    S({ editor: draft, selectedId: plain.id }),
    { type: 'editorSave' },
    ctx,
  ).effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  // The wall clock gains the calendar's zone on the way out — the machine's would read LA.
  assert.deepEqual(fx.change.fields.start, {
    type: 'floating',
    local: '2026-10-30T02:00',
    timeZone: 'Asia/Tokyo',
  });
});

test('review11: a create on a calendar takes that calendar’s zone', () => {
  const ctx = ctxFor([], [], [TKO_CAL]);
  const draft = { ...newDraft(THU, NOW, [], 'tko-cal'), title: 'Focus' };
  const fx = update(S({ editor: draft }), { type: 'editorSave' }, ctx).effects.find(
    f => f.kind === 'eventSet',
  );
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'create');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'create') return;
  assert.equal(fx.change.fields.timeZone, 'Asia/Tokyo');
  assert.deepEqual(fx.change.fields.start, {
    type: 'floating',
    local: '2026-10-30T02:00',
    timeZone: 'Asia/Tokyo',
  });
});

test('review11: the ‘all events’ overlay shifts siblings in the series’ zone across the fall-back', () => {
  const e1 = tokyo1();
  const e2 = tokyo2();
  const ctx = ctxFor([e1, e2], [], [LA_CAL]);
  // October 27 → November 1 on the LA grid crosses the fall-back: +5d on that clock, +5d+1h on Tokyo's.
  const draft = patchDraft(draftFromEvent(e1), { date: '2026-11-01' });
  const ask = update(S({ editor: draft, selectedId: e1.id }), { type: 'editorSave' }, ctx);
  const fx = update(ask.state, { type: 'scope', scope: 'series' }, ctx).effects.find(
    f => f.kind === 'eventSet',
  );
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind !== 'eventSet' || fx.change.type !== 'update') return;
  assert.deepEqual(fx.change.fields.start, {
    type: 'floating',
    local: '2026-11-02T10:00',
    timeZone: 'Asia/Tokyo',
  });
  const { start } = fx.change.fields;
  assert.ok(start);
  assert.equal(wallDeltaMs(e1.start, start, 'Asia/Tokyo'), 5 * 24 * HOUR + HOUR);
  // The sibling's own Tokyo wall moves by the same delta: Oct 31 09:00 → Nov 5 10:00 (Nov 4 17:00 PST).
  // Read in the calendar's LA zone the same write would land an hour earlier — the old zone's answer.
  const sib = fx.optimistic.more?.find(m => m.id === e2.id);
  assert.equal(sib?.patch?.start, toIsoDateTime(localMs('2026-11-04', '17:00')));
  assert.equal(sib?.patch?.end, toIsoDateTime(localMs('2026-11-04', '17:30')));
});
