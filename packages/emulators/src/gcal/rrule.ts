import {
  civilOfDay,
  dateKey,
  dateOfDay,
  dayOfCivil,
  daysInMonth,
  isValidZone,
  localToUtc,
  utcKey,
  weekdayOfDay,
} from './tz';

/**
 * Recurrence expansion for the Calendar emulator (RFC 5545, the part tests need).
 *
 * Supported: RRULE with FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with
 * ordinals such as 2TU or -1FR), BYMONTHDAY (negative values count from the month's end), BYMONTH,
 * BYSETPOS (monthly and yearly) and WKST; EXDATE and RDATE lines (UTC, zoned or date values).
 * Not supported, and refused as invalid: HOURLY/MINUTELY/SECONDLY, BYHOUR/BYMINUTE/BYSECOND,
 * BYWEEKNO, BYYEARDAY, EXRULE. Only the first RRULE line counts. YEARLY ordinals apply inside the
 * BYMONTH month (or the start month), not across the whole year. Like Google, an RRULE whose
 * first match is after DTSTART does not make DTSTART itself an occurrence.
 */
export class RecurrenceError extends Error {}

const DAY_MS = 86_400_000;
const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
/** Periods in a row that produce nothing before a rule is declared empty (e.g. BYMONTHDAY=31 in FEB only). */
const MAX_IDLE_PERIODS = 2000;

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  /** UNTIL as text; resolved against the series when expanding. */
  until?: string;
  byday: { ord: number; dow: number }[];
  bymonthday: number[];
  bymonth: number[];
  bysetpos: number[];
  wkst: number;
}

/** What expansion needs from the master event. */
export interface Series {
  allDay: boolean;
  /** Zone the wall-clock repeats in; UTC for all-day series. */
  tz: string;
  /** First local date as a day number. */
  startDay: number;
  h: number;
  mi: number;
  s: number;
  recurrence: string[];
}

export interface Occurrence {
  /** The id suffix: 'YYYYMMDDTHHMMSSZ' (timed) or 'YYYYMMDD' (all-day). */
  key: string;
  day: number;
  /** The instant of the start (timed) or the UTC midnight of the date (all-day). */
  startMs: number;
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(text: string): Line {
  const colon = text.indexOf(':');
  if (colon < 0) throw new RecurrenceError(`Invalid recurrence line: ${text.slice(0, 20)}`);
  const [name, ...rest] = text.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const item of rest) {
    const eq = item.indexOf('=');
    if (eq > 0) params[item.slice(0, eq).toUpperCase()] = item.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value: text.slice(colon + 1).trim() };
}

function ints(value: string, min: number, max: number, what: string): number[] {
  return value.split(',').map(part => {
    const n = Number(part);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > max || Math.abs(n) < min)
      throw new RecurrenceError(`Invalid ${what}`);
    return n;
  });
}

function parseRule(value: string): Rule {
  const rule: Rule = {
    freq: 'DAILY',
    interval: 1,
    byday: [],
    bymonthday: [],
    bymonth: [],
    bysetpos: [],
    wkst: 1,
  };
  let hasFreq = false;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) throw new RecurrenceError('Invalid RRULE');
    const key = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    switch (key) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(v.toUpperCase()))
          throw new RecurrenceError(`Unsupported FREQ ${v}`);
        rule.freq = v.toUpperCase() as Freq;
        hasFreq = true;
        break;
      case 'INTERVAL':
        rule.interval = Number(v);
        if (!Number.isInteger(rule.interval) || rule.interval < 1)
          throw new RecurrenceError('Invalid INTERVAL');
        break;
      case 'COUNT':
        rule.count = Number(v);
        if (!Number.isInteger(rule.count) || rule.count < 1)
          throw new RecurrenceError('Invalid COUNT');
        break;
      case 'UNTIL':
        if (!/^\d{8}(T\d{6}Z?)?$/.test(v)) throw new RecurrenceError('Invalid UNTIL');
        rule.until = v;
        break;
      case 'BYDAY':
        for (const token of v.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token);
          if (!m) throw new RecurrenceError('Invalid BYDAY');
          rule.byday.push({ ord: m[1] ? Number(m[1]) : 0, dow: DOW[m[2].toUpperCase()] });
        }
        break;
      case 'BYMONTHDAY':
        rule.bymonthday = ints(v, 1, 31, 'BYMONTHDAY');
        break;
      case 'BYMONTH':
        rule.bymonth = ints(v, 1, 12, 'BYMONTH');
        break;
      case 'BYSETPOS':
        rule.bysetpos = ints(v, 1, 366, 'BYSETPOS');
        break;
      case 'WKST':
        if (!(v.toUpperCase() in DOW)) throw new RecurrenceError('Invalid WKST');
        rule.wkst = DOW[v.toUpperCase()];
        break;
      default:
        throw new RecurrenceError(`Unsupported RRULE part ${key}`);
    }
  }
  if (!hasFreq) throw new RecurrenceError('RRULE needs FREQ');
  if (rule.count !== undefined && rule.until)
    throw new RecurrenceError('RRULE cannot have both COUNT and UNTIL');
  return rule;
}

/** Throws RecurrenceError for a recurrence array Google would refuse. */
export function validateRecurrence(lines: unknown): asserts lines is string[] {
  if (!Array.isArray(lines) || lines.some(l => typeof l !== 'string'))
    throw new RecurrenceError('Invalid recurrence');
  for (const text of lines as string[]) {
    const line = parseLine(text);
    if (line.name === 'RRULE') parseRule(line.value);
    else if (line.name !== 'EXDATE' && line.name !== 'RDATE')
      throw new RecurrenceError(`Unsupported recurrence line ${line.name}`);
    if (line.params.TZID && !isValidZone(line.params.TZID))
      throw new RecurrenceError('Invalid time zone in recurrence');
  }
}

// ---------- day generation ----------

/** Days of one month a rule selects, before the start-day cut. */
function monthDays(rule: Rule, y: number, mo: number, startDom: number): number[] {
  const n = daysInMonth(y, mo);
  const first = dayOfCivil(y, mo, 1);
  const weekdays = (dow: number): number[] => {
    const out: number[] = [];
    for (let d = 0; d < n; d++) if (weekdayOfDay(first + d) === dow) out.push(first + d);
    return out;
  };
  let days: number[];
  if (rule.bymonthday.length) {
    days = rule.bymonthday
      .map(d => (d > 0 ? d : n + 1 + d))
      .filter(d => d >= 1 && d <= n)
      .map(d => first + d - 1);
    if (rule.byday.length)
      days = days.filter(day => rule.byday.some(b => b.dow === weekdayOfDay(day)));
  } else if (rule.byday.length) {
    days = rule.byday.flatMap(({ ord, dow }) => {
      const all = weekdays(dow);
      if (ord === 0) return all;
      const picked = ord > 0 ? all[ord - 1] : all[all.length + ord];
      return picked === undefined ? [] : [picked];
    });
  } else {
    days = startDom <= n ? [first + startDom - 1] : [];
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos.length) {
    days = [
      ...new Set(
        rule.bysetpos
          .map(p => (p > 0 ? days[p - 1] : days[days.length + p]))
          .filter((d): d is number => d !== undefined),
      ),
    ].sort((a, b) => a - b);
  }
  return days;
}

/** Local dates the rule produces in order, starting at `startDay`. Endless for rules without a stop. */
function* ruleDays(rule: Rule, startDay: number): Generator<number> {
  const start = civilOfDay(startDay);
  const monthOk = (day: number): boolean =>
    !rule.bymonth.length || rule.bymonth.includes(civilOfDay(day).mo);
  let idle = 0;
  const step = (produced: boolean): boolean => {
    idle = produced ? 0 : idle + 1;
    return idle <= MAX_IDLE_PERIODS;
  };
  if (rule.freq === 'DAILY') {
    for (let day = startDay; ; day += rule.interval) {
      const dom = civilOfDay(day).d;
      const n = daysInMonth(civilOfDay(day).y, civilOfDay(day).mo);
      const ok =
        monthOk(day) &&
        (!rule.byday.length || rule.byday.some(b => b.dow === weekdayOfDay(day))) &&
        (!rule.bymonthday.length || rule.bymonthday.some(d => (d > 0 ? d : n + 1 + d) === dom));
      if (ok) yield day;
      if (!step(ok)) return;
    }
  }
  if (rule.freq === 'WEEKLY') {
    const targets = rule.byday.length
      ? [...new Set(rule.byday.map(b => b.dow))]
      : [weekdayOfDay(startDay)];
    const firstWeek = startDay - ((weekdayOfDay(startDay) - rule.wkst + 7) % 7);
    for (let week = firstWeek; ; week += 7 * rule.interval) {
      const days = targets
        .map(dow => week + ((dow - rule.wkst + 7) % 7))
        .sort((a, b) => a - b)
        .filter(day => day >= startDay && monthOk(day));
      yield* days;
      if (!step(days.length > 0)) return;
    }
  }
  if (rule.freq === 'MONTHLY') {
    for (let k = 0; ; k += rule.interval) {
      const index = start.y * 12 + (start.mo - 1) + k;
      const y = Math.floor(index / 12);
      const mo = (index % 12) + 1;
      const days =
        rule.bymonth.length && !rule.bymonth.includes(mo)
          ? []
          : monthDays(rule, y, mo, start.d).filter(day => day >= startDay);
      yield* days;
      if (!step(days.length > 0)) return;
    }
  }
  const months = rule.bymonth.length ? [...rule.bymonth].sort((a, b) => a - b) : [start.mo];
  for (let y = start.y; ; y += rule.interval) {
    const days = months
      .flatMap(mo => monthDays(rule, y, mo, start.d))
      .filter(day => day >= startDay);
    yield* days;
    if (!step(days.length > 0)) return;
  }
}

// ---------- occurrences ----------

function occurrenceOfDay(series: Series, day: number): Occurrence {
  if (series.allDay) return { key: dateKey(dateOfDay(day)), day, startMs: day * DAY_MS };
  const { y, mo, d } = civilOfDay(day);
  const startMs = localToUtc({ y, mo, d, h: series.h, mi: series.mi, s: series.s }, series.tz);
  return { key: utcKey(startMs), day, startMs };
}

/** Occurrences named by an EXDATE or RDATE line. */
function datedOccurrences(line: Line, series: Series): Occurrence[] {
  const out: Occurrence[] = [];
  for (const value of line.value.split(',').filter(Boolean)) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!m) throw new RecurrenceError(`Invalid ${line.name} value`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (series.allDay || m[4] === undefined) {
      out.push(occurrenceOfDay(series, dayOfCivil(y, mo, d)));
    } else if (m[7]) {
      const startMs = Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6]));
      out.push({ key: utcKey(startMs), day: dayOfCivil(y, mo, d), startMs });
    } else {
      const startMs = localToUtc(
        { y, mo, d, h: Number(m[4]), mi: Number(m[5]), s: Number(m[6]) },
        line.params.TZID ?? series.tz,
      );
      out.push({ key: utcKey(startMs), day: dayOfCivil(y, mo, d), startMs });
    }
  }
  return out;
}

function untilCutoff(until: string, series: Series): (occ: Occurrence) => boolean {
  const date = /^(\d{4})(\d{2})(\d{2})/.exec(until)!;
  const untilDay = dayOfCivil(Number(date[1]), Number(date[2]), Number(date[3]));
  if (series.allDay || until.length === 8) return occ => occ.day <= untilDay;
  const time = /T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(until)!;
  const untilMs = time[4]
    ? Date.UTC(
        Number(date[1]),
        Number(date[2]) - 1,
        Number(date[3]),
        Number(time[1]),
        Number(time[2]),
        Number(time[3]),
      )
    : localToUtc(
        {
          y: Number(date[1]),
          mo: Number(date[2]),
          d: Number(date[3]),
          h: Number(time[1]),
          mi: Number(time[2]),
          s: Number(time[3]),
        },
        series.tz,
      );
  return occ => occ.startMs <= untilMs;
}

/**
 * Occurrences of a series in start order, endless for open rules (the caller stops reading).
 * EXDATEs are skipped but still count toward COUNT, as RFC 5545 says.
 */
export function* occurrences(series: Series): Generator<Occurrence> {
  const lines = series.recurrence.map(parseLine);
  const ruleLine = lines.find(l => l.name === 'RRULE');
  const excluded = new Set(
    lines
      .filter(l => l.name === 'EXDATE')
      .flatMap(l => datedOccurrences(l, series))
      .map(o => o.key),
  );
  const extra = lines
    .filter(l => l.name === 'RDATE')
    .flatMap(l => datedOccurrences(l, series))
    .sort((a, b) => a.startMs - b.startMs);
  const seen = new Set<string>();
  let nextExtra = 0;
  const emit = function* (occ: Occurrence): Generator<Occurrence> {
    if (seen.has(occ.key)) return;
    seen.add(occ.key);
    if (!excluded.has(occ.key)) yield occ;
  };

  function* fromRule(): Generator<Occurrence> {
    if (!ruleLine) {
      yield occurrenceOfDay(series, series.startDay);
      return;
    }
    const rule = parseRule(ruleLine.value);
    const withinUntil = rule.until ? untilCutoff(rule.until, series) : () => true;
    let produced = 0;
    for (const day of ruleDays(rule, series.startDay)) {
      const occ = occurrenceOfDay(series, day);
      if (!withinUntil(occ) || (rule.count !== undefined && produced >= rule.count)) return;
      produced++;
      yield occ;
    }
  }

  for (const occ of fromRule()) {
    while (nextExtra < extra.length && extra[nextExtra].startMs <= occ.startMs)
      yield* emit(extra[nextExtra++]);
    yield* emit(occ);
  }
  while (nextExtra < extra.length) yield* emit(extra[nextExtra++]);
}
