import type { Counts, ErrorBody, Folder, State, ViewSpec, WindowBody } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { FrameBus } from '../runtime/frames';
import type { Clock, DeadlineRegistry, Logger, StorePort } from '../ports';
import type { StoreReader } from '../store';
import { accountIds } from './compile';
import { readCounts, readFolders, readSenderGroups, type SenderGroupRow } from './counts';
import { createTicker, gateOf, reaches, summarize, type ChangeSummary, type Gate } from './fanout';
import {
  growSections,
  holdIds,
  lapseHolds,
  newHolds,
  releaseHolds,
  shrinkSections,
  touchHolds,
  withoutEmpty,
} from './holds';
import { changedThreads, frozenPlan, readPage, seek, viewEnv, type PageState } from './page';
import { compileView } from './registry';
import type { LayoutSection, RowType, ViewLayout, ViewPlan } from './specs';
import { MATERIALIZED_LIMIT } from './specs';

/*
 * The live-window engine (views-2, ARCH 9.2). `View/watch` opens a window: its first answer is at most 200 body-free
 * ids. After a commit the change set is mapped to the windows it can reach (type and account), and each marked window
 * re-runs its keyset query at most four times a second with a guaranteed trailing run, pushing an ID-only `window`
 * frame when ids, counts, sections or held rows moved. Held rows keep their slot (`holds.ts`). All time is the injected
 * clock; the engine has no timers of its own beyond the one tick (`fanout.ts`).
 */

/** A window re-runs at most this often: four frames a second. */
export const WINDOW_INTERVAL_MS = 250;
/** A view with more rows than this counts them at most once per `LAYOUT_REFRESH_MS` (counts scan the index range). */
export const BIG_VIEW = 2_000;
export const LAYOUT_REFRESH_MS = 1_000;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
/** Events windows are not capped at 200 rows (the range is capped at 62 days instead). */
const EVENTS_LIMIT = MATERIALIZED_LIMIT;
const MAX_WINDOWS_PER_CONNECTION = 64;
/** A bound on the whole engine: the frame bus cannot yet say a connection closed, so its windows linger. */
const MAX_WINDOWS = 512;

export interface Anchor {
  id?: string;
  offset?: number;
  position?: number;
}
export interface WatchArgs {
  spec: ViewSpec;
  holdIds?: string[];
  anchor?: Anchor;
  limit?: number;
}
export interface MoveArgs {
  windowId: string;
  anchor?: Anchor;
  limit?: number;
  range?: { from: number; to: number };
}
export type QueryResult = Omit<WindowBody, 'windowId'>;

/** The window engine, as `services.views`. Every call that names a window is checked against its connection. */
export interface ViewEngine {
  watch(args: WatchArgs, connectionId: string): WindowBody;
  move(args: MoveArgs, connectionId: string): WindowBody;
  unwatch(windowId: string, connectionId: string): void;
  hold(windowId: string, ids: string[], connectionId: string): void;
  release(windowId: string, ids: string[] | undefined, connectionId: string): void;
  query(args: Omit<WatchArgs, 'holdIds'>): QueryResult;
  folders(accountId?: string): { state: State; list: Folder[] };
  counts(): Counts;
  senderGroups(ids: string[]): { state: State; list: SenderGroupRow[]; notFound: string[] };
  /** Looks for commits now instead of at the next tick, and runs the windows they reach. */
  committed(): void;
  /** Ends a connection's windows of one kind with a last frame carrying `error` (remote search failed or is paused). */
  stopWindows(
    connectionId: string,
    kind: ViewSpec['kind'],
    error: ErrorBody,
    match?: (spec: ViewSpec) => boolean,
  ): void;
  /** Open windows of a connection whose spec matches. */
  specsOf(connectionId: string, kind: ViewSpec['kind']): ViewSpec[];
  /** The owner's IANA zone, for local days (`Thread/act`'s due bands). */
  readonly zone: string;
  /** Counters for tests and the diagnostics bundle. */
  readonly stats: { reruns: number; layouts: number; frames: number; windows: number };
  close(): void;
}

export interface ViewEngineDeps {
  store: StorePort;
  clock: Clock;
  frames: FrameBus;
  log: Logger;
  deadlines: DeadlineRegistry;
  randomBytes(n: number): Uint8Array;
  /** The owner's IANA zone for local days; the host's by default. */
  zone?: string;
}

interface Win extends PageState {
  id: string;
  connectionId: string;
  epoch: string;
  spec: ViewSpec;
  rowType: RowType;
  gate: Gate;
  /** `oneByOne`: the order taken when the window opened. */
  frozen?: string[];
  layout?: ViewLayout;
  layoutStale: boolean;
  layoutAt: number;
  /** The change-log position of the last answer or frame: rows revised after it are `changed`. */
  sentSeq: number;
  signature: string;
  pending: boolean;
  lastRunAt: number;
  /** Changed ids of a non-thread row type since the last run. */
  touched: Set<string>;
  /** Every shown row may have changed (a coarse or overflowed change, or a sender group's threads moved). */
  touchedAll: boolean;
}

const notFound = () =>
  new ContractError({ type: 'notFound', message: 'This list is no longer open. Reopen it.' });

const rowNotFound = () =>
  new ContractError({ type: 'notFound', message: 'That item is not in this list.' });

const signatureOf = (b: QueryResult) =>
  JSON.stringify([b.ids, b.total, b.position, b.sections, b.held]);

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function createViewEngine(deps: ViewEngineDeps): ViewEngine {
  const { store, clock, frames } = deps;
  const windows = new Map<string, Win>();
  const stats = { reruns: 0, layouts: 0, frames: 0, windows: 0 };
  const zone = deps.zone ?? localZone();
  let lastSeq = store.seq();

  const ticker = createTicker({ clock, deadlines: deps.deadlines, tick: () => committed() });
  const refreshTicker = () => {
    stats.windows = windows.size;
    if (windows.size) ticker.start();
    else ticker.stop();
  };

  // ---------------------------------------------------------------- building a body

  const planOf = (w: Win, q: StoreReader, now: number): ViewPlan =>
    w.frozen ? frozenPlan(w.frozen) : compileView(w.spec, viewEnv(q, now, zone));

  function refreshLayout(w: Win, q: StoreReader, plan: ViewPlan, now: number, force: boolean) {
    const big = (w.layout?.total ?? 0) > BIG_VIEW;
    const due =
      !w.layout || force || (w.layoutStale && (!big || now - w.layoutAt >= LAYOUT_REFRESH_MS));
    if (!due) return;
    w.layout = plan.layout(q);
    stats.layouts++;
    w.layoutStale = false;
    w.layoutAt = now;
  }

  /**
   * Total and sections for the page, with room for held rows the view has already let go of (they count), and held
   * rows the view holds at another index (they leave the section they sit in there and join the one at their slot).
   */
  function shape(w: Win, ids: string[]): { total: number; sections: LayoutSection[] } {
    const layout = w.layout!;
    const shown = ids.map((id, slot) => ({ id, at: w.position + slot }));
    const dropped = shown.filter(s => w.departed.has(s.id));
    const moved = shown.filter(s => (w.places.get(s.id) ?? s.at) !== s.at);
    let sections = layout.sections;
    const leaving = moved.map(s => w.places.get(s.id)!).sort((x, y) => y - x);
    for (const index of leaving) sections = shrinkSections(sections, index);
    const joining = [...moved, ...dropped].sort((x, y) => x.at - y.at);
    for (const s of joining) sections = growSections(sections, s.at);
    return { total: layout.total + w.departed.size, sections: withoutEmpty(sections) };
  }

  function changedIds(w: Win, q: StoreReader, ids: string[]): string[] {
    if (w.rowType === 'Thread') return changedThreads(q, ids, w.sentSeq, accountIds(q));
    const shown = new Set(ids);
    // An Event mark names the resource (`acct:cal/remote`); a shown occurrence carries `@<recurrenceId>`
    // appended, so it matches its resource's mark by prefix.
    const hit =
      w.rowType === 'Event'
        ? (id: string) => shown.has(id) || ids.some(s => s.startsWith(`${id}@`))
        : (id: string) => shown.has(id);
    const out = w.touchedAll ? ids : [...w.touched].filter(hit);
    w.touched.clear();
    w.touchedAll = false;
    return out;
  }

  /** The window as it stands now. `first` skips `changed`: the client knows no rows yet. */
  function build(w: Win, q: StoreReader, plan: ViewPlan, first: boolean): QueryResult {
    w.rowType = plan.rowType;
    const page = readPage(q, plan, w);
    w.ids = page.ids;
    const { total, sections } = shape(w, page.ids);
    const state: State = { dbEpoch: store.dbEpoch, seq: store.seq() };
    const changed = first ? [] : changedIds(w, q, page.ids);
    w.sentSeq = state.seq;
    return {
      state,
      rowType: w.rowType,
      ids: page.ids,
      position: w.position,
      total,
      sections,
      ...(changed.length ? { changed } : {}),
      ...(page.kept.length ? { held: page.kept } : {}),
    };
  }

  const withId = (w: Win, body: QueryResult): WindowBody => ({ windowId: w.id, ...body });

  // ---------------------------------------------------------------- opening, moving, closing

  function newWin(spec: ViewSpec, connectionId: string, q: StoreReader, limit?: number): Win {
    return {
      id: `w${hex(deps.randomBytes(8))}`,
      connectionId,
      epoch: store.dbEpoch,
      spec,
      rowType: 'Thread',
      gate: gateOf(spec, accountIds(q)),
      limit: spec.kind === 'events' ? EVENTS_LIMIT : Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      after: undefined,
      position: 0,
      ids: [],
      holds: newHolds(),
      departed: new Set(),
      places: new Map(),
      marks: new Map(),
      layoutStale: false,
      layoutAt: 0,
      sentSeq: 0,
      signature: '',
      pending: false,
      lastRunAt: clock.now(),
      touched: new Set(),
      touchedAll: false,
    };
  }

  /** Where an anchor points: a position, a known row, or an offset from the current start. */
  function target(w: Win, q: StoreReader, plan: ViewPlan, anchor?: Anchor): number {
    if (!anchor) return w.position;
    let at = anchor.position ?? w.position;
    if (anchor.id !== undefined) at = indexOfRow(w, q, plan, anchor.id);
    return at + (anchor.offset ?? 0);
  }

  /** The row's index in the view, remembered as a mark so the scroll can start from it. */
  function indexOfRow(w: Win, q: StoreReader, plan: ViewPlan, id: string): number {
    const found = plan.locate(q, id);
    if (!found) throw rowNotFound();
    w.marks.set(found.index + 1, { id, at: found.at });
    return found.index;
  }

  /** Scrolls an open (or opening) window and reads its page. */
  function scroll(
    w: Win,
    q: StoreReader,
    plan: ViewPlan,
    anchor: Anchor | undefined,
    first: boolean,
  ) {
    const now = clock.now();
    refreshLayout(w, q, plan, now, first);
    const last = Math.max(0, (w.layout?.total ?? 0) - 1);
    seek(q, plan, w, Math.min(target(w, q, plan, anchor), last));
    w.ids = [];
    w.departed.clear();
    const body = build(w, q, plan, first);
    w.signature = signatureOf(body);
    return body;
  }

  /** Makes room for one more window: the oldest of this connection past its share, then the oldest overall. */
  function evict(connectionId: string) {
    const mine = [...windows.values()].filter(w => w.connectionId === connectionId);
    const over = Math.max(0, mine.length - MAX_WINDOWS_PER_CONNECTION + 1);
    const gone = notFound().body;
    for (const old of mine.slice(0, over)) stopWindow(old, gone);
    const extra = Math.max(0, windows.size - MAX_WINDOWS + 1);
    for (const old of [...windows.values()].slice(0, extra)) stopWindow(old, gone);
  }

  function watch(args: WatchArgs, connectionId: string): WindowBody {
    committed();
    const body = store.read(q => {
      const now = clock.now();
      const w = newWin(args.spec, connectionId, q, args.limit);
      if (args.spec.kind === 'oneByOne') {
        const all = compileView({ ...args.spec, kind: 'homeSection' }, viewEnv(q, now, zone));
        w.frozen = all.rows(q, undefined, MATERIALIZED_LIMIT).map(r => r.id);
      }
      holdIds(w.holds, args.holdIds ?? [], now);
      const result = scroll(w, q, planOf(w, q, now), args.anchor, true);
      evict(connectionId);
      windows.set(w.id, w);
      return withId(w, result);
    });
    refreshTicker();
    return body;
  }

  function windowFor(windowId: string, connectionId: string): Win {
    const w = windows.get(windowId);
    if (!w || w.connectionId !== connectionId) throw notFound();
    if (w.epoch !== store.dbEpoch) {
      windows.delete(windowId);
      refreshTicker();
      throw notFound();
    }
    return w;
  }

  function move(args: MoveArgs, connectionId: string): WindowBody {
    committed();
    const w = windowFor(args.windowId, connectionId);
    if (args.range && w.spec.kind === 'events') w.spec = { ...w.spec, ...args.range };
    if (args.limit && w.spec.kind !== 'events') w.limit = Math.min(args.limit, MAX_LIMIT);
    touchHolds(w.holds, clock.now());
    return store.read(q => {
      const plan = planOf(w, q, clock.now());
      return withId(w, scroll(w, q, plan, args.anchor, false));
    });
  }

  function unwatch(windowId: string, connectionId: string): void {
    const w = windows.get(windowId);
    if (w && w.connectionId === connectionId) windows.delete(windowId);
    refreshTicker();
  }

  function hold(windowId: string, ids: string[], connectionId: string): void {
    holdIds(windowFor(windowId, connectionId).holds, ids, clock.now());
  }

  function release(windowId: string, ids: string[] | undefined, connectionId: string): void {
    const w = windowFor(windowId, connectionId);
    releaseHolds(w.holds, ids);
    w.pending = true;
    run(clock.now());
  }

  function query(args: Omit<WatchArgs, 'holdIds'>): QueryResult {
    return store.read(q => {
      const now = clock.now();
      const w = newWin(args.spec, '', q, args.limit);
      if (args.spec.kind === 'oneByOne') w.spec = { ...args.spec, kind: 'homeSection' };
      return scroll(w, q, planOf(w, q, now), args.anchor, true);
    });
  }

  // ---------------------------------------------------------------- re-running

  function rerun(w: Win, now: number): void {
    w.pending = false;
    w.lastRunAt = now;
    stats.reruns++;
    let body: QueryResult;
    try {
      body = store.read(q => {
        const plan = planOf(w, q, now);
        refreshLayout(w, q, plan, now, false);
        return build(w, q, plan, false);
      });
    } catch (error) {
      return failed(w, error);
    }
    const sig = signatureOf(body);
    if (sig === w.signature && !body.changed) return;
    w.signature = sig;
    send(w, body);
  }

  const send = (w: Win, body: QueryResult) => {
    stats.frames++;
    frames.emit({ frame: 'window', ...withId(w, body) }, w.connectionId);
  };

  /** A window whose view is gone (its thread was deleted) ends with a last frame carrying why. */
  function failed(w: Win, error: unknown): void {
    if (!(error instanceof ContractError)) {
      deps.log.event('rpc.failed', { method: 'View/rerun', reason: 'internal' });
      return;
    }
    // Contract failures end the window with the same body the caller sees; logged too, or a generic
    // "Couldn't load this list." is all anyone ever finds (owner calendar bug: the log stayed silent).
    deps.log.event('view.window_failed', { kind: w.spec.kind, type: error.body.type });
    stopWindow(w, error.body);
  }

  function stopWindow(w: Win, error: ErrorBody): void {
    const state: State = { dbEpoch: store.dbEpoch, seq: store.seq() };
    const body: QueryResult = {
      state,
      rowType: w.rowType,
      ids: [],
      position: 0,
      total: 0,
      sections: [],
      error,
    };
    windows.delete(w.id);
    refreshTicker();
    send(w, body);
  }

  /** Runs every window that is due: marked and past its interval, holds lapsed, or its counts overdue. */
  function run(now: number): void {
    for (const w of [...windows.values()]) {
      if (!windows.has(w.id)) continue;
      if (w.epoch !== store.dbEpoch) {
        // A restore replaced the database: the window's rows are gone, and the next call on it answers notFound.
        windows.delete(w.id);
        refreshTicker();
        continue;
      }
      if (lapseHolds(w.holds, now)) w.pending = true;
      const overdue = w.layoutStale && now - w.layoutAt >= LAYOUT_REFRESH_MS;
      if ((w.pending || overdue) && now - w.lastRunAt >= WINDOW_INTERVAL_MS) rerun(w, now);
    }
  }

  // ---------------------------------------------------------------- commits

  function fanOut(sum: ChangeSummary): void {
    for (const w of windows.values()) {
      if (!reaches(w.gate, sum)) continue;
      w.pending = true;
      w.layoutStale = true;
      if (w.frozen) w.frozen = w.frozen.filter(id => !sum.deleted.has(id));
      if (w.rowType !== 'Thread') touch(w, sum.ids.get(w.rowType));
    }
  }

  /** Notes which shown rows may have changed: the ids a commit named, or all of them when it did not say. */
  function touch(w: Win, ids: Set<string> | undefined): void {
    // A sender group is a summary of threads: any thread change reaching it may have moved its count.
    if (w.rowType === 'SenderGroup' || ids?.size === 0) w.touchedAll = true;
    else if (ids) for (const id of ids) w.touched.add(id);
  }

  function voidWindows(reason: 'cannotCalculateChanges'): void {
    windows.clear();
    refreshTicker();
    frames.reset(reason);
  }

  function committed(): void {
    const seq = store.seq();
    if (seq !== lastSeq && windows.size) {
      const sum = summarize(store, lastSeq, store.read(accountIds));
      if (sum === 'void') voidWindows('cannotCalculateChanges');
      else fanOut(sum);
    }
    lastSeq = seq;
    run(clock.now());
  }

  // ---------------------------------------------------------------- the rest of the area

  const state = (): State => ({ dbEpoch: store.dbEpoch, seq: store.seq() });

  return {
    watch,
    move,
    unwatch,
    hold,
    release,
    query,
    committed,
    stats,
    zone,
    folders: accountId => store.read(q => ({ state: state(), list: readFolders(q, accountId) })),
    counts: () => store.read(q => readCounts(q, viewEnv(q, clock.now(), zone))),
    senderGroups: ids => store.read(q => readSenderGroups(q, ids, state())),
    stopWindows(connectionId, kind, error, match = () => true) {
      for (const w of [...windows.values()])
        if (w.connectionId === connectionId && w.spec.kind === kind && match(w.spec))
          stopWindow(w, error);
    },
    specsOf: (connectionId, kind) =>
      [...windows.values()]
        .filter(w => w.connectionId === connectionId && w.spec.kind === kind)
        .map(w => w.spec),
    close() {
      windows.clear();
      ticker.close();
    },
  };
}
