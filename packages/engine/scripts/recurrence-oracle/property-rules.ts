/**
 * Seeded random recurring events inside oracle B's subset (FREQ DAILY to YEARLY, INTERVAL, COUNT,
 * UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), over three years each.
 * Where B reads RFC 5545 differently (YEARLY ordinals or BYMONTHDAY without BYMONTH, BYSETPOS
 * outside MONTHLY or across several months) the generator stays out, so a mismatch is a real bug.
 */
import type { CaseEvent } from './cases';

export interface PropertyRule {
  id: string;
  event: CaseEvent;
  /** Range in ms: the series start's day to three years later. */
  from: number;
  to: number;
}

/** mulberry32: a tiny deterministic PRNG, so the sweep is the same on every run. */
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

const ZONES = [
  'America/Los_Angeles',
  'Europe/London',
  'Australia/Sydney',
  'America/New_York',
  'Asia/Kolkata',
  'UTC',
  'floating',
  'all-day',
];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const YEAR = 365.25 * 86_400_000;

/** The draws the rule-part builders share (bound to propertyRules' seeded prng). */
interface Draws {
  rnd: () => number;
  int: (lo: number, hi: number) => number;
  pick: <T>(xs: readonly T[]) => T;
  some: <T>(xs: readonly T[], k: number) => T[];
}

function dailyParts(parts: string[], r: Draws): void {
  if (r.rnd() < 0.3) parts.push(`BYDAY=${r.some(DAYS, r.int(1, 3)).join(',')}`);
  if (r.rnd() < 0.2)
    parts.push(`BYMONTHDAY=${r.some([1, 10, 15, 28, 31, -1, -2], r.int(1, 2)).join(',')}`);
  if (r.rnd() < 0.2) parts.push(`BYMONTH=${r.some([1, 3, 6, 10, 11, 12], r.int(1, 3)).join(',')}`);
}

function weeklyParts(parts: string[], r: Draws): void {
  if (r.rnd() < 0.8) parts.push(`BYDAY=${r.some(DAYS, r.int(1, 4)).join(',')}`);
  if (r.rnd() < 0.5) parts.push(`WKST=${r.pick(DAYS)}`);
  if (r.rnd() < 0.15) parts.push(`BYMONTH=${r.some([2, 3, 4, 10, 11], r.int(1, 2)).join(',')}`);
}

function monthlyParts(parts: string[], r: Draws): void {
  const shape = r.int(0, 5);
  if (shape === 1)
    parts.push(`BYMONTHDAY=${r.some([1, 5, 15, 29, 30, 31, -1, -3, -10], r.int(1, 3)).join(',')}`);
  if (shape === 2)
    parts.push(
      `BYDAY=${r
        .some([1, 2, 3, 4, 5, -1, -2], r.int(1, 2))
        .map(o => `${o}${r.pick(DAYS)}`)
        .join(',')}`,
    );
  if (shape === 3)
    parts.push(
      `BYDAY=${r.some(DAYS, r.int(2, 5)).join(',')}`,
      `BYSETPOS=${r.some([1, 2, -1, -2], r.int(1, 2)).join(',')}`,
    );
  if (shape === 4)
    parts.push(
      `BYDAY=${r.some(DAYS, r.int(1, 2)).join(',')}`,
      `BYMONTHDAY=${r.some([1, 7, 13, 20, -1], r.int(1, 3)).join(',')}`,
    );
  if (shape === 5) parts.push(`BYDAY=${r.some(DAYS, r.int(1, 3)).join(',')}`);
  if (r.rnd() < 0.2)
    parts.push(`BYMONTH=${r.some([1, 2, 3, 4, 10, 11, 12], r.int(2, 4)).join(',')}`);
}

function yearlyParts(parts: string[], r: Draws): void {
  const shape = r.int(0, 4);
  if (shape === 1) parts.push(`BYMONTH=${r.some([1, 2, 3, 6, 10, 11, 12], r.int(1, 3)).join(',')}`);
  if (shape === 2)
    parts.push(
      `BYMONTH=${r.some([2, 3, 10, 11], r.int(1, 2)).join(',')}`,
      `BYMONTHDAY=${r.some([1, 29, 30, 31, -1], r.int(1, 2)).join(',')}`,
    );
  if (shape === 3)
    parts.push(
      `BYMONTH=${r.some([3, 4, 10, 11], r.int(1, 2)).join(',')}`,
      `BYDAY=${r.pick([1, 2, -1, 4])}${r.pick(DAYS)}`,
    );
  if (shape === 4)
    parts.push(
      `BYMONTH=${r.pick([2, 3, 10, 11])}`,
      `BYDAY=${r.some(DAYS, r.int(2, 5)).join(',')}`,
      `BYSETPOS=${r.pick([1, -1, 2])}`,
    );
}

export function propertyRules(seed: number, n: number): PropertyRule[] {
  const rnd = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const some = <T>(xs: readonly T[], k: number): T[] => [
    ...new Set(Array.from({ length: k }, () => pick(xs))),
  ];
  const r: Draws = { rnd, int, pick, some };
  const pad = (x: number): string => String(x).padStart(2, '0');
  const out: PropertyRule[] = [];

  for (let i = 0; i < n; i++) {
    const zone = pick(ZONES);
    const y = int(2025, 2027);
    const mo = int(1, 12);
    const d = int(1, 28);
    // Early-morning hours on purpose: they cross DST gaps and overlaps.
    const h = pick([0, 1, 2, 2, 3, 9, 12, 17, 23]);
    const mi = pick([0, 15, 30, 45]);
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    const local = `${date}T${pad(h)}:${pad(mi)}:00`;

    const freq = pick(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const);
    const parts = [`FREQ=${freq}`];
    if (rnd() < 0.5) parts.push(`INTERVAL=${int(2, 4)}`);
    if (freq === 'DAILY') dailyParts(parts, r);
    else if (freq === 'WEEKLY') weeklyParts(parts, r);
    else if (freq === 'MONTHLY') monthlyParts(parts, r);
    else yearlyParts(parts, r);
    const startMs = Date.UTC(y, mo - 1, d);
    const ending = int(0, 2);
    if (ending === 1) parts.push(`COUNT=${int(1, 60)}`);
    if (ending === 2) {
      const u = new Date(startMs + int(30, 900) * 86_400_000).toISOString();
      const ud = u.slice(0, 10).replace(/-/g, '');
      parts.push(
        `UNTIL=${zone === 'all-day' ? ud : zone === 'floating' ? `${ud}T120000` : `${ud}T120000Z`}`,
      );
    }
    const rrule = parts.join(';');

    let event: CaseEvent;
    if (zone === 'all-day') {
      const end = new Date(startMs + int(1, 3) * 86_400_000).toISOString().slice(0, 10);
      event = { start: { date }, end: { date: end }, allDay: true, rrule };
    } else {
      const minutes = pick([30, 60, 90]);
      const end = new Date(Date.parse(`${local}Z`) + minutes * 60_000).toISOString().slice(0, 19);
      event =
        zone === 'floating'
          ? { start: { local }, end: { local: end }, allDay: false, rrule }
          : { start: { local, tzid: zone }, end: { local: end, tzid: zone }, allDay: false, rrule };
    }
    // From a day before the start (wide of any offset) to three years on.
    out.push({
      id: `p${String(i).padStart(3, '0')}`,
      event,
      from: startMs - 86_400_000,
      to: startMs + 3 * YEAR,
    });
  }
  return out;
}
