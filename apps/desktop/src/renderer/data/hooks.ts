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
import { memoSnapshot, sameJson } from './emitter';
import { toHomeView } from './home';
import type {
  AgendaView,
  DataRuntime,
  FrameFilter,
  HomeView,
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
import type { EngineWindow } from './windows';

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

export function createHooks(layer: DataLayer): DataRuntime {
  const { emitter, session } = layer;
  const subscribe = emitter.subscribe;

  /** Acquire a window for the component's lifetime and keep its `holdIds` in sync. */
  function useWindow(spec: ViewSpec, holdIds: readonly Id[]): EngineWindow {
    const key = specKey(spec);
    // The spec is compared by value: an inline literal never re-watches.
    const stableSpec = useMemo(() => spec, [key]);
    const w = layer.windows.get(stableSpec);
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
    return w;
  }

  function useView<S extends ViewSpec>(spec: S, opts?: UseViewOptions) {
    const w = useWindow(spec, opts?.holdIds ?? EMPTY_IDS);
    return useSyncExternalStore(subscribe, w.snapshot, w.snapshot) as never;
  }

  function useHome(opts?: UseHomeOptions): HomeView {
    const accountId = opts?.accountId;
    const homeSpec = accountId ? { kind: 'home' as const, accountId } : { kind: 'home' as const };
    const lowSpec = accountId
      ? { kind: 'lowSenders' as const, accountId }
      : { kind: 'lowSenders' as const };
    const w = useWindow(homeSpec, opts?.holdIds ?? EMPTY_IDS);
    const home = useSyncExternalStore(subscribe, w.snapshot, w.snapshot) as ViewResult<ThreadRow>;
    const lw = useWindow(lowSpec, EMPTY_IDS);
    const low = useSyncExternalStore(subscribe, lw.snapshot, lw.snapshot);
    const readHold = useMemo(
      () =>
        memoSnapshot(
          emitter,
          () => ({
            held: w.held,
            sections: [...w.sectionsAtHold],
            waiting: {
              do: w.waiting('do'),
              fromLater: w.waiting('fromLater'),
              update: w.waiting('update'),
              follow: w.waiting('follow'),
            },
          }),
          sameJson,
        ),
      [w],
    );
    const hold = useSyncExternalStore(subscribe, readHold, readHold);
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
    return useMemo(
      () =>
        memoSnapshot(
          emitter,
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
      [type, id],
    );
  }

  function useRowState<T extends CachedRowType>(type: T, id: Id | undefined) {
    const read = useRowRead(type, id);
    return useSyncExternalStore(subscribe, read, read) as RowState<never>;
  }

  function useRow<T extends CachedRowType>(type: T, id: Id | undefined) {
    return useRowState(type, id).row;
  }

  function useOperation(opId: OpId | undefined) {
    const read = useMemo(() => () => layer.operations.view(opId), [opId]);
    return useSyncExternalStore(subscribe, read, read);
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
    return useSyncExternalStore(subscribe, read, read);
  }

  function useSingleton<T>(name: Parameters<typeof session.want>[0], read: () => T): T {
    useEffect(() => session.want(name), [name]);
    return useSyncExternalStore(subscribe, read, read);
  }

  const readSession = () => session.session;
  const readConnection = () => session.connection;
  const readAccounts = () => session.accounts;
  const readSetup = () => session.setup;
  const readSettings = () => session.settings;
  const readConsent = () => session.consent;

  function useStatus(accountId?: AccountId) {
    useEffect(() => session.want('accounts'), []);
    const read = useMemo(
      () =>
        memoSnapshot(
          emitter,
          () => pickStatus(session.accounts, accountId, layer.clock.now()),
          sameJson,
        ),
      [accountId],
    );
    return useSyncExternalStore(subscribe, read, read);
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
    return useSyncExternalStore(subscribe, read, read);
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
    return useSyncExternalStore(subscribe, layer.undoStack.top, layer.undoStack.top);
  }

  return {
    useOperation,
    useView: useView as DataRuntime['useView'],
    useHome,
    useRow: useRow as DataRuntime['useRow'],
    useRowState: useRowState as DataRuntime['useRowState'],
    useHold,
    usePrefetchIntent,
    useMessageBody,
    useSession: () => useSingleton('session', readSession),
    useConnection: () => useSyncExternalStore(subscribe, readConnection, readConnection),
    useAccounts: () => useSingleton('accounts', readAccounts),
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
