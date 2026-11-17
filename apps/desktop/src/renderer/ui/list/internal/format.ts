// Date and size formatting for the list and reader families (plain first version).
// The shared formatter `ui/format.ts` (README "Shared infrastructure") is not on this branch yet; when it
// lands, these helpers become thin re-exports of it. en-US, local time zone; the harness freezes the clock.

import type { IsoDateTime } from '../../props';

const LOCALE = 'en-US';
const DAY_MS = 86_400_000;

let clock: () => number = () => Date.now();

/** Test and harness hook: freeze "now" (the harness uses 2026-10-29T10:00 local). Pass null to restore. */
export function setFormatClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

function parse(iso: IsoDateTime): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days from today to `d` (negative is the past). */
function dayOffset(d: Date): number {
  return Math.round((startOfDay(d) - startOfDay(new Date(clock()))) / DAY_MS);
}

/** Both moments fall on the same local calendar day. */
export function sameDay(a: IsoDateTime, b: IsoDateTime): boolean {
  const first = parse(a);
  const second = parse(b);
  return first !== null && second !== null && startOfDay(first) === startOfDay(second);
}

/** A future day later this week (through Sunday), where a bare weekday cannot be misread. */
function laterThisWeek(off: number): boolean {
  const daysToSunday = (7 - new Date(clock()).getDay()) % 7;
  return off > 1 && off <= daysToSunday;
}

/** An earlier day of the current week (Monday onwards, before yesterday), where a bare weekday cannot be misread. */
function earlierThisWeek(off: number): boolean {
  const daysSinceMonday = (new Date(clock()).getDay() + 6) % 7;
  return off < -1 && off >= -daysSinceMonday;
}

function isMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0;
}

function clean(text: string): string {
  // Some ICU builds write a narrow no-break space before AM/PM; use a plain space so copy reads the same everywhere.
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

/** "10:00 AM". */
export function formatTime(d: Date): string {
  return clean(d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }));
}

function monthDay(d: Date): string {
  const sameYear = d.getFullYear() === new Date(clock()).getFullYear();
  return d.toLocaleDateString(
    LOCALE,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

function weekdayShort(d: Date): string {
  return d.toLocaleDateString(LOCALE, { weekday: 'short' });
}

function weekdayLong(d: Date): string {
  return d.toLocaleDateString(LOCALE, { weekday: 'long' });
}

/**
 * The list date column: "10:00 AM" today, "Yesterday", "Tuesday" earlier this week, then "Oct 23", "Oct 23, 2025". Under
 * a "Yesterday" group header (`inDayGroup`) the word would repeat the header, so the row shows its clock.
 */
export function formatListDate(iso: IsoDateTime, inDayGroup = false): string {
  const d = parse(iso);
  if (!d) return '';
  const off = dayOffset(d);
  if (off === 0) return formatTime(d);
  if (off === -1) return inDayGroup ? formatTime(d) : 'Yesterday';
  if (off === 1) return 'Tomorrow';
  if (earlierThisWeek(off)) return weekdayLong(d);
  return monthDay(d);
}

function relativeDay(d: Date, style: 'short' | 'long'): string {
  const off = dayOffset(d);
  if (off === 0) return 'Today';
  if (off === 1) return 'Tomorrow';
  if (off === -1) return 'Yesterday';
  if (laterThisWeek(off)) return style === 'short' ? weekdayShort(d) : weekdayLong(d);
  return style === 'short' ? `${weekdayShort(d)}, ${monthDay(d)}` : monthDay(d);
}

/** Due chip text (DESIGN §7.2): 'short' "Due today" / "Tomorrow" / "Sat" / "Nov 4"; 'withTime' "Today, 5:00 PM"; 'sentence' "Due tomorrow". */
export function formatDue(iso: IsoDateTime, format: 'short' | 'withTime' | 'sentence'): string {
  const d = parse(iso);
  if (!d) return '';
  const off = dayOffset(d);
  if (format === 'short') {
    if (off === 0) return 'Due today';
    if (off === 1) return 'Due tomorrow';
    if (off === -1) return 'Due yesterday';
    if (laterThisWeek(off)) return `Due ${weekdayShort(d)}`;
    return `Due ${monthDay(d)}`;
  }
  if (format === 'withTime') {
    const day = relativeDay(d, 'short');
    return isMidnight(d) ? day : `${day}, ${formatTime(d)}`;
  }
  if (off === 0) return 'Due today';
  if (off === 1) return 'Due tomorrow';
  if (off === -1) return 'Due yesterday';
  if (laterThisWeek(off)) return `Due ${weekdayLong(d)}`;
  return `Due ${monthDay(d)}`;
}

/** When a Later item comes back (later.html): "Yesterday", "Tue, Oct 27", "Today, 5:00 PM". */
export function formatLaterUntil(iso: IsoDateTime): string {
  const d = parse(iso);
  if (!d) return '';
  const off = dayOffset(d);
  const day =
    off >= -1 && off <= 1 ? relativeDay(d, 'short') : `${weekdayShort(d)}, ${monthDay(d)}`;
  return isMidnight(d) ? day : `${day}, ${formatTime(d)}`;
}

/**
 * The Later chip's short return, so the subject keeps its room: "today 5 PM", "tomorrow 9 AM", "Thu 9 AM" for the next
 * week; a past day or a farther one keeps its date, "Tue, Oct 27". The full date rides in the chip's tooltip.
 */
export function formatLaterUntilCompact(iso: IsoDateTime): string {
  const d = parse(iso);
  if (!d) return '';
  const off = dayOffset(d);
  if (off < 0 || off > 6) return formatLaterUntil(iso);
  const day = off === 0 ? 'today' : off === 1 ? 'tomorrow' : weekdayShort(d);
  return isMidnight(d) ? day : `${day} ${formatTime(d).replace(/:00(?=\s)/, '')}`;
}

/** The reader's sender-line time: "10:00 AM" today, otherwise day plus time. */
export function formatReaderTime(iso: IsoDateTime): string {
  const d = parse(iso);
  if (!d) return '';
  const off = dayOffset(d);
  if (off === 0) return formatTime(d);
  if (off === -1) return `Yesterday, ${formatTime(d)}`;
  if (off < -1 && off > -7) return `${weekdayLong(d)}, ${formatTime(d)}`;
  return `${monthDay(d)}, ${formatTime(d)}`;
}

/**
 * A message header time: "Just now", "Today, 10:00 AM", "Yesterday, 4:12 PM", then the long form with its weekday,
 * "Fri, Nov 13, 10:42 PM". Always the date and the clock, so one thread never mixes "Oct 21" with "Friday".
 */
export function formatMessageTime(iso: IsoDateTime): string {
  const d = parse(iso);
  if (!d) return '';
  const age = clock() - d.getTime();
  if (age >= 0 && age < 60_000) return 'Just now';
  const off = dayOffset(d);
  if (off === 0) return `Today, ${formatTime(d)}`;
  if (off === -1) return `Yesterday, ${formatTime(d)}`;
  return `${weekdayShort(d)}, ${monthDay(d)}, ${formatTime(d)}`;
}

/** Full date for `title` and screen readers: "Thursday, October 29, 2026 at 10:00 AM". */
export function formatFull(iso: IsoDateTime): string {
  const d = parse(iso);
  if (!d) return '';
  return clean(
    d.toLocaleString(LOCALE, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
}

/** Attachment size, decimal units like Finder, with the short unit: "129 B", "4.2 KB", "312 KB", "4.2 MB", "1.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 10_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** Counts with grouping: "9,999". */
export function formatCount(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString(LOCALE);
}

/** "Jordan", "Jordan and Mina", "Jordan, you and Mina"; past `max` names: "Jordan, you, Mina and 4 others". */
export function joinNames(names: readonly string[], max = 3): string {
  const list = names.filter(n => n.length > 0);
  if (list.length === 0) return '';
  if (list.length > max) {
    const rest = list.length - max;
    return `${list.slice(0, max).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
  }
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
