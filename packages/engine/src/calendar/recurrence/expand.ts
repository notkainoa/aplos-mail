/**
 * Expansion on query (ADR-20): the occurrences of one stored master that overlap a range, with
 * RDATE added, EXDATE removed and overrides applied, in start order and never more than `limit`.
 */
import { ruleWalls } from './generate';
import { instAt, pastUntil, prepare, shift, type Inst, type Normal, type Placed } from './series';
import { DAY_MS, dayOfWall, isoDate, isoLocal } from './time';
import type { ExpandRequest, ExpandResult, Occurrence } from './types';

export const DEFAULT_LIMIT = 5_000;
/** Wider than any zone offset (±14 h), so a wall reading outside it cannot reach the range. */
const SLACK = 2 * DAY_MS;

interface Placement {
  occurrence: Occurrence;
  at: number;
  endAt: number;
}

/** The plain (not overridden) occurrence for an instance. */
function plain(n: Normal, inst: Inst): Placement {
  const endWall = inst.wall + n.duration;
  const endAt = n.mode === 'zoned' ? inst.at + n.duration : instAt(n, endWall).at;
  const time = (wall: number, at: number) =>
    n.mode === 'zoned'
      ? { utc: at }
      : n.mode === 'date'
        ? { date: isoDate(dayOfWall(wall)) }
        : { local: isoLocal(wall) };
  return {
    occurrence: {
      recurrenceId: inst.key,
      start: time(inst.wall, inst.at),
      end: time(endWall, endAt),
      overridden: false,
    },
    at: inst.at,
    endAt,
  };
}

/** Applies an override, or returns undefined when it cancels the occurrence. */
function resolve(n: Normal, inst: Inst): Placement | undefined {
  const o = n.overrides.get(inst.key);
  if (!o) return plain(n, inst);
  if (o.cancelled) return undefined;
  const base = plain(n, inst);
  const start: Placed = o.start ?? { time: base.occurrence.start, at: base.at };
  const end: Placed =
    o.end ?? (o.start ? shift(n, o.start) : { time: base.occurrence.end, at: base.endAt });
  return {
    occurrence: { recurrenceId: inst.key, start: start.time, end: end.time, overridden: true },
    at: start.at,
    endAt: end.at,
  };
}

function overlaps(p: Placement, from: number, to: number): boolean {
  // A zero-length occurrence counts when its start is inside the range.
  return p.endAt > p.at ? p.at < to && p.endAt > from : p.at >= from && p.at < to;
}

export function expand(req: ExpandRequest): ExpandResult {
  const { from, to } = req.range;
  // A NaN or infinite bound would walk the rule to year 9999 and return nothing.
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return { ok: false, refused: 'invalid', reason: `bad range ${from} to ${to}`, occurrences: [] };
  }
  const prepared = prepare(req, req.floatingZone ?? 'UTC');
  const limit = Math.max(0, Math.floor(req.limit ?? DEFAULT_LIMIT));
  if (prepared.ok) return { ok: true, ...expandNormal(prepared.normal, from, to, limit) };
  const n = prepared.normal;
  const first = n && plain(n, instAt(n, n.startWall));
  const occurrences = first && limit > 0 && overlaps(first, from, to) ? [first.occurrence] : [];
  return { ok: false, refused: prepared.refused, reason: prepared.reason, occurrences };
}

/** Occurrence keys of the recurrence set alone (overrides ignored) overlapping [from, to). */
export const instanceKeys = (n: Normal, from: number, to: number): string[] =>
  expandNormal({ ...n, overrides: new Map() }, from, to, 20_000).occurrences.map(
    o => o.recurrenceId,
  );

/** Rule walls (or the lone start) from about `fromDay` to `toDay`; may begin earlier, never later. */
function walls(n: Normal, fromDay: number, toDay: number): Iterable<number> {
  return n.rule ? ruleWalls(n.rule, n.startWall, toDay, n.mode === 'date', fromDay) : [n.startWall];
}

/** The instance whose key is `key`, looking at rule walls within a day of `wall`, or undefined. */
function ruleInstNear(n: Normal, key: string, wall: number): Inst | undefined {
  for (const w of walls(n, dayOfWall(wall) - 1, dayOfWall(wall) + 1)) {
    if (pastUntil(n, w) || w > wall + DAY_MS) return undefined;
    if (w < wall - DAY_MS) continue;
    const inst = instAt(n, w);
    if (inst.key === key) return inst;
  }
  return undefined;
}

/** Rule instances inside the widened range, in wall order, stopping a day past `limit` shown ones. */
function ruleInstances(
  n: Normal,
  lo: number,
  hi: number,
  from: number,
  to: number,
  limit: number,
): { found: Map<string, Inst>; truncated: boolean } {
  const found = new Map<string, Inst>();
  let truncated = false;
  let counted = 0;
  let limitWall = Infinity;
  for (const wall of walls(n, dayOfWall(lo), dayOfWall(hi))) {
    if (pastUntil(n, wall) || wall > hi) break;
    if (wall < lo) continue;
    const inst = instAt(n, wall);
    if (found.has(inst.key)) continue;
    const p = resolve(n, inst);
    const shown = p !== undefined && !n.exKeys.has(inst.key) && overlaps(p, from, to);
    // Past `limit` plain occurrences (plus a day, for DST reorderings) later ones can only sort after
    // them. The result was cut only if one of those later ones would be shown, so skip hidden ones.
    if (counted >= limit && wall > limitWall + DAY_MS) {
      if (shown) {
        truncated = true;
        break;
      }
      continue;
    }
    found.set(inst.key, inst);
    if (shown && !n.overrides.has(inst.key) && ++counted === limit) limitWall = wall;
  }
  return { found, truncated };
}

/** Overrides moved into the range, and RDATEs, collectable additions to `found`. */
function addDated(n: Normal, found: Map<string, Inst>, from: number, to: number): void {
  // An override moved into the range from elsewhere shows when its original start is an instance.
  // Only overrides that land in the range are looked up, so a far-off or invented id costs nothing.
  for (const [key, o] of n.overrides) {
    if (found.has(key) || o.cancelled) continue;
    const p = resolve(n, o.inst);
    if (!p || !overlaps(p, from, to)) continue;
    const inst = ruleInstNear(n, key, o.inst.wall);
    if (inst) found.set(key, inst);
  }
  for (const inst of n.rdates) if (!found.has(inst.key)) found.set(inst.key, inst);
}

function placements(n: Normal, found: Map<string, Inst>, from: number, to: number): Placement[] {
  const placed: Placement[] = [];
  for (const inst of found.values()) {
    const p = n.exKeys.has(inst.key) ? undefined : resolve(n, inst);
    if (p && overlaps(p, from, to)) placed.push(p);
  }
  placed.sort(
    (a, b) => a.at - b.at || (a.occurrence.recurrenceId < b.occurrence.recurrenceId ? -1 : 1),
  );
  return placed;
}

function expandNormal(
  n: Normal,
  from: number,
  to: number,
  limit: number,
): { occurrences: Occurrence[]; truncated: boolean } {
  const { found, truncated } = ruleInstances(
    n,
    from - n.duration - SLACK,
    to + SLACK,
    from,
    to,
    limit,
  );
  addDated(n, found, from, to);
  const placed = placements(n, found, from, to);
  return {
    occurrences: placed.slice(0, limit).map(p => p.occurrence),
    truncated: truncated || placed.length > limit,
  };
}
