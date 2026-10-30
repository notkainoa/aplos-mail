/**
 * Regression tests for the fuzz review's findings: hostile or odd input must neither stall
 * expansion nor be misread. Expectations are worked out by hand from RFC 5545.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expand,
  googleInstanceId,
  occurrenceKey,
  parseRRule,
  splitFollowing,
  type ExpandResult,
  type Series,
} from '../src/calendar/recurrence';

const LA = 'America/Los_Angeles';
const ids = (r: ExpandResult): string[] => r.occurrences.map(o => o.recurrenceId);
const timed = (ms: () => unknown): number => {
  const t0 = performance.now();
  ms();
  return performance.now() - t0;
};

function la(local: string, rrule: string, extra: Partial<Series> = {}): Series {
  const end = new Date(Date.parse(`${local}Z`) + 3_600_000).toISOString().slice(0, 19);
  return {
    start: { local, tzid: LA },
    end: { local: end, tzid: LA },
    allDay: false,
    rrule,
    ...extra,
  };
}

test('24 start times a day still expand, and a series from decades ago costs no more than a new one', () => {
  const hours = Array.from({ length: 24 }, (_, i) => i).join(',');
  let r: ExpandResult | undefined;
  const ms = timed(() => {
    r = expand({
      ...la('1990-01-01T00:00:00', `FREQ=DAILY;BYHOUR=${hours}`),
      range: { from: Date.UTC(2026, 9, 27, 12), to: Date.UTC(2026, 9, 27, 15) },
    });
  });
  assert.ok(r?.ok);
  assert.deepEqual(ids(r), ['20261027T120000Z', '20261027T130000Z', '20261027T140000Z']);
  // Alone this takes 20-70 ms; walking 8,000 years would take minutes, so the bound is loose enough for a loaded box.
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
  const tooMany = expand({
    ...la('2026-01-01T00:00:00', `FREQ=WEEKLY;BYHOUR=${hours};BYMINUTE=0,30`),
    range: { from: 0, to: Date.UTC(2027, 0, 1) },
  });
  assert.ok(!tooMany.ok && tooMany.refused === 'unsupported');
  // The refused master still shows its own first instance when it is in range.
  assert.deepEqual(ids(tooMany), ['20260101T080000Z']);
});

test('skipping ahead keeps INTERVAL phase and BYSETPOS periods intact', () => {
  // Every third day from 1 Jan 2000 (a leap year start): 1 Jan 2026 is day 9497 = 3 x 3165 + 2, so
  // the instances near it fall on 30 Dec 2025, 2 Jan 2026 and 5 Jan 2026.
  const every3 = expand({
    ...la('2000-01-01T09:00:00', 'FREQ=DAILY;INTERVAL=3'),
    range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 6) },
  });
  assert.deepEqual(ids(every3), ['20260102T170000Z', '20260105T170000Z']);
  // Last weekday of every other month from January 2000: even months-since-start only (Jan, Mar, ...).
  const bimonthly = expand({
    ...la('2000-01-31T09:00:00', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),
    range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 5, 1) },
  });
  assert.deepEqual(ids(bimonthly), ['20260130T170000Z', '20260331T160000Z', '20260529T160000Z']);
});

test('a bad range is refused at once', () => {
  const s = la('2026-01-01T09:00:00', 'FREQ=DAILY');
  for (const range of [
    { from: NaN, to: Date.UTC(2026, 1, 1) },
    { from: 0, to: Infinity },
    { from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1) },
  ]) {
    let r: ExpandResult | undefined;
    const ms = timed(() => (r = expand({ ...s, range })));
    assert.ok(r && !r.ok && r.refused === 'invalid', JSON.stringify(range));
    assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
  }
});

test('a rule that never matches ends quickly even for a range out to year 9999', () => {
  let r: ExpandResult | undefined;
  const ms = timed(
    () =>
      (r = expand({
        ...la('2026-01-01T09:00:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'),
        range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(9999, 11, 31) },
      })),
  );
  assert.ok(r?.ok);
  assert.deepEqual(ids(r), []);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});

test('an override moved into the range from far ahead is still applied', () => {
  // Daily 09:00 LA; the 1 Jan 2040 instance (17:00Z) is moved to 10 Jan 2026 18:00Z.
  const s = la('2026-01-01T09:00:00', 'FREQ=DAILY', {
    overrides: [{ recurrenceId: '20400101T170000Z', start: { utc: Date.UTC(2026, 0, 10, 18) } }],
  });
  const r = expand({ ...s, range: { from: Date.UTC(2026, 0, 10), to: Date.UTC(2026, 0, 11) } });
  assert.deepEqual(ids(r), ['20260110T170000Z', '20400101T170000Z']);
  assert.equal(r.occurrences[1].overridden, true);
  // A COUNT series has to be counted from DTSTART, so the same move past its end is ignored.
  const short = expand({
    ...s,
    rrule: 'FREQ=DAILY;COUNT=30',
    range: { from: Date.UTC(2026, 0, 10), to: Date.UTC(2026, 0, 11) },
  });
  assert.deepEqual(ids(short), ['20260110T170000Z']);
});

test('a start given as an exact instant keeps it on a fall-back night; later instances take the first reading', () => {
  // 09:30Z on 1 Nov 2026 is the second 01:30 in LA; 2 Nov 01:30 PST is 09:30Z too.
  const start = Date.UTC(2026, 10, 1, 9, 30);
  const s: Series = {
    start: { utc: start },
    end: { utc: start + 3_600_000 },
    tzid: LA,
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=2',
  };
  const r = expand({ ...s, range: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 1) } });
  assert.deepEqual(ids(r), ['20261101T093000Z', '20261102T093000Z']);
  assert.deepEqual(r.occurrences[0].end, { utc: start + 3_600_000 });
  // An override and an EXDATE keyed by Google's id for that first instance both match it.
  const moved = expand({
    ...s,
    overrides: [{ recurrenceId: '2026-11-01T01:30:00-08:00', cancelled: true }],
    range: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 1) },
  });
  assert.deepEqual(ids(moved), ['20261102T093000Z']);
  const excluded = expand({
    ...s,
    exdate: ['20261101T093000Z'],
    range: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 1) },
  });
  assert.deepEqual(ids(excluded), ['20261102T093000Z']);
});

test('splitFollowing in a DST gap: a {utc} start becomes the zoned wall reading', () => {
  const s: Series = {
    start: { utc: Date.UTC(2026, 2, 1, 10, 30) },
    end: { utc: Date.UTC(2026, 2, 1, 11, 30) },
    tzid: LA,
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=20',
  };
  const r = splitFollowing(s, '20260308T103000Z');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(r.after.start, { local: '2026-03-08T02:30:00', tzid: LA });
  assert.deepEqual(r.after.end, { utc: Date.UTC(2026, 2, 8, 11, 30) });
  const range = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) };
  assert.deepEqual(
    [...ids(expand({ ...r.before, range })), ...ids(expand({ ...r.after, range }))],
    ids(expand({ ...s, range })),
  );
  // Outside a gap a {utc} start stays {utc}.
  const plain = splitFollowing(s, '20260310T093000Z');
  assert.ok(plain.ok);
  assert.deepEqual(plain.after.start, { utc: Date.UTC(2026, 2, 10, 9, 30) });
});

test('Google instance ids: RFC 3339 originalStartTime is read, floating times are refused', () => {
  assert.equal(googleInstanceId('evt', '2026-11-01T01:30:00-07:00'), 'evt_20261101T083000Z');
  assert.equal(googleInstanceId('evt', '2026-11-01T01:30:00-08:00'), 'evt_20261101T093000Z');
  assert.equal(googleInstanceId('evt', '2026-11-01T09:30:00.000Z'), 'evt_20261101T093000Z');
  assert.equal(googleInstanceId('evt', '2026-03-08T21:15:00+05:30'), 'evt_20260308T154500Z');
  assert.equal(occurrenceKey('2026-11-01T09:30:00.250Z'), '20261101T093000Z');
  assert.throws(() => googleInstanceId('evt', { local: '2026-11-01T01:30:00' }), RangeError);
  assert.throws(() => googleInstanceId('evt', '20261101T013000'), RangeError);
  assert.throws(() => occurrenceKey('2026-11-01T01:30:00+25:00'), RangeError);
  assert.throws(() => occurrenceKey({ utc: NaN }), RangeError);
});

test('one trailing semicolon in an RRULE is tolerated; anything emptier is not', () => {
  const r = parseRRule('RRULE:FREQ=WEEKLY;BYDAY=TH;');
  assert.ok(r.ok);
  assert.deepEqual(r.rule.byDay, [{ weekday: 'TH' }]);
  for (const bad of ['FREQ=WEEKLY;;', 'FREQ=WEEKLY;;BYDAY=TH', ';', ';FREQ=WEEKLY']) {
    const p = parseRRule(bad);
    assert.ok(!p.ok && p.error === 'invalid', bad);
  }
});

test('splitFollowing: a far-off id is answered at once, and a series running since 1970 still splits', () => {
  const s = la('1970-01-05T09:00:00', 'FREQ=DAILY');
  // 31 Dec 9999 09:00 PST is a real instance; 09:15 is not. Both are answered without walking 8,000 years.
  const results: ReturnType<typeof splitFollowing>[] = [];
  const ms = timed(() =>
    results.push(splitFollowing(s, '99991231T170000Z'), splitFollowing(s, '99991231T171500Z')),
  );
  assert.deepEqual(
    results.map(r => r.ok),
    [true, false],
  );
  // Alone this takes 20-70 ms; walking 8,000 years would take minutes, so the bound is loose enough for a loaded box.
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
  const r = splitFollowing(s, '20261027T160000Z');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.before.rrule, 'FREQ=DAILY;UNTIL=20261027T155959Z');
  assert.deepEqual(r.after.start, { local: '2026-10-27T09:00:00', tzid: LA });
  assert.equal(splitFollowing(s, '19700105T170000Z').ok, false);
});
