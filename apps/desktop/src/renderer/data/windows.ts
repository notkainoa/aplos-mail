/**
 * Watched windows (plan 30 4.1 `windows.ts`): `View/watch`, `View/move`, `View/unwatch`, `View/hold` and
 * `View/release` over the one `WindowSource` the renderer has, `engineWindows`. Frames are ID-only; a frame's unknown
 * or stale rows are read with one `T/get` per frame. A `reset` frame (any reason, including `cannotCalculateChanges`)
 * voids every window: each reopens and re-reads while its previous ids stay on screen. While `holdIds` is non-empty a
 * window renders the held order and queues the engine's frames, then reconciles with the newest one on release.
 */
import type {
  ErrorBody,
  Id,
  MailSettings,
  ViewSpec,
  WindowBody,
  WindowFrame,
  WindowSection,
} from './contract-shapes';
import type { DataClient } from './client';
import { toErrorBody } from './client';
import {
  FAILURES_TOPIC,
  memoSnapshot,
  OVERLAY_TOPIC,
  readsRows,
  sameArray,
  sameJson,
  sameMap,
  SESSION_TOPIC,
  windowTopic,
  type Emitter,
  type Topic,
} from './emitter';
import type { RowFailure, ViewRange, ViewResult, ViewStatus } from './index';
import {
  entersView,
  overlayWindow,
  sectionAt,
  specKey,
  type Overlay,
  type OverlaidWindow,
  type OverlayEntry,
} from './optimistic';
import type { RowCache, RowFetcher } from './rows';
import type { StateOrder } from './states';
import type { CachedRowType } from './ui-types';

const CACHED_TYPES = new Set<string>([
  'Thread',
  'Message',
  'Draft',
  'Submission',
  'Event',
  'Plan',
  'Conversation',
  'SenderGroup',
]);

/** The cache table for a window's `rowType`; null for a type this renderer does not cache. */
export function cachedType(rowType: string | null | undefined): CachedRowType | null {
  return rowType && CACHED_TYPES.has(rowType) ? (rowType as CachedRowType) : null;
}

/** Most ids `View/watch` and `View/move` return (ARCH 9.2). */
const MAX_LIMIT = 200;

export interface WindowDeps {
  readonly client: DataClient;
  readonly rows: RowCache;
  readonly fetcher: RowFetcher;
  readonly overlay: Overlay;
  readonly order: StateOrder;
  readonly emitter: Emitter;
  /** Done and Later's after-actions, for predicting whether a row leaves the Inbox. */
  readonly mail: () => Pick<MailSettings, 'doneAction' | 'laterAction'> | undefined;
  /** Rows whose last write was rejected, by thread id. */
  readonly failures: () => ReadonlyMap<Id, RowFailure>;
  /** A window's base moved: the overlay may have caught up. */
  readonly settled: () => void;
  /** Run later, in the next flush (a window released by a render that is about to re-acquire it). */
  readonly defer: (fn: () => void) => void;
}

const EMPTY_FAILURES: ReadonlyMap<Id, RowFailure> = new Map();

export class EngineWindow {
  readonly key: string;
  windowId: string | null = null;
  base: WindowBody | null = null;
  status: ViewStatus = 'opening';
  error: ErrorBody | null = null;
  /** Hooks and helpers using this window. */
  refs = 0;
  /** Section keys that had rows when the current hold began (Home keeps an emptied label at 0 until release). */
  sectionsAtHold: ReadonlySet<string> = new Set();

  private queued: WindowBody | null = null;
  private readonly queuedChanged = new Set<Id>();
  private readonly holders = new Map<number, readonly Id[]>();
  private sentHold: readonly Id[] = [];
  private retainedType: CachedRowType | null = null;
  private retainedIds: readonly Id[] = [];
  private openGeneration = 0;
  private lastMove = '';
  private refreshing = false;
  private closed = false;
  /** The ids the last snapshot drew, so a row change wakes only the windows showing it. */
  private drawn: ReadonlySet<Id> = new Set();
  readonly topic: Topic;
  readonly snapshot: () => ViewResult<unknown>;

  constructor(
    readonly spec: ViewSpec,
    private readonly deps: WindowDeps,
    private readonly orphan: (windowId: string) => WindowFrame | undefined,
  ) {
    this.key = specKey(spec);
    this.topic = windowTopic(this.key);
    this.snapshot = memoSnapshot(deps.emitter, () => this.compute(), sameView);
  }

  /** Ids to keep in place: every holder's, together. */
  get holdIds(): readonly Id[] {
    const all = new Set<Id>();
    for (const ids of this.holders.values()) for (const id of ids) all.add(id);
    return [...all];
  }

  /** Whether a change to these topics can change this window's snapshot. */
  reads(topics: ReadonlySet<Topic>): boolean {
    if (topics.has(this.topic) || topics.has(FAILURES_TOPIC)) return true;
    const type = cachedType(this.base?.rowType);
    if (!type) return false;
    // Settings decide whether Done and Later take a row out of the Inbox.
    if (type === 'Thread' && (topics.has(OVERLAY_TOPIC) || topics.has(SESSION_TOPIC))) return true;
    return readsRows(topics, type, id => this.drawn.has(id));
  }

  private changed(): void {
    this.deps.emitter.emit(this.topic);
  }

  get held(): boolean {
    return this.holdIds.length > 0;
  }

  /** Rows that arrived during a hold and wait to arrive, by section ("2 new" beside Do now). */
  waiting(section: string | null): number {
    if (!this.queued || !this.base) return 0;
    const shown = new Set(this.base.ids);
    let n = 0;
    this.queued.ids.forEach((id, i) => {
      if (!shown.has(id) && (section === null || sectionAt(this.queued!, i) === section)) n++;
    });
    return n;
  }

  open(): void {
    if (this.closed) return;
    const generation = ++this.openGeneration;
    const holdIds = this.holdIds;
    this.sentHold = holdIds;
    const position = this.base?.position ?? 0;
    this.deps.client
      .call('View/watch', {
        spec: this.spec,
        ...(holdIds.length ? { holdIds: [...holdIds] } : {}),
        ...(position ? { anchor: { position } } : {}),
      })
      .then(
        body => {
          if (generation !== this.openGeneration || this.closed) {
            // A reopen or a close overtook this watch: nobody will read the engine window it made.
            void this.deps.client.call('View/unwatch', { windowId: body.windowId }).catch(() => {});
            return;
          }
          this.windowId = body.windowId;
          this.deps.emitter.batch(() => {
            this.apply(body, true);
            const early = this.orphan(body.windowId);
            if (early) this.frame(early);
            if (this.holdIds.join() !== this.sentHold.join()) this.syncHold();
          });
        },
        error => {
          if (generation !== this.openGeneration || this.closed) return;
          this.status = 'failed';
          this.error = toErrorBody(error);
          this.changed();
        },
      );
  }

  /** A `window` frame for this window. */
  frame(frame: WindowFrame): void {
    if (frame.windowId !== this.windowId || this.closed) return;
    if (this.held) {
      if (!this.queued || this.deps.order.compare(frame.state, this.queued.state) >= 0)
        this.queued = frame;
      for (const id of frame.changed ?? []) this.queuedChanged.add(id);
      this.changed();
      return;
    }
    this.apply(frame, false);
  }

  /** The engine voided every window: reopen, keeping the previous ids on screen. */
  reset(): void {
    if (this.closed) return;
    this.windowId = null;
    this.queued = null;
    this.queuedChanged.clear();
    this.lastMove = '';
    if (this.status !== 'opening') this.status = 'reset';
    this.changed();
    this.open();
  }

  move(range: ViewRange): void {
    if (!this.windowId || this.spec.kind === 'events') return;
    const start = Math.max(0, Math.floor(range.start));
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.ceil(range.end) - start));
    const key = `${start}:${limit}`;
    if (key === this.lastMove) return;
    this.lastMove = key;
    const windowId = this.windowId;
    this.deps.client.call('View/move', { windowId, anchor: { position: start }, limit }).then(
      body => {
        if (this.windowId === windowId && !this.held) this.apply(body, false);
      },
      () => {
        this.lastMove = '';
      },
    );
  }

  /**
   * Re-read the window where it is (`View/move` with no anchor or limit keeps both), for a window that will get no
   * frame for a commit it is waiting on: nothing it shows changed at the engine.
   */
  refresh(): void {
    if (!this.windowId || this.refreshing) return;
    const windowId = this.windowId;
    this.refreshing = true;
    this.deps.client.call('View/move', { windowId }).then(
      body => {
        this.refreshing = false;
        if (this.windowId !== windowId) return;
        this.deps.emitter.batch(() =>
          this.frame({
            frame: 'window',
            dbEpoch: body.state.dbEpoch,
            seq: body.state.seq,
            ...body,
          }),
        );
      },
      () => {
        this.refreshing = false;
      },
    );
  }

  /** One holder's `holdIds`; a change sends `View/hold` or `View/release`, never a re-watch. */
  setHold(holder: number, ids: readonly Id[]): void {
    const wasHeld = this.held;
    if (ids.length) this.holders.set(holder, ids);
    else this.holders.delete(holder);
    if (!wasHeld && this.held) {
      this.sectionsAtHold = new Set(
        (this.base?.sections ?? []).filter(s => s.count > 0).map(s => s.key),
      );
      this.changed();
    }
    this.syncHold();
    if (wasHeld && !this.held) {
      const queued = this.queued;
      this.queued = null;
      const changed = [...this.queuedChanged];
      this.queuedChanged.clear();
      this.sectionsAtHold = new Set();
      if (queued) this.apply({ ...queued, changed }, false);
      else this.changed();
    }
  }

  private syncHold(): void {
    const ids = this.holdIds;
    if (!this.windowId) return;
    if (ids.join() === this.sentHold.join()) return;
    const windowId = this.windowId;
    this.sentHold = ids;
    const sent = ids.length
      ? this.deps.client.call('View/hold', { windowId, ids: [...ids] })
      : this.deps.client.call('View/release', { windowId });
    sent.catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.windowId)
      void this.deps.client.call('View/unwatch', { windowId: this.windowId }).catch(() => {});
    if (this.retainedType) this.deps.rows.release(this.retainedType, this.retainedIds, true);
    this.retainedIds = [];
  }

  /** Takes a body as the window's base: retains its rows and reads the unknown or stale ones. */
  private apply(raw: WindowBody, opened: boolean): void {
    const { rows, fetcher, order, emitter } = this.deps;
    if (!opened && this.base && order.compare(raw.state, this.base.state) < 0) return;
    const body = uniqueIds(raw);
    order.observe(body.state.dbEpoch);
    const type = cachedType(body.rowType);
    const previous = new Set(this.base?.ids ?? []);
    emitter.batch(() => {
      if (type) {
        rows.retain(type, body.ids, true);
        if (body.changed?.length) rows.markStale(type, body.changed);
        const known: Id[] = [];
        const fresh: Id[] = [];
        for (const id of body.ids) (previous.has(id) ? known : fresh).push(id);
        fetcher.request(type, known);
        // A row new to this window may have changed on its way here; trust only a read at this frame's state.
        fetcher.request(type, fresh, body.state);
      }
      if (this.retainedType) rows.release(this.retainedType, this.retainedIds, true);
      this.retainedType = type;
      this.retainedIds = body.ids;
      this.base = { ...body };
      delete this.base.changed;
      this.status = body.error ? 'failed' : 'live';
      this.error = body.error ?? null;
      this.changed();
    });
    this.deps.settled();
  }

  /** The window's ids, total and sections with the overlay applied. */
  rendered(): OverlaidWindow | null {
    if (!this.base) return null;
    if (this.base.rowType !== 'Thread') return this.base;
    return overlayWindow(
      this.key,
      this.spec,
      this.base,
      this.deps.overlay.entries,
      this.deps.order,
      this.deps.mail(),
    );
  }

  private compute(): ViewResult<unknown> {
    const base = this.base;
    const move = (range: ViewRange) => this.move(range);
    if (!base) {
      return {
        ids: [],
        position: 0,
        total: 0,
        rows: new Map(),
        sections: [],
        held: [],
        rowType: null,
        state: null,
        status: this.status,
        error: this.error,
        failures: EMPTY_FAILURES,
        move,
      };
    }
    const shown = this.rendered()!;
    const type = cachedType(base.rowType);
    const rowMap = new Map<Id, unknown>();
    if (type)
      for (const id of shown.ids) {
        const row = this.deps.rows.get(type, id);
        if (!row) continue;
        rowMap.set(
          id,
          type === 'Thread'
            ? this.deps.overlay.row(
                row as never,
                this.deps.rows.fetchedAt(type, id),
                this.deps.order,
              )
            : row,
        );
      }
    this.drawn = new Set(shown.ids);
    const all = this.deps.failures();
    let failures = EMPTY_FAILURES;
    if (all.size) {
      const mine = new Map<Id, RowFailure>();
      for (const id of shown.ids) {
        const failure = all.get(id);
        if (failure) mine.set(id, failure);
      }
      if (mine.size) failures = mine;
    }
    return {
      ids: shown.ids,
      position: base.position,
      total: shown.total,
      rows: rowMap,
      sections: shown.sections,
      held: base.held ?? [],
      rowType: base.rowType,
      state: base.state,
      status: this.status,
      error: this.error,
      failures,
      move,
    };
  }
}

function sameView(a: ViewResult<unknown>, b: ViewResult<unknown>): boolean {
  return (
    a.status === b.status &&
    a.state === b.state &&
    a.total === b.total &&
    a.position === b.position &&
    a.rowType === b.rowType &&
    a.error === b.error &&
    sameArray(a.ids, b.ids) &&
    sameArray(a.held, b.held) &&
    sameMap(a.rows, b.rows) &&
    sameMap(a.failures, b.failures) &&
    sameSections(a.sections, b.sections)
  );
}

function sameSections(a: readonly WindowSection[], b: readonly WindowSection[]): boolean {
  return a === b || sameJson(a, b);
}

/**
 * A body with each id once. Sections never overlap by contract, but a row listed twice would give a list two rows
 * with one key; the later copy is dropped and its section's count and the starts after it move up.
 */
export function uniqueIds(body: WindowBody): WindowBody {
  if (new Set(body.ids).size === body.ids.length) return body;
  const seen = new Set<Id>();
  const dropped: number[] = [];
  const ids = body.ids.filter((id, i) => {
    if (seen.has(id)) {
      dropped.push(body.position + i);
      return false;
    }
    seen.add(id);
    return true;
  });
  const before = (at: number) => dropped.filter(d => d < at).length;
  const sections = body.sections
    .map(s =>
      s.key === 'low'
        ? { ...s, start: s.start - before(s.start) }
        : {
            ...s,
            start: s.start - before(s.start),
            count: s.count - dropped.filter(d => d >= s.start && d < s.start + s.count).length,
          },
    )
    .filter(s => s.key === 'low' || s.count > 0);
  return { ...body, ids, sections, total: body.total - dropped.length };
}

/** Frames for windows this renderer has not heard of yet (a watch's answer still on its way), newest per window. */
const ORPHAN_LIMIT = 64;

/** `engineWindows`: one engine window per distinct spec, shared by every hook that watches it. */
export class WindowManager {
  private readonly windows = new Map<string, EngineWindow>();
  private readonly orphans = new Map<string, WindowFrame>();

  constructor(private readonly deps: WindowDeps) {}

  /** The window for a spec, created (not yet watched) when new. Pass `key` (its `specKey`) to skip computing it. */
  get(spec: ViewSpec, key = specKey(spec)): EngineWindow {
    let w = this.windows.get(key);
    if (!w) {
      w = new EngineWindow(spec, this.deps, id => this.takeOrphan(id));
      this.windows.set(key, w);
    }
    return w;
  }

  /** Start using a window: the first user watches it. */
  acquire(spec: ViewSpec): EngineWindow {
    const w = this.get(spec);
    if (w.refs++ === 0 && !w.windowId && w.status === 'opening') w.open();
    return w;
  }

  /** Stop using a window: the last user unwatches it, unless someone takes it again before the next flush. */
  release(w: EngineWindow): void {
    if (--w.refs > 0) return;
    w.refs = 0;
    this.deps.defer(() => {
      if (w.refs > 0) return;
      w.close();
      if (this.windows.get(w.key) === w) this.windows.delete(w.key);
    });
  }

  /** Windows created by a render that never mounted. */
  sweepUnused(): void {
    for (const [key, w] of this.windows) if (w.refs === 0 && !w.windowId) this.windows.delete(key);
  }

  all(): EngineWindow[] {
    return [...this.windows.values()];
  }

  frame(frame: WindowFrame): void {
    for (const w of this.windows.values())
      if (w.windowId === frame.windowId) {
        w.frame(frame);
        return;
      }
    const prior = this.orphans.get(frame.windowId);
    if (!prior || this.deps.order.compare(frame.state, prior.state) >= 0)
      this.orphans.set(frame.windowId, frame);
    while (this.orphans.size > ORPHAN_LIMIT) this.orphans.delete(this.orphans.keys().next().value!);
  }

  reset(): void {
    this.orphans.clear();
    for (const w of this.windows.values()) if (w.refs > 0) w.reset();
  }

  /**
   * The open windows that still need the entry: not yet at its state, and touched by it. Only windows that held a
   * target (or match its selector) get a frame for the commit, so only they are waited for. A restore waits for every
   * window it puts a row back in or takes one out of.
   */
  blocking(entry: OverlayEntry): EngineWindow[] {
    const at = entry.appliedState;
    if (!at) return [];
    const selectorKey = entry.selector ? specKey(entry.selector.spec) : null;
    const out: EngineWindow[] = [];
    const mail = this.deps.mail();
    for (const w of this.windows.values()) {
      if (w.refs === 0 || !w.base || w.base.rowType !== 'Thread') continue;
      if (this.deps.order.reached(w.base.state, at)) continue;
      const shows = w.base.ids.some(id => entry.targets.has(id));
      const waits =
        entry.kind === 'restore'
          ? entry.originalPosition.has(w.key) ||
            (shows && !!entry.action && entersView(w.spec, entry.action, mail))
          : w.key === selectorKey || shows;
      if (waits) out.push(w);
    }
    return out;
  }

  /** True when no open window still needs the entry. */
  settled(entry: OverlayEntry): boolean {
    return !!entry.appliedState && this.blocking(entry).length === 0;
  }

  private takeOrphan(windowId: string): WindowFrame | undefined {
    const frame = this.orphans.get(windowId);
    this.orphans.delete(windowId);
    return frame;
  }
}
