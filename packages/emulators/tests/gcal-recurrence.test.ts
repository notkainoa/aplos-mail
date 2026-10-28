import assert from 'node:assert/strict';
import test from 'node:test';
import { occurrences, validateRecurrence, type Series } from '../src/gcal';
import { dateOfDay, dayOf, isoInZone } from '../src/gcal/tz';
import { setupCal, timed } from './gcal-helpers';

/** An event as the JSON response carries it. */
interface EventJson {
  [field: string]: unknown;
  id: string;
  summary?: string;
  status?: string;
  recurrence?: string[];
  start: { [field: string]: unknown; date?: string; dateTime?: string };
  end?: { [field: string]: unknown; date?: string; dateTime?: string };
  location?: string;
  recurringEventId?: string;
  originalStartTime?: { [field: string]: unknown; date?: string; dateTime?: string };
}

const ZONE = 'America/Los_Angeles';

/** First `n` occurrences of an all-day series starting on `date`, as local dates. */
function dates(date: string, recurrence: string[], n = 50): string[] {
  const series: Series = {
    allDay: true,
    tz: 'UTC',
    startDay: dayOf(date),
    h: 0,
    mi: 0,
    s: 0,
    recurrence,
  };
  const out: string[] = [];
  for (const occ of occurrences(series)) {
    out.push(dateOfDay(occ.day));
    if (out.length >= n) break;
  }
  return out;
}

/** First `n` occurrences of a timed series in Los Angeles, as local ISO text with offsets. */
function timedSeries(
  startDate: string,
  time: [number, number],
  recurrence: string[],
  n = 20,
): string[] {
  const series: Series = {
    allDay: false,
    tz: ZONE,
    startDay: dayOf(startDate),
    h: time[0],
    mi: time[1],
    s: 0,
    recurrence,
  };
  const out: string[] = [];
  for (const occ of occurrences(series)) {
    out.push(isoInZone(occ.startMs, ZONE));
    if (out.length >= n) break;
  }
  return out;
}

test('daily with INTERVAL and COUNT; weekly with BYDAY, INTERVAL and UNTIL', () => {
  assert.deepEqual(dates('2026-11-02', ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4']), [
    '2026-11-02',
    '2026-11-04',
    '2026-11-06',
    '2026-11-08',
  ]);
  assert.deepEqual(
    dates('2026-11-02', ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;UNTIL=20261120']),
    ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-16', '2026-11-18', '2026-11-20'],
  );
  // A weekly rule with no BYDAY repeats on the start's weekday.
  assert.deepEqual(dates('2026-11-04', ['RRULE:FREQ=WEEKLY;COUNT=3']), [
    '2026-11-04',
    '2026-11-11',
    '2026-11-18',
  ]);
  // The first occurrence is never before the start, even when BYDAY names earlier days of that week.
  assert.deepEqual(dates('2026-11-04', ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3']), [
    '2026-11-04',
    '2026-11-09',
    '2026-11-11',
  ]);
});

test('monthly: ordinal weekdays, last day, 31st skipping short months, and BYSETPOS', () => {
  assert.deepEqual(dates('2026-11-10', ['RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3']), [
    '2026-11-10',
    '2026-12-08',
    '2027-01-12',
  ]);
  assert.deepEqual(dates('2026-11-27', ['RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3']), [
    '2026-11-27',
    '2026-12-25',
    '2027-01-29',
  ]);
  assert.deepEqual(dates('2026-11-30', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4']), [
    '2026-11-30',
    '2026-12-31',
    '2027-01-31',
    '2027-02-28',
  ]);
  assert.deepEqual(dates('2026-12-31', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4']), [
    '2026-12-31',
    '2027-01-31',
    '2027-03-31',
    '2027-05-31',
  ]);
  assert.deepEqual(
    dates('2026-11-30', ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3']),
    ['2026-11-30', '2026-12-31', '2027-01-29'],
  );
  assert.deepEqual(dates('2026-11-15', ['RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;COUNT=3']), [
    '2026-11-15',
    '2027-02-15',
    '2027-05-15',
  ]);
  // Without a day rule a monthly series repeats on the start's day number and skips months without it.
  assert.deepEqual(dates('2026-10-31', ['RRULE:FREQ=MONTHLY;COUNT=3']), [
    '2026-10-31',
    '2026-12-31',
    '2027-01-31',
  ]);
});

test('yearly: same date, leap day, BYMONTH with an ordinal weekday', () => {
  assert.deepEqual(dates('2026-11-27', ['RRULE:FREQ=YEARLY;COUNT=3']), [
    '2026-11-27',
    '2027-11-27',
    '2028-11-27',
  ]);
  assert.deepEqual(dates('2028-02-29', ['RRULE:FREQ=YEARLY;COUNT=3']), [
    '2028-02-29',
    '2032-02-29',
    '2036-02-29',
  ]);
  assert.deepEqual(dates('2026-11-26', ['RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3']), [
    '2026-11-26',
    '2027-11-25',
    '2028-11-23',
  ]);
  assert.deepEqual(dates('2026-03-01', ['RRULE:FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1;COUNT=4']), [
    '2026-03-01',
    '2026-09-01',
    '2027-03-01',
    '2027-09-01',
  ]);
});

test('UNTIL (date or UTC time), EXDATE (counts toward COUNT), and RDATE', () => {
  assert.deepEqual(dates('2026-11-02', ['RRULE:FREQ=DAILY;UNTIL=20261104T235959Z']), [
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
  ]);
  assert.deepEqual(
    dates('2026-11-02', ['RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;VALUE=DATE:20261103']),
    ['2026-11-02', '2026-11-04', '2026-11-05'],
  );
  assert.deepEqual(
    dates('2026-11-02', ['RRULE:FREQ=DAILY;COUNT=2', 'RDATE;VALUE=DATE:20261120,20261110']),
    ['2026-11-02', '2026-11-03', '2026-11-10', '2026-11-20'],
  );
  // Timed series: an EXDATE written in UTC or in the series' own zone names the same occurrence.
  assert.deepEqual(
    timedSeries('2026-11-02', [10, 0], ['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261103T180000Z'], 5),
    ['2026-11-02T10:00:00-08:00', '2026-11-04T10:00:00-08:00'],
  );
  assert.deepEqual(
    timedSeries(
      '2026-11-02',
      [10, 0],
      ['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/Los_Angeles:20261103T100000'],
      5,
    ),
    ['2026-11-02T10:00:00-08:00', '2026-11-04T10:00:00-08:00'],
  );
  assert.deepEqual(
    timedSeries('2026-11-02', [10, 0], ['RRULE:FREQ=DAILY;COUNT=1', 'RDATE:20261110T200000Z'], 5),
    ['2026-11-02T10:00:00-08:00', '2026-11-10T12:00:00-08:00'],
  );
});

test('a series repeats at the same wall-clock time across both DST changes', () => {
  const weekly = timedSeries('2026-10-26', [10, 0], ['RRULE:FREQ=WEEKLY;BYDAY=MO'], 4);
  assert.deepEqual(weekly, [
    '2026-10-26T10:00:00-07:00',
    '2026-11-02T10:00:00-08:00',
    '2026-11-09T10:00:00-08:00',
    '2026-11-16T10:00:00-08:00',
  ]);
  // Spring forward 2027-03-14: 02:30 does not exist and moves to 03:30.
  assert.deepEqual(timedSeries('2027-03-13', [2, 30], ['RRULE:FREQ=DAILY;COUNT=3']), [
    '2027-03-13T02:30:00-08:00',
    '2027-03-14T03:30:00-07:00',
    '2027-03-15T02:30:00-07:00',
  ]);
  // Fall back 2026-11-01: 01:30 happens twice; the first one is used.
  assert.deepEqual(timedSeries('2026-10-31', [1, 30], ['RRULE:FREQ=DAILY;COUNT=3']), [
    '2026-10-31T01:30:00-07:00',
    '2026-11-01T01:30:00-07:00',
    '2026-11-02T01:30:00-08:00',
  ]);
});

test('rules the emulator does not model, and malformed lines, are refused', () => {
  for (const bad of [
    ['RRULE:FREQ=HOURLY'],
    ['RRULE:FREQ=DAILY;BYHOUR=9'],
    ['RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261231'],
    ['RRULE:INTERVAL=2'],
    ['EXRULE:FREQ=DAILY'],
    ['FREQ=DAILY'],
    ['RRULE:FREQ=WEEKLY;BYDAY=XX'],
    ['EXDATE;TZID=Mars/Base:20261103T100000'],
  ]) {
    assert.throws(() => validateRecurrence(bad), Error, bad[0]);
  }
  assert.doesNotThrow(() =>
    validateRecurrence([
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE:20261103T180000Z',
      'RDATE;VALUE=DATE:20261201',
    ]),
  );
  // A rule that can never match ends instead of hanging.
  assert.deepEqual(dates('2026-11-02', ['RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'], 3), []);
});

test('events.instances: DST in the instance ids and times, paging and windows', async () => {
  const t = await setupCal();
  const master = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Planning', '2026-10-26T10:00:00', '2026-10-26T10:30:00', {
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      }),
    })
  ).json;
  assert.equal(master.start.timeZone, ZONE);
  const path = (q: Record<string, string | number> = {}) =>
    `${t.events('primary', master.id)}/instances?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`;
  const r = await t.call(
    path({ timeMin: '2026-10-25T00:00:00-07:00', timeMax: '2026-11-17T00:00:00-08:00' }),
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'calendar#events');
  assert.equal(r.json.nextSyncToken, undefined, 'instances has no sync token');
  assert.deepEqual(
    r.json.items.map((e: EventJson) => [e.id.slice(master.id.length + 1), e.start.dateTime]),
    [
      ['20261026T170000Z', '2026-10-26T10:00:00-07:00'],
      ['20261102T180000Z', '2026-11-02T10:00:00-08:00'],
      ['20261109T180000Z', '2026-11-09T10:00:00-08:00'],
      ['20261116T180000Z', '2026-11-16T10:00:00-08:00'],
    ],
  );
  const second = r.json.items[1];
  assert.equal(second.recurringEventId, master.id);
  assert.deepEqual(second.originalStartTime, second.start);
  assert.equal(second.end.dateTime, '2026-11-02T10:30:00-08:00');
  assert.equal(second.iCalUID, master.iCalUID);
  assert.equal(second.recurrence, undefined);
  // Paging (an open series is bounded by the expansion horizon, two years by default).
  const p1 = await t.call(path({ maxResults: 3 }));
  assert.equal(p1.json.items.length, 3);
  const p2 = await t.call(path({ maxResults: 3, pageToken: p1.json.nextPageToken }));
  assert.equal(p2.json.items[0].start.dateTime, '2026-11-16T10:00:00-08:00');
  // Every instance of the horizon is reachable and reads 10:00 local all year.
  const all = await t.call(path({ maxResults: 2500 }));
  assert.ok(all.json.items.length >= 104);
  assert.ok(all.json.items.every((e: EventJson) => /T10:00:00-0[78]:00$/.test(e.start.dateTime!)));
});

test('events.instances on a bad target: not recurring is 400, unknown is 404', async () => {
  const t = await setupCal();
  const single = t.emu.calendar.addEvent(
    'primary',
    timed('One', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  assert.equal((await t.call(`${t.events('primary', single.id)}/instances`)).status, 400);
  assert.equal((await t.call(`${t.events('primary', 'nosuchevent1')}/instances`)).status, 404);
});

test('singleEvents=true expands masters, shows overrides where they moved to, and drops cancelled instances', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed({ singleEvents: 0, invitations: 0 });
  const start = '2026-10-01T00:00:00-07:00';
  const end = '2026-12-01T00:00:00-08:00';
  const list = async (q: Record<string, string>) =>
    (
      await t.call(
        t.events('primary', undefined, { singleEvents: true, timeMin: start, timeMax: end, ...q }),
      )
    ).json.items as EventJson[];
  const weekly = (await list({})).filter(e => e.recurringEventId === gen.weekly.masterId);
  const ids = weekly.map(e => e.id);
  assert.ok(ids.includes(gen.weekly.overrideId));
  assert.ok(!ids.includes(gen.weekly.cancelledId));
  const moved = weekly.find(e => e.id === gen.weekly.overrideId)!;
  assert.equal(moved.summary, 'Weekly planning sync (moved)');
  assert.match(moved.start.dateTime!, /T11:00:00-0[78]:00$/);
  assert.match(moved.originalStartTime!.dateTime!, /T10:00:00-0[78]:00$/);
  // Chronological, no duplicates.
  const starts = weekly.map(e => Date.parse(e.start.dateTime!));
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
  );
  assert.equal(new Set(ids).size, ids.length);
  // With showDeleted the cancelled one is a stub.
  const withDeleted = (await list({ showDeleted: 'true' })).find(
    e => e.id === gen.weekly.cancelledId,
  )!;
  assert.equal(withDeleted.status, 'cancelled');
  // Without expansion: one master plus the two exceptions.
  const raw = (
    await t.call(t.events('primary', undefined, { showDeleted: true }))
  ).json.items.filter((e: EventJson) => e.id.startsWith(gen.weekly.masterId));
  assert.deepEqual(
    raw.map((e: EventJson) => e.id).sort(),
    [gen.weekly.masterId, gen.weekly.overrideId, gen.weekly.cancelledId].sort(),
  );
  assert.deepEqual(raw.find((e: EventJson) => e.id === gen.weekly.masterId).recurrence, [
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
  ]);
});

test('the master is listed for a window only when the series has an occurrence in it', async () => {
  const t = await setupCal();
  const master = t.emu.calendar.addEvent(
    'primary',
    timed('Monthly review', '2026-11-02T09:00:00', '2026-11-02T10:00:00', {
      recurrence: ['RRULE:FREQ=MONTHLY;COUNT=2'],
    }),
  );
  const inWindow = (
    await t.call(
      t.events('primary', undefined, {
        timeMin: '2026-12-01T00:00:00-08:00',
        timeMax: '2026-12-31T00:00:00-08:00',
      }),
    )
  ).json.items;
  assert.deepEqual(
    inWindow.map((e: EventJson) => e.id),
    [master.id],
  );
  const after = (
    await t.call(
      t.events('primary', undefined, {
        timeMin: '2027-02-01T00:00:00-08:00',
        timeMax: '2027-03-01T00:00:00-08:00',
      }),
    )
  ).json.items;
  assert.deepEqual(after, []);
});

test('all-day recurring events expand by date', async () => {
  const t = await setupCal();
  const master = t.emu.calendar.addEvent('primary', {
    summary: 'Trash day',
    start: { date: '2026-11-02' },
    end: { date: '2026-11-03' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'],
  });
  const items = (await t.call(`${t.events('primary', master.id)}/instances`)).json.items;
  assert.deepEqual(
    items.map((e: EventJson) => [e.id.slice(master.id.length + 1), e.start.date, e.end!.date]),
    [
      ['20261102', '2026-11-02', '2026-11-03'],
      ['20261109', '2026-11-09', '2026-11-10'],
      ['20261116', '2026-11-16', '2026-11-17'],
    ],
  );
  assert.deepEqual(items[0].originalStartTime, { date: '2026-11-02' });
  const one = await t.call(t.events('primary', `${master.id}_20261109`));
  assert.equal(one.status, 200);
  assert.equal(one.json.start.date, '2026-11-09');
});

test('a recurring timed event needs a time zone on its start', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: {
      summary: 'x',
      start: { dateTime: '2026-11-02T09:00:00-08:00' },
      end: { dateTime: '2026-11-02T10:00:00-08:00' },
      recurrence: ['RRULE:FREQ=DAILY'],
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.message, 'Missing time zone definition for start time.');
});

test('incremental sync keeps the shape of the first request: expanded instances for a changed master', async () => {
  const t = await setupCal();
  const master = t.emu.calendar.addEvent(
    'primary',
    timed('Standup', '2026-11-02T09:00:00', '2026-11-02T09:15:00', {
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'],
    }),
  );
  const window = {
    singleEvents: true,
    timeMin: '2026-10-01T00:00:00-07:00',
    timeMax: '2027-01-01T00:00:00-08:00',
  };
  const first = await t.call(t.events('primary', undefined, window));
  assert.equal(first.json.items.length, 3);
  const token = first.json.nextSyncToken;
  // Changing the master re-sends its instances; editing one occurrence sends just that exception.
  t.emu.calendar.editEvent('primary', master.id, { summary: 'Standup v2' });
  const changed = (
    await t.call(t.events('primary', undefined, { singleEvents: true, syncToken: token }))
  ).json;
  assert.deepEqual(
    changed.items.map((e: EventJson) => e.summary),
    ['Standup v2', 'Standup v2', 'Standup v2'],
  );
  assert.ok(
    changed.items.every((e: EventJson) => e.recurringEventId === master.id && !e.recurrence),
  );
  t.emu.calendar.editEvent('primary', `${master.id}_20261109T170000Z`, { location: 'Room 1' });
  const afterEdit = (
    await t.call(
      t.events('primary', undefined, { singleEvents: true, syncToken: changed.nextSyncToken }),
    )
  ).json;
  assert.deepEqual(
    afterEdit.items.map((e: EventJson) => [e.id.slice(master.id.length + 1), e.location]),
    [['20261109T170000Z', 'Room 1']],
  );
  // Deleting the series sends the cancelled master (and its cancelled exception).
  t.emu.calendar.removeEvent('primary', master.id);
  const gone = (
    await t.call(
      t.events('primary', undefined, { singleEvents: true, syncToken: afterEdit.nextSyncToken }),
    )
  ).json.items;
  assert.deepEqual(
    gone.map((e: EventJson) => [e.id, e.status]).sort(),
    [
      [master.id, 'cancelled'],
      [`${master.id}_20261109T170000Z`, 'cancelled'],
    ].sort(),
  );
});
