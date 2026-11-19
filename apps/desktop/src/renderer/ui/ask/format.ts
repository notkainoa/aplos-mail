/**
 * Local date formatting for the ask family until `ui/format.ts` (the shared formatter) lands on this branch.
 * It reads the wall-clock fields of the ISO string, so the answer does not depend on the machine's time zone.
 * en-US only, like the harness.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

let clock: () => number = () => Date.now();

/** Test and harness hook: freeze "now" (the host wires it to the renderer clock, `data`'s `getNow`). Null restores the wall clock. */
export function setFormatClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

function wall(iso: string): Wall | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso);
  if (!hit) return null;
  return { y: +hit[1], m: +hit[2], d: +hit[3], hh: +(hit[4] ?? 0), mm: +(hit[5] ?? 0) };
}

function dayNumber(w: Wall): number {
  return Math.round(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);
}

/** "10:00 AM". */
export function formatTime(iso: string): string {
  const w = wall(iso);
  if (!w) return '';
  const hour = w.hh % 12 === 0 ? 12 : w.hh % 12;
  return `${hour}:${String(w.mm).padStart(2, '0')} ${w.hh < 12 ? 'AM' : 'PM'}`;
}

/** The wall clock of `now` as an ISO-like string (the harness freezes the clock; pass it to be deterministic). */
export function wallNow(now: Date = new Date(clock())): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** A chat time: "9:42 AM" today, "Yesterday", "Mon" within the week, then "Oct 20" (with the year when it differs). */
export function formatRecent(iso: string, nowIso: string = wallNow()): string {
  const w = wall(iso);
  const n = wall(nowIso);
  if (!w || !n) return '';
  const age = dayNumber(n) - dayNumber(w);
  if (age === 0) return formatTime(iso);
  if (age === 1) return 'Yesterday';
  if (age > 1 && age < 7) return DAYS[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
  return `${MONTHS[w.m - 1]} ${w.d}${w.y === n.y ? '' : `, ${w.y}`}`;
}

/** A source time: "Today, 10:00 AM", "Yesterday, 4:12 PM", "Oct 27" (with the year when it differs). */
export function formatSource(iso: string, nowIso: string = wallNow()): string {
  const w = wall(iso);
  const n = wall(nowIso);
  if (!w || !n) return '';
  const age = dayNumber(n) - dayNumber(w);
  if (age === 0) return `Today, ${formatTime(iso)}`;
  if (age === 1) return `Yesterday, ${formatTime(iso)}`;
  return `${MONTHS[w.m - 1]} ${w.d}${w.y === n.y ? '' : `, ${w.y}`}`;
}
