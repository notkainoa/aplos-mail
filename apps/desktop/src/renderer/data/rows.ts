/**
 * The row cache (plan 30 4.1 `rows.ts`): rows by contract type and id, reference-counted by windows, hooks and the
 * overlay, evicted when nothing holds them. A row whose `rev` did not move keeps its object identity, so memo deps and
 * `useSyncExternalStore` snapshots stay stable. `RowFetcher` batches every request of one frame into one `T/get` per
 * type and never asks again for an id already in flight unless it went stale meanwhile.
 */
import type { Id, Input, MethodName, State } from './contract-shapes';
import type { DataClient } from './client';
import { rowTopic, type Emitter } from './emitter';
import type { StateOrder } from './states';
import type { CachedRowType, RowTypeMap } from './ui-types';

export type RowStatus = 'loading' | 'ready' | 'notFound';

interface RowEntry {
  row: unknown;
  /** The state the row was read at; null when the answer carried none (accounts, operations). */
  state: State | null;
  status: RowStatus;
  refs: number;
  windowRefs: number;
  stale: boolean;
}

/** The id of a cached row: `opId` for operations, `id` for everything else. */
export function rowId(type: CachedRowType, row: unknown): Id {
  const r = row as { id?: Id; opId?: Id };
  return (type === 'Operation' ? r.opId : r.id) ?? '';
}

function sameRow(a: unknown, b: unknown): boolean {
  const ra = (a as { rev?: unknown }).rev;
  const rb = (b as { rev?: unknown }).rev;
  if (typeof ra === 'number' && typeof rb === 'number') return ra === rb;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class RowCache {
  private readonly tables = new Map<CachedRowType, Map<Id, RowEntry>>();

  constructor(
    private readonly order: StateOrder,
    private readonly emitter: Emitter,
  ) {}

  private table(type: CachedRowType): Map<Id, RowEntry> {
    let table = this.tables.get(type);
    if (!table) this.tables.set(type, (table = new Map()));
    return table;
  }

  private entry(type: CachedRowType, id: Id): RowEntry {
    const table = this.table(type);
    let entry = table.get(id);
    if (!entry) {
      entry = {
        row: undefined,
        state: null,
        status: 'loading',
        refs: 0,
        windowRefs: 0,
        stale: false,
      };
      table.set(id, entry);
    }
    return entry;
  }

  get<T extends CachedRowType>(type: T, id: Id): RowTypeMap[T] | undefined {
    return this.tables.get(type)?.get(id)?.row as RowTypeMap[T] | undefined;
  }

  status(type: CachedRowType, id: Id): RowStatus {
    return this.tables.get(type)?.get(id)?.status ?? 'loading';
  }

  fetchedAt(type: CachedRowType, id: Id): State | null {
    return this.tables.get(type)?.get(id)?.state ?? null;
  }

  has(type: CachedRowType, id: Id): boolean {
    return this.tables.get(type)?.has(id) ?? false;
  }

  /** Hold rows; `window` marks a window's hold, so `heldOutsideWindows` can tell hooks and the overlay apart. */
  retain(type: CachedRowType, ids: Iterable<Id>, window = false): void {
    for (const id of ids) {
      const entry = this.entry(type, id);
      entry.refs++;
      if (window) entry.windowRefs++;
    }
  }

  release(type: CachedRowType, ids: Iterable<Id>, window = false): void {
    const table = this.tables.get(type);
    if (!table) return;
    for (const id of ids) {
      const entry = table.get(id);
      if (!entry) continue;
      entry.refs = Math.max(0, entry.refs - 1);
      if (window) entry.windowRefs = Math.max(0, entry.windowRefs - 1);
      if (entry.refs === 0) table.delete(id);
    }
  }

  /** Stores fetched rows read at `state`; an older answer than the cached one is ignored. Returns whether anything changed. */
  put(type: CachedRowType, rows: readonly unknown[], state: State | null): boolean {
    const changed: string[] = [];
    const table = this.table(type);
    for (const row of rows) {
      const id = rowId(type, row);
      const entry = table.get(id);
      if (!entry) continue;
      if (entry.state && state && this.order.compare(state, entry.state) < 0) continue;
      entry.stale = false;
      // The overlay lays itself over a thread read before the commit it predicts, so a newer read can change it.
      let moved =
        type === 'Thread' &&
        (entry.state?.seq !== state?.seq || entry.state?.dbEpoch !== state?.dbEpoch);
      entry.state = state;
      if (entry.status !== 'ready') {
        entry.status = 'ready';
        moved = true;
      }
      if (entry.row === undefined || !sameRow(entry.row, row)) {
        entry.row = row;
        moved = true;
      }
      if (moved) changed.push(rowTopic(type, id));
    }
    if (changed.length) this.emitter.emit(...changed);
    return changed.length > 0;
  }

  notFound(type: CachedRowType, ids: readonly Id[], state: State | null): void {
    const changed: string[] = [];
    const table = this.table(type);
    for (const id of ids) {
      const entry = table.get(id);
      if (!entry) continue;
      if (entry.state && state && this.order.compare(state, entry.state) < 0) continue;
      entry.stale = false;
      entry.state = state;
      if (entry.status !== 'notFound' || entry.row !== undefined) changed.push(rowTopic(type, id));
      entry.status = 'notFound';
      entry.row = undefined;
    }
    if (changed.length) this.emitter.emit(...changed);
  }

  markStale(type: CachedRowType, ids: Iterable<Id>): void {
    const table = this.tables.get(type);
    if (!table) return;
    for (const id of ids) {
      const entry = table.get(id);
      if (entry) entry.stale = true;
    }
  }

  /** Every held row of a type: on a reset nothing cached can be trusted. */
  markAllStale(type: CachedRowType): Id[] {
    const ids = [...(this.tables.get(type)?.keys() ?? [])];
    this.markStale(type, ids);
    return ids;
  }

  /** True when the row is known, not stale, and was read at or after `atState` when one is given. */
  isFresh(type: CachedRowType, id: Id, atState?: State | null): boolean {
    const entry = this.tables.get(type)?.get(id);
    if (!entry || entry.status === 'loading' || entry.stale) return false;
    if (atState && !this.order.reached(entry.state, atState)) return false;
    return true;
  }

  /** Rows held by hooks or the overlay but by no window, which no window frame will report as changed. */
  heldOutsideWindows(type: CachedRowType): Id[] {
    const out: Id[] = [];
    for (const [id, entry] of this.tables.get(type) ?? [])
      if (entry.refs > entry.windowRefs) out.push(id);
    return out;
  }

  /** Total cached rows, for tests and diagnostics. */
  size(type: CachedRowType): number {
    return this.tables.get(type)?.size ?? 0;
  }
}

const getMethods: { readonly [T in CachedRowType]: MethodName } = {
  Thread: 'Thread/get',
  Message: 'Message/get',
  Draft: 'Draft/get',
  Submission: 'Submission/get',
  Event: 'Event/get',
  Plan: 'Plan/get',
  Conversation: 'Conversation/get',
  SenderGroup: 'SenderGroup/get',
  Account: 'Account/get',
  Operation: 'Operation/get',
};

/**
 * `T/get` takes at most 500 ids (Account/get 200), so a big batch is split; one frame rarely needs more than 200.
 * Events fetch in chunks of 100: an event row carries its attendees, and `Event/get` with many attendees can exceed
 * the reply cap (500 events with 10 attendees each is a ~594 KB answer, refused as tooLarge).
 */
const MAX_IDS: Partial<Record<CachedRowType, number>> = { Account: 200, Event: 100 };

interface GetAnswer {
  state?: State;
  list: unknown[];
  notFound: string[];
}

/** Batches row reads: every id requested before `flush()` goes out in one `T/get` per type. */
export class RowFetcher {
  private readonly queued = new Map<CachedRowType, Set<Id>>();
  private readonly inFlight = new Map<CachedRowType, Map<Id, boolean>>();

  constructor(
    private readonly client: DataClient,
    private readonly rows: RowCache,
    private readonly wake: () => void,
    private readonly onError: (type: CachedRowType, ids: readonly Id[], error: unknown) => void,
    private readonly onLoaded: () => void = () => {},
  ) {}

  /** Ask for rows that are unknown or stale (or read before `atState`); ids already fresh are skipped. */
  request(type: CachedRowType, ids: Iterable<Id>, atState?: State | null): void {
    let added = false;
    for (const id of ids) {
      if (this.rows.isFresh(type, id, atState)) continue;
      const flying = this.inFlight.get(type);
      if (flying?.has(id)) {
        // Re-read once the current answer lands, which may predate the change.
        flying.set(id, true);
        continue;
      }
      let set = this.queued.get(type);
      if (!set) this.queued.set(type, (set = new Set()));
      if (!set.has(id)) {
        set.add(id);
        added = true;
      }
    }
    if (added) this.wake();
  }

  get pending(): boolean {
    for (const set of this.queued.values()) if (set.size) return true;
    return false;
  }

  /** Send the queued reads: one call per type. */
  flush(): void {
    for (const [type, set] of this.queued) {
      if (!set.size) continue;
      const ids = [...set];
      set.clear();
      const max = MAX_IDS[type] ?? 500;
      for (let i = 0; i < ids.length; i += max) this.send(type, ids.slice(i, i + max));
    }
  }

  private send(type: CachedRowType, ids: Id[]): void {
    let flying = this.inFlight.get(type);
    if (!flying) this.inFlight.set(type, (flying = new Map()));
    for (const id of ids) flying.set(id, false);
    const args = (type === 'Operation' ? { opIds: ids } : { ids }) as Input<MethodName>;
    const finish = (): Id[] => {
      const again: Id[] = [];
      for (const id of ids) {
        if (flying.get(id)) again.push(id);
        flying.delete(id);
      }
      return again;
    };
    this.client.call(getMethods[type], args).then(
      result => {
        const answer = result as GetAnswer;
        const again = finish();
        const state = answer.state ?? null;
        this.rows.put(type, answer.list, state);
        this.rows.notFound(type, answer.notFound, state);
        if (again.length) {
          this.rows.markStale(type, again);
          this.request(type, again);
        }
        this.onLoaded();
      },
      error => {
        finish();
        this.onError(type, ids, error);
      },
    );
  }
}
