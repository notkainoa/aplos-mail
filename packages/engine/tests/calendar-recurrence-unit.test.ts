/**
 * Unit tests for the recurrence module: the RRULE parser, limits and refusals, occurrence keys and
 * Google instance ids, and the three edit scopes (including "this and following" with COUNT and UNTIL).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editOccurrence,
  editSeries,
  expand,
  formatRRule,
  googleInstanceId,
  occurrenceKey,
  parseRRule,
  splitFollowing,
  type ExpandResult,
  type Series,
} from '../src/calendar/recurrence';
import { fromWall, offsetReader, partsReader, toWall } from '../src/calendar/recurrence/zone';

const LA = 'America/Los_Angeles';
const YEAR_2026 = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) };
const ids = (r: ExpandResult): string[] => r.occurrences.map(o => o.recurrenceId);

/** A weekly 09:00-10:00 Los Angeles series starting Monday 2 February 2026. */
function weekly(rrule: string, extra: Partial<Series> = {}): Series {
  return {
    start: { local: '2026-02-02T09:00:00', tzid: LA },
    end: { local: '2026-02-02T10:00:00', tzid: LA },
    allDay: false,
    rrule,
    ...extra,
  };
}

function okExpand(series: Series, range = YEAR_2026): string[] {
  const r = expand({ ...series, range });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return ids(r);
}

// ---------- parser ----------

test('parseRRule reads every rule part', () => {
  const r = parseRRule(
    'RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=1,3;BYDAY=-1SU,2MO,TU;BYMONTHDAY=-1,15;BYSETPOS=1,-1;BYHOUR=9;BYMINUTE=30;BYSECOND=0;WKST=SU;UNTIL=20301231T235959Z',
  );
  assert.ok(r.ok);
  assert.equal(r.rule.freq, 'YEARLY');
  assert.equal(r.rule.interval, 2);
  assert.deepEqual(r.rule.byDay, [
    { weekday: 'SU', ordinal: -1 },
    { weekday: 'MO', ordinal: 2 },
    { weekday: 'TU' },
  ]);
  assert.deepEqual(r.rule.byMonthDay, [-1, 15]);
  assert.deepEqual(r.rule.bySetPos, [1, -1]);
  assert.equal(r.rule.wkst, 'SU');
  assert.deepEqual(r.rule.until, { kind: 'utc', ms: Date.UTC(2030, 11, 31, 23, 59, 59) });
  const y = parseRRule('FREQ=YEARLY;BYYEARDAY=1,-1;BYWEEKNO=20,-1');
  assert.ok(y.ok);
  assert.deepEqual(
    [y.rule.byYearDay, y.rule.byWeekNo],
    [
      [1, -1],
      [20, -1],
    ],
  );
});

test('UNTIL keeps its form: UTC, floating or date', () => {
  const kinds = ['20261231T120000Z', '20261231T120000', '20261231'].map(u => {
    const r = parseRRule(`FREQ=DAILY;UNTIL=${u}`);
    assert.ok(r.ok);
    return r.rule.until?.kind;
  });
  assert.deepEqual(kinds, ['utc', 'local', 'date']);
});

test('formatRRule is the exact inverse of parseRRule', () => {
  // Any order in, one canonical order out, and nothing lost on the way back.
  const messy = parseRRule('wkst=su;byday=tu,su;interval=2;count=10;freq=weekly');
  assert.ok(messy.ok);
  assert.equal(formatRRule(messy.rule), 'FREQ=WEEKLY;COUNT=10;INTERVAL=2;BYDAY=TU,SU;WKST=SU');
  for (const text of [
    'FREQ=DAILY',
    'FREQ=WEEKLY;COUNT=10;INTERVAL=2;BYDAY=TU,SU;WKST=SU',
    'FREQ=MONTHLY;UNTIL=20271231T235959Z;BYDAY=-1FR',
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'FREQ=YEARLY;UNTIL=20300101;BYMONTHDAY=-1;BYMONTH=2',
    'FREQ=YEARLY;BYDAY=MO;BYMINUTE=0,30;BYHOUR=9,17;BYWEEKNO=20',
    'FREQ=DAILY;UNTIL=20260320T090000',
    'FREQ=HOURLY;INTERVAL=3',
  ]) {
    const r = parseRRule(text);
    assert.ok(r.ok, text);
    assert.equal(formatRRule(r.rule), text);
    const back = parseRRule(formatRRule(r.rule));
    assert.ok(back.ok);
    assert.deepEqual(back.rule, r.rule);
  }
});

test('parseRRule refuses what RFC 5545 forbids, and RFC 7529 as unsupported', () => {
  const invalid = [
    '',
    'COUNT=3',
    'FREQ=FORTNIGHTLY',
    'FREQ=DAILY;FREQ=WEEKLY',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;COUNT=2;UNTIL=20260101T000000Z',
    'FREQ=DAILY;UNTIL=20260231',
    'FREQ=DAILY;UNTIL=2026-01-01',
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=DAILY;BYDAY=-1FR',
    'FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO',
    'FREQ=WEEKLY;BYMONTHDAY=1',
    'FREQ=MONTHLY;BYYEARDAY=1',
    'FREQ=MONTHLY;BYWEEKNO=1',
    'FREQ=MONTHLY;BYSETPOS=1',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYMONTHDAY=0',
    'FREQ=YEARLY;BYMONTH=13',
    'FREQ=MONTHLY;BYDAY=6XX',
    'FREQ=DAILY;BYHOUR=24',
    'FREQ=DAILY;X-NAME=1',
    'FREQ=DAILY;COUNT',
  ];
  for (const text of invalid) {
    const r = parseRRule(text);
    assert.ok(!r.ok && r.error === 'invalid', `${text} is invalid`);
  }
  const rscale = parseRRule('RSCALE=HEBREW;FREQ=YEARLY');
  assert.ok(!rscale.ok && rscale.error === 'unsupported');
  // Finer than daily parses (it round-trips) but is refused at expansion.
  assert.ok(parseRRule('FREQ=MINUTELY;INTERVAL=15').ok);
});

// ---------- limits and refusals ----------

test('an endless rule stops at the limit (default 5,000) and says it was cut', () => {
  const daily = weekly('FREQ=DAILY');
  const all = expand({ ...daily, range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2060, 0, 1) } });
  assert.ok(all.ok);
  assert.equal(all.occurrences.length, 5000);
  assert.equal(all.truncated, true);
  const few = expand({ ...daily, range: YEAR_2026, limit: 7 });
  assert.ok(few.ok);
  assert.equal(few.occurrences.length, 7);
  assert.equal(few.truncated, true);
  const none = expand({ ...daily, range: YEAR_2026, limit: 0 });
  assert.deepEqual(none.occurrences, []);
  const short = expand({ ...weekly('FREQ=DAILY;COUNT=3'), range: YEAR_2026 });
  assert.ok(short.ok);
  assert.equal(short.truncated, false);
});

test('a series that started long ago still counts COUNT from DTSTART', () => {
  const old = {
    ...weekly('FREQ=WEEKLY;COUNT=600'),
    start: { local: '2015-01-05T09:00:00', tzid: LA },
    end: { local: '2015-01-05T10:00:00', tzid: LA },
  };
  const later = okExpand(old, { from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 8, 1) });
  // 600 weeks from 5 January 2015 end in June 2026, so nothing is left in July.
  assert.deepEqual(later, []);
});

test('HOURLY and finer are refused as unsupported and show only the first instance', () => {
  for (const rrule of ['FREQ=HOURLY;COUNT=5', 'FREQ=MINUTELY', 'FREQ=SECONDLY;INTERVAL=30']) {
    const r = expand({ ...weekly(rrule), range: YEAR_2026 });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.refused === 'unsupported');
    assert.deepEqual(ids(r), ['20260202T170000Z']);
  }
  // The first instance is still range-filtered.
  const outside = expand({
    ...weekly('FREQ=HOURLY'),
    range: { from: Date.UTC(2027, 0, 1), to: Date.UTC(2028, 0, 1) },
  });
  assert.deepEqual(outside.occurrences, []);
});

test('other refusals are typed', () => {
  const two = expand({ ...weekly(''), rrule: ['FREQ=DAILY', 'FREQ=WEEKLY'], range: YEAR_2026 });
  assert.ok(!two.ok && two.refused === 'unsupported');
  const zone = expand({
    ...weekly('FREQ=DAILY'),
    start: { local: '2026-02-02T09:00:00', tzid: 'Mars/Olympus' },
    range: YEAR_2026,
  });
  assert.ok(!zone.ok && zone.refused === 'invalid');
  assert.deepEqual(zone.occurrences, []);
  const allDayMismatch = expand({ ...weekly('FREQ=DAILY'), allDay: true, range: YEAR_2026 });
  assert.ok(!allDayMismatch.ok && allDayMismatch.refused === 'invalid');
  const byHourAllDay = expand({
    start: { date: '2026-02-02' },
    end: { date: '2026-02-03' },
    allDay: true,
    rrule: 'FREQ=DAILY;BYHOUR=9',
    range: YEAR_2026,
  });
  assert.ok(!byHourAllDay.ok && byHourAllDay.refused === 'invalid');
  const badExdate = expand({
    ...weekly('FREQ=DAILY'),
    exdate: ['EXDATE:yesterday'],
    range: YEAR_2026,
  });
  assert.ok(!badExdate.ok && badExdate.refused === 'invalid');
});

// ---------- DST and lenient forms ----------

test('wall clock to instant: gaps move forward, overlaps take the first reading', () => {
  const wall = (s: string): number => Date.parse(`${s}Z`);
  assert.equal(fromWall(wall('2026-03-08T02:30:00'), LA), Date.UTC(2026, 2, 8, 10, 30));
  assert.equal(fromWall(wall('2026-11-01T01:30:00'), LA), Date.UTC(2026, 10, 1, 8, 30));
  assert.equal(
    fromWall(wall('2026-10-04T02:30:00'), 'Australia/Sydney'),
    Date.UTC(2026, 9, 3, 16, 30),
  );
  assert.equal(
    fromWall(wall('2026-04-05T02:30:00'), 'Australia/Sydney'),
    Date.UTC(2026, 3, 4, 15, 30),
  );
  assert.equal(toWall(Date.UTC(2026, 10, 1, 9, 30), LA), wall('2026-11-01T01:30:00'));
});

test('the fallback offset reader agrees with the fast one', () => {
  for (const tz of [LA, 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'America/St_Johns']) {
    const fast = offsetReader(tz);
    const slow = partsReader(tz);
    for (
      let ms = Date.UTC(2025, 0, 1);
      ms < Date.UTC(2027, 0, 1);
      ms += 7 * 3_600_000 + 13 * 60_000
    )
      assert.equal(slow(ms), fast(ms), `${tz} at ${ms}`);
  }
});

test('floating and all-day series never shift, whatever zone they are viewed in', () => {
  const floating: Series = {
    start: { local: '2026-03-07T02:30:00' },
    end: { local: '2026-03-07T03:00:00' },
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=3',
  };
  const r = expand({ ...floating, range: YEAR_2026, floatingZone: LA });
  assert.ok(r.ok);
  assert.deepEqual(
    r.occurrences.map(o => o.start),
    [
      { local: '2026-03-07T02:30:00' },
      { local: '2026-03-08T02:30:00' },
      { local: '2026-03-09T02:30:00' },
    ],
  );
  const allDay = expand({
    start: { date: '2026-03-07' },
    end: { date: '2026-03-08' },
    allDay: true,
    tzid: LA,
    rrule: 'FREQ=DAILY;COUNT=2',
    range: YEAR_2026,
  });
  assert.deepEqual(
    allDay.occurrences.map(o => [o.start, o.end]),
    [
      [{ date: '2026-03-07' }, { date: '2026-03-08' }],
      [{ date: '2026-03-08' }, { date: '2026-03-09' }],
    ],
  );
});

test('the range is placed in floatingZone for floating times', () => {
  const floating: Series = {
    start: { local: '2026-03-07T23:00:00' },
    end: { local: '2026-03-07T23:30:00' },
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=1',
  };
  // 23:00 floating is 07:00Z the next day in Los Angeles, so a UTC range on the 7th misses it there.
  const range = { from: Date.UTC(2026, 2, 7), to: Date.UTC(2026, 2, 8) };
  assert.equal(expand({ ...floating, range }).occurrences.length, 1);
  assert.equal(expand({ ...floating, range, floatingZone: LA }).occurrences.length, 0);
});

test('a DATE in EXDATE or RDATE on a timed series means that day at the series time', () => {
  const s = weekly('FREQ=DAILY;COUNT=4', {
    exdate: ['EXDATE;VALUE=DATE:20260203'],
    rdate: ['RDATE;VALUE=DATE:20260210'],
  });
  assert.deepEqual(okExpand(s), [
    '20260202T170000Z',
    '20260204T170000Z',
    '20260205T170000Z',
    '20260210T170000Z',
  ]);
});

test('an RDATE PERIOD is refused as unsupported, never half-read', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=2', {
    rdate: ['RDATE;VALUE=PERIOD;TZID=America/Los_Angeles:20260204T120000/PT2H30M'],
  });
  const r = expand({ ...s, range: YEAR_2026 });
  assert.ok(!r.ok && r.refused === 'unsupported');
  assert.deepEqual(ids(r), ['20260202T170000Z']);
});

// ---------- keys and Google instance ids ----------

test('occurrence keys and Google instance ids', () => {
  assert.equal(occurrenceKey({ utc: Date.UTC(2026, 2, 8, 17) }), '20260308T170000Z');
  assert.equal(occurrenceKey({ local: '2026-03-08T09:00:00', tzid: LA }), '20260308T160000Z');
  assert.equal(occurrenceKey({ local: '2026-03-08T09:00:00' }), '20260308T090000');
  assert.equal(occurrenceKey({ date: '2026-03-08' }), '20260308');
  assert.equal(occurrenceKey('2026-03-08T16:00:00Z'), '20260308T160000Z');
  assert.throws(() => occurrenceKey('next tuesday'), RangeError);

  assert.equal(
    googleInstanceId('abc123', { local: '2026-11-01T01:30:00', tzid: LA }),
    'abc123_20261101T083000Z',
  );
  assert.equal(googleInstanceId('abc123', { date: '2026-12-25' }), 'abc123_20261225');

  // An expanded occurrence's recurrenceId is exactly the instance id suffix.
  const r = expand({ ...weekly('FREQ=WEEKLY;COUNT=6'), range: YEAR_2026 });
  const sixth = r.occurrences[5];
  assert.equal(googleInstanceId('m', sixth.start), `m_${sixth.recurrenceId}`);
  assert.equal(sixth.recurrenceId, '20260309T160000Z');
});

// ---------- edit: one occurrence ----------

test('editOccurrence creates, updates and cancels an override', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=4');
  const moved = editOccurrence(s, '20260209T170000Z', {
    start: { local: '2026-02-10T09:00:00', tzid: LA },
    end: { local: '2026-02-10T10:00:00', tzid: LA },
  });
  assert.ok(moved.ok);
  assert.equal(moved.override.recurrenceId, '20260209T170000Z');
  const r1 = expand({ ...moved.series, range: YEAR_2026 });
  assert.deepEqual(r1.occurrences[1], {
    recurrenceId: '20260209T170000Z',
    start: { utc: Date.UTC(2026, 1, 10, 17) },
    end: { utc: Date.UTC(2026, 1, 10, 18) },
    overridden: true,
  });

  // The same occurrence named by an EventTime updates the same override (end only).
  const longer = editOccurrence(
    moved.series,
    { local: '2026-02-09T09:00:00', tzid: LA },
    { end: { local: '2026-02-10T11:00:00', tzid: LA } },
  );
  assert.ok(longer.ok);
  assert.equal(longer.series.overrides?.length, 1);
  assert.deepEqual(longer.override.start, { local: '2026-02-10T09:00:00', tzid: LA });

  const cancelled = editOccurrence(longer.series, '20260216T170000Z', { cancelled: true });
  assert.ok(cancelled.ok);
  assert.deepEqual(okExpand(cancelled.series), [
    '20260202T170000Z',
    '20260209T170000Z',
    '20260223T170000Z',
  ]);
  assert.deepEqual(s.overrides, undefined, 'the input is not mutated');

  const missing = editOccurrence(s, '20260210T170000Z', { cancelled: true });
  assert.ok(!missing.ok && missing.error === 'not-an-occurrence');
  const excluded = editOccurrence(
    { ...s, exdate: ['EXDATE:20260209T170000Z'] },
    '20260209T170000Z',
    { cancelled: true },
  );
  assert.ok(!excluded.ok && excluded.error === 'not-an-occurrence');
  const refused = editOccurrence(weekly('FREQ=HOURLY'), '20260202T170000Z', { cancelled: true });
  assert.ok(!refused.ok && refused.error === 'unsupported');
});

// ---------- edit: whole series ----------

test('editSeries keeps overrides that still exist and reports the others', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=6', {
    overrides: [
      { recurrenceId: '20260209T170000Z', cancelled: true },
      { recurrenceId: '20260302T170000Z', start: { local: '2026-03-02T11:00:00', tzid: LA } },
    ],
  });
  const shorter = editSeries(s, { rrule: 'FREQ=WEEKLY;COUNT=3' });
  assert.ok(shorter.ok);
  assert.deepEqual(
    shorter.series.overrides?.map(o => o.recurrenceId),
    ['20260209T170000Z'],
  );
  assert.deepEqual(shorter.dropped, ['20260302T170000Z']);

  const retimed = editSeries(s, {
    start: { local: '2026-02-02T10:00:00', tzid: LA },
    end: { local: '2026-02-02T11:00:00', tzid: LA },
  });
  assert.ok(retimed.ok);
  assert.deepEqual(retimed.series.overrides, []);
  assert.deepEqual(retimed.dropped, ['20260209T170000Z', '20260302T170000Z']);

  const single = editSeries(s, { rrule: null });
  assert.ok(single.ok);
  assert.equal(single.series.rrule, undefined);
  assert.deepEqual(okExpand(single.series), ['20260202T170000Z']);

  const bad = editSeries(s, { rrule: 'FREQ=WEEKLY;BYDAY=1MO' });
  assert.ok(!bad.ok && bad.error === 'invalid');
});

// ---------- edit: this and following ----------

test('splitFollowing with COUNT: UNTIL before the split, the remaining COUNT after', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=10', {
    exdate: ['EXDATE;TZID=America/Los_Angeles:20260216T090000,20260323T090000'],
    overrides: [
      { recurrenceId: '20260209T170000Z', cancelled: true },
      { recurrenceId: '20260316T160000Z', start: { local: '2026-03-17T09:00:00', tzid: LA } },
    ],
  });
  const original = okExpand(s);
  // Split at the 5th rule instance (2 March); the excluded 16 February still counts toward COUNT.
  const r = splitFollowing(s, '20260302T170000Z');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.before.rrule, 'FREQ=WEEKLY;UNTIL=20260302T165959Z');
  assert.equal(r.after.rrule, 'FREQ=WEEKLY;COUNT=6');
  assert.deepEqual(r.after.start, { local: '2026-03-02T09:00:00', tzid: LA });
  assert.deepEqual(r.after.end, { local: '2026-03-02T10:00:00', tzid: LA });
  assert.deepEqual(r.before.exdate, ['EXDATE;TZID=America/Los_Angeles:20260216T090000']);
  assert.deepEqual(r.after.exdate, ['EXDATE;TZID=America/Los_Angeles:20260323T090000']);
  assert.deepEqual(
    r.before.overrides?.map(o => o.recurrenceId),
    ['20260209T170000Z'],
  );
  assert.deepEqual(
    r.after.overrides?.map(o => o.recurrenceId),
    ['20260316T160000Z'],
  );
  assert.deepEqual([...okExpand(r.before), ...okExpand(r.after)], original);
  assert.deepEqual(r.dropped, []);
});

test('splitFollowing with UNTIL keeps the end on the new series, across DST', () => {
  const s = weekly('FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20260501T000000Z');
  const original = okExpand(s);
  const r = splitFollowing(s, '20260312T160000Z');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.before.rrule, 'FREQ=WEEKLY;UNTIL=20260312T155959Z;BYDAY=MO,TH');
  assert.equal(r.after.rrule, 'FREQ=WEEKLY;UNTIL=20260501T000000Z;BYDAY=MO,TH');
  // The new master keeps the 09:00 wall clock, now in daylight time.
  assert.deepEqual(r.after.start, { local: '2026-03-12T09:00:00', tzid: LA });
  assert.deepEqual([...okExpand(r.before), ...okExpand(r.after)], original);
});

test('splitFollowing on all-day and floating series writes UNTIL in their own form', () => {
  const allDay: Series = {
    start: { date: '2026-02-02' },
    end: { date: '2026-02-03' },
    allDay: true,
    rrule: 'FREQ=DAILY;COUNT=10',
  };
  const a = splitFollowing(allDay, '20260205');
  assert.ok(a.ok);
  assert.equal(a.before.rrule, 'FREQ=DAILY;UNTIL=20260204');
  assert.equal(a.after.rrule, 'FREQ=DAILY;COUNT=7');
  assert.deepEqual([a.after.start, a.after.end], [{ date: '2026-02-05' }, { date: '2026-02-06' }]);
  assert.deepEqual([...okExpand(a.before), ...okExpand(a.after)], okExpand(allDay));

  const floating: Series = {
    start: { local: '2026-02-02T09:00:00' },
    end: { local: '2026-02-02T09:30:00' },
    allDay: false,
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR',
  };
  const f = splitFollowing(floating, { local: '2026-02-16T09:00:00' });
  assert.ok(f.ok);
  assert.equal(f.before.rrule, 'FREQ=WEEKLY;UNTIL=20260216T085959;INTERVAL=2;BYDAY=MO,FR');
  assert.deepEqual([...okExpand(f.before), ...okExpand(f.after)], okExpand(floating));
});

test('splitFollowing applies a change to the new series and reports overrides it loses', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=6', {
    overrides: [{ recurrenceId: '20260302T170000Z', cancelled: true }],
  });
  const r = splitFollowing(s, '20260216T170000Z', {
    start: { local: '2026-02-16T14:00:00', tzid: LA },
    end: { local: '2026-02-16T15:00:00', tzid: LA },
  });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(okExpand(r.before), ['20260202T170000Z', '20260209T170000Z']);
  assert.deepEqual(okExpand(r.after), [
    '20260216T220000Z',
    '20260223T220000Z',
    '20260302T220000Z',
    '20260309T210000Z',
  ]);
  assert.deepEqual(r.dropped, ['20260302T170000Z']);
});

test('splitFollowing refuses what it cannot write back exactly', () => {
  const s = weekly('FREQ=WEEKLY;COUNT=4', {
    rdate: ['RDATE:20260204T200000Z'],
    exdate: ['EXDATE:20260216T170000Z'],
  });
  const reasons = [
    splitFollowing(s, '20260202T170000Z'), // the first occurrence: a whole-series edit
    splitFollowing(s, '20260203T170000Z'), // not an occurrence
    splitFollowing(s, '20260204T200000Z'), // an RDATE-only occurrence
    splitFollowing(s, '20260216T170000Z'), // excluded
    splitFollowing(weekly('FREQ=HOURLY'), '20260202T180000Z'),
    splitFollowing({ ...s, rrule: undefined }, '20260202T170000Z'),
    splitFollowing(s, 'soon'),
  ].map(r => {
    assert.ok(!r.ok && r.error === 'cannot-split');
    return r.reason;
  });
  assert.equal(new Set(reasons).size, reasons.length, `distinct reasons: ${reasons.join(' | ')}`);
});
