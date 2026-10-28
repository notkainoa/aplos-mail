import type { Frame } from '@aplos/contract';
import type { Clock, StorePort, Timer } from '../ports';

/** `state` frames coalesce over this long (ARCH 9.2: 50 to 250 ms). */
export const STATE_COALESCE_MS = 100;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A frame as a lane hands it to the bus: unstamped, and never a `desktop` frame, which only main sends. `state` and
 * `reset` have their own calls, so the bus alone decides when they go out.
 */
export type EngineFrame = Exclude<
  DistributiveOmit<Frame, 'dbEpoch' | 'seq'>,
  { frame: 'desktop' | 'state' | 'reset' }
>;
export type StampedFrame = Exclude<Frame, { frame: 'desktop' }>;
export type ResetReason = Extract<Frame, { frame: 'reset' }>['reason'];

/**
 * Frames out to every open connection (ARCH 9.2). Every frame is stamped with the store's `{dbEpoch, seq}` as it leaves,
 * so one connection's frames never go backwards. The bus logs nothing: `progress` frames carry Ask text and are never
 * written anywhere.
 */
export interface FrameBus {
  /** Stamps one frame and sends it to every open connection, or only to `to` (a `MethodContext.connectionId`). */
  emit(frame: EngineFrame, to?: string): void;
  /** Types a commit touched, with the seq that touched each; they leave as one coalesced `state` frame. */
  changed(types: Readonly<Record<string, number>>): void;
  /** Voids every window. Drops a pending `state` frame, since clients re-read everything after a reset. */
  reset(reason: ResetReason): void;
}

/** The runtime's side of the bus: connections attach and detach, and the engine closes it. */
export interface FrameHub extends FrameBus {
  attach(connectionId: string, deliver: (frame: StampedFrame) => void): void;
  detach(connectionId: string): void;
  close(): void;
}

export function createFrameHub(deps: { store: StorePort; clock: Clock }): FrameHub {
  const targets = new Map<string, (frame: StampedFrame) => void>();
  const pending = new Map<string, number>();
  let timer: Timer | undefined;

  const send = (frame: StampedFrame, to?: string) => {
    for (const [id, deliver] of [...targets]) {
      if (to !== undefined && id !== to) continue;
      try {
        deliver(frame);
      } catch {
        // A connection's listener bug is not the engine's, and must not stop the others.
      }
    }
  };
  const stamp = <F extends object>(frame: F) =>
    ({ ...frame, dbEpoch: deps.store.dbEpoch, seq: deps.store.seq() }) as unknown as StampedFrame;
  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const types = Object.fromEntries(pending);
    pending.clear();
    send(stamp({ frame: 'state', types }));
  };
  const cancel = () => {
    timer?.cancel();
    timer = undefined;
    pending.clear();
  };

  return {
    emit: (frame, to) => send(stamp(frame), to),
    changed(types) {
      for (const [type, seq] of Object.entries(types))
        pending.set(type, Math.max(seq, pending.get(type) ?? 0));
      if (pending.size && !timer)
        timer = deps.clock.timer(deps.clock.now() + STATE_COALESCE_MS, flush);
    },
    reset(reason) {
      cancel();
      send(stamp({ frame: 'reset', reason }));
    },
    attach: (id, deliver) => void targets.set(id, deliver),
    detach: id => void targets.delete(id),
    close() {
      cancel();
      targets.clear();
    },
  };
}

/**
 * The store every service sees: the same port, except that a commit which landed tells the bus which types it touched.
 * A replayed or empty commit leaves `seq` where it was and sends nothing.
 */
export function observeCommits(store: StorePort, bus: Pick<FrameBus, 'changed'>): StorePort {
  const observed = Object.create(store) as StorePort;
  Object.defineProperty(observed, 'commit', {
    value: (input: Parameters<StorePort['commit']>[0]) => {
      const before = store.seq();
      const result = store.commit(input);
      if (store.seq() > before) bus.changed(touchedSince(store, before));
      return result;
    },
  });
  return observed;
}

function touchedSince(store: StorePort, from: number): Record<string, number> {
  const types: Record<string, number> = {};
  let since = from;
  for (;;) {
    const page = store.changesSince(since);
    if (page.status !== 'ok') return types;
    for (const change of page.changes)
      types[change.type] = Math.max(change.seq, types[change.type] ?? 0);
    if (!page.hasMore || page.toSeq <= since) return types;
    since = page.toSeq;
  }
}
