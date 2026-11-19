/**
 * Golden corpus inputs, part 2: WKST, COUNT vs UNTIL, all-day, overrides, EXDATE, RDATE, floating,
 * dateutil-only rules, lenient UNTIL forms, limits and refusals. Expected outputs are never
 * written here: generate.ts runs both oracles over these inputs.
 */

import { type Case, allDay, at, floating, LA, LON, NY, SYD, zoned } from './cases-shared';

export const casesEditing: Case[] = [
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
