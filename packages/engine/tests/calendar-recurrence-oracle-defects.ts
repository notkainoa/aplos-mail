/**
 * Oracle-defect classifiers used by `calendar-recurrence-fuzz.test.ts` (they live here so that
 * file stays under the line budget). They identify the two documented, harmless mismatches:
 * dateutil's week-53 counting near 1 January and oracle B's alternative readings of RFC 5545.
 */

/** An oracle's materialised expectation, shared with calendar-recurrence-fuzz.test.ts. */
export interface Expected {
  recurrenceId: string;
  start: string;
  end: string;
  overridden: boolean;
}

const DEFECT_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_MS = 86_400_000;

/**
 * RFC 5545 week number of a UTC-midnight day, by brute force: week 1 of year Y is the first week
 * (starting on `wkst`, 0 = Monday) holding at least four days of Y. Returns [n, n - weeksInYear - 1].
 */
export function rfcWeekNumbers(dayMs: number, wkst: number): [number, number] {
  const weekday = (ms: number): number => (new Date(ms).getUTCDay() + 6) % 7;
  const week1 = (y: number): number => {
    for (let s = Date.UTC(y - 1, 11, 25); ; s += DAY_MS) {
      if (weekday(s) !== wkst) continue;
      let inYear = 0;
      for (let k = 0; k < 7; k++) if (new Date(s + k * DAY_MS).getUTCFullYear() === y) inYear++;
      if (inYear >= 4) return s;
    }
  };
  const y = new Date(dayMs).getUTCFullYear();
  const owner = [y + 1, y, y - 1].find(c => week1(c) <= dayMs)!;
  const n = Math.floor((dayMs - week1(owner)) / (7 * DAY_MS)) + 1;
  const weeks = (week1(owner + 1) - week1(owner)) / (7 * DAY_MS);
  return [n, n - weeks - 1];
}

/**
 * dateutil 3.0.0 counts the previous year's weeks with the current year's length (`lnumweeks`), so
 * near 1 January it can call week 52 "week 53". A mismatch is put down to that only when every
 * occurrence A alone has fails the brute-force week check and every one the module alone has passes it.
 */
export function weekNoDefectOfA(
  rrule: string,
  want: Expected[],
  actual: Expected[],
  toDay: (k: string) => number,
): boolean {
  const m = /BYWEEKNO=([^;]+)/.exec(rrule);
  if (!m) return false;
  const wanted = m[1].split(',').map(Number);
  const wkst = DEFECT_DAYS.indexOf(/WKST=(\w\w)/.exec(rrule)?.[1] ?? 'MO');
  const matches = (k: string): boolean =>
    rfcWeekNumbers(toDay(k), wkst).some(n => wanted.includes(n));
  const a = new Set(want.map(e => e.recurrenceId));
  const b = new Set(actual.map(e => e.recurrenceId));
  const aOnly = [...a].filter(k => !b.has(k));
  const mOnly = [...b].filter(k => !a.has(k));
  return aOnly.length > 0 && aOnly.every(k => !matches(k)) && mOnly.every(matches);
}

/** Shapes where oracle B is documented to read RFC 5545 differently (disagreements.md). */
export function bDisputed(rrule: string): boolean {
  const has = (p: string): boolean => new RegExp(`(^|;)${p}=`).test(rrule);
  const freq = /FREQ=(\w+)/.exec(rrule)![1];
  if (freq === 'YEARLY' && !has('BYMONTH') && (has('BYMONTHDAY') || /BYDAY=[^;]*\d/.test(rrule)))
    return true;
  if (has('BYSETPOS') && (freq === 'WEEKLY' || freq === 'DAILY')) return true;
  if (has('BYSETPOS') && freq === 'YEARLY' && !/BYMONTH=\d+(;|$)/.test(rrule)) return true;
  return false;
}
