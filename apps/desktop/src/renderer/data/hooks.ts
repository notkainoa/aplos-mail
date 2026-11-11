/**
 * The React face of the data layer: every hook reads a plain store through `useSyncExternalStore`, so a component
 * re-renders only when its own snapshot changes, never per animation frame. `createHooks(layer)` returns the
 * `DataRuntime` that `connectDataLayer()` installs behind `./index.ts`.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type {
  AccountId,
  Event,
  EventTime,
  Id,
  MessageId,
  OpId,
  ThreadRow,
  ViewSpec,
} from './contract-shapes';
import {
  BODY_TOPIC,
  memoSnapshot,
  opTopic,
  rowTopic,
  sameJson,
  SESSION_TOPIC,
  UNDO_TOPIC,
  type Emitter,
  type Topic,
} from './emitter';
import { toHomeView } from './home';
import type {
  AgendaView,
  DataRuntime,
  FrameFilter,
  HomeView,
  OperationView,
  RowState,
  UseFramesOptions,
  UseHomeOptions,
  UseNowOptions,
  UseViewOptions,
  ViewResult,
} from './index';
import type { DataLayer } from './layer';
import { countsFor, pickStatus } from './session';
import { specKey } from './optimistic';
import type { CachedRowType, StreamKind, ViewSpecOf } from './ui-types';
import type { EngineWindow, WindowManager } from './windows';

const EMPTY_IDS: readonly Id[] = [];

let holderSeq = 0;

/** Sort key for an event start: epoch ms for `utc`, local midnight for `date`, the local wall time for `floating`. */
function startKey(time: EventTime): number {
  if (time.type === 'utc') return time.utc;
  if (time.type === 'date') return new Date(`${time.date}T00:00:00`).getTime();
  return new Date(time.local).getTime();
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Events by start, all-day first within a day. */
export function orderEvents(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const ka = startKey(a.start);
    const kb = startKey(b.start);
    const da = localDay(ka);
    const db = localDay(kb);
    if (da !== db) return ka - kb;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return ka - kb;
  });
}

/** A store for `useSyncExternalStore`: wakes only for the topics `reads` accepts. */
export interface TopicStore<T> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => T;
}

export function topicStore<T>(
  emitter: Emitter,
  reads: (topics: ReadonlySet<Topic>) => boolean,
  getSnapshot: () => T,
): TopicStore<T> {
  return { subscribe: listener => emitter.subscribe(listener, reads), getSnapshot };
}

/**
 * A window's store, read through the manager on every call: a window created by a render can be swept before the
 * effect that acquires it runs, and the acquired one replaces it under the same spec.
 */
export function windowStore(
  emitter: Emitter,
  windows: WindowManager,
  spec: ViewSpec,
): TopicStore<ViewResult<unknown>> & { readonly current: () => EngineWindow } {
  const key = specKey(spec);
  const current = () => windows.get(spec, key);
  return {
    current,
    ...topicStore(
      emitter,
      topics => current().reads(topics),
      () => current().snapshot(),
    ),
  };
}

/** One cached row with the overlay laid over it; wakes only when that row (or an overlay entry on it) changes. */
export function rowStore<T extends CachedRowType>(
  layer: DataLayer,
  type: T,
  id: Id | undefined,
): TopicStore<{ row: unknown; status: RowState<never>['status'] }> {
  const topic = id ? rowTopic(type, id) : '';
  return topicStore(
    layer.emitter,
    topics => !!id && topics.has(topic),
    memoSnapshot(
      layer.emitter,
      () => {
        if (!id) return { row: undefined, status: 'loading' as const };
        const raw = layer.rows.get(type, id);
        const row =
          raw && type === 'Thread'
            ? layer.overlay.row(raw as ThreadRow, layer.rows.fetchedAt(type, id), layer.order)
            : raw;
        return { row, status: layer.rows.status(type, id) };
      },
      (a, b) => a.row === b.row && a.status === b.status,
    ),
  );
}

/** One operation as toasts see it: its record and its provider-side row. */
export function operationStore(
  layer: DataLayer,
  opId: OpId | undefined,
): TopicStore<ReturnType<DataLayer['operations']['view']>> {
  const mine = opId ? [opTopic(opId), rowTopic('Operation', opId)] : [];
  return topicStore(
    layer.emitter,
    topics => mine.some(topic => topics.has(topic)),
    () => layer.operations.view(opId),
  );
}

const readsSession = (topics: ReadonlySet<Topic>) => topics.has(SESSION_TOPIC);
const readsBody = (topics: ReadonlySet<Topic>) => topics.has(BODY_TOPIC);

/** The undo stack's top depends on every remembered operation and its provider-side row. */
function readsUndo(topics: ReadonlySet<Topic>): boolean {
  if (topics.has(UNDO_TOPIC)) return true;
  for (const topic of topics)
    if (topic.startsWith('op:') || topic.startsWith('row:Operation:')) return true;
  return false;
}

export function createHooks(layer: DataLayer): DataRuntime {
  const { emitter, session } = layer;
  const sessionSub = (listener: () => void) => emitter.subscribe(listener, readsSession);
  const bodySub = (listener: () => void) => emitter.subscribe(listener, readsBody);
  const undoSub = (listener: () => void) => emitter.subscribe(listener, readsUndo);

  /** Acquire a window for the component's lifetime and keep its `holdIds` in sync. */
  function useWindow(spec: ViewSpec, holdIds: readonly Id[]) {
    const key = specKey(spec);
    // The spec is compared by value: an inline literal never re-watches.
    const stableSpec = useMemo(() => spec, [key]);
    const store = useMemo(() => windowStore(emitter, layer.windows, stableSpec), [stableSpec]);
    const holder = useRef(0);
    if (!holder.current) holder.current = ++holderSeq;
    useEffect(() => {
      const acquired = layer.windows.acquire(stableSpec);
      return () => {
        acquired.setHold(holder.current, EMPTY_IDS);
        layer.windows.release(acquired);
      };
    }, [stableSpec]);
    const holdKey = holdIds.join('\u0000');
    useEffect(() => {
      layer.windows.get(stableSpec).setHold(holder.current, holdIds);
    }, [stableSpec, holdKey]);
    return store;
  }

  function useView<S extends ViewSpec>(spec: S, opts?: UseViewOptions) {
    const w = useWindow(spec, opts?.holdIds ?? EMPTY_IDS);
    return useSyncExternalStore(w.subscribe, w.getSnapshot, w.getSnapshot) as never;
  }

  function useHome(opts?: UseHomeOptions): HomeView {
    const accountId = opts?.accountId;
    const homeSpec = accountId ? { kind: 'home' as const, accountId } : { kind: 'home' as const };
    const lowSpec = accountId
      ? { kind: 'lowSenders' as const, accountId }
      : { kind: 'lowSenders' as const };
    const w = useWindow(homeSpec, opts?.holdIds ?? EMPTY_IDS);
    const home = useSyncExternalStore(
      w.subscribe,
      w.getSnapshot,
      w.getSnapshot,
    ) as ViewResult<ThreadRow>;
    const lw = useWindow(lowSpec, EMPTY_IDS);
    const low = useSyncExternalStore(lw.subscribe, lw.getSnapshot, lw.getSnapshot);
    const holdStore = useMemo(
      () =>
        topicStore(
          emitter,
          topics => topics.has(w.current().topic),
          memoSnapshot(
            emitter,
            () => {
              const now = w.current();
              return {
                held: now.held,
                sections: [...now.sectionsAtHold],
                waiting: {
                  do: now.waiting('do'),
                  fromLater: now.waiting('fromLater'),
                  update: now.waiting('update'),
                  follow: now.waiting('follow'),
                },
              };
            },
            sameJson,
          ),
        ),
      [w],
    );
    const hold = useSyncExternalStore(
      holdStore.subscribe,
      holdStore.getSnapshot,
      holdStore.getSnapshot,
    );
    return useMemo(
      () =>
        toHomeView(home, low.total, {
          held: hold.held,
          sectionsAtHold: new Set(hold.sections),
          waiting: key => hold.waiting[key as keyof typeof hold.waiting] ?? 0,
        }),
      [home, low.total, hold],
    );
  }

  function useRowRead<T extends CachedRowType>(type: T, id: Id | undefined) {
    useEffect(() => {
      if (!id) return;
      layer.rows.retain(type, [id]);
      layer.fetcher.request(type, [id]);
      return () => layer.rows.release(type, [id]);
    }, [type, id]);
    return useMemo(() => rowStore(layer, type, id), [type, id]);
  }

  function useRowState<T extends CachedRowType>(type: T, id: Id | undefined) {
    const store = useRowRead(type, id);
    return useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    ) as RowState<never>;
  }

  function useRow<T extends CachedRowType>(type: T, id: Id | undefined) {
    return useRowState(type, id).row;
  }

  function useOperation(opId: OpId | undefined) {
    const store = useMemo(() => operationStore(layer, opId), [opId]);
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  }

  /** One operation without a component: the listener runs once with the current view, then on each change. */
  function subscribeOperation(
    opId: OpId,
    listener: (view: OperationView | undefined) => void,
  ): () => void {
    const store = operationStore(layer, opId);
    // A listener's own throw stays with it: never into emit(), where it would starve the listeners
    // behind it and escape into the frame that notified (nothing sensitive is logged).
    const notify = () => {
      try {
        listener(store.getSnapshot());
      } catch {
        /* the listener owns its errors */
      }
    };
    notify();
    return store.subscribe(notify);
  }

  function useHold(scope: string) {
    const gate = layer.hold(scope);
    const version = () => gate.version;
    useSyncExternalStore(gate.subscribe, version, version);
    return gate;
  }

  function usePrefetchIntent() {
    const intent = useMemo(() => layer.prefetch(), []);
    useEffect(() => () => intent.cancel(), [intent]);
    return intent;
  }

  function useMessageBody(messageId: MessageId | undefined) {
    useEffect(() => layer.bodies.retain(messageId), [messageId]);
    const read = useMemo(() => () => layer.bodies.get(messageId), [messageId]);
    return useSyncExternalStore(bodySub, read, read);
  }

  function useSingleton<T>(name: Parameters<typeof session.want>[0], read: () => T): T {
    useEffect(() => session.want(name), [name]);
    return useSyncExternalStore(sessionSub, read, read);
  }

  const readSession = () => session.session;
  const readConnection = () => session.connection;
  const readAccounts = () => session.accounts;
  const readAccountsLoaded = () => session.accountsLoaded;
  const readSetup = () => session.setup;
  const readSettings = () => session.settings;
  const readConsent = () => session.consent;

  function useStatus(accountId?: AccountId) {
    useEffect(() => session.want('accounts'), []);
    // The minute clock is a dependency, so the 24 h reconnect window is re-evaluated as time passes.
    const minute = useNow({ granularity: 'minute' });
    const read = useMemo(
      () =>
        memoSnapshot(
          emitter,
          () => pickStatus(session.accounts, accountId, layer.clock.now()),
          sameJson,
        ),
      [accountId, minute],
    );
    return useSyncExternalStore(sessionSub, read, read);
  }

  function useCounts(accountId?: AccountId) {
    useEffect(() => {
      session.want('counts');
      session.want('accounts');
    }, []);
    const read = useMemo(
      () =>
        memoSnapshot(
          emitter,
          () => countsFor(session.counts, session.accounts, accountId),
          sameJson,
        ),
      [accountId],
    );
    return useSyncExternalStore(sessionSub, read, read);
  }

  function useAgenda(spec: ViewSpecOf<'events'>): AgendaView {
    const view = useView(spec) as ViewResult<Event>;
    return useMemo(() => {
      const events = orderEvents(view.ids.flatMap(id => view.rows.get(id) ?? []));
      const status: AgendaView['status'] =
        view.status === 'failed' ? 'failed' : view.status === 'opening' ? 'loading' : 'ready';
      return { events, status, error: view.error };
    }, [view]);
  }

  function useFrames<K extends StreamKind>(
    kind: K,
    filter?: FrameFilter<K>,
    opts?: UseFramesOptions,
  ) {
    const filterKey = JSON.stringify(filter ?? {});
    const source = useMemo(
      () => layer.bus.open(kind, filter, opts?.max),
      [kind, filterKey, opts?.max],
    );
    return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  }

  function useNow(opts: UseNowOptions) {
    const granularity = opts.granularity;
    const sub = useMemo(
      () => (listener: () => void) => layer.clock.subscribe(granularity, listener),
      [granularity],
    );
    const read = () => layer.clock.snapshot(granularity);
    return useSyncExternalStore(sub, read, read);
  }

  function useUndoTop() {
    return useSyncExternalStore(undoSub, layer.undoStack.top, layer.undoStack.top);
  }

  return {
    useOperation,
    subscribeOperation,
    useView: useView as DataRuntime['useView'],
    useHome,
    useRow: useRow as DataRuntime['useRow'],
    useRowState: useRowState as DataRuntime['useRowState'],
    useHold,
    usePrefetchIntent,
    useMessageBody,
    useSession: () => useSingleton('session', readSession),
    useConnection: () => useSyncExternalStore(sessionSub, readConnection, readConnection),
    useAccounts: () => useSingleton('accounts', readAccounts),
    useAccountsLoaded: () => useSingleton('accounts', readAccountsLoaded),
    useStatus,
    useCounts,
    useAgenda,
    useSetupStatus: () => useSingleton('setup', readSetup),
    useSettings: () => useSingleton('settings', readSettings),
    useConsent: () => useSingleton('consent', readConsent),
    useFrames: useFrames as DataRuntime['useFrames'],
    useNow,
    getNow: () => layer.clock.now(),
    setClock: clock => layer.clock.setClock(clock),
    undoStack: layer.undoStack,
    useUndoTop,
    api: layer.api,
  };
}
