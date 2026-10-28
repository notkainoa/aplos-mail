import type { StoreReader } from '../store';
import { accountOf } from './fanout';
import { placeHeld, type Holds } from './holds';
import { materializedPlan } from './compile';
import type { ViewEnv, ViewPlan, ViewPoint } from './specs';

/*
 * One window's page (views-2): where it starts, which rows it shows and how a scroll finds a new start. Keyset only: a
 * window remembers the point of the row before its first row (`after`), so a re-run is one indexed range read that
 * ignores rows added or removed above it. A scroll to an unknown position walks the view in big strides from the
 * nearest remembered point (`marks`) and remembers the points it passes, so scrolling on or back is one read. A mark
 * remembers its row, and is used only while that row still sits just before its position.
 */

/** Rows read per step while walking to a position. */
const STRIDE = 1_000;

/** The parts of a window the page code reads and updates. */
export interface PageState {
  limit: number;
  /** The point of the row just before the first shown row; undefined at the top. */
  after: ViewPoint | undefined;
  /** Index of the first shown row (approximate while the view changes above it). */
  position: number;
  /** The ids last sent, including held rows kept past their view. */
  ids: string[];
  holds: Holds;
  /** Held rows shown in their slot that the view no longer holds. */
  departed: Set<string>;
  /** Held rows shown in their slot that the view still holds elsewhere: id -> its index in the view. */
  places: Map<string, number>;
  /** Index n -> the row n - 1 and its point, for positions already walked past. */
  marks: Map<number, Mark>;
}

export interface Mark {
  id: string;
  at: ViewPoint;
}

/** `mail.followUpDays` from the settings document, or its default. */
const DEFAULT_FOLLOW_UP_DAYS = 3;

export function viewEnv(q: StoreReader, now: number, zone: string): ViewEnv {
  const row = q.get<{ days: number | null }>(
    "SELECT json_extract(data, '$.mail.followUpDays') AS days FROM settings WHERE id = 1",
  );
  const days = Number(row?.days);
  return { now, zone, followUpDays: days > 0 ? days : DEFAULT_FOLLOW_UP_DAYS };
}

/** A `oneByOne` window's frozen order as a plan: it pages through the ids taken when the window opened. */
export function frozenPlan(ids: readonly string[]): ViewPlan {
  return materializedPlan({
    kind: 'oneByOne',
    rowType: 'Thread',
    build: () => ({ ids: [...ids], sections: [] }),
    statements: () => [],
  });
}

// ------------------------------------------------------------ scrolling

/** The nearest remembered point at or before `target` whose row still sits where it was left. */
function nearestMark(q: StoreReader, plan: ViewPlan, marks: Map<number, Mark>, target: number) {
  for (;;) {
    let pos = 0;
    for (const at of marks.keys()) if (at <= target && at > pos) pos = at;
    const mark = marks.get(pos);
    if (!mark) return { pos: 0, point: undefined };
    if (plan.locate(q, mark.id)?.index === pos - 1) return { pos, point: mark.at };
    marks.delete(pos);
  }
}

/** Walks forward to row `target`, remembering the points on the way; `end` when the view ran out first. */
function walkTo(q: StoreReader, plan: ViewPlan, marks: Map<number, Mark>, target: number) {
  let { pos, point } = nearestMark(q, plan, marks, target);
  while (pos < target) {
    const n = Math.min(STRIDE, target - pos);
    const rows = plan.rows(q, point, n);
    if (rows.length) {
      pos += rows.length;
      point = rows[rows.length - 1].at;
      marks.set(pos, { id: rows[rows.length - 1].id, at: point });
    }
    if (rows.length < n) return { pos, point, end: true };
  }
  return { pos, point, end: false };
}

/** Moves the window's start to row `target`; past the end it shows the last row, as a short list does. */
export function seek(q: StoreReader, plan: ViewPlan, w: PageState, target: number): void {
  let want = Math.max(0, Math.trunc(target));
  let reached = walkTo(q, plan, w.marks, want);
  if (reached.end) {
    want = Math.max(0, reached.pos - 1);
    reached = walkTo(q, plan, w.marks, want);
  }
  w.position = reached.pos;
  w.after = reached.point;
}

// ------------------------------------------------------------ the page

export interface Page {
  ids: string[];
  /** Held rows that kept their slot. */
  kept: string[];
}

/**
 * Reads the window's rows: the view from `after`, with held rows put back at the slot they were last sent in. A held
 * row the view no longer holds stays in its slot (`departed`) until it is released; one the view holds elsewhere is
 * noted in `places`, so the sections can follow the slots.
 */
export function readPage(q: StoreReader, plan: ViewPlan, w: PageState): Page {
  const held = w.holds.ids;
  // Only held rows already on the page can keep a slot, so only they widen the read.
  const shown = w.ids.reduce((n, id) => n + (held.has(id) ? 1 : 0), 0);
  const want = w.limit + shown;
  const rows = plan.rows(q, w.after, want);
  const fresh = rows.map(r => r.id);
  const placed = placeHeld(fresh, w.ids, held, w.limit);
  const { ids } = placed;
  const onPage = new Set(ids);
  const kept = placed.kept.filter(id => onPage.has(id));
  trackKept(q, plan, w, kept, fresh);
  if (!kept.length && rows.length >= ids.length && ids.length)
    w.marks.set(w.position + ids.length, { id: ids[ids.length - 1], at: rows[ids.length - 1].at });
  return { ids, kept };
}

/** Sorts the kept held rows into those the view dropped (`departed`) and those it holds at another index (`places`). */
function trackKept(
  q: StoreReader,
  plan: ViewPlan,
  w: PageState,
  kept: string[],
  fresh: string[],
): void {
  w.departed.clear();
  w.places.clear();
  const inFresh = new Map(fresh.map((id, i) => [id, w.position + i]));
  for (const id of kept) {
    const index = inFresh.get(id) ?? plan.locate(q, id)?.index;
    if (index === undefined) w.departed.add(id);
    else w.places.set(id, index);
  }
}

// ------------------------------------------------------------ what changed

/** Threads among `ids` whose row moved after `since`: the window's `changed`. */
export function changedThreads(
  q: StoreReader,
  ids: readonly string[],
  since: number,
  accounts: readonly string[],
): string[] {
  const byAccount = new Map<string, string[]>();
  for (const id of ids) {
    const account = accountOf(id, accounts);
    if (!account) continue;
    const list = byAccount.get(account) ?? [];
    list.push(id.slice(account.length + 1));
    byAccount.set(account, list);
  }
  const out: string[] = [];
  for (const [account, remote] of byAccount)
    for (const row of q.all<{ remote_id: string }>(
      'SELECT remote_id FROM threads WHERE account_id = ? AND rev > ? AND remote_id IN (SELECT value FROM json_each(?))',
      account,
      since,
      JSON.stringify(remote),
    ))
      out.push(`${account}:${row.remote_id}`);
  return out;
}
