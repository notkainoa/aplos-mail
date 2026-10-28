/**
 * Parses an HTTP `Retry-After` header (RFC 9110 section 10.2.3) into milliseconds from `now`.
 *
 * Accepts delta-seconds (integers; decimals are tolerated because some servers send them) and an
 * HTTP-date in any of the three RFC 9110 forms: IMF-fixdate, obsolete RFC 850 and ANSI C asctime.
 * There is deliberately no cap: the governor decides what to do with a long wait, though a value
 * beyond the last valid Date is clamped to it. A date in the past is 0. Anything else, including negative numbers, is `undefined`.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (header == null) return undefined;
  const value = header.trim();
  if (!value) return undefined;

  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    if (!Number.isFinite(ms)) return undefined;
    // No cap, but never past the latest instant a Date can hold, so `now + ms` stays a real time.
    return Math.min(ms, Math.max(0, MAX_TIME - now));
  }

  const at = parseHttpDate(value, now);
  return at === undefined ? undefined : Math.max(0, at - now);
}

/** The latest instant a Date can hold (ECMA-262 21.4.1.1). */
const MAX_TIME = 8.64e15;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = '(?:mon|tue|wed|thu|fri|sat|sun)';
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';

// Sun, 06 Nov 1994 08:49:37 GMT
const IMF = new RegExp(`^${DAY}, (\\d{2}) ${MON} (\\d{4}) ${TIME} GMT$`, 'i');
// Sunday, 06-Nov-94 08:49:37 GMT
const RFC850 = new RegExp(`^${DAY}[a-z]*, (\\d{2})-${MON}-(\\d{2}) ${TIME} GMT$`, 'i');
// Sun Nov  6 08:49:37 1994 (day is space padded; asctime has no zone and means GMT in HTTP)
const ASCTIME = new RegExp(`^${DAY} ${MON} ([ \\d]\\d) ${TIME} (\\d{4})$`, 'i');

function parseHttpDate(value: string, now: number): number | undefined {
  let m: RegExpExecArray | null;
  let day: string, mon: string, year: string, hh: string, mm: string, ss: string;
  if ((m = IMF.exec(value))) [, day, mon, year, hh, mm, ss] = m;
  else if ((m = RFC850.exec(value))) {
    [, day, mon, year, hh, mm, ss] = m;
    year = String(expandTwoDigitYear(Number(year), now));
  } else if ((m = ASCTIME.exec(value))) [, mon, day, hh, mm, ss, year] = m;
  else return undefined;

  const d = Number(day),
    mo = MONTHS.indexOf(mon.toLowerCase()),
    y = Number(year);
  const h = Number(hh),
    mi = Number(mm),
    s = Number(ss);
  if (h > 23 || mi > 59 || s > 60) return undefined;
  const at = Date.UTC(y, mo, d, h, mi, Math.min(s, 59));
  // Reject overflowing dates such as 31 Feb, which Date.UTC would silently roll into March.
  const check = new Date(at);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d)
    return undefined;
  return at;
}

/** RFC 9110: a two-digit year more than 50 years ahead of now means the most recent past century. */
function expandTwoDigitYear(yy: number, now: number): number {
  const nowYear = new Date(now).getUTCFullYear();
  let year = Math.floor(nowYear / 100) * 100 + yy;
  if (year > nowYear + 50) year -= 100;
  return year;
}
