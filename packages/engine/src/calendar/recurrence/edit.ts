/**
 * The three edit scopes (port EditScope): one occurrence becomes an override, the whole series
 * changes the master, and "this and following" splits the series in two. Each helper returns new
 * values and never mutates its input; a series that cannot be written back exactly is refused.
 */
import { instanceKeys } from './expand';
import { ruleWalls } from './generate';
import { formatRRule, type Rule } from './rule';
import {
  instAt,
  instOf,
  instOfId,
  parseDateLine,
  pastUntil,
  prepare,
  type Inst,
  type Normal,
} from './series';
import { DAY_MS, dayOfWall, isoDate, isoLocal, parseIcalValue } from './time';
import type { EventTime, Override, Series } from './types';
import { toWall } from './zone';

export interface OccurrenceChange {
  start?: EventTime;
  end?: EventTime;
  cancelled?: boolean;
}

/** Fields of the master a series edit may change; `rrule: null` makes it a single event. */
export type SeriesChange = Partial<
  Pick<Series, 'start' | 'end' | 'allDay' | 'tzid' | 'rdate' | 'exdate'>
> & {
  rrule?: Series['rrule'] | null;
};

export type EditOccurrenceResult =
  | { ok: true; series: Series; override: Override & { recurrenceId: string } }
  | { ok: false; error: 'not-an-occurrence' | 'invalid' | 'unsupported'; reason: string };

export type EditSeriesResult =
  | {
      ok: true;
      series: Series;
      /** Keys of overrides whose occurrence no longer exists. */ dropped: string[];
    }
  | { ok: false; error: 'invalid' | 'unsupported'; reason: string };

export type SplitResult =
  | { ok: true; before: Series; after: Series; dropped: string[] }
  | { ok: false; error: 'cannot-split'; reason: string };

const TEN_YEARS = 3653 * DAY_MS;

/** The key of the live occurrence named by `id`, or undefined (excluded and invented ids included). */
function findInstance(n: Normal, id: string | EventTime): string | undefined {
  try {
    const { key, at } = instOfId(n, id);
    return instanceKeys(n, at - DAY_MS, at + DAY_MS).find(k => k === key);
  } catch {
    return undefined;
  }
}

/** Creates or updates the override for one occurrence. */
export function editOccurrence(
  series: Series,
  recurrenceId: string | EventTime,
  change: OccurrenceChange,
): EditOccurrenceResult {
  const prepared = prepare(series);
  if (!prepared.ok) return { ok: false, error: prepared.refused, reason: prepared.reason };
  const n = prepared.normal;
  const key = findInstance(n, recurrenceId);
  if (!key) return { ok: false, error: 'not-an-occurrence', reason: 'no such occurrence' };
  const existing = (series.overrides ?? []).find(o => instOfId(n, o.recurrenceId).key === key);
  const override: Override & { recurrenceId: string } = change.cancelled
    ? { recurrenceId: key, cancelled: true }
    : { ...existing, ...change, recurrenceId: key, cancelled: false };
  if (!override.cancelled) delete override.cancelled;
  const others = (series.overrides ?? []).filter(o => o !== existing);
  return { ok: true, series: { ...series, overrides: [...others, override] }, override };
}

/** Changes the master; keeps each override whose original start is still an occurrence. */
export function editSeries(series: Series, change: SeriesChange): EditSeriesResult {
  const { rrule, ...rest } = change;
  const next: Series = {
    ...series,
    ...rest,
    rrule: rrule === null ? undefined : (rrule ?? series.rrule),
  };
  if (next.rrule === undefined) delete next.rrule;
  const old = prepare(series).normal;
  const prepared = prepare({ ...next, overrides: [] });
  if (!prepared.ok) return { ok: false, error: prepared.refused, reason: prepared.reason };
  const kept: Override[] = [];
  const dropped: string[] = [];
  for (const o of series.overrides ?? []) {
    // A move between timed and all-day changes every occurrence, so no override can carry over.
    if (old?.mode === prepared.normal.mode && findInstance(prepared.normal, o.recurrenceId))
      kept.push(o);
    else dropped.push(old ? instOfId(old, o.recurrenceId).key : JSON.stringify(o.recurrenceId));
  }
  return { ok: true, series: { ...next, overrides: kept }, dropped };
}

/** Rebuilds RDATE or EXDATE lines, keeping only values `keep` accepts. */
function filterLines(n: Normal, lines: string[] = [], keep: (inst: Inst) => boolean): string[] {
  return lines.flatMap(line => {
    const { prefix, params, values } = parseDateLine(line);
    const chosen = values
      .filter(v => keep(instOf(n, parseIcalValue(v)!, params.get('TZID'))))
      .join(',');
    return chosen ? [prefix ? `${prefix}:${chosen}` : chosen] : [];
  });
}

/** `like`'s EventTime kind, for the instant/wall reading given (an end: its zone may differ from the series'). */
function timeLike(n: Normal, like: EventTime, at: number, wall: number): EventTime {
  if ('utc' in like) return { utc: at };
  if ('date' in like) return { date: isoDate(dayOfWall(wall)) };
  const local = isoLocal(n.mode === 'zoned' ? toWall(at, like.tzid ?? n.tz) : wall);
  return like.tzid ? { local, tzid: like.tzid } : { local };
}

/**
 * The new master's start: the split's own wall reading on the series clock, not its instant read
 * back. On a spring-forward day a 02:30 series' occurrence is at 03:30, and a series written to
 * start at 03:30 would repeat at 03:30 from then on. A {utc} start cannot hold a reading that
 * never happens, so that one case becomes a zoned local start.
 */
function startLike(n: Normal, like: EventTime, split: Inst): EventTime {
  if (n.mode !== 'zoned' || 'date' in like) return timeLike(n, like, split.at, split.wall);
  if ('utc' in like)
    return toWall(split.at, n.tz) === split.wall
      ? { utc: split.at }
      : { local: isoLocal(split.wall), tzid: n.tz };
  // A zoned series' start is in the series zone (`tz` is the start's own tzid, or the series tzid).
  return like.tzid
    ? { local: isoLocal(split.wall), tzid: like.tzid }
    : { local: isoLocal(split.wall) };
}

function untilBefore(n: Normal, split: Inst): Rule['until'] {
  if (n.mode === 'date') return { kind: 'date', day: dayOfWall(split.wall) - 1 };
  // RFC 5545: UNTIL is UTC when DTSTART has a zone, and floating when DTSTART is floating.
  return n.mode === 'zoned'
    ? { kind: 'utc', ms: split.at - 1000 }
    : { kind: 'local', wall: split.wall - 1000 };
}

/**
 * "This and following": the original master ends with UNTIL just before the split occurrence, and a
 * new master starts there with the remaining COUNT (or the same UNTIL). `change` is then applied
 * to the new master as a series edit.
 */
export function splitFollowing(
  series: Series,
  recurrenceId: string | EventTime,
  change: SeriesChange = {},
): SplitResult {
  const refuse = (reason: string): SplitResult => ({ ok: false, error: 'cannot-split', reason });
  const prepared = prepare(series);
  if (!prepared.ok) return refuse(`the series is refused: ${prepared.reason}`);
  const n = prepared.normal;
  if (!n.rule) return refuse('the event does not repeat');
  let target: Inst;
  try {
    target = instOfId(n, recurrenceId);
  } catch {
    return refuse('the occurrence id is not a date or date-time');
  }
  if (n.exKeys.has(target.key)) return refuse('that occurrence is excluded');

  // Without COUNT only "is it the first?" matters, so the walk may jump to the target (a far-off
  // id must not walk decades of instances); with COUNT every earlier instance is counted.
  const lastDay = dayOfWall(target.wall) + 2;
  const firstWall = ruleWalls(n.rule, n.startWall, lastDay, n.mode === 'date').next().value;
  let earlier = 0;
  let split: Inst | undefined;
  for (const wall of ruleWalls(
    n.rule,
    n.startWall,
    lastDay,
    n.mode === 'date',
    dayOfWall(target.wall) - 2,
  )) {
    if (pastUntil(n, wall) || wall > target.wall + 2 * DAY_MS) break;
    const inst = instAt(n, wall);
    if (inst.key === target.key) {
      split = inst;
      break;
    }
    earlier++;
  }
  if (!split) {
    return refuse(
      n.rdates.some(r => r.key === target.key)
        ? 'an RDATE-only occurrence cannot start a series'
        : 'the series has no such occurrence',
    );
  }
  if (split.wall === firstWall)
    return refuse('this is the first occurrence: edit the whole series instead');
  const at = split.at;

  // Both halves are re-parsed from this text below, so a rule that did not survive formatting fails the check.
  const beforeRule = formatRRule({ ...n.rule, count: undefined, until: untilBefore(n, split) });
  const afterRule = formatRRule({
    ...n.rule,
    count: n.rule.count === undefined ? undefined : n.rule.count - earlier,
  });

  // Each half keeps the RDATEs, EXDATEs and overrides on its side of the split.
  const half = (keep: (i: Inst) => boolean, fields: Partial<Series>): Series => {
    const out: Series = {
      ...series,
      ...fields,
      overrides: (series.overrides ?? []).filter(o => keep(instOfId(n, o.recurrenceId))),
    };
    for (const k of ['rdate', 'exdate'] as const) {
      const lines = filterLines(n, series[k], keep);
      if (lines.length) out[k] = lines;
      else delete out[k];
    }
    return out;
  };
  const before = half(i => i.at < at, { rrule: beforeRule });
  const after = half(i => i.at >= at, {
    start: startLike(n, series.start, split),
    end: timeLike(n, series.end, at + n.duration, split.wall + n.duration),
    rrule: afterRule,
  });

  // Never write a split that changes which occurrences exist: compare against the original.
  const pb = prepare(before);
  const pa = prepare(after);
  if (!pb.ok || !pa.ok) return refuse('a half of the split does not parse');
  // Ten years either side: earlier instances come from the unchanged rule and DTSTART, so they match
  // by construction, and a long-running series stays inside instanceKeys' limit.
  const from = Math.max(instAt(n, n.startWall).at - DAY_MS, at - TEN_YEARS);
  const to = at + TEN_YEARS;
  const original = instanceKeys(n, from, to).join();
  if (
    original !== [...instanceKeys(pb.normal, from, to), ...instanceKeys(pa.normal, from, to)].join()
  ) {
    return refuse('the halves would not reproduce the original occurrences');
  }

  const edited = editSeries(after, change);
  if (!edited.ok) return refuse(`the change is refused: ${edited.reason}`);
  return { ok: true, before, after: edited.series, dropped: edited.dropped };
}
