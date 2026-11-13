import type { Frame } from '@aplos/contract';
import type { Clock, StorePort, Timer } from '../ports';
import type { Caller } from '../methods/types';
/**
 * The change types `Counts/get` can move on; a durable change of one marks `Counts` in the `state` frame — a
 * derived mark, never a changes row, so the durable log and `Session/changes` keep only what was written
 * (fix-counts). Space-delimited so `includes` cannot match a substring of another type.
 */
const COUNTS_TYPES = ' Thread Message Folder Draft Submission Account Settings ';

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
  /** `accepts` decides which broadcast frames this connection may see (`frameFilter`); a targeted `emit` bypasses it. */
  attach(
    connectionId: string,
    deliver: (frame: StampedFrame) => void,
    accepts: (frame: StampedFrame) => boolean,
  ): void;
  detach(connectionId: string): void;
  close(): void;
}

/** Frames only the bus (`state`, `reset`) or main (`desktop`) sends. */
const OWN_KINDS: ReadonlySet<string> = new Set(['state', 'reset', 'desktop']);

type Scope = Caller['scopes'][number];

/** Ask, polish and transcription need `ai`; remote search needs `read`; setup progress is an `admin` matter. */
const PROGRESS_SCOPE: ReadonlyMap<string, Scope> = new Map<string, Scope>(
  Object.entries({
    ask: 'ai',
    ai: 'ai',
    transcribe: 'ai',
    search: 'read',
    setup: 'admin',
  }),
);

const OPERATION_SCOPES: ReadonlySet<unknown> = new Set([
  'read',
  'triage',
  'draft',
  'send',
  'ai',
  'admin',
]);

/** An operation's recorded scope, or `undefined` for anything that is not one of the six known scope strings. */
function knownScope(scope: unknown): Scope | undefined {
  return OPERATION_SCOPES.has(scope) ? (scope as Scope) : undefined;
}

/**
 * The scope a broadcast frame needs, `null` when it carries no content (`state` counts, `reset`), or `undefined` for a
 * frame kind or source this table does not know, which no caller receives except main's control connection.
 */
function frameScope(frame: StampedFrame): Scope | null | undefined {
  switch (frame.frame) {
    case 'state':
    case 'reset':
      return null;
    case 'window':
      return 'read';
    case 'Draft/changed':
      return 'draft';
    case 'connect':
      return 'admin';
    case 'progress':
      return PROGRESS_SCOPE.get(frame.source);
    case 'operation':
      return knownScope(frame.operation?.scope);
    default:
      return undefined;
  }
}

/** Host events a window needs to draw itself (parked banner, theme, clock); every other one is main's alone. */
const CALLER_KINDS: ReadonlySet<string> = new Set(['window', 'listener', 'host']);
const WINDOW_HOST_EVENTS: ReadonlySet<string> = new Set(['parked', 'appearance', 'clock']);

function hostEventVisible(caller: Caller, type: string | undefined): boolean {
  if (type === undefined) return false;
  if (caller.kind === 'window') return WINDOW_HOST_EVENTS.has(type);
  return caller.kind === 'host' && caller.scopes.includes('host');
}

/**
 * What a connection's broadcasts may contain, by its caller. Fail closed for every kind of caller, main included: a
 * frame kind, progress source or operation without a scope that this file does not know is withheld from everyone.
 * `host` events go to main's control connection, except parked, appearance and clock, which windows also get
 * (notify, badge, reminder, openExternal stay main's). Every other frame needs its scope: a window holds every
 * grantable scope, a listener only its grant, main's control connection every known one. A targeted `emit` reply is
 * not filtered at all.
 */
export function frameFilter(caller: Caller): (frame: StampedFrame) => boolean {
  return frame => {
    if (!CALLER_KINDS.has(caller.kind)) return false;
    if (frame.frame === 'host') return hostEventVisible(caller, frame.event?.type);
    const scope = frameScope(frame);
    if (scope === null) return true;
    if (scope === undefined) return false;
    return caller.kind === 'host' || caller.scopes.includes(scope);
  };
}

export function createFrameHub(deps: { store: StorePort; clock: Clock }): FrameHub {
  const targets = new Map<
    string,
    { deliver: (frame: StampedFrame) => void; accepts: (frame: StampedFrame) => boolean }
  >();
  const pending = new Map<string, number>();
  let timer: Timer | undefined;
  let closed = false;

  const send = (frame: StampedFrame, to?: string) => {
    for (const [id, target] of [...targets]) {
      if (to !== undefined && id !== to) continue;
      if (to === undefined && !target.accepts(frame)) continue;
      try {
        target.deliver(frame);
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
    emit(frame, to) {
      // The types forbid these, but a lane's untyped frame must not skip coalescing or pose as main.
      if (OWN_KINDS.has((frame as { frame?: unknown }).frame as string))
        throw new Error(`The frame bus sends ${String(frame.frame)} frames itself`);
      if (!closed) send(stamp(frame), to);
    },
    changed(types) {
      if (closed) return;
      for (const [type, seq] of Object.entries(types))
        pending.set(type, Math.max(seq, pending.get(type) ?? 0));
      if (pending.size && !timer)
        timer = deps.clock.timer(deps.clock.now() + STATE_COALESCE_MS, flush);
    },
    reset(reason) {
      cancel();
      if (!closed) send(stamp({ frame: 'reset', reason }));
    },
    attach: (id, deliver, accepts) => void targets.set(id, { deliver, accepts }),
    detach: id => void targets.delete(id),
    close() {
      closed = true;
      cancel();
      targets.clear();
    },
  };
}

/**
 * The store every service sees: the same port, except that a commit which landed tells the bus which types it touched.
 * A replayed or empty commit leaves `seq` where it was and sends nothing.
 */
export function observeCommits(
  store: StorePort,
  bus: Pick<FrameBus, 'changed' | 'reset'>,
): StorePort {
  const observed = Object.create(store) as StorePort;
  Object.defineProperty(observed, 'commit', {
    value: (input: Parameters<StorePort['commit']>[0]) => {
      const before = store.seq();
      const result = store.commit(input);
      if (store.seq() > before) {
        const types = touchedSince(store, before);
        // The change log could not say what this commit touched: windows cannot trust their view, so they re-open.
        if (types) bus.changed(types);
        else bus.reset('cannotCalculateChanges');
      }
      return result;
    },
  });
  return observed;
}

function touchedSince(store: StorePort, from: number): Record<string, number> | undefined {
  const types: Record<string, number> = {};
  let since = from;
  for (;;) {
    const page = store.changesSince(since);
    if (page.status !== 'ok') return undefined;
    for (const change of page.changes) {
      types[change.type] = Math.max(change.seq, types[change.type] ?? 0);
      if (COUNTS_TYPES.includes(` ${change.type} `))
        types.Counts = Math.max(change.seq, types.Counts ?? 0);
    }
    if (!page.hasMore || page.toSeq <= since) return types;
    since = page.toSeq;
  }
}
