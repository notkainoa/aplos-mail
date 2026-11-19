/**
 * The rule half of expansion: wall-clock readings an RRULE produces, in order, from DTSTART.
 * Works period by period (a day, week, month or year per FREQ and INTERVAL): keep the days every
 * BYxxx part allows, attach the times of day, apply BYSETPOS, then drop anything before DTSTART.
 * Zones, UNTIL, RDATE and EXDATE are the caller's business (expand.ts).
 */
import type { Rule } from './rule';
import { WEEKDAYS } from './rule';
import { DAY_MS, civilFromDay, dayFromCivil, daysInMonth, weekdayOf } from './time';

interface Plan {
  rule: Rule;
  byMonth: number[];
  byMonthDay: number[];
  byDay: { weekday: number; ordinal?: number }[];
  wkst: number;
  /** Seconds of the day, sorted. */
  times: number[];
  /** Ordinals count within the month (MONTHLY, or YEARLY with BYMONTH) rather than the year. */
  ordinalsInMonth: boolean;
}

function plan(rule: Rule, startDay: number, startSec: number, allDay: boolean): Plan {
  const start = civilFromDay(startDay);
  let byMonth = rule.byMonth;
  let byMonthDay = rule.byMonthDay;
  let byDay = rule.byDay.map(b => ({ weekday: WEEKDAYS.indexOf(b.weekday), ordinal: b.ordinal }));
  // With no day-level part, the rule repeats DTSTART's own day (RFC 5545: missing parts come from DTSTART).
  if (!rule.byWeekNo.length && !rule.byYearDay.length && !byMonthDay.length && !byDay.length) {
    if (rule.freq === 'YEARLY') {
      if (!byMonth.length) byMonth = [start.m];
      byMonthDay = [start.d];
    } else if (rule.freq === 'MONTHLY') {
      byMonthDay = [start.d];
    } else if (rule.freq === 'WEEKLY') {
      byDay = [{ weekday: weekdayOf(startDay), ordinal: undefined }];
    }
  }
  const pick = (list: number[], own: number): number[] =>
    list.length ? [...new Set(list)].sort((a, b) => a - b) : [own];
  const times: number[] = [];
  if (allDay) times.push(0);
  else {
    for (const h of pick(rule.byHour, Math.floor(startSec / 3600)))
      for (const mi of pick(rule.byMinute, Math.floor((startSec % 3600) / 60)))
        // A leap second (60) never appears on a clock without leap seconds, so it is skipped.
        for (const s of pick(rule.bySecond, startSec % 60))
          if (s < 60) times.push((h * 60 + mi) * 60 + s);
  }
  return {
    rule,
    byMonth,
    byMonthDay,
    byDay,
    wkst: WEEKDAYS.indexOf(rule.wkst ?? 'MO'),
    times,
    ordinalsInMonth: rule.freq === 'MONTHLY' || rule.byMonth.length > 0,
  };
}

/** Start times one matching day gets: the BYHOUR x BYMINUTE x BYSECOND combinations (leap second 60 left out). */
export function timesPerDay(rule: Rule): number {
  const size = (list: number[]): number => (list.length ? new Set(list).size : 1);
  return (
    size(rule.byHour) *
    size(rule.byMinute) *
    (rule.bySecond.length ? new Set(rule.bySecond.filter(s => s < 60)).size : 1)
  );
}

/** First day of the week (per WKST) holding `day`. */
const weekStart = (day: number, wkst: number): number => day - ((weekdayOf(day) - wkst + 7) % 7);

/** RFC 5545 week number: week 1 is the first week with at least four days in the year, i.e. the week of 4 January. */
function weekNumberMatches(day: number, wkst: number, wanted: number[]): boolean {
  const ws = weekStart(day, wkst);
  const year = civilFromDay(ws + 3).y; // the year owning the majority of this week
  const firstWeek = weekStart(dayFromCivil(year, 1, 4), wkst);
  const weeks = (weekStart(dayFromCivil(year + 1, 1, 4), wkst) - firstWeek) / 7;
  const n = (ws - firstWeek) / 7 + 1;
  return wanted.some(w => w === n || w === n - weeks - 1);
}

/** A day number (or weekday rank) against signed BYxxx values, -1 being the last of `len`. */
const matchSigned = (list: number[], value: number, len: number): boolean =>
  list.some(n => (n > 0 ? n : len + n + 1) === value);

function dayMatches(p: Plan, day: number): boolean {
  const r = p.rule;
  const c = civilFromDay(day);
  if (p.byMonth.length && !p.byMonth.includes(c.m)) return false;
  if (r.byWeekNo.length && !weekNumberMatches(day, p.wkst, r.byWeekNo)) return false;
  const jan1 = dayFromCivil(c.y, 1, 1);
  if (
    r.byYearDay.length &&
    !matchSigned(r.byYearDay, day - jan1 + 1, dayFromCivil(c.y + 1, 1, 1) - jan1)
  )
    return false;
  if (p.byMonthDay.length && !matchSigned(p.byMonthDay, c.d, daysInMonth(c.y, c.m))) return false;
  if (p.byDay.length) {
    const wd = weekdayOf(day);
    const first = p.ordinalsInMonth ? dayFromCivil(c.y, c.m, 1) : dayFromCivil(c.y, 1, 1);
    const last = p.ordinalsInMonth ? first + daysInMonth(c.y, c.m) - 1 : dayFromCivil(c.y, 12, 31);
    const nth = Math.floor((day - first) / 7) + 1;
    const nthFromEnd = -(Math.floor((last - day) / 7) + 1);
    if (
      !p.byDay.some(
        b =>
          b.weekday === wd &&
          (b.ordinal === undefined || b.ordinal === nth || b.ordinal === nthFromEnd),
      )
    )
      return false;
  }
  return true;
}

/** First and last day of period number `k` (period 0 holds DTSTART). */
function period(p: Plan, startDay: number, k: number): [number, number] {
  const { freq, interval } = p.rule;
  const start = civilFromDay(startDay);
  if (freq === 'DAILY') return [startDay + k * interval, startDay + k * interval];
  if (freq === 'WEEKLY') {
    const first = weekStart(startDay, p.wkst) + 7 * interval * k;
    return [first, first + 6];
  }
  if (freq === 'MONTHLY') {
    const index = start.y * 12 + start.m - 1 + k * interval;
    const first = dayFromCivil(Math.floor(index / 12), (index % 12) + 1, 1);
    return [first, first + daysInMonth(Math.floor(index / 12), (index % 12) + 1) - 1];
  }
  const y = start.y + k * interval;
  return [dayFromCivil(y, 1, 1), dayFromCivil(y + 1, 1, 1) - 1];
}

/**
 * Periods per Gregorian cycle: the calendar repeats every 400 years (146,097 days, exactly 20,871
 * weeks), so any `CYCLE` consecutive periods of one FREQ see every pattern a rule can match.
 */
const CYCLE: Record<string, number> = {
  DAILY: 146_097,
  WEEKLY: 20_871,
  MONTHLY: 4_800,
  YEARLY: 400,
};

/** Number of the last period starting on or before `day` (0 when `day` is before DTSTART's period). */
function periodIndex(p: Plan, startDay: number, day: number): number {
  const { freq, interval } = p.rule;
  const s = civilFromDay(startDay);
  const c = civilFromDay(day);
  const steps =
    freq === 'DAILY'
      ? day - startDay
      : freq === 'WEEKLY'
        ? (weekStart(day, p.wkst) - weekStart(startDay, p.wkst)) / 7
        : freq === 'MONTHLY'
          ? (c.y - s.y) * 12 + c.m - s.m
          : c.y - s.y;
  return Math.max(0, Math.floor(steps / interval));
}

/**
 * Wall-clock starts (ms on the day scale) the rule produces from DTSTART onwards, honouring COUNT.
 * Stops after `lastDay`, and after one full Gregorian cycle without a match, so rules that never
 * match (BYMONTHDAY=30;BYMONTH=2) still end quickly. `allDay` pins every time to midnight.
 * `skipToDay` is the first day the caller cares about: without COUNT, whole periods before it are
 * jumped over, so a series that started decades ago costs no more than a new one. With COUNT every
 * earlier instance has to be counted, so nothing is skipped.
 */
export function* ruleWalls(
  rule: Rule,
  startWall: number,
  lastDay: number,
  allDay: boolean,
  skipToDay = -Infinity,
): Generator<number> {
  const startDay = Math.floor(startWall / DAY_MS);
  const p = plan(rule, startDay, Math.floor((startWall - startDay * DAY_MS) / 1000), allDay);
  const first =
    rule.count === undefined && skipToDay > startDay ? periodIndex(p, startDay, skipToDay) : 0;
  let produced = 0;
  let matched = false;
  for (let k = first; ; k++) {
    if (!matched && k - first >= CYCLE[rule.freq]) return;
    const range = period(p, startDay, k);
    // Year 9999 is the end of the calendar iCalendar can write.
    if (range[0] > lastDay || civilFromDay(range[0]).y > 9999) return;
    let set: number[] = [];
    for (let day = range[0]; day <= range[1]; day++) {
      if (dayMatches(p, day)) for (const t of p.times) set.push(day * DAY_MS + t * 1000);
    }
    if (rule.bySetPos.length && set.length) {
      const chosen = rule.bySetPos
        .map(n => set[n > 0 ? n - 1 : set.length + n])
        .filter((v): v is number => v !== undefined);
      set = [...new Set(chosen)].sort((a, b) => a - b);
    }
    if (set.length) matched = true;
    for (const wall of set) {
      if (wall < startWall) continue;
      yield wall;
      if (rule.count !== undefined && ++produced >= rule.count) return;
    }
  }
}
