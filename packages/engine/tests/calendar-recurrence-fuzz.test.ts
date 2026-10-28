/**
 * Adversarial fuzz of the recurrence module (written by a reviewer, not the module's author).
 *
 * 1. Seeded random series (every rule part the expander runs, DST zones in both hemispheres
 *    including 30- and 45-minute offsets, all-day and floating, EXDATE / RDATE / overrides), each
 *    over ten years, compared with oracle A (python-dateutil in the throwaway venv; expectations are
 *    generated into a temp JSON file during setup) and, where it supports the rule, oracle B (the
 *    Calendar emulator's expander, read-only). Reproduce with APLOS_FUZZ_SEED / APLOS_FUZZ_N.
 * 2. Hand checks of edge cases RFC 5545 pins down, with expectations worked out by hand.
 *
 * child_process and fs are allowed here because this is a test; the module itself stays pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  editOccurrence,
  expand,
  googleInstanceId,
  splitFollowing,
  type EventTime,
  type ExpandResult,
  type Override,
  type Series,
} from '../src/calendar/recurrence';

const PYTHON = process.env.APLOS_ORACLE_PYTHON ?? '/tmp/aplos-rrule-oracle/bin/python';
const ORACLE_A = join(import.meta.dirname, '..', 'scripts', 'recurrence-oracle', 'oracle_a.py');
const ORACLE_B_DIR =
  process.env.APLOS_ORACLE_B_DIR ??
  '/Users/knewton/.t3/worktrees/aplos-mail/rv-prov-emu-gcal/packages/emulators/src/gcal';
const SEED = Number(process.env.APLOS_FUZZ_SEED ?? 5545);
const N = Number(process.env.APLOS_FUZZ_N ?? 300);
const DAY = 86_400_000;
const LIMIT = 20_000;
const LA = 'America/Los_Angeles';

// ---------- small independent helpers (never the module's own) ----------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Key text to ms on the UTC scale (floating and date keys read as UTC, i.e. floatingZone UTC). */
function keyMs(key: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(key);
  if (!m) throw new Error(`bad key ${key}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function msKey(ms: number, like: string): string {
  const iso = new Date(ms).toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  if (like.length === 8) return date;
  return `${date}T${iso.slice(11, 19).replace(/:/g, '')}${like.endsWith('Z') ? 'Z' : ''}`;
}

function key(t: EventTime): string {
  if ('date' in t) return t.date.replace(/-/g, '');
  if ('local' in t) return t.local.replace(/[-:]/g, '');
  return msKey(t.utc, 'xxxxxxxxTxxxxxxZ');
}

/** The wall clock of an instant in a zone, 'YYYYMMDDTHHMMSS', straight from Intl. */
function localOf(ms: number, tz: string): string {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

const isoOfKey = (k: string): string =>
  `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}${k.length > 8 ? `T${k.slice(9, 11)}:${k.slice(11, 13)}:${k.slice(13, 15)}` : ''}`;

// ---------- the random series ----------

interface Job extends Series {
  id: string;
  rrule: string;
  cutoff: number;
}

interface FuzzCase {
  id: string;
  zone: string;
  mode: 'zoned' | 'floating' | 'date';
  job: Job;
  range: { from: number; to: number };
}

const ZONES = [
  'America/Los_Angeles',
  'Europe/London',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/St_Johns',
  'Asia/Kolkata',
  'UTC',
  'floating',
  'all-day',
];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function baseCases(seed: number, n: number): FuzzCase[] {
  const rnd = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const some = <T>(xs: readonly T[], k: number): T[] => [
    ...new Set(Array.from({ length: k }, () => pick(xs))),
  ];
  const out: FuzzCase[] = [];
  for (let i = 0; i < n; i++) {
    const zone = pick(ZONES);
    const mode = zone === 'all-day' ? 'date' : zone === 'floating' ? 'floating' : 'zoned';
    const y = int(2024, 2027);
    const mo = int(1, 12);
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const d = Math.min(int(1, 31), dim);
    // Hours near midnight and 1-3 a.m. on purpose: Santiago changes at 24:00, the rest at 1-3 a.m.
    const h = pick([0, 0, 1, 1, 2, 2, 2, 3, 9, 12, 23]);
    const mi = pick([0, 0, 15, 30, 45]);
    const s = rnd() < 0.1 ? 17 : 0;
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    const local = `${date}T${pad(h)}:${pad(mi)}:${pad(s)}`;
    const timed = mode !== 'date';

    const freq = pick(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const);
    const parts = [`FREQ=${freq}`];
    if (rnd() < 0.4) parts.push(`INTERVAL=${int(2, 3)}`);
    const hours = (): void => {
      if (!timed) return;
      if (rnd() < 0.2) parts.push(`BYHOUR=${some([0, 1, 2, 3, 9, 23], int(1, 2)).join(',')}`);
      if (rnd() < 0.1) parts.push(`BYMINUTE=${some([0, 30, 45], int(1, 2)).join(',')}`);
    };
    if (freq === 'DAILY') {
      if (rnd() < 0.3) parts.push(`BYDAY=${some(DAYS, int(1, 3)).join(',')}`);
      if (rnd() < 0.2)
        parts.push(`BYMONTHDAY=${some([1, 15, 29, 30, 31, -1, -2], int(1, 2)).join(',')}`);
      if (rnd() < 0.2)
        parts.push(`BYMONTH=${some([1, 2, 3, 4, 9, 10, 11, 12], int(1, 3)).join(',')}`);
      hours();
      if (parts.some(p => p.startsWith('BYHOUR=') && p.includes(',')) && rnd() < 0.5)
        parts.push(`BYSETPOS=${pick([1, -1])}`);
    } else if (freq === 'WEEKLY') {
      const byday = rnd() < 0.8 ? some(DAYS, int(1, 4)) : [];
      if (byday.length) parts.push(`BYDAY=${byday.join(',')}`);
      if (rnd() < 0.5) parts.push(`WKST=${pick(DAYS)}`);
      if (rnd() < 0.15) parts.push(`BYMONTH=${some([2, 3, 4, 9, 10, 11], int(1, 2)).join(',')}`);
      if (byday.length > 1 && rnd() < 0.2) parts.push(`BYSETPOS=${pick([1, -1, 2, -2])}`);
      hours();
    } else if (freq === 'MONTHLY') {
      const shape = int(0, 5);
      if (shape === 1)
        parts.push(
          `BYMONTHDAY=${some([1, 5, 15, 29, 30, 31, -1, -3, -10, -31], int(1, 3)).join(',')}`,
        );
      if (shape === 2)
        parts.push(
          `BYDAY=${some([1, 2, 3, 4, 5, -1, -2, -5], int(1, 2))
            .map(o => `${o}${pick(DAYS)}`)
            .join(',')}`,
        );
      if (shape === 3)
        parts.push(
          `BYDAY=${some(DAYS, int(2, 5)).join(',')}`,
          `BYSETPOS=${some([1, 2, 3, -1, -2, -3], int(1, 2)).join(',')}`,
        );
      if (shape === 4)
        parts.push(
          `BYDAY=${some(DAYS, int(1, 2)).join(',')}`,
          `BYMONTHDAY=${some([1, 7, 13, 20, -1], int(1, 3)).join(',')}`,
        );
      if (shape === 5) parts.push(`BYDAY=${some(DAYS, int(1, 3)).join(',')}`);
      if (rnd() < 0.2)
        parts.push(`BYMONTH=${some([1, 2, 3, 4, 9, 10, 11, 12], int(2, 4)).join(',')}`);
      hours();
    } else {
      const shape = int(0, 9);
      if (shape === 1)
        parts.push(`BYMONTH=${some([1, 2, 3, 4, 9, 10, 11, 12], int(1, 3)).join(',')}`);
      if (shape === 2)
        parts.push(
          `BYMONTH=${some([2, 3, 4, 9, 10, 11], int(1, 2)).join(',')}`,
          `BYMONTHDAY=${some([1, 29, 30, 31, -1], int(1, 2)).join(',')}`,
        );
      if (shape === 3)
        parts.push(
          `BYMONTH=${some([3, 4, 9, 10, 11], int(1, 2)).join(',')}`,
          `BYDAY=${pick([1, 2, -1, 4, 5])}${pick(DAYS)}`,
        );
      if (shape === 4)
        parts.push(
          `BYMONTH=${some([2, 3, 4, 10, 11], int(1, 2))}`,
          `BYDAY=${some(DAYS, int(2, 5)).join(',')}`,
          `BYSETPOS=${pick([1, -1, 2, -2])}`,
        );
      if (shape === 5) parts.push(`BYDAY=${pick([1, 20, 52, 53, -1, -53])}${pick(DAYS)}`);
      if (shape === 6) parts.push(`BYMONTHDAY=${some([1, 15, 31, -1], int(1, 2)).join(',')}`);
      if (shape === 7)
        parts.push(
          `BYYEARDAY=${some([1, 60, 100, 200, 365, 366, -1, -306, -366], int(1, 3)).join(',')}`,
        );
      if (shape === 8) {
        parts.push(`BYWEEKNO=${some([1, 2, 20, 52, 53, -1, -2], int(1, 2)).join(',')}`);
        if (rnd() < 0.7) parts.push(`BYDAY=${some(DAYS, int(1, 3)).join(',')}`);
        if (rnd() < 0.5) parts.push(`WKST=${pick(DAYS)}`);
      }
      if (shape === 9) parts.push('BYMONTH=2', 'BYMONTHDAY=29');
      hours();
    }
    const startMs = Date.UTC(y, mo - 1, d);
    const ending = int(0, 2);
    if (ending === 1) parts.push(`COUNT=${int(1, 80)}`);
    if (ending === 2) {
      const u = new Date(startMs + int(-3, 3000) * DAY + int(0, 23) * 3_600_000);
      const ymd = `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}`;
      const hms = `${pad(u.getUTCHours())}0000`;
      // UNTIL in DTSTART's own form, as RFC 5545 requires (lenient forms are oracle B territory).
      parts.push(
        `UNTIL=${mode === 'date' ? ymd : mode === 'floating' ? `${ymd}T${hms}` : `${ymd}T${hms}Z`}`,
      );
    }

    const durMin = pick([0, 30, 60, 90, 1440, 1530]);
    let start: EventTime;
    let end: EventTime;
    let tzid: string | undefined;
    if (mode === 'date') {
      start = { date };
      end = { date: new Date(startMs + int(1, 3) * DAY).toISOString().slice(0, 10) };
    } else if (mode === 'floating') {
      start = { local };
      end = {
        local: new Date(Date.parse(`${local}Z`) + durMin * 60_000).toISOString().slice(0, 19),
      };
    } else if (rnd() < 0.25) {
      // An instant start with the zone on the series, the way Google's API reports it.
      const at = Date.parse(`${local}Z`);
      start = { utc: at };
      end = { utc: at + durMin * 60_000 };
      tzid = zone;
    } else {
      start = { local, tzid: zone };
      end = {
        local: new Date(Date.parse(`${local}Z`) + durMin * 60_000).toISOString().slice(0, 19),
        tzid: zone,
      };
    }
    if (freq === 'WEEKLY' && parts.some(p => p.startsWith('BYSETPOS='))) {
      // dateutil builds DTSTART's week from DTSTART onwards, not from WKST, so BYSETPOS counts a
      // partial first week (an oracle A defect, pinned by hand below). Starting the week on DTSTART's
      // weekday keeps the comparison fair without dropping WEEKLY BYSETPOS from the fuzz.
      const wall = 'utc' in start ? localOf(start.utc, zone) : date.replace(/-/g, '');
      const wd =
        (new Date(
          Date.UTC(+wall.slice(0, 4), +wall.slice(4, 6) - 1, +wall.slice(6, 8)),
        ).getUTCDay() +
          6) %
        7;
      const at = parts.findIndex(p => p.startsWith('WKST='));
      if (at >= 0) parts.splice(at, 1);
      parts.push(`WKST=${DAYS[wd]}`);
    }
    const shift = rnd() < 0.3 ? int(30, 1500) : -2;
    const from = startMs + shift * DAY;
    const to = startMs + 3653 * DAY;
    const job: Job = {
      id: `s${seed}-${i}`,
      start,
      end,
      allDay: mode === 'date',
      rrule: parts.join(';'),
      cutoff: to + 3 * DAY,
    };
    if (tzid) job.tzid = tzid;
    out.push({ id: job.id, zone, mode, job, range: { from, to } });
  }
  return out;
}

/** Adds EXDATE, RDATE and overrides chosen from oracle A's own instances, so they actually hit. */
function decorate(c: FuzzCase, instances: string[], seed: number): void {
  const rnd = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const tz = c.mode === 'zoned' ? c.zone : 'UTC';
  if (!instances.length) return;
  if (rnd() < 0.4) {
    const chosen = [...new Set(Array.from({ length: int(1, 3) }, () => pick(instances)))];
    const lines: string[] = [];
    for (const k of chosen) {
      if (c.mode === 'date') lines.push(rnd() < 0.5 ? `EXDATE;VALUE=DATE:${k}` : k);
      else if (c.mode === 'floating') lines.push(`EXDATE:${k}`);
      else {
        const form = int(0, 2);
        if (form === 0) lines.push(`EXDATE:${k}`);
        if (form === 1) lines.push(`EXDATE;TZID=${tz}:${localOf(keyMs(k), tz)}`);
        if (form === 2)
          lines.push(`EXDATE;TZID=Europe/Berlin:${localOf(keyMs(k), 'Europe/Berlin')}`);
      }
    }
    c.job.exdate = lines;
  }
  if (rnd() < 0.3) {
    const base = keyMs(instances[0]);
    const lines: string[] = [];
    for (let j = int(1, 2); j > 0; j--) {
      const day = new Date(base + int(-10, 2000) * DAY);
      const ymd = `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}`;
      const hms = `${pad(pick([0, 1, 2, 3, 9, 23]))}${pick(['00', '30'])}00`;
      if (c.mode === 'date') lines.push(`RDATE;VALUE=DATE:${ymd}`);
      else if (c.mode === 'floating') lines.push(`RDATE:${ymd}T${hms}`);
      else lines.push(rnd() < 0.5 ? `RDATE;TZID=${tz}:${ymd}T${hms}` : `RDATE:${ymd}T${hms}Z`);
    }
    c.job.rdate = lines;
  }
  if (rnd() < 0.4) {
    const overrides: Override[] = [];
    for (const k of new Set(Array.from({ length: int(1, 3) }, () => pick(instances)))) {
      const idForm = int(0, 2);
      let recurrenceId: string | EventTime = k;
      if (c.mode === 'zoned' && idForm === 1) recurrenceId = { utc: keyMs(k) };
      if (c.mode === 'zoned' && idForm === 2)
        recurrenceId = { local: isoOfKey(localOf(keyMs(k), tz)), tzid: tz };
      if (c.mode === 'date' && idForm === 1) recurrenceId = { date: isoOfKey(k) };
      if (c.mode === 'floating' && idForm === 1) recurrenceId = { local: isoOfKey(k) };
      if (rnd() < 0.3) {
        overrides.push({ recurrenceId, cancelled: true });
        continue;
      }
      const delta = pick([-DAY, 2 * 3_600_000, 3 * DAY, -40 * DAY, 400 * DAY]);
      const moved = keyMs(k) + (c.mode === 'date' ? Math.round(delta / DAY) * DAY : delta);
      const o: Override = { recurrenceId };
      if (c.mode === 'date') o.start = { date: new Date(moved).toISOString().slice(0, 10) };
      else if (c.mode === 'floating')
        o.start = { local: new Date(moved).toISOString().slice(0, 19) };
      else o.start = { utc: moved };
      if (rnd() < 0.4) {
        if (c.mode === 'date')
          o.end = { date: new Date(moved + 2 * DAY).toISOString().slice(0, 10) };
        else if (c.mode === 'floating')
          o.end = { local: new Date(moved + 45 * 60_000).toISOString().slice(0, 19) };
        else o.end = { utc: moved + 45 * 60_000 };
      }
      overrides.push(o);
    }
    c.job.overrides = overrides;
  }
}

// ---------- oracles ----------

type OracleOk = {
  id: string;
  status: 'ok';
  mode: string;
  durationMs: number;
  instances: string[];
  overrides: {
    recurrenceId: string;
    start: string | null;
    end: string | null;
    cancelled: boolean;
  }[];
};
type OracleResult = OracleOk | { id: string; status: 'refused'; error: string };

const haveA = existsSync(PYTHON) && existsSync(ORACLE_A);

function runA(jobs: Job[], dir: string, name: string): Map<string, OracleResult> {
  const input = join(dir, `${name}-jobs.json`);
  const output = join(dir, `${name}-expected.json`);
  writeFileSync(input, JSON.stringify(jobs));
  const raw = execFileSync(PYTHON, ['-I', ORACLE_A], {
    input: readFileSync(input),
    maxBuffer: 1 << 29,
  });
  writeFileSync(output, raw);
  const parsed = JSON.parse(readFileSync(output, 'utf8')) as { results: OracleResult[] };
  return new Map(parsed.results.map(r => [r.id, r]));
}

interface Expected {
  recurrenceId: string;
  start: string;
  end: string;
  overridden: boolean;
}

/** An oracle's recurrence set with overrides, range and limit applied (same rules as generate.ts). */
function materialise(
  res: OracleOk,
  range: { from: number; to: number },
  limit = LIMIT,
): Expected[] {
  const after = (k: string, ms: number): string =>
    k.length === 8 && res.mode !== 'date' ? msKey(keyMs(k) + DAY, k) : msKey(keyMs(k) + ms, k);
  const overrides = new Map(res.overrides.map(o => [o.recurrenceId, o]));
  const list: (Expected & { at: number })[] = [];
  for (const id of res.instances) {
    const o = overrides.get(id);
    if (o?.cancelled) continue;
    const start = o?.start ?? id;
    const end = o?.end ?? after(start, res.durationMs);
    const [s, e] = [keyMs(start), keyMs(end)];
    if (e > s ? s < range.to && e > range.from : s >= range.from && s < range.to)
      list.push({ recurrenceId: id, start, end, overridden: o !== undefined, at: s });
  }
  list.sort((a, b) => a.at - b.at || (a.recurrenceId < b.recurrenceId ? -1 : 1));
  return list.slice(0, limit).map(({ at: _at, ...rest }) => rest);
}

function actualOf(r: ExpandResult): Expected[] {
  return r.occurrences.map(o => ({
    recurrenceId: o.recurrenceId,
    start: key(o.start),
    end: key(o.end),
    overridden: o.overridden,
  }));
}

function diff(expected: Expected[], actual: Expected[]): string {
  const i = expected.findIndex((e, j) => JSON.stringify(e) !== JSON.stringify(actual[j]));
  const at = i < 0 ? Math.min(expected.length, actual.length) : i;
  return `${actual.length} vs ${expected.length} expected; first difference at ${at}: got ${JSON.stringify(actual[at])}, want ${JSON.stringify(expected[at])}`;
}

/**
 * RFC 5545 week number of a UTC-midnight day, by brute force: week 1 of year Y is the first week
 * (starting on `wkst`, 0 = Monday) holding at least four days of Y. Returns [n, n - weeksInYear - 1].
 */
function rfcWeekNumbers(dayMs: number, wkst: number): [number, number] {
  const weekday = (ms: number): number => (new Date(ms).getUTCDay() + 6) % 7;
  const week1 = (y: number): number => {
    for (let s = Date.UTC(y - 1, 11, 25); ; s += DAY) {
      if (weekday(s) !== wkst) continue;
      let inYear = 0;
      for (let k = 0; k < 7; k++) if (new Date(s + k * DAY).getUTCFullYear() === y) inYear++;
      if (inYear >= 4) return s;
    }
  };
  const y = new Date(dayMs).getUTCFullYear();
  const owner = [y + 1, y, y - 1].find(c => week1(c) <= dayMs)!;
  const n = Math.floor((dayMs - week1(owner)) / (7 * DAY)) + 1;
  const weeks = (week1(owner + 1) - week1(owner)) / (7 * DAY);
  return [n, n - weeks - 1];
}

/**
 * dateutil 3.0.0 counts the previous year's weeks with the current year's length (`lnumweeks`), so
 * near 1 January it can call week 52 "week 53". A mismatch is put down to that only when every
 * occurrence A alone has fails the brute-force week check and every one the module alone has passes it.
 */
function weekNoDefectOfA(
  rrule: string,
  want: Expected[],
  actual: Expected[],
  toDay: (k: string) => number,
): boolean {
  const m = /BYWEEKNO=([^;]+)/.exec(rrule);
  if (!m) return false;
  const wanted = m[1].split(',').map(Number);
  const wkst = DAYS.indexOf(/WKST=(\w\w)/.exec(rrule)?.[1] ?? 'MO');
  const matches = (k: string): boolean =>
    rfcWeekNumbers(toDay(k), wkst).some(n => wanted.includes(n));
  const a = new Set(want.map(e => e.recurrenceId));
  const b = new Set(actual.map(e => e.recurrenceId));
  const aOnly = [...a].filter(k => !b.has(k));
  const mOnly = [...b].filter(k => !a.has(k));
  return aOnly.length > 0 && aOnly.every(k => !matches(k)) && mOnly.every(matches);
}

/** Shapes where oracle B is documented to read RFC 5545 differently (disagreements.md). */
function bDisputed(rrule: string): boolean {
  const has = (p: string): boolean => new RegExp(`(^|;)${p}=`).test(rrule);
  const freq = /FREQ=(\w+)/.exec(rrule)![1];
  if (freq === 'YEARLY' && !has('BYMONTH') && (has('BYMONTHDAY') || /BYDAY=[^;]*\d/.test(rrule)))
    return true;
  if (has('BYSETPOS') && (freq === 'WEEKLY' || freq === 'DAILY')) return true;
  if (has('BYSETPOS') && freq === 'YEARLY' && !/BYMONTH=\d+(;|$)/.test(rrule)) return true;
  return false;
}

// ---------- the fuzz run ----------

test(
  `seeded random series over ten years match oracle A (seed ${SEED}, ${N} series)`,
  { skip: !haveA && 'oracle A venv missing' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aplos-rrule-fuzz-'));
    try {
      const cases = baseCases(SEED, N);
      const first = runA(
        cases.map(c => c.job),
        dir,
        'base',
      );
      cases.forEach((c, i) => {
        const r = first.get(c.id);
        if (r?.status === 'ok') decorate(c, r.instances, SEED * 1000 + i);
      });
      const expectedA = runA(
        cases.map(c => c.job),
        dir,
        'full',
      );

      let oracleB: ((job: Job) => OracleResult) | undefined;
      if (existsSync(join(ORACLE_B_DIR, 'rrule.ts'))) {
        const { loadOracleB } = await import('../scripts/recurrence-oracle/oracle-b');
        oracleB = (await loadOracleB()) as unknown as (job: Job) => OracleResult;
      }

      const failures: string[] = [];
      const bNotes: string[] = [];
      const aDefects: string[] = [];
      let compared = 0;
      let occurrences = 0;
      let comparedB = 0;
      for (const c of cases) {
        const { id: _id, cutoff: _cutoff, ...series } = c.job;
        const result = expand({ ...series, range: c.range, limit: LIMIT });
        const actual = actualOf(result);
        const a = expectedA.get(c.id)!;
        const b = oracleB?.(c.job);
        const what = `${c.id} ${c.zone} ${c.job.rrule} start=${JSON.stringify(c.job.start)}${c.job.exdate ? ` exdate=${c.job.exdate.join('|')}` : ''}${c.job.rdate ? ` rdate=${c.job.rdate.join('|')}` : ''}${c.job.overrides ? ` overrides=${JSON.stringify(c.job.overrides)}` : ''}`;
        if (!result.ok) {
          if (a.status === 'ok')
            failures.push(`${what}: module refused (${result.reason}) but oracle A expands it`);
          continue;
        }
        if (result.truncated) failures.push(`${what}: truncated below the ${LIMIT} limit`);
        if (a.status === 'ok') {
          const want = materialise(a, c.range);
          compared++;
          occurrences += want.length;
          const toDay = (k: string): number => {
            const wall = c.mode === 'zoned' ? localOf(keyMs(k), c.zone) : k;
            return Date.UTC(+wall.slice(0, 4), +wall.slice(4, 6) - 1, +wall.slice(6, 8));
          };
          if (JSON.stringify(want) !== JSON.stringify(actual)) {
            if (weekNoDefectOfA(c.job.rrule, want, actual, toDay))
              aDefects.push(`${what}: ${diff(want, actual)}`);
            else failures.push(`${what} [A]: ${diff(want, actual)}`);
          }
          if (b?.status === 'ok' && !bDisputed(c.job.rrule)) {
            comparedB++;
            const wantB = materialise(b, c.range);
            if (JSON.stringify(wantB) !== JSON.stringify(actual))
              bNotes.push(
                `${what} [B, A ${JSON.stringify(want) === JSON.stringify(wantB) ? 'agrees with B' : 'agrees with module'}]: ${diff(wantB, actual)}`,
              );
          }
        } else if (b?.status === 'ok') {
          comparedB++;
          const wantB = materialise(b, c.range);
          if (JSON.stringify(wantB) !== JSON.stringify(actual))
            failures.push(`${what} [B only; A: ${a.error}]: ${diff(wantB, actual)}`);
        }
      }
      console.log(
        `fuzz seed ${SEED}: ${compared} series vs A (${occurrences} occurrences), ${comparedB} vs B; ${failures.length} failures, ${bNotes.length} B-only notes, ${aDefects.length} put down to dateutil's week-53 defect; oracle files in ${dir}`,
      );
      for (const n of bNotes.slice(0, 10)) console.log(`B note: ${n}`);
      for (const n of aDefects.slice(0, 10)) console.log(`A defect: ${n}`);
      assert.ok(
        compared >= N * 0.9,
        `only ${compared} of ${N} series were checked against oracle A`,
      );
      assert.deepEqual(failures.slice(0, 15), [], `${failures.length} failing series`);
    } finally {
      if (!process.env.APLOS_FUZZ_KEEP) rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------- hand checks ----------

const R2026 = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2036, 0, 1) };
const ids = (r: ExpandResult): string[] => r.occurrences.map(o => o.recurrenceId);
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
function allDay(date: string, rrule: string, extra: Partial<Series> = {}): Series {
  const end = new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  return { start: { date }, end: { date: end }, allDay: true, rrule, ...extra };
}

test('COUNT counts EXDATE-removed instances: EXDATE never gives a count back', () => {
  const r = expand({
    ...la('2026-03-02T09:00:00', 'FREQ=DAILY;COUNT=5', {
      exdate: ['EXDATE;TZID=America/Los_Angeles:20260303T090000'],
    }),
    range: R2026,
  });
  assert.deepEqual(ids(r), [
    '20260302T170000Z',
    '20260304T170000Z',
    '20260305T170000Z',
    '20260306T170000Z',
  ]);
});

test('UNTIL earlier than DTSTART: no occurrences, not even DTSTART', () => {
  const r = expand({
    ...la('2026-03-02T09:00:00', 'FREQ=DAILY;UNTIL=20260301T000000Z'),
    range: R2026,
  });
  assert.ok(r.ok);
  assert.deepEqual(ids(r), []);
});

test('negative BYSETPOS picks from the end of each month', () => {
  const r = expand({
    ...la('2026-01-01T09:00:00', 'FREQ=MONTHLY;COUNT=4;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2'),
    range: R2026,
  });
  // Second-to-last weekday: Thu 29 Jan, Thu 26 Feb, Mon 30 Mar, Wed 29 Apr 2026.
  assert.deepEqual(ids(r), [
    '20260129T170000Z',
    '20260226T170000Z',
    '20260330T160000Z',
    '20260429T160000Z',
  ]);
});

test('BYMONTHDAY=31 skips short months instead of clamping', () => {
  const r = expand({ ...allDay('2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=7'), range: R2026 });
  assert.deepEqual(ids(r), [
    '20260131',
    '20260331',
    '20260531',
    '20260731',
    '20260831',
    '20261031',
    '20261231',
  ]);
  const neg = expand({
    ...allDay('2026-01-01', 'FREQ=MONTHLY;BYMONTHDAY=-31;COUNT=3'),
    range: R2026,
  });
  assert.deepEqual(ids(neg), ['20260101', '20260301', '20260501']);
});

test('a leap-day yearly series skips non-leap years', () => {
  const r = expand({
    ...allDay('2024-02-29', 'FREQ=YEARLY;COUNT=3'),
    range: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2040, 0, 1) },
  });
  assert.deepEqual(ids(r), ['20240229', '20280229', '20320229']);
});

test('splitFollowing a COUNT series at its first and its last instance', () => {
  const s = la('2026-03-02T09:00:00', 'FREQ=DAILY;COUNT=5');
  const firstSplit = splitFollowing(s, '20260302T170000Z');
  assert.equal(firstSplit.ok, false);
  const last = splitFollowing(s, '20260306T170000Z');
  assert.ok(last.ok, last.ok ? '' : last.reason);
  assert.equal(last.after.rrule, 'FREQ=DAILY;COUNT=1');
  assert.deepEqual(last.after.start, { local: '2026-03-06T09:00:00', tzid: LA });
  assert.equal(last.before.rrule, 'FREQ=DAILY;UNTIL=20260306T165959Z');
  assert.deepEqual(
    [
      ...ids(expand({ ...last.before, range: R2026 })),
      ...ids(expand({ ...last.after, range: R2026 })),
    ],
    ids(expand({ ...s, range: R2026 })),
  );
});

test('an override whose recurrence id is not an instance changes nothing and cannot be created', () => {
  const s = la('2026-03-02T09:00:00', 'FREQ=WEEKLY;COUNT=4');
  const orphan = expand({
    ...s,
    overrides: [{ recurrenceId: '20260303T170000Z', start: { utc: Date.UTC(2026, 2, 20, 17) } }],
    range: R2026,
  });
  assert.deepEqual(ids(orphan), ids(expand({ ...s, range: R2026 })));
  assert.ok(orphan.occurrences.every(o => !o.overridden));
  const edited = editOccurrence(s, '20260303T170000Z', { cancelled: true });
  assert.equal(edited.ok, false);
  assert.equal(!edited.ok && edited.error, 'not-an-occurrence');
});

test('WEEKLY BYSETPOS counts the whole week holding DTSTART, not the part from DTSTART on (dateutil gets this wrong)', () => {
  // Week Wed 12 - Tue 18 Aug 2026 (WKST=WE) holds WE 12, FR 14, SA 15; position 1 is Wed 12, before
  // DTSTART, so that week gives nothing. dateutil 3.0.0 returns Sat 15 because it starts the week at DTSTART.
  const r = expand({
    ...allDay('2026-08-15', 'FREQ=WEEKLY;BYDAY=FR,WE,SA;WKST=WE;BYSETPOS=1;COUNT=3'),
    range: R2026,
  });
  assert.deepEqual(ids(r), ['20260819', '20260826', '20260902']);
});

test('BYWEEKNO=53 only names weeks that exist (dateutil calls week 52 of 2026 "53" with WKST=SU)', () => {
  // WKST=SU: 2025 has 53 weeks (28 Dec 2025 - 3 Jan 2026 is week 53); 2026 has 52, so 1-2 Jan 2027 are week 52.
  const r = expand({
    ...allDay('2024-07-20', 'FREQ=YEARLY;BYWEEKNO=53;WKST=SU;COUNT=9'),
    range: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2040, 0, 1) },
  });
  assert.deepEqual(ids(r), [
    '20251228',
    '20251229',
    '20251230',
    '20251231',
    '20260101',
    '20260102',
    '20260103',
    '20311228',
    '20311229',
  ]);
  assert.deepEqual(rfcWeekNumbers(Date.UTC(2027, 0, 1), 6), [52, -1]);
});

test('limit exhaustion: exactly `limit` occurrences and truncated', () => {
  const r = expand({ ...la('2026-01-05T09:00:00', 'FREQ=DAILY'), range: R2026, limit: 10 });
  assert.equal(r.occurrences.length, 10);
  assert.ok(r.ok && r.truncated);
});

test('limit exhaustion: truncated is true even when the next instance after the limit is excluded', () => {
  // Weekly, limit 2: 5 and 12 Jan are returned, 19 Jan is excluded, 26 Jan onwards still exist.
  const r = expand({
    ...la('2026-01-05T09:00:00', 'FREQ=WEEKLY', {
      exdate: ['EXDATE;TZID=America/Los_Angeles:20260119T090000'],
    }),
    range: R2026,
    limit: 2,
  });
  assert.equal(r.occurrences.length, 2);
  assert.ok(r.ok && r.truncated, 'more occurrences exist after the limit, so the result was cut');
});

test('limit exhaustion: truncated is true when the next instance after the limit is cancelled', () => {
  const r = expand({
    ...la('2026-01-05T09:00:00', 'FREQ=WEEKLY', {
      overrides: [{ recurrenceId: '20260119T170000Z', cancelled: true }],
    }),
    range: R2026,
    limit: 2,
  });
  assert.equal(r.occurrences.length, 2);
  assert.ok(r.ok && r.truncated);
});

test('Google instance ids around DST (gap, overlap, southern hemisphere, all-day)', () => {
  const at = (series: Series, from: string, to: string): string[] =>
    ids(expand({ ...series, range: { from: Date.parse(from), to: Date.parse(to) } })).map(k =>
      googleInstanceId('evt', k),
    );
  // LA spring forward 8 Mar 2026: 02:30 does not exist, so it is 03:30 PDT = 10:30Z.
  assert.deepEqual(
    at(la('2026-03-07T02:30:00', 'FREQ=DAILY;COUNT=3'), '2026-03-01', '2026-03-31'),
    ['evt_20260307T103000Z', 'evt_20260308T103000Z', 'evt_20260309T093000Z'],
  );
  // LA fall back 1 Nov 2026: 01:30 happens twice; the first (PDT, 08:30Z) is the occurrence.
  assert.deepEqual(
    at(la('2026-10-31T01:30:00', 'FREQ=DAILY;COUNT=3'), '2026-10-01', '2026-11-30'),
    ['evt_20261031T083000Z', 'evt_20261101T083000Z', 'evt_20261102T093000Z'],
  );
  // Sydney spring forward 4 Oct 2026 (02:00 -> 03:00 AEDT) and fall back 5 Apr 2026 (03:00 -> 02:00).
  const syd = (local: string): Series => ({
    start: { local, tzid: 'Australia/Sydney' },
    end: {
      local: local.replace(/T\d\d/, m => `T${pad(Number(m.slice(1)) + 1)}`),
      tzid: 'Australia/Sydney',
    },
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=3',
  });
  assert.deepEqual(at(syd('2026-10-03T02:30:00'), '2026-09-01', '2026-11-30'), [
    'evt_20261002T163000Z',
    'evt_20261003T163000Z',
    'evt_20261004T153000Z',
  ]);
  assert.deepEqual(at(syd('2026-04-04T02:30:00'), '2026-03-01', '2026-05-30'), [
    'evt_20260403T153000Z',
    'evt_20260404T153000Z',
    'evt_20260405T163000Z',
  ]);
  // Lord Howe moves by 30 minutes: 02:15 on 4 Oct 2026 does not exist (02:00 -> 02:30).
  const lhi: Series = {
    start: { local: '2026-10-03T02:15:00', tzid: 'Australia/Lord_Howe' },
    end: { local: '2026-10-03T03:15:00', tzid: 'Australia/Lord_Howe' },
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=3',
  };
  assert.deepEqual(at(lhi, '2026-09-01', '2026-11-30'), [
    'evt_20261002T154500Z',
    'evt_20261003T154500Z',
    'evt_20261004T151500Z',
  ]);
  // All-day instance ids are dates, whatever the DST change that day.
  assert.deepEqual(at(allDay('2026-03-07', 'FREQ=DAILY;COUNT=3'), '2026-03-01', '2026-03-31'), [
    'evt_20260307',
    'evt_20260308',
    'evt_20260309',
  ]);
  assert.equal(
    googleInstanceId('evt', { local: '2026-03-08T02:30:00', tzid: LA }),
    'evt_20260308T103000Z',
  );
});

test('a DTSTART given as the second 01:30 of a fall-back night stays at that instant', () => {
  // 09:30Z on 1 Nov 2026 is 01:30 PST, the SECOND 01:30 in Los Angeles. The event starts there, and
  // Google's instance id for it is ..._20261101T093000Z, so the first occurrence must be 09:30Z.
  const start = Date.UTC(2026, 10, 1, 9, 30);
  const single = expand({
    start: { utc: start },
    end: { utc: start + 1_800_000 },
    tzid: LA,
    allDay: false,
    range: R2026,
  });
  assert.deepEqual(
    single.occurrences.map(o => o.start),
    [{ utc: start }],
  );
  const series = expand({
    start: { utc: start },
    end: { utc: start + 1_800_000 },
    tzid: LA,
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=2',
    range: R2026,
  });
  assert.equal(ids(series)[0], '20261101T093000Z');
});

test('splitFollowing at an occurrence that fell in a DST gap', () => {
  // Daily 02:30 LA; 8 Mar 2026's occurrence is 03:30 PDT (10:30Z). The new series must keep 02:30.
  const s = la('2026-03-01T02:30:00', 'FREQ=DAILY;COUNT=20');
  const r = splitFollowing(s, '20260308T103000Z');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(
    [...ids(expand({ ...r.before, range: R2026 })), ...ids(expand({ ...r.after, range: R2026 }))],
    ids(expand({ ...s, range: R2026 })),
  );
});

test('a garbled override id far in the future does not stall expansion', () => {
  const t0 = performance.now();
  const r = expand({
    ...la('2026-01-01T09:00:00', 'FREQ=DAILY', {
      overrides: [{ recurrenceId: '99991231T170000Z', cancelled: true }],
    }),
    range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) },
  });
  const ms = performance.now() - t0;
  assert.equal(r.occurrences.length, 31);
  assert.ok(ms < 1000, `one month took ${ms.toFixed(0)} ms`);
});

test('a DAILY rule that is SECONDLY in disguise does not stall expansion', () => {
  // HOURLY and finer are refused, but DAILY with BYHOUR, BYMINUTE and BYSECOND lists produces 86,400
  // instances a day and every one before the range is generated. One day of history:
  const all = (n: number): string => Array.from({ length: n }, (_, i) => i).join(',');
  const t0 = performance.now();
  const r = expand({
    start: { local: '2026-10-26T00:00:00', tzid: LA },
    end: { local: '2026-10-26T00:00:01', tzid: LA },
    allDay: false,
    rrule: `FREQ=DAILY;BYHOUR=${all(24)};BYMINUTE=${all(60)};BYSECOND=${all(60)}`,
    range: { from: Date.UTC(2026, 9, 27, 12), to: Date.UTC(2026, 9, 27, 13) },
  });
  const ms = performance.now() - t0;
  // More than 24 start times a day is HOURLY or finer in effect, refused like FREQ=HOURLY; the
  // master's own start is not in this range, so nothing is shown.
  assert.ok(!r.ok && r.refused === 'unsupported', r.ok ? 'expanded' : r.reason);
  assert.deepEqual(r.occurrences, []);
  assert.ok(ms < 1000, `one hour of a rule starting a day earlier took ${ms.toFixed(0)} ms`);
});
