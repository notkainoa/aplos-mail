/**
 * Golden corpus INPUTS (hand-written). Expected outputs are never written here: generate.ts runs
 * both oracles over these inputs and records only what they agree on.
 */

export type EventTime = { utc: number } | { date: string } | { local: string; tzid?: string };

export interface CaseOverride {
  recurrenceId: string | EventTime;
  start?: EventTime;
  end?: EventTime;
  cancelled?: boolean;
}

export interface CaseEvent {
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  tzid?: string;
  rrule?: string;
  rdate?: string[];
  exdate?: string[];
  overrides?: CaseOverride[];
}

export interface Case {
  id: string;
  tags: string[];
  note?: string;
  /** Input intent only: the case exercises a refusal. The refusal kind still comes from the oracles. */
  refusal?: true;
  event: CaseEvent;
  /** ISO instants; occurrences overlapping [from, to) are expected. */
  range: { from: string; to: string };
  limit?: number;
}

const LA = 'America/Los_Angeles';
const LON = 'Europe/London';
const SYD = 'Australia/Sydney';
const NY = 'America/New_York';
const TYO = 'Asia/Tokyo';

const RANGE = { from: '2026-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' };

function addWall(local: string, minutes: number): string {
  const ms = Date.parse(`${local}Z`) + minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 19);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type Extra = Partial<Omit<Case, 'id' | 'tags' | 'event'>> &
  Partial<Pick<CaseEvent, 'rdate' | 'exdate' | 'overrides' | 'tzid'>>;

function split(extra: Extra): { event: Partial<CaseEvent>; rest: Partial<Case> } {
  const { rdate, exdate, overrides, tzid, ...rest } = extra;
  const event: Partial<CaseEvent> = {};
  if (rdate) event.rdate = rdate;
  if (exdate) event.exdate = exdate;
  if (overrides) event.overrides = overrides;
  if (tzid) event.tzid = tzid;
  return { event, rest };
}

/** A zoned event: wall clock `local` in `tz`, lasting `minutes`. */
function zoned(
  id: string,
  tags: string[],
  tz: string,
  local: string,
  minutes: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { local, tzid: tz },
      end: { local: addWall(local, minutes), tzid: tz },
      allDay: false,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

function floating(
  id: string,
  tags: string[],
  local: string,
  minutes: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { local },
      end: { local: addWall(local, minutes) },
      allDay: false,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

function allDay(
  id: string,
  tags: string[],
  date: string,
  days: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { date },
      end: { date: addDays(date, days) },
      allDay: true,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

const at = (local: string, tz: string): EventTime => ({ local, tzid: tz });

export const cases: Case[] = [
  // ---------- basics ----------
  zoned(
    'basic-daily-count',
    ['basic', 'count'],
    LA,
    '2026-01-05T09:00:00',
    60,
    'FREQ=DAILY;COUNT=10',
  ),
  zoned(
    'basic-daily-interval-3-utc',
    ['basic', 'interval'],
    'UTC',
    '2026-01-05T07:15:00',
    30,
    'FREQ=DAILY;INTERVAL=3;COUNT=12',
  ),
  zoned(
    'basic-weekly-mwf',
    ['basic', 'weekly'],
    NY,
    '2026-02-02T08:30:00',
    45,
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=15',
  ),
  zoned(
    'basic-weekly-default-day-until',
    ['basic', 'weekly', 'until'],
    LA,
    '2026-01-07T14:00:00',
    60,
    'FREQ=WEEKLY;UNTIL=20260401T000000Z',
  ),
  zoned(
    'basic-monthly-default-mday',
    ['basic', 'monthly'],
    LON,
    '2026-01-15T10:00:00',
    60,
    'FREQ=MONTHLY;COUNT=12',
  ),
  zoned(
    'basic-monthly-mday-list',
    ['basic', 'monthly', 'bymonthday'],
    TYO,
    '2026-01-01T12:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=10',
  ),
  zoned(
    'basic-yearly-default',
    ['basic', 'yearly'],
    LA,
    '2026-06-15T18:00:00',
    120,
    'FREQ=YEARLY;COUNT=5',
    { range: { from: '2026-01-01T00:00:00Z', to: '2033-01-01T00:00:00Z' } },
  ),
  {
    id: 'basic-start-instant-with-zone',
    tags: ['basic', 'dst-la', 'utc-start'],
    range: RANGE,
    event: {
      start: { utc: Date.UTC(2026, 1, 24, 17, 0) },
      end: { utc: Date.UTC(2026, 1, 24, 18, 0) },
      tzid: LA,
      allDay: false,
      rrule: 'FREQ=WEEKLY;COUNT=6',
    },
  },
  {
    id: 'basic-start-instant-no-zone',
    tags: ['basic', 'utc-start'],
    range: RANGE,
    event: {
      start: { utc: Date.UTC(2026, 2, 6, 23, 30) },
      end: { utc: Date.UTC(2026, 2, 7, 0, 30) },
      allDay: false,
      rrule: 'FREQ=DAILY;COUNT=5',
    },
  },
  zoned('basic-single-no-rule', ['basic'], LON, '2026-05-01T09:00:00', 60, undefined),
  zoned(
    'basic-weekly-interval-2',
    ['basic', 'interval'],
    SYD,
    '2026-01-06T07:00:00',
    30,
    'FREQ=WEEKLY;INTERVAL=2;COUNT=8',
  ),
  zoned('basic-daily-infinite', ['basic'], NY, '2026-11-20T06:00:00', 30, 'FREQ=DAILY', {
    range: { from: '2026-12-01T00:00:00Z', to: '2026-12-15T00:00:00Z' },
  }),

  // ---------- DST: America/Los_Angeles ----------
  zoned('la-weekly-0900-spring', ['dst-la'], LA, '2026-02-22T09:00:00', 60, 'FREQ=WEEKLY;COUNT=6'),
  zoned(
    'la-daily-0230-gap',
    ['dst-la', 'gap'],
    LA,
    '2026-03-05T02:30:00',
    60,
    'FREQ=DAILY;COUNT=6',
  ),
  zoned(
    'la-daily-0130-fallback',
    ['dst-la', 'ambiguous'],
    LA,
    '2026-10-29T01:30:00',
    30,
    'FREQ=DAILY;COUNT=6',
  ),
  zoned(
    'la-dtstart-in-gap',
    ['dst-la', 'gap'],
    LA,
    '2026-03-08T02:30:00',
    60,
    'FREQ=WEEKLY;COUNT=3',
  ),
  zoned(
    'la-monthly-2su-0230',
    ['dst-la', 'gap', 'ordinal'],
    LA,
    '2026-01-11T02:30:00',
    60,
    'FREQ=MONTHLY;BYDAY=2SU;COUNT=6',
  ),
  zoned(
    'la-monthly-1su-0130',
    ['dst-la', 'ambiguous', 'ordinal'],
    LA,
    '2026-10-04T01:30:00',
    60,
    'FREQ=MONTHLY;BYDAY=1SU;COUNT=3',
  ),
  zoned(
    'la-until-utc-inclusive',
    ['dst-la', 'until'],
    LA,
    '2026-03-01T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260310T160000Z',
  ),
  zoned(
    'la-until-utc-exclusive',
    ['dst-la', 'until'],
    LA,
    '2026-03-01T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260310T155959Z',
  ),
  zoned(
    'la-yearly-2su-march-gap',
    ['dst-la', 'gap', 'ordinal', 'yearly'],
    LA,
    '2026-03-08T02:15:00',
    30,
    'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;COUNT=4',
    { range: { from: '2026-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' } },
  ),
  zoned(
    'la-weekly-sunday-late-all-year',
    ['dst-la'],
    LA,
    '2026-01-04T23:30:00',
    60,
    'FREQ=WEEKLY;BYDAY=SU;UNTIL=20261231T000000Z',
  ),
  zoned(
    'la-long-duration-across-dst',
    ['dst-la', 'duration'],
    LA,
    '2026-03-07T22:00:00',
    360,
    'FREQ=DAILY;COUNT=3',
  ),
  zoned(
    'la-byhour-fallback',
    ['dst-la', 'ambiguous', 'byhour'],
    LA,
    '2026-10-31T00:00:00',
    15,
    'FREQ=DAILY;BYHOUR=0,1,2,3;COUNT=12',
  ),

  // ---------- DST: Europe/London ----------
  zoned('lon-weekly-spring', ['dst-london'], LON, '2026-03-15T09:00:00', 60, 'FREQ=WEEKLY;COUNT=4'),
  zoned(
    'lon-daily-0130-gap',
    ['dst-london', 'gap'],
    LON,
    '2026-03-27T01:30:00',
    30,
    'FREQ=DAILY;COUNT=4',
  ),
  zoned(
    'lon-daily-0130-fallback',
    ['dst-london', 'ambiguous'],
    LON,
    '2026-10-23T01:30:00',
    30,
    'FREQ=DAILY;COUNT=4',
  ),
  zoned(
    'lon-monthly-last-sunday-0130',
    ['dst-london', 'gap', 'ambiguous', 'ordinal'],
    LON,
    '2026-01-25T01:30:00',
    30,
    'FREQ=MONTHLY;BYDAY=-1SU;COUNT=12',
  ),
  zoned(
    'lon-exdate-tzid',
    ['dst-london', 'exdate'],
    LON,
    '2026-10-20T09:00:00',
    60,
    'FREQ=DAILY;COUNT=10',
    { exdate: ['EXDATE;TZID=Europe/London:20261025T090000,20261027T090000'] },
  ),
  zoned(
    'lon-yearly-last-sunday-october',
    ['dst-london', 'ambiguous', 'yearly', 'ordinal'],
    LON,
    '2026-10-25T01:30:00',
    60,
    'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;COUNT=4',
    { range: { from: '2026-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' } },
  ),
  zoned(
    'lon-weekly-autumn-evening',
    ['dst-london'],
    LON,
    '2026-10-11T18:00:00',
    90,
    'FREQ=WEEKLY;BYDAY=SU,WE;COUNT=6',
  ),

  // ---------- DST: Australia/Sydney (southern hemisphere) ----------
  zoned(
    'syd-weekly-april-fallback',
    ['dst-sydney'],
    SYD,
    '2026-03-22T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
  ),
  zoned(
    'syd-daily-0230-gap-october',
    ['dst-sydney', 'gap'],
    SYD,
    '2026-10-01T02:30:00',
    60,
    'FREQ=DAILY;COUNT=6',
  ),
  zoned(
    'syd-daily-0230-ambiguous-april',
    ['dst-sydney', 'ambiguous'],
    SYD,
    '2026-04-02T02:30:00',
    30,
    'FREQ=DAILY;COUNT=5',
  ),
  zoned(
    'syd-monthly-1su-0230',
    ['dst-sydney', 'gap', 'ambiguous', 'ordinal'],
    SYD,
    '2026-01-04T02:30:00',
    30,
    'FREQ=MONTHLY;BYDAY=1SU;COUNT=12',
  ),
  zoned(
    'syd-exdate-tzid',
    ['dst-sydney', 'exdate'],
    SYD,
    '2026-09-27T08:00:00',
    60,
    'FREQ=WEEKLY;COUNT=5',
    { exdate: ['EXDATE;TZID=Australia/Sydney:20261004T080000'] },
  ),
  zoned(
    'syd-until-utc-inclusive',
    ['dst-sydney', 'until'],
    SYD,
    '2026-09-28T18:00:00',
    60,
    'FREQ=DAILY;UNTIL=20261005T070000Z',
  ),
  allDay(
    'syd-allday-weekly-across-dst',
    ['dst-sydney', 'all-day'],
    '2026-03-29',
    1,
    'FREQ=WEEKLY;COUNT=4',
    { tzid: SYD },
  ),

  // ---------- ordinal BYDAY ----------
  zoned(
    'ordinal-monthly-last-friday',
    ['ordinal'],
    NY,
    '2026-01-30T16:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=-1FR;COUNT=12',
  ),
  zoned(
    'ordinal-monthly-2tu',
    ['ordinal'],
    LA,
    '2026-01-13T10:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=2TU;COUNT=12',
  ),
  zoned(
    'ordinal-monthly-first-and-last-monday',
    ['ordinal'],
    LON,
    '2026-01-05T09:00:00',
    30,
    'FREQ=MONTHLY;BYDAY=1MO,-1MO;COUNT=10',
  ),
  zoned(
    'ordinal-yearly-thanksgiving',
    ['ordinal', 'yearly'],
    NY,
    '2026-11-26T15:00:00',
    180,
    'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=6',
    { range: { from: '2026-01-01T00:00:00Z', to: '2033-01-01T00:00:00Z' } },
  ),
  zoned(
    'ordinal-monthly-fifth-friday',
    ['ordinal'],
    LA,
    '2026-01-30T12:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=5FR;UNTIL=20271231T235959Z',
  ),
  zoned(
    'ordinal-monthly-second-last-wednesday',
    ['ordinal'],
    SYD,
    '2026-01-21T10:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=-2WE;COUNT=8',
  ),
  zoned(
    'ordinal-monthly-interval-2-first-saturday',
    ['ordinal', 'interval'],
    LON,
    '2026-01-03T11:00:00',
    120,
    'FREQ=MONTHLY;INTERVAL=2;BYDAY=1SA;COUNT=6',
  ),
  zoned(
    'ordinal-yearly-first-monday-jan-jul',
    ['ordinal', 'yearly'],
    NY,
    '2026-01-05T09:00:00',
    60,
    'FREQ=YEARLY;BYMONTH=1,7;BYDAY=1MO;COUNT=6',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),
  zoned(
    'ordinal-monthly-plain-tu-th',
    ['byday'],
    NY,
    '2026-01-01T17:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=TU,TH;COUNT=20',
  ),
  zoned(
    'ordinal-yearly-20th-monday',
    ['ordinal', 'yearly', 'disputed'],
    LA,
    '2026-05-18T09:00:00',
    60,
    'FREQ=YEARLY;BYDAY=20MO;COUNT=3',
    {
      range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
      note: 'RFC: the 20th Monday of the year (no BYMONTH)',
    },
  ),
  zoned(
    'ordinal-yearly-last-sunday-december-start',
    ['ordinal', 'yearly'],
    LON,
    '2026-12-27T10:00:00',
    60,
    'FREQ=YEARLY;BYDAY=-1SU;COUNT=3',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),
  zoned(
    'ordinal-yearly-last-sunday-june-start',
    ['ordinal', 'yearly', 'disputed', 'dtstart'],
    LON,
    '2026-06-28T10:00:00',
    60,
    'FREQ=YEARLY;BYDAY=-1SU;COUNT=3',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),

  // ---------- BYSETPOS ----------
  zoned(
    'setpos-last-weekday',
    ['bysetpos'],
    NY,
    '2026-01-30T17:00:00',
    30,
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=12',
  ),
  zoned(
    'setpos-first-weekday',
    ['bysetpos'],
    LON,
    '2026-01-01T09:00:00',
    30,
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;COUNT=12',
  ),
  zoned(
    'setpos-second-last-weekday',
    ['bysetpos'],
    LA,
    '2026-01-29T09:00:00',
    30,
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2;COUNT=12',
  ),
  zoned(
    'setpos-first-and-last-weekend-day',
    ['bysetpos'],
    SYD,
    '2026-01-03T10:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1,-1;COUNT=10',
  ),
  zoned(
    'setpos-monthdays-last',
    ['bysetpos', 'bymonthday'],
    LA,
    '2026-01-30T09:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=10,20,30;BYSETPOS=-1;COUNT=8',
  ),
  zoned(
    'setpos-yearly-last-weekday-march',
    ['bysetpos', 'yearly'],
    LON,
    '2026-03-31T16:00:00',
    60,
    'FREQ=YEARLY;BYMONTH=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4',
    { range: { from: '2026-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' } },
  ),
  zoned(
    'setpos-weekly-last-of-week',
    ['bysetpos', 'disputed'],
    NY,
    '2026-01-05T09:00:00',
    30,
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYSETPOS=-1;COUNT=6',
  ),
  zoned(
    'setpos-yearly-across-months',
    ['bysetpos', 'yearly', 'disputed'],
    NY,
    '2026-01-05T09:00:00',
    30,
    'FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO;BYSETPOS=1;COUNT=3',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),
  zoned(
    'setpos-monthly-third-tue-wed-thu',
    ['bysetpos'],
    LA,
    '2026-01-01T10:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=TU,WE,TH;BYSETPOS=3;COUNT=6',
  ),

  // ---------- BYMONTHDAY ----------
  zoned(
    'mday-31',
    ['bymonthday'],
    LA,
    '2026-01-31T09:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=7',
  ),
  zoned('mday-default-31', ['bymonthday'], LON, '2026-01-31T09:00:00', 60, 'FREQ=MONTHLY;COUNT=7'),
  zoned(
    'mday-minus-1-across-leap',
    ['bymonthday', 'leap'],
    NY,
    '2027-11-30T18:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6',
    { range: { from: '2027-01-01T00:00:00Z', to: '2029-01-01T00:00:00Z' } },
  ),
  zoned(
    'mday-minus-3',
    ['bymonthday'],
    SYD,
    '2026-01-29T09:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=-3;COUNT=8',
  ),
  zoned(
    'mday-friday-13th',
    ['bymonthday', 'byday'],
    LA,
    '2026-02-13T09:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=5',
    { range: { from: '2026-01-01T00:00:00Z', to: '2032-01-01T00:00:00Z' } },
  ),
  zoned(
    'mday-30-skips-february',
    ['bymonthday'],
    NY,
    '2026-01-30T09:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=30;COUNT=6',
  ),
  zoned(
    'mday-daily-first-and-last',
    ['bymonthday', 'daily'],
    LON,
    '2026-01-01T08:00:00',
    30,
    'FREQ=DAILY;BYMONTHDAY=1,-1;COUNT=8',
  ),
  zoned(
    'mday-yearly-last-of-feb-and-aug',
    ['bymonthday', 'leap', 'yearly'],
    LA,
    '2026-02-28T09:00:00',
    60,
    'FREQ=YEARLY;BYMONTH=2,8;BYMONTHDAY=-1;COUNT=6',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),
  zoned(
    'mday-yearly-no-bymonth',
    ['bymonthday', 'yearly', 'disputed'],
    NY,
    '2026-01-15T09:00:00',
    60,
    'FREQ=YEARLY;BYMONTHDAY=15;COUNT=4',
  ),

  // ---------- leap day ----------
  zoned(
    'leap-yearly-feb-29',
    ['leap', 'yearly'],
    LA,
    '2024-02-29T09:00:00',
    60,
    'FREQ=YEARLY;COUNT=3',
    { range: { from: '2024-01-01T00:00:00Z', to: '2037-01-01T00:00:00Z' } },
  ),
  zoned(
    'leap-yearly-feb-29-until',
    ['leap', 'yearly', 'until'],
    LON,
    '2024-02-29T12:00:00',
    60,
    'FREQ=YEARLY;UNTIL=20400101T000000Z',
    { range: { from: '2024-01-01T00:00:00Z', to: '2041-01-01T00:00:00Z' } },
  ),
  zoned(
    'leap-monthly-29th',
    ['leap', 'monthly'],
    NY,
    '2027-12-29T09:00:00',
    60,
    'FREQ=MONTHLY;COUNT=6',
    { range: { from: '2027-01-01T00:00:00Z', to: '2029-01-01T00:00:00Z' } },
  ),
  zoned(
    'leap-yearly-last-day-of-february',
    ['leap', 'yearly'],
    SYD,
    '2026-02-28T09:00:00',
    60,
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1;COUNT=6',
    { range: { from: '2026-01-01T00:00:00Z', to: '2033-01-01T00:00:00Z' } },
  ),
  allDay(
    'leap-allday-feb-29',
    ['leap', 'all-day', 'yearly'],
    '2028-02-29',
    1,
    'FREQ=YEARLY;COUNT=2',
    { range: { from: '2028-01-01T00:00:00Z', to: '2034-01-01T00:00:00Z' } },
  ),

  // ---------- WKST ----------
  zoned(
    'wkst-mo-interval-2-tu-su',
    ['wkst', 'interval'],
    NY,
    '2026-08-04T09:00:00',
    60,
    'FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=TU,SU;WKST=MO',
  ),
  zoned(
    'wkst-su-interval-2-tu-su',
    ['wkst', 'interval'],
    NY,
    '2026-08-04T09:00:00',
    60,
    'FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=TU,SU;WKST=SU',
  ),
  zoned(
    'wkst-sa-interval-2-sa-mo',
    ['wkst', 'interval'],
    LON,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,MO;WKST=SA;COUNT=8',
  ),
  zoned(
    'wkst-th-interval-3',
    ['wkst', 'interval'],
    LA,
    '2026-01-05T09:00:00',
    60,
    'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH,SU;WKST=TH;COUNT=9',
  ),
  zoned(
    'wkst-default-interval-2-su-mo',
    ['wkst', 'interval'],
    SYD,
    '2026-02-01T09:00:00',
    60,
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;COUNT=8',
  ),

  // ---------- COUNT vs UNTIL ----------
  zoned('count-weekly-10', ['count'], LON, '2026-04-06T09:00:00', 60, 'FREQ=WEEKLY;COUNT=10'),
  zoned(
    'until-on-an-instance',
    ['until'],
    'UTC',
    '2026-02-01T10:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260207T100000Z',
  ),
  zoned(
    'until-between-instances',
    ['until'],
    NY,
    '2026-02-01T10:00:00',
    60,
    'FREQ=WEEKLY;UNTIL=20260220T000000Z',
  ),
  zoned(
    'until-before-start',
    ['until'],
    NY,
    '2026-02-01T10:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260101T000000Z',
  ),
  zoned(
    'count-with-exdate',
    ['count', 'exdate'],
    LA,
    '2026-02-02T09:00:00',
    60,
    'FREQ=DAILY;COUNT=5',
    { exdate: ['EXDATE;TZID=America/Los_Angeles:20260203T090000'] },
  ),
  zoned(
    'until-with-rdate-after',
    ['until', 'rdate'],
    LA,
    '2026-02-02T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260205T170000Z',
    { rdate: ['RDATE;TZID=America/Los_Angeles:20260210T090000'] },
  ),
  zoned('count-1', ['count'], LON, '2026-02-02T09:00:00', 60, 'FREQ=WEEKLY;COUNT=1'),

  // ---------- all-day ----------
  allDay(
    'allday-daily-across-la-dst',
    ['all-day', 'dst-la'],
    '2026-03-06',
    1,
    'FREQ=DAILY;COUNT=5',
    { tzid: LA },
  ),
  allDay(
    'allday-weekly-until-date-inclusive',
    ['all-day', 'until', 'until-date'],
    '2026-04-02',
    1,
    'FREQ=WEEKLY;UNTIL=20260430',
  ),
  allDay(
    'allday-weekly-until-date-between',
    ['all-day', 'until', 'until-date'],
    '2026-04-02',
    1,
    'FREQ=WEEKLY;UNTIL=20260428',
  ),
  allDay(
    'allday-monthly-last-day',
    ['all-day', 'bymonthday'],
    '2026-01-31',
    1,
    'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6',
  ),
  allDay('allday-yearly-birthday', ['all-day', 'yearly'], '2026-07-04', 1, 'FREQ=YEARLY;COUNT=4', {
    range: { from: '2026-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' },
  }),
  allDay(
    'allday-multiday-biweekly',
    ['all-day', 'interval'],
    '2026-05-01',
    3,
    'FREQ=WEEKLY;INTERVAL=2;COUNT=4',
  ),
  allDay('allday-exdate', ['all-day', 'exdate'], '2026-03-16', 1, 'FREQ=DAILY;COUNT=7', {
    exdate: ['EXDATE;VALUE=DATE:20260318,20260320'],
  }),
  allDay('allday-override-moved', ['all-day', 'override'], '2026-06-01', 1, 'FREQ=WEEKLY;COUNT=4', {
    overrides: [
      {
        recurrenceId: { date: '2026-06-08' },
        start: { date: '2026-06-10' },
        end: { date: '2026-06-11' },
      },
    ],
  }),
  allDay(
    'allday-london-across-dst',
    ['all-day', 'dst-london'],
    '2026-10-23',
    1,
    'FREQ=DAILY;COUNT=4',
    { tzid: LON },
  ),

  // ---------- overrides ----------
  zoned(
    'override-moved-same-day',
    ['override'],
    LA,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
    {
      overrides: [
        {
          recurrenceId: '20260209T170000Z',
          start: at('2026-02-09T11:00:00', LA),
          end: at('2026-02-09T12:00:00', LA),
        },
      ],
    },
  ),
  zoned(
    'override-moved-another-day',
    ['override', 'moved-day'],
    LON,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
    {
      overrides: [
        {
          recurrenceId: '20260209T090000Z',
          start: at('2026-02-12T15:00:00', LON),
          end: at('2026-02-12T16:00:00', LON),
        },
      ],
    },
  ),
  zoned(
    'override-moved-into-range',
    ['override', 'moved-day'],
    NY,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=10',
    {
      range: { from: '2026-02-01T00:00:00Z', to: '2026-02-15T00:00:00Z' },
      overrides: [
        {
          recurrenceId: '20260302T140000Z',
          start: at('2026-02-11T09:00:00', NY),
          end: at('2026-02-11T10:00:00', NY),
        },
      ],
    },
  ),
  zoned(
    'override-moved-out-of-range',
    ['override', 'moved-day'],
    NY,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=10',
    {
      range: { from: '2026-02-01T00:00:00Z', to: '2026-02-15T00:00:00Z' },
      overrides: [
        {
          recurrenceId: '20260209T140000Z',
          start: at('2026-03-20T09:00:00', NY),
          end: at('2026-03-20T10:00:00', NY),
        },
      ],
    },
  ),
  zoned(
    'override-cancelled',
    ['override', 'cancelled'],
    SYD,
    '2026-02-02T09:00:00',
    60,
    'FREQ=DAILY;COUNT=5',
    {
      overrides: [{ recurrenceId: at('2026-02-04T09:00:00', SYD), cancelled: true }],
    },
  ),
  zoned('override-end-only', ['override'], LA, '2026-02-02T09:00:00', 60, 'FREQ=DAILY;COUNT=4', {
    overrides: [{ recurrenceId: '20260203T170000Z', end: at('2026-02-03T12:00:00', LA) }],
  }),
  zoned(
    'override-start-only-keeps-duration',
    ['override'],
    LA,
    '2026-02-02T09:00:00',
    45,
    'FREQ=DAILY;COUNT=4',
    {
      overrides: [{ recurrenceId: '20260204T170000Z', start: at('2026-02-04T13:00:00', LA) }],
    },
  ),
  zoned(
    'override-orphan-ignored',
    ['override'],
    LON,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
    {
      overrides: [
        {
          recurrenceId: '20260210T090000Z',
          start: at('2026-02-10T12:00:00', LON),
          end: at('2026-02-10T13:00:00', LON),
        },
      ],
    },
  ),
  zoned(
    'override-on-rdate',
    ['override', 'rdate'],
    LA,
    '2026-02-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=3',
    {
      rdate: ['RDATE;TZID=America/Los_Angeles:20260205T150000'],
      overrides: [
        {
          recurrenceId: at('2026-02-05T15:00:00', LA),
          start: at('2026-02-05T16:00:00', LA),
          end: at('2026-02-05T17:30:00', LA),
        },
      ],
    },
  ),
  zoned(
    'override-cancel-and-move',
    ['override', 'cancelled', 'moved-day'],
    NY,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=8',
    {
      overrides: [
        { recurrenceId: '20260305T140000Z', cancelled: true },
        {
          recurrenceId: '20260309T130000Z',
          start: at('2026-03-10T09:00:00', NY),
          end: at('2026-03-10T10:00:00', NY),
        },
      ],
    },
  ),
  zoned(
    'override-at-dst-change',
    ['override', 'dst-london'],
    LON,
    '2026-03-22T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=3',
    {
      overrides: [
        {
          recurrenceId: at('2026-03-29T09:00:00', LON),
          start: at('2026-03-29T08:00:00', LON),
          end: at('2026-03-29T08:30:00', LON),
        },
      ],
    },
  ),
  zoned('override-utc-start', ['override'], SYD, '2026-05-04T09:00:00', 60, 'FREQ=WEEKLY;COUNT=3', {
    overrides: [
      {
        recurrenceId: '20260510T230000Z',
        start: { utc: Date.UTC(2026, 4, 11, 1, 0) },
        end: { utc: Date.UTC(2026, 4, 11, 2, 0) },
      },
    ],
  }),

  // ---------- EXDATE ----------
  zoned('exdate-utc-form', ['exdate'], LA, '2026-03-02T09:00:00', 60, 'FREQ=DAILY;COUNT=12', {
    exdate: ['EXDATE:20260310T160000Z'],
  }),
  zoned(
    'exdate-first-instance',
    ['exdate'],
    LON,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
    { exdate: ['EXDATE;TZID=Europe/London:20260302T090000'] },
  ),
  zoned('exdate-other-zone', ['exdate'], NY, '2026-03-02T09:00:00', 60, 'FREQ=WEEKLY;COUNT=4', {
    exdate: ['EXDATE;TZID=Europe/London:20260316T130000'],
  }),
  zoned(
    'exdate-matches-nothing',
    ['exdate'],
    NY,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
    { exdate: ['EXDATE;TZID=America/New_York:20260316T100000'] },
  ),
  zoned('exdate-two-lines', ['exdate'], SYD, '2026-03-30T18:00:00', 60, 'FREQ=DAILY;COUNT=10', {
    exdate: ['EXDATE;TZID=Australia/Sydney:20260404T180000', 'EXDATE:20260405T080000Z'],
  }),

  // ---------- RDATE ----------
  zoned('rdate-zoned', ['rdate'], LA, '2026-03-02T09:00:00', 60, 'FREQ=WEEKLY;COUNT=3', {
    rdate: ['RDATE;TZID=America/Los_Angeles:20260304T150000'],
  }),
  zoned('rdate-utc', ['rdate'], LON, '2026-03-02T09:00:00', 60, 'FREQ=WEEKLY;COUNT=3', {
    rdate: ['RDATE:20260311T120000Z'],
  }),
  zoned(
    'rdate-duplicate-of-rule',
    ['rdate'],
    NY,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=3',
    { rdate: ['RDATE;TZID=America/New_York:20260309T090000'] },
  ),
  zoned('rdate-before-dtstart', ['rdate'], SYD, '2026-03-02T09:00:00', 60, 'FREQ=WEEKLY;COUNT=3', {
    rdate: ['RDATE;TZID=Australia/Sydney:20260225T090000'],
  }),
  zoned(
    'rdate-also-excluded',
    ['rdate', 'exdate'],
    LA,
    '2026-03-02T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=3',
    {
      rdate: ['RDATE;TZID=America/Los_Angeles:20260304T090000'],
      exdate: ['EXDATE;TZID=America/Los_Angeles:20260304T090000'],
    },
  ),
  zoned('rdate-without-rule', ['rdate'], LON, '2026-03-02T09:00:00', 60, undefined, {
    rdate: ['RDATE;TZID=Europe/London:20260401T090000,20260501T090000'],
  }),

  // ---------- floating ----------
  floating('floating-daily', ['floating'], '2026-03-06T09:00:00', 60, 'FREQ=DAILY;COUNT=5'),
  floating(
    'floating-weekly-0230-no-shift',
    ['floating', 'gap'],
    '2026-03-01T02:30:00',
    60,
    'FREQ=WEEKLY;COUNT=4',
  ),
  floating(
    'floating-until-local',
    ['floating', 'until'],
    '2026-03-10T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260320T090000',
  ),
  floating(
    'floating-monthly-last-friday',
    ['floating', 'ordinal'],
    '2026-01-30T17:00:00',
    60,
    'FREQ=MONTHLY;BYDAY=-1FR;COUNT=6',
  ),
  floating(
    'floating-exdate',
    ['floating', 'exdate'],
    '2026-03-06T09:00:00',
    60,
    'FREQ=DAILY;COUNT=5',
    { exdate: ['EXDATE:20260308T090000'] },
  ),
  floating(
    'floating-override',
    ['floating', 'override'],
    '2026-03-06T09:00:00',
    60,
    'FREQ=DAILY;COUNT=3',
    {
      overrides: [
        {
          recurrenceId: '20260307T090000',
          start: { local: '2026-03-07T10:30:00' },
          end: { local: '2026-03-07T11:00:00' },
        },
      ],
    },
  ),

  // ---------- parts only oracle A (dateutil) knows ----------
  zoned(
    'a-only-yearly-byyearday',
    ['byyearday', 'yearly'],
    LON,
    '2026-01-01T09:00:00',
    60,
    'FREQ=YEARLY;BYYEARDAY=1,100,-1;COUNT=9',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),
  zoned(
    'a-only-yearly-byweekno-20',
    ['byweekno', 'yearly'],
    NY,
    '2026-05-11T09:00:00',
    60,
    'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=4',
    { range: { from: '2026-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' } },
  ),
  zoned(
    'a-only-yearly-byweekno-1-wkst-su',
    ['byweekno', 'wkst', 'yearly'],
    LA,
    '2026-01-01T09:00:00',
    60,
    'FREQ=YEARLY;BYWEEKNO=1;BYDAY=TH;WKST=SU;COUNT=5',
    { range: { from: '2025-12-01T00:00:00Z', to: '2032-01-01T00:00:00Z' } },
  ),
  zoned(
    'a-only-yearly-byweekno-53',
    ['byweekno', 'yearly'],
    LON,
    '2026-12-28T09:00:00',
    60,
    'FREQ=YEARLY;BYWEEKNO=53;BYDAY=MO;COUNT=2',
    { range: { from: '2026-01-01T00:00:00Z', to: '2040-01-01T00:00:00Z' } },
  ),
  zoned(
    'a-only-daily-byhour-byminute',
    ['byhour'],
    LA,
    '2026-03-06T09:00:00',
    15,
    'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30;COUNT=12',
  ),
  zoned(
    'a-only-monthly-byhour-setpos',
    ['byhour', 'bysetpos'],
    NY,
    '2026-01-05T08:00:00',
    30,
    'FREQ=MONTHLY;BYDAY=MO;BYHOUR=8,12;BYSETPOS=-1;COUNT=4',
  ),
  zoned(
    'a-only-yearly-last-day-of-year',
    ['byyearday', 'yearly'],
    SYD,
    '2026-12-31T20:00:00',
    60,
    'FREQ=YEARLY;BYYEARDAY=-1;COUNT=3',
    { range: { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } },
  ),

  // ---------- lenient UNTIL forms only oracle B accepts ----------
  zoned(
    'b-only-timed-until-date',
    ['until', 'until-date'],
    LA,
    '2026-03-05T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260310',
    {
      note: 'RFC 5545 says UNTIL must match DTSTART; Google writes this form; read as the whole day',
    },
  ),
  zoned(
    'b-only-timed-until-floating',
    ['until'],
    LON,
    '2026-03-25T09:00:00',
    60,
    'FREQ=DAILY;UNTIL=20260330T090000',
  ),

  // ---------- limit and far ranges ----------
  zoned('limit-10-of-infinite', ['limit'], LA, '2026-01-01T09:00:00', 30, 'FREQ=DAILY', {
    limit: 10,
  }),
  zoned(
    'range-far-after-start',
    ['count', 'range'],
    LON,
    '2015-01-05T09:00:00',
    60,
    'FREQ=WEEKLY;COUNT=600',
    { range: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' } },
  ),
  zoned(
    'limit-with-override-moved-earlier',
    ['limit', 'override'],
    NY,
    '2026-01-05T09:00:00',
    60,
    'FREQ=DAILY',
    {
      limit: 3,
      range: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
      overrides: [
        {
          recurrenceId: '20260120T140000Z',
          start: at('2026-01-05T07:00:00', NY),
          end: at('2026-01-05T08:00:00', NY),
        },
      ],
    },
  ),
  zoned(
    'unsynced-dtstart-weekly',
    ['dtstart'],
    NY,
    '2026-03-04T09:00:00',
    60,
    'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    { note: 'DTSTART (a Wednesday) does not match BYDAY=MO' },
  ),
  zoned(
    'unsynced-dtstart-monthly',
    ['dtstart'],
    LON,
    '2026-01-05T09:00:00',
    60,
    'FREQ=MONTHLY;BYMONTHDAY=10;COUNT=3',
  ),

  // ---------- refused ----------
  ...(
    [
      ['refused-hourly-count', 'FREQ=HOURLY;COUNT=5'],
      ['refused-hourly-interval-until', 'FREQ=HOURLY;INTERVAL=3;UNTIL=20260303T000000Z'],
      ['refused-hourly-byday', 'FREQ=HOURLY;BYDAY=MO,TU;COUNT=10'],
      ['refused-minutely', 'FREQ=MINUTELY;INTERVAL=15;COUNT=8'],
      ['refused-secondly', 'FREQ=SECONDLY;COUNT=3'],
      ['refused-no-freq', 'INTERVAL=2;COUNT=3'],
      ['refused-unknown-freq', 'FREQ=FORTNIGHTLY;COUNT=3'],
      ['refused-bad-byday', 'FREQ=WEEKLY;BYDAY=XX;COUNT=3'],
      ['refused-bad-until', 'FREQ=DAILY;UNTIL=tomorrow'],
      ['refused-count-and-until', 'FREQ=DAILY;COUNT=3;UNTIL=20260310T000000Z'],
      ['refused-count-not-a-number', 'FREQ=DAILY;COUNT=three'],
      // Monday 09:00, so DTSTART is also the first instance of every refused rule (the one occurrence callers show).
    ] as const
  ).map(([id, rule]) => ({
    ...zoned(id, ['refused'], LA, '2026-03-02T09:00:00', 60, rule),
    refusal: true as const,
  })),
];
