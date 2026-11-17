/**
 * Home's pure logic (DESIGN 7.2): the order inside each section, the flat list of cursor stops, and how the cursor
 * moves, jumps between sections and survives rows leaving or arriving. No React, no engine: callers pass rows in.
 *
 * The cursor is a key (a thread id, or the Low band's), never an index, so a row arriving above it can not move it.
 */
import type { HomeView, ThreadId, ThreadRow, ViewRange } from '../../data';
import { absoluteIndex, LIST_WINDOW, rangeAround } from '../lists/listModel';

/** A section of rows as the engine keys them; `fromLater` is Back from Later, the bottom block of Do now. */
export type SectionKey = 'do' | 'fromLater' | 'update' | 'follow';

/** The sections Tab and Shift-Tab jump between: Do now (with Back from Later), Important updates, Follow up. */
export type TabSection = 'do' | 'update' | 'follow';

/** The cursor key of the Low importance band. */
export const LOW_KEY = 'band:low';

/** One cursor stop: a thread row or the Low band. */
export type HomeItem =
  | { readonly kind: 'row'; readonly id: ThreadId; readonly section: SectionKey }
  | {
      readonly kind: 'low';
      /** The band holds no mail: it opens the empty sheet, but the cursor never settles on it. */ readonly empty?: boolean;
    };

/** What the screen lays out: the ids of each section in rendered order, and how many threads the Low band holds. */
export interface HomeLayout {
  readonly do: readonly ThreadId[];
  readonly fromLater: readonly ThreadId[];
  readonly update: readonly ThreadId[];
  readonly follow: readonly ThreadId[];
  readonly lowCount: number;
  /** Whether the band shows (see `showsLowBand`); absent means only while it holds mail. */
  readonly lowShown?: boolean;
}

/** The layout of a live Home view: each section's ids and the Low band's count. */
export function layoutOf(home: Pick<HomeView, 'sections' | 'low' | 'total'>): HomeLayout {
  const bySection = (key: 'do' | 'update' | 'follow') =>
    home.sections.find(section => section.key === key);
  return {
    do: bySection('do')?.ids ?? [],
    fromLater: bySection('do')?.fromLater?.ids ?? [],
    update: bySection('update')?.ids ?? [],
    follow: bySection('follow')?.ids ?? [],
    lowCount: home.low.count,
    lowShown: home.low.count > 0 || home.total > 0,
  };
}

/** A row lookup; a row the cache has not fetched yet is undefined. */
export type RowOf = (id: ThreadId) => ThreadRow | undefined;

const TAB_SECTIONS: readonly TabSection[] = ['do', 'update', 'follow'];

/** The key the cursor uses for an item. */
export function keyOf(item: HomeItem): string {
  return item.kind === 'low' ? LOW_KEY : item.id;
}

/** The section an item belongs to for Tab; the Low band counts as between Important updates and Follow up. */
function tabSectionOf(item: HomeItem): TabSection | 'low' {
  if (item.kind === 'low') return 'low';
  return item.section === 'fromLater' ? 'do' : item.section;
}

// ---------------------------------------------------------------------------
// Order inside a section
// ---------------------------------------------------------------------------

const importanceRank = (row: ThreadRow): number => (row.rank.importance === 'important' ? 0 : 1);
const receivedAt = (row: ThreadRow): number => row.lastInboundDate ?? row.lastDate;
const NO_DUE = '9999-12-31';

function byId(a: ThreadRow, b: ThreadRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Do now (DESIGN 7.2): due band, important before normal, soonest due date, newest received. */
export function compareDoNow(a: ThreadRow, b: ThreadRow): number {
  return (
    a.rank.dueBand - b.rank.dueBand ||
    importanceRank(a) - importanceRank(b) ||
    (a.workflow.dueDate ?? NO_DUE).localeCompare(b.workflow.dueDate ?? NO_DUE) ||
    receivedAt(b) - receivedAt(a) ||
    byId(a, b)
  );
}

/** Important updates: important first, then newest. */
export function compareUpdate(a: ThreadRow, b: ThreadRow): number {
  return importanceRank(a) - importanceRank(b) || receivedAt(b) - receivedAt(a) || byId(a, b);
}

/** Follow up: the longest wait first. */
export function compareFollow(a: ThreadRow, b: ThreadRow): number {
  return (a.follow?.since ?? a.lastDate) - (b.follow?.since ?? b.lastDate) || byId(a, b);
}

/** Sorts ids by a row comparison; ids whose row is not cached yet keep their order, after the known ones. */
function sortIds(
  ids: readonly ThreadId[],
  rowOf: RowOf,
  compare: (a: ThreadRow, b: ThreadRow) => number,
): ThreadId[] {
  const known: ThreadRow[] = [];
  const unknown: ThreadId[] = [];
  for (const id of ids) {
    const row = rowOf(id);
    if (row) known.push(row);
    else unknown.push(id);
  }
  return [...known.sort(compare).map(row => row.id), ...unknown];
}

/**
 * Puts each section in DESIGN 7.2's order. While held it returns the layout untouched: the list holds still under
 * the cursor and the new order lands, as `close`, when the hold releases (DESIGN 5 rule 6).
 */
export function orderLayout(layout: HomeLayout, rowOf: RowOf, held: boolean): HomeLayout {
  if (held) return layout;
  return {
    ...layout,
    do: sortIds(layout.do, rowOf, compareDoNow),
    fromLater: sortIds(layout.fromLater, rowOf, compareDoNow),
    update: sortIds(layout.update, rowOf, compareUpdate),
    follow: sortIds(layout.follow, rowOf, compareFollow),
  };
}

// ---------------------------------------------------------------------------
// Cursor stops
// ---------------------------------------------------------------------------

function rowsOf(ids: readonly ThreadId[], section: SectionKey): HomeItem[] {
  return ids.map(id => ({ kind: 'row', id, section }));
}

/**
 * Whether the Low band shows: when it holds mail, and also at 0 while the view has other mail (`layoutOf` reads the
 * view's totals, the same test as the empty Home), so Low importance is always one Return or click away and opens the
 * sheet's "No low-importance mail". An empty Home shows the handled line instead.
 */
export function showsLowBand(layout: HomeLayout): boolean {
  return layout.lowShown ?? layout.lowCount > 0;
}

/** Every cursor stop, top to bottom: Do now, Back from Later, Important updates, the Low band, Follow up. */
export function buildItems(layout: HomeLayout): HomeItem[] {
  const low: HomeItem[] = showsLowBand(layout)
    ? [{ kind: 'low', empty: layout.lowCount === 0 }]
    : [];
  return [
    ...rowsOf(layout.do, 'do'),
    ...rowsOf(layout.fromLater, 'fromLater'),
    ...rowsOf(layout.update, 'update'),
    ...low,
    ...rowsOf(layout.follow, 'follow'),
  ];
}

/** The key of the item at `index`, or null when there is none. */
function keyAt(items: readonly HomeItem[], index: number): string | null {
  const item = items[index];
  return item ? keyOf(item) : null;
}

function indexOfKey(items: readonly HomeItem[], key: string | null): number {
  if (key === null) return -1;
  return items.findIndex(item => keyOf(item) === key);
}

/** Where the cursor starts: the first row of Do now, else of Important updates, else of Follow up; the band if alone. */
export function initialKey(items: readonly HomeItem[]): string | null {
  for (const section of TAB_SECTIONS) {
    const first = items.find(item => item.kind === 'row' && tabSectionOf(item) === section);
    if (first) return keyOf(first);
  }
  return keyAt(items, 0);
}

/**
 * The cursor after the list changed. A key still in the list stays, wherever the row moved to. A key that left (Done,
 * Later, a lane move) goes to the row that took its place, or the one above when it was last. Null for an empty list.
 */
export function settleCursor(
  before: readonly HomeItem[],
  after: readonly HomeItem[],
  key: string | null,
): string | null {
  if (after.length === 0) return null;
  if (key === null) return initialKey(after);
  if (indexOfKey(after, key) >= 0) return key;
  const was = Math.max(0, indexOfKey(before, key));
  const at = Math.min(was, after.length - 1);
  const landing = after[at];
  // An empty band is a stop to walk onto, never a place for the cursor to settle: take the row above, else below.
  if (landing?.kind === 'low' && landing.empty) {
    const row = after[at - 1]?.kind === 'row' ? at - 1 : after.findIndex(i => i.kind === 'row');
    if (row >= 0) return keyAt(after, row);
  }
  return keyAt(after, at);
}

/** A row the cursor was on that left the list, the row the cursor settled on instead, and when. */
export interface Displaced {
  readonly key: string;
  readonly to: string;
  readonly at: number;
}

/** What `settleHome` returns: where the cursor is now, and the departures it can still hand back. */
export interface HomeSettled {
  readonly key: string | null;
  readonly displaced: readonly Displaced[];
}

const MAX_DISPLACED = 50;
/** How long a departure can be handed back: a mail that returns later came back for some other reason. */
export const UNDO_WINDOW_MS = 30_000;

/**
 * `settleCursor` that also remembers where the cursor came from. A row that leaves under the cursor (Done, Later,
 * Trash, a lane move) is noted with the neighbour that took the cursor; when it comes back (Undo) soon after, while
 * the cursor has not been moved since, the cursor goes back to it, so the focus card is the same mail it was. Moving
 * the cursor by hand forgets the notes (the caller clears them). Notes whose row is already back, or that are older
 * than the undo window, are dropped.
 */
export function settleHome(
  before: readonly HomeItem[],
  after: readonly HomeItem[],
  key: string | null,
  displaced: readonly Displaced[],
  now: number,
): HomeSettled {
  const fresh = displaced.filter(note => now - note.at <= UNDO_WINDOW_MS);
  const last = fresh.at(-1);
  if (last && key === last.to && indexOfKey(after, last.key) >= 0) {
    return { key: last.key, displaced: fresh.slice(0, -1).filter(note => !isBack(after, note)) };
  }
  const kept = fresh.filter(note => !isBack(after, note));
  const next = settleCursor(before, after, key);
  const left = key !== null && next !== null && next !== key && indexOfKey(after, key) < 0;
  if (!left) return { key: next, displaced: kept };
  return { key: next, displaced: [...kept, { key, to: next, at: now }].slice(-MAX_DISPLACED) };
}

/**
 * The notes after the cursor is moved to `next`. A move by hand forgets them (nothing is handed back to a cursor the
 * owner placed), except a bump that stays put. `departed` names the row the cursor left because its mail went (a bulk
 * Done, Later or Trash that includes the card): that departure is noted like one `settleHome` sees, so an Undo can hand
 * the card back.
 */
export function movedHome(
  displaced: readonly Displaced[],
  current: string | null,
  next: string | null,
  departed: string | undefined,
  now: number,
): readonly Displaced[] {
  if (departed !== undefined && next !== null && departed !== next) {
    const fresh = displaced.filter(note => now - note.at <= UNDO_WINDOW_MS);
    return [...fresh, { key: departed, to: next, at: now }].slice(-MAX_DISPLACED);
  }
  return next === current ? displaced : [];
}

function isBack(after: readonly HomeItem[], note: Displaced): boolean {
  return indexOfKey(after, note.key) >= 0;
}

/** One step of J/K or the arrows; stops at the ends. */
export function stepCursor(
  items: readonly HomeItem[],
  key: string | null,
  delta: 1 | -1,
): string | null {
  if (items.length === 0) return null;
  const at = indexOfKey(items, key);
  if (at < 0) return initialKey(items);
  return keyAt(items, Math.max(0, Math.min(items.length - 1, at + delta)));
}

/** The sections that have rows, in Tab order. */
function presentSections(items: readonly HomeItem[]): TabSection[] {
  const present = new Set(items.map(tabSectionOf));
  return TAB_SECTIONS.filter(section => present.has(section));
}

/** Where Tab (1) or Shift-Tab (-1) lands: the first row of the next or previous section, wrapping round. */
export function jumpSection(
  items: readonly HomeItem[],
  key: string | null,
  delta: 1 | -1,
): string | null {
  const present = presentSections(items);
  if (present.length === 0) return key;
  const current = items.find(item => keyOf(item) === key);
  const here = current ? tabSectionOf(current) : null;
  const target = nextSection(present, here, delta);
  const first = items.find(item => item.kind === 'row' && tabSectionOf(item) === target);
  return first ? keyOf(first) : key;
}

function nextSection(
  present: readonly TabSection[],
  here: TabSection | 'low' | null,
  delta: 1 | -1,
): TabSection {
  const order: readonly (TabSection | 'low')[] = ['do', 'update', 'low', 'follow'];
  const at = here === null ? -1 : order.indexOf(here);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(((at + delta * step) % order.length) + order.length) % order.length];
    if (candidate !== undefined && candidate !== 'low' && present.includes(candidate))
      return candidate;
  }
  return present[0] ?? 'do';
}

/** Radius of rows pinned around the cursor while a burst lasts. */
export const HOLD_RADIUS = 3;

/** Ids of the rows around the cursor, for `hold`: the neighbours a re-rank must not move. */
export function neighbourIds(
  items: readonly HomeItem[],
  key: string | null,
  radius: number,
): ThreadId[] {
  const at = indexOfKey(items, key);
  if (at < 0) return [];
  const ids: ThreadId[] = [];
  for (const item of items.slice(Math.max(0, at - radius), at + radius + 1)) {
    if (item.kind === 'row') ids.push(item.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The bulk pick
// ---------------------------------------------------------------------------

/**
 * The ids X, ⇧X and ⌘A can pick, in list order: the ordinary rows of every section. The Low importance band is a
 * cursor stop but not a thread, so it is never pickable and a ⇧X run steps over it.
 */
export function pickableIds(items: readonly HomeItem[]): ThreadId[] {
  const ids: ThreadId[] = [];
  for (const item of items) {
    if (item.kind === 'row') ids.push(item.id);
  }
  return ids;
}

/** The cursor key when it is on a row X can pick, else null (the Low band, an empty list). */
export function pickableKey(items: readonly HomeItem[], key: string | null): ThreadId | null {
  const item = items.find(candidate => keyOf(candidate) === key);
  return item?.kind === 'row' ? item.id : null;
}

// ---------------------------------------------------------------------------
// Lanes and the suggested action
// ---------------------------------------------------------------------------

/** A lane a thread can be moved between with ⌥↑ and ⌥↓. */
export type MovableLane = 'do' | 'update' | 'low';

const LANES: readonly MovableLane[] = ['do', 'update', 'low'];

/** The lane a row is in, or null for a value a newer engine added (draw no lane controls then). */
export function laneOf(row: ThreadRow): MovableLane | null {
  return LANES.find(lane => lane === row.rank.lane) ?? null;
}

/** One lane down (`down`) or up from `lane`; null at the end, where the key does nothing. */
export function stepLane(lane: MovableLane, direction: 'up' | 'down'): MovableLane | null {
  const at = LANES.indexOf(lane);
  return LANES[direction === 'down' ? at + 1 : at - 1] ?? null;
}

/** The command Space runs on a row (DESIGN 7.2): the nudge on Follow up, Done on an update, else the row's action. */
export function suggestedCommand(row: ThreadRow, section: SectionKey): string {
  if (section === 'follow') return 'mail.reply';
  const kind = row.summary.action?.kind;
  if (kind === 'done' || (section === 'update' && kind === undefined)) return 'mail.done';
  if (kind === undefined || kind === 'reply') return 'mail.reply';
  return 'mail.open';
}

/**
 * Whether Done on this row should offer "Remind me if no reply" (DESIGN 7.2). The reminder fires only if nobody has
 * answered by its date, so it means something only when the owner sent the last message: Follow up, or a thread awaiting
 * a reply. A thread that needs the owner's own reply has no one to wait for, so it offers nothing.
 */
export function offersReminder(row: ThreadRow, section: SectionKey): boolean {
  return section === 'follow' || row.workflow.replyStatus === 'awaitingReply';
}

// ---------------------------------------------------------------------------
// Paging the window
// ---------------------------------------------------------------------------

/** Rows from the edge of the loaded window at which the cursor asks the engine for the next one. */
export const PAGE_EDGE = 25;

/** What the cursor knows about the loaded window of the whole `home` view. */
export interface PageFacts {
  /** Index of the window's first id in the whole view. */
  readonly position: number;
  /** Ids in the window. */
  readonly loaded: number;
  /** Rows in the whole view (the Low band's rows count: they sit in the window too). */
  readonly total: number;
  /** Index of the cursor row in the window, or -1 when it is not a loaded row. */
  readonly at: number;
}

/**
 * The window to ask for when the cursor nears the edge of the loaded rows, centred on the cursor like the lists
 * (`rangeAround`), or null while a short view fits one window or the cursor is well inside it. Without this a view of
 * more than one window never shows, or lets the keys reach, the sections after the first window.
 */
export function pageRequest(facts: PageFacts): ViewRange | null {
  const { position, loaded, total, at } = facts;
  if (total <= LIST_WINDOW || at < 0) return null;
  const nearTop = position > 0 && at < PAGE_EDGE;
  const nearEnd = position + loaded < total && loaded - 1 - at < PAGE_EDGE;
  return nearTop || nearEnd ? rangeAround(absoluteIndex(position, at), total) : null;
}
