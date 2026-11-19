/**
 * A stored master turned into one normalised shape: which clock it repeats on, its rule, and its
 * RDATE, EXDATE and override instants as occurrence keys. Expansion and the edit helpers share it.
 */
import { timesPerDay } from './generate';
import { EXPANDABLE, Refusal, fail, parseRRule, type Rule } from './rule';
import {
  DAY_MS,
  dateKey,
  dayOfWall,
  isoDate,
  isoLocal,
  parseIcalValue,
  parseOffsetTime,
  utcKey,
  valueMs,
  wallKey,
  type IcalValue,
} from './time';
import type { EventTime, Override, Series } from './types';
import { fromWall, isKnownZone, toWall } from './zone';

/** A rule may start at most this many times on one day: hourly, the finest FREQ Aplos would accept. */
export const MAX_TIMES_PER_DAY = 24;

/** zoned: a wall clock in a real zone (UTC included); floating: no zone; date: all-day. */
export type Mode = 'zoned' | 'floating' | 'date';

/** One instant of the series: its key, wall reading in the series clock, and place on the timeline. */
export interface Inst {
  key: string;
  wall: number;
  at: number;
}

export interface Placed {
  time: EventTime;
  at: number;
}

export interface NormalOverride {
  inst: Inst;
  start?: Placed;
  end?: Placed;
  cancelled: boolean;
}

export interface Normal {
  mode: Mode;
  /** The series' zone (zoned) or the zone floating and all-day times are placed in. */
  tz: string;
  floatingZone: string;
  startWall: number;
  /**
   * The first instance's exact instant when the start was given as one ({utc}). Needed on a
   * fall-back night: 09:30Z in Los Angeles reads 01:30, and reading 01:30 back gives the FIRST
   * 01:30 (08:30Z), but the event starts at the second, and Google's instance id says so.
   */
  startAt?: number;
  /** Exact ms for zoned series (RFC 5545: DTEND gives an exact duration); wall ms otherwise. */
  duration: number;
  rule?: Rule;
  rdates: Inst[];
  exKeys: Set<string>;
  overrides: Map<string, NormalOverride>;
}

export type Prepared =
  | { ok: true; normal: Normal }
  /** `normal` is present when the start itself was usable, so the first instance can still be shown. */
  | { ok: false; refused: 'unsupported' | 'invalid'; reason: string; normal?: Normal };

function parseEventTime(t: EventTime): { value: IcalValue; tzid?: string } {
  const value =
    'utc' in t
      ? Number.isFinite(t.utc)
        ? ({ kind: 'utc', ms: t.utc } as const)
        : undefined
      : parseIcalValue('date' in t ? t.date : t.local);
  // { date } must hold a DATE and { local } a DATE-TIME.
  if (!value || 'date' in t !== (value.kind === 'date')) fail(`bad time ${JSON.stringify(t)}`);
  return { value, tzid: 'local' in t ? t.tzid : undefined };
}

function zone(tz: string): string {
  if (!isKnownZone(tz)) fail(`unknown time zone ${tz}`);
  return tz;
}

/** Key and timeline place for a wall reading on the series clock. */
export function instAt(n: Normal, wall: number): Inst {
  if (n.mode === 'zoned') {
    const at = wall === n.startWall && n.startAt !== undefined ? n.startAt : fromWall(wall, n.tz);
    return { key: utcKey(at), wall, at };
  }
  const at = fromWall(wall, n.floatingZone);
  return { key: n.mode === 'date' ? dateKey(dayOfWall(wall)) : wallKey(wall), wall, at };
}

/**
 * A DATE or DATE-TIME (RECURRENCE-ID, RDATE or EXDATE value) as an instant of this series.
 * Mismatched forms are read leniently, the way servers write them: a DATE on a timed series means
 * that day at the series' time, a time on an all-day series means its date, and a UTC time on a
 * floating series is read as a plain wall reading.
 */
export function instOf(n: Normal, value: IcalValue, tzid?: string): Inst {
  if (n.mode === 'date') return instAt(n, dayOfWall(valueMs(value)) * DAY_MS);
  if (value.kind === 'date')
    return instAt(n, valueMs(value) + n.startWall - dayOfWall(n.startWall) * DAY_MS);
  if (n.mode === 'floating') return instAt(n, valueMs(value));
  if (value.kind === 'local' && (!tzid || tzid === n.tz)) return instAt(n, value.wall);
  const at = value.kind === 'utc' ? value.ms : fromWall(value.wall, zone(tzid!));
  return { key: utcKey(at), wall: toWall(at, n.tz), at };
}

/** Normalises a recurrence id given as an EventTime, a key, or an RFC 3339 time (Google's originalStartTime). */
export function instOfId(n: Normal, id: string | EventTime): Inst {
  const { value, tzid } =
    typeof id === 'string'
      ? { value: parseIcalValue(id) ?? parseOffsetTime(id), tzid: undefined }
      : parseEventTime(id);
  if (!value) fail(`bad occurrence key ${id}`);
  return instOf(n, value, tzid);
}

/** An override's own start or end, as the occurrence will report it. */
function place(n: Normal, t: EventTime): Placed {
  const { value, tzid } = parseEventTime(t);
  if (value.kind === 'utc') return { time: { utc: value.ms }, at: value.ms };
  if (value.kind === 'date')
    return { time: { date: isoDate(value.day) }, at: fromWall(value.day * DAY_MS, n.floatingZone) };
  const tz = tzid ?? (n.mode === 'zoned' ? n.tz : undefined);
  if (tz) {
    const at = fromWall(value.wall, zone(tz));
    return { time: { utc: at }, at };
  }
  return { time: { local: isoLocal(value.wall) }, at: fromWall(value.wall, n.floatingZone) };
}

/** An override start moved on by the series duration, in its own kind (an all-day start on a timed series gets one day). */
export function shift(n: Normal, p: Placed): Placed {
  const t = p.time;
  if ('utc' in t) return place(n, { utc: t.utc + n.duration });
  if ('date' in t)
    return place(n, {
      date: isoDate(
        dayOfWall(valueMs(parseIcalValue(t.date)!)) +
          (n.mode === 'date' ? Math.round(n.duration / DAY_MS) : 1),
      ),
    });
  return place(n, { local: isoLocal(valueMs(parseIcalValue(t.local)!) + n.duration) });
}

/** 'EXDATE;TZID=Europe/London:20261025T013000,20261101T013000' or a bare value list. */
export function parseDateLine(line: string): {
  prefix?: string;
  params: Map<string, string>;
  values: string[];
} {
  const m = /^([A-Z-]+(?:;[^:]*)?):(.*)$/i.exec(line);
  const params = new Map<string, string>();
  for (const item of m ? m[1].split(';').slice(1) : []) {
    const [k, v = ''] = item.split('=');
    params.set(k.toUpperCase(), v.replace(/"/g, ''));
  }
  return {
    prefix: m?.[1],
    params,
    values: (m ? m[2] : line)
      .split(',')
      .map(v => v.trim())
      .filter(Boolean),
  };
}

function datedInsts(n: Normal, lines: string[] | undefined, what: string): Inst[] {
  return (lines ?? []).flatMap(line => {
    const { params, values } = parseDateLine(line);
    // RDATE;VALUE=PERIOD gives each extra instance its own end; no provider Aplos syncs writes it.
    if (params.get('VALUE')?.toUpperCase() === 'PERIOD')
      fail(`${what};VALUE=PERIOD`, 'unsupported');
    const tzid = params.get('TZID');
    return values.map(raw => {
      const value = parseIcalValue(raw);
      if (!value) fail(`bad ${what} ${raw}`);
      return instOf(n, value, tzid && zone(tzid));
    });
  });
}

function rulesOf(rrule: Series['rrule']): string[] {
  return (Array.isArray(rrule) ? rrule : rrule === undefined ? [] : [rrule])
    .map(r => r.trim())
    .filter(Boolean);
}

/** The master's clock, start and duration, before any dated instance is read. */
function baseNormal(series: Series, floatingZone: string): Normal {
  zone(floatingZone);
  const start = parseEventTime(series.start);
  const end = parseEventTime(series.end);
  if (series.allDay !== (start.value.kind === 'date')) fail('allDay must match a { date } start');
  if ((start.value.kind === 'date') !== (end.value.kind === 'date'))
    fail('start and end must both be dates or both be times');
  const tzid = start.tzid ?? series.tzid;
  const zoned = start.value.kind === 'utc' || (start.value.kind === 'local' && tzid !== undefined);
  const mode: Mode = start.value.kind === 'date' ? 'date' : zoned ? 'zoned' : 'floating';
  const tz = zoned ? zone(tzid ?? 'UTC') : floatingZone;
  // A zoned start inside a DST gap repeats at its written wall time, so the wall is kept as given.
  const startWall = start.value.kind === 'utc' ? toWall(start.value.ms, tz) : valueMs(start.value);
  // Start and end may name different zones; the exact gap between the two instants is the duration.
  const instant = (t: typeof start): number =>
    t.value.kind === 'utc' ? t.value.ms : fromWall(valueMs(t.value), zone(t.tzid ?? tz));
  const duration = zoned ? instant(end) - instant(start) : valueMs(end.value) - startWall;
  const normal: Normal = {
    mode,
    tz,
    floatingZone,
    startWall,
    duration: Math.max(0, duration),
    startAt: zoned && start.value.kind === 'utc' ? start.value.ms : undefined,
    rdates: [],
    exKeys: new Set(),
    overrides: new Map(),
  };
  return normal;
}

/** Reads RDATE, EXDATE and overrides into the master. May throw a Refusal part-way. */
function addDated(normal: Normal, series: Series): void {
  normal.rdates = datedInsts(normal, series.rdate, 'RDATE');
  normal.exKeys = new Set(datedInsts(normal, series.exdate, 'EXDATE').map(i => i.key));
  for (const o of series.overrides ?? []) normal.overrides.set(...normalOverride(normal, o));
}

/** Checks the series' RRULE against the normalised master and attaches a usable rule. */
function withRule(series: Series, normal: Normal): Prepared {
  const rules = rulesOf(series.rrule);
  if (rules.length > 1)
    return { ok: false, refused: 'unsupported', reason: 'more than one RRULE', normal };
  if (rules.length === 0) return { ok: true, normal };
  const parsed = parseRRule(rules[0]);
  if (!parsed.ok) return { ok: false, refused: parsed.error, reason: parsed.reason, normal };
  const rule = parsed.rule;
  if (
    normal.mode === 'date' &&
    (rule.byHour.length || rule.byMinute.length || rule.bySecond.length)
  ) {
    return {
      ok: false,
      refused: 'invalid',
      reason: 'BYHOUR, BYMINUTE and BYSECOND need a timed start',
      normal,
    };
  }
  if (!EXPANDABLE.has(rule.freq))
    return {
      ok: false,
      refused: 'unsupported',
      reason: `FREQ=${rule.freq} is not expanded`,
      normal,
    };
  // DAILY;BYHOUR=0..23;BYMINUTE=0..59 is MINUTELY in disguise (86,400 a day with BYSECOND), and one
  // such invite would stall expansion. More than once an hour is refused like HOURLY and finer.
  if (timesPerDay(rule) > MAX_TIMES_PER_DAY) {
    return {
      ok: false,
      refused: 'unsupported',
      reason: `more than ${MAX_TIMES_PER_DAY} start times a day (HOURLY or finer in effect)`,
      normal,
    };
  }
  normal.rule = rule;
  return { ok: true, normal };
}

/** Normalises a master. Never throws: bad input comes back as a typed refusal. */
export function prepare(series: Series, floatingZone = 'UTC'): Prepared {
  let normal: Normal | undefined;
  try {
    // Assigned before the dated instances are read, so an unsupported RDATE still returns the
    // master and its first instance (DTSTART) can be shown.
    normal = baseNormal(series, floatingZone);
    addDated(normal, series);
  } catch (err) {
    if (err instanceof Refusal)
      return {
        ok: false,
        refused: err.kind,
        reason: err.message,
        normal: err.kind === 'unsupported' ? normal : undefined,
      };
    if (err instanceof RangeError) return { ok: false, refused: 'invalid', reason: err.message };
    throw err;
  }
  return withRule(series, normal);
}

function normalOverride(n: Normal, o: Override): [string, NormalOverride] {
  const inst = instOfId(n, o.recurrenceId);
  return [
    inst.key,
    {
      inst,
      start: o.start ? place(n, o.start) : undefined,
      end: o.end ? place(n, o.end) : undefined,
      cancelled: o.cancelled === true,
    },
  ];
}

/**
 * Whether a rule instance at `wall` falls after UNTIL. UNTIL normally has DTSTART's form; other
 * forms are read leniently: a DATE keeps that whole day, a floating time compares wall readings.
 */
export function pastUntil(n: Normal, wall: number): boolean {
  const u = n.rule?.until;
  if (!u) return false;
  if (u.kind === 'date' || n.mode === 'date') return dayOfWall(wall) > dayOfWall(valueMs(u));
  if (u.kind === 'local' || n.mode === 'floating') return wall > valueMs(u);
  // Zoned against a UTC UNTIL: offsets never exceed 14 hours, so only readings near UNTIL need a zone lookup.
  const SLACK = 15 * 3_600_000;
  if (wall + SLACK <= u.ms) return false;
  if (wall - SLACK > u.ms) return true;
  return fromWall(wall, n.tz) > u.ms;
}
