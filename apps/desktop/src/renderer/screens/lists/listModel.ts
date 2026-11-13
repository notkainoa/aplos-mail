/**
 * The lists' pure logic (DESIGN 4.1, 5, 7.4): the cursor over a flat list of ids, how it survives rows leaving and
 * arriving, which ids a hold pins, the window of rows to ask the engine for, and the date groups of All mail and Done.
 * No React and no engine; the cursor is a key (an id), never an index, so mail arriving above it cannot move it.
 */
import type { ViewRange } from '../../data';

/** The most rows the engine keeps in a window (`WINDOW_MAX_ROWS`). */
export const LIST_WINDOW = 200;

/** Radius of rows pinned around the cursor while keys are at work. */
export const HOLD_RADIUS = 3;

function indexOfKey(ids: readonly string[], key: string | null): number {
  return key === null ? -1 : ids.indexOf(key);
}

/** Where the cursor starts: the first row. */
export function firstKey(ids: readonly string[]): string | null {
  return ids[0] ?? null;
}

/** One step of J/K or the arrows; stops at the ends and never wraps. Null for an empty list. */
export function stepKey(ids: readonly string[], key: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = indexOfKey(ids, key);
  if (at < 0) return firstKey(ids);
  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))] ?? null;
}

/**
 * The cursor after the list changed. A key still in the list stays, wherever the row moved to. A key that left (Done,
 * Later, Restore) goes to the row that took its place, or the one above when it was last. Null for an empty list.
 */
export function settleKey(
  before: readonly string[],
  after: readonly string[],
  key: string | null,
): string | null {
  if (after.length === 0) return null;
  if (key === null) return firstKey(after);
  if (after.includes(key)) return key;
  const was = Math.max(0, indexOfKey(before, key));
  return after[Math.min(was, after.length - 1)] ?? null;
}

/**
 * Where the cursor goes when `leaving` rows are about to go (a bulk action): it stays when its row survives, else it
 * lands on the nearest surviving row below, then the nearest above. Null when nothing survives.
 */
export function survivorKey(
  ids: readonly string[],
  key: string | null,
  leaving: readonly string[],
): string | null {
  const gone = new Set(leaving);
  if (key !== null && ids.includes(key) && !gone.has(key)) return key;
  const at = Math.max(0, indexOfKey(ids, key));
  const below = ids.slice(at).find(id => !gone.has(id));
  return (
    below ??
    ids
      .slice(0, at)
      .reverse()
      .find(id => !gone.has(id)) ??
    null
  );
}

/** The ids within `radius` rows of the cursor: what a re-rank must not move. */
export function neighbourKeys(
  ids: readonly string[],
  key: string | null,
  radius: number = HOLD_RADIUS,
): string[] {
  const at = indexOfKey(ids, key);
  if (at < 0) return [];
  return ids.slice(Math.max(0, at - radius), at + radius + 1);
}

/** A confirmation none of whose threads is in the list any more has nothing left to ask about. */
export function confirmationIsStale(
  confirmation: { readonly ids: readonly string[] },
  ids: readonly string[],
): boolean {
  return !confirmation.ids.some(id => ids.includes(id));
}

/**
 * The window of the whole view to hold in memory around the cursor: at most `size` rows, clamped to the view, with the
 * cursor row inside. Passed to `view.move` so a 10,000-row list never loads more than one window.
 */
export function rangeAround(index: number, total: number, size: number = LIST_WINDOW): ViewRange {
  const span = Math.max(1, Math.min(size, total));
  const start = Math.max(0, Math.min(total - span, index - Math.floor(span / 2)));
  return { start, end: start + span };
}

/** The index in the whole view of the id at `at` in a window that starts at `position`. */
export function absoluteIndex(position: number, at: number): number {
  return Math.max(0, position) + Math.max(0, at);
}

// ---------------------------------------------------------------------------
// Date groups (All mail and Done)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function midnight(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Midnight at the start of the Monday of the week `date` is in. */
function weekStartOf(date: Date): number {
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime();
}

/** The section label for a moment, read against now: Today, Yesterday, Earlier this week, Last week, then months. */
export function dateGroupLabel(ms: number, nowMs: number): string {
  const today = midnight(nowMs);
  const day = midnight(ms);
  const ago = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  // A date ahead of the clock (skew) reads as its row's own text does: Tomorrow, or a plain date.
  if (ago === -1) return 'Tomorrow';
  if (ago < -1) return 'Upcoming';
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  const thisWeek = weekStartOf(today);
  if (day.getTime() >= thisWeek) return 'Earlier this week';
  if (day.getTime() >= thisWeek - 7 * DAY_MS) return 'Last week';
  const month = MONTHS[day.getMonth()] ?? '';
  if (day.getFullYear() !== today.getFullYear()) return `${month} ${day.getFullYear()}`;
  return day.getMonth() === today.getMonth() ? `Earlier in ${month}` : month;
}

/** A run of consecutive rows under one date label. */
export interface DateGroup {
  /** The run's position, safe in a DOM id. */
  readonly key: string;
  readonly label: string;
  readonly ids: readonly string[];
}

/**
 * Splits ids into runs under one date label, keeping the engine's order. Runs, not buckets: a held list (rows pinned
 * out of date order) shows the same label twice rather than moving a row. A row whose date is unknown (not fetched
 * yet) joins the run before it, or Today when it comes first.
 */
export function groupByDate(
  ids: readonly string[],
  dateOf: (id: string) => number | undefined,
  nowMs: number,
): DateGroup[] {
  const groups: { label: string; ids: string[] }[] = [];
  for (const id of ids) {
    const at = dateOf(id);
    const last = groups[groups.length - 1];
    const label = at === undefined ? (last?.label ?? 'Today') : dateGroupLabel(at, nowMs);
    if (last && last.label === label) last.ids.push(id);
    else groups.push({ label, ids: [id] });
  }
  return groups.map((group, index) => ({ key: String(index), ...group }));
}
