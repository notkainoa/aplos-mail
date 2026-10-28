/**
 * Time zone offsets from the platform's own database through `Intl`, so the engine needs no
 * tz data of its own and works the same in Node, a browser or a mobile JS runtime.
 */
import { DAY_MS, dayFromCivil } from './time';

const UTC_NAMES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Z']);

/** Offset reader for one zone, or null for a name the runtime does not know. */
type Reader = (ms: number) => number;
const readers = new Map<string, Reader | null>();

/** Fast path: 'GMT-04:56:02' from timeZoneName 'longOffset' (ES2023 runtimes). */
export function offsetReader(tz: string): Reader {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  return ms => {
    const m = /GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(f.format(ms));
    if (!m) throw new RangeError(`Unreadable offset for ${tz}`);
    if (!m[1]) return 0;
    const size = ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000;
    return m[1] === '-' ? -size : size;
  };
}

/** Fallback for runtimes without 'longOffset': read the wall clock and subtract. */
export function partsReader(tz: string): Reader {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return ms => {
    const at = Math.floor(ms / 1000) * 1000;
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(at)) p[part.type] = Number(part.value);
    return (
      dayFromCivil(p.year, p.month, p.day) * DAY_MS +
      ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 -
      at
    );
  };
}

function reader(tz: string): Reader | null {
  let r = readers.get(tz);
  if (r === undefined) {
    r = null;
    for (const make of [offsetReader, partsReader]) {
      try {
        const candidate = make(tz);
        candidate(0);
        r = candidate;
        break;
      } catch {
        // An unknown zone, or a runtime without 'longOffset': try the next reader.
      }
    }
    readers.set(tz, r);
  }
  return r;
}

export const isKnownZone = (tz: string): boolean => UTC_NAMES.has(tz) || reader(tz) !== null;

/**
 * Per zone and UTC day: the day's offset when it is the same at both ends, or null on a day with a
 * transition. Intl lookups are slow (tens of µs) and expansion asks thousands of times, so a quiet
 * day is read once and only transition days are read per call.
 */
const days = new Map<string, Map<number, number | null>>();

/** Wall clock minus UTC, in ms, at the instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  if (UTC_NAMES.has(tz)) return 0;
  const read = reader(tz);
  if (!read) throw new RangeError(`Unknown time zone ${tz}`);
  let cache = days.get(tz);
  if (!cache) days.set(tz, (cache = new Map()));
  const day = Math.floor(ms / DAY_MS);
  let steady = cache.get(day);
  if (steady === undefined) {
    const start = read(day * DAY_MS);
    steady = start === read((day + 1) * DAY_MS) ? start : null;
    if (cache.size > 100_000) cache.clear();
    cache.set(day, steady);
  }
  return steady ?? read(ms);
}

export const toWall = (ms: number, tz: string): number => ms + offsetAt(ms, tz);

/**
 * The instant a zone's wall clock shows `wall`. RFC 5545 §3.3.5: a reading that happens twice
 * (clocks going back) is the first one; a reading that never happens (clocks going forward)
 * uses the offset from before the gap, which moves it forward by the gap's length.
 */
export function fromWall(wall: number, tz: string): number {
  if (UTC_NAMES.has(tz)) return wall;
  // Offsets a day either side bracket any single transition near this reading.
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  // The larger offset gives the earlier instant, so trying it first picks the first of two readings.
  for (const off of before === after
    ? [before]
    : [Math.max(before, after), Math.min(before, after)]) {
    if (offsetAt(wall - off, tz) === off) return wall - off;
  }
  return wall - before;
}
