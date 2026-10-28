/**
 * The change signal every store in the data layer shares; hooks read it through `useSyncExternalStore`. An emit may
 * name topics (a row, a window, an operation, the overlay); a listener with a filter wakes only for topics it reads.
 * An emit with no topics wakes every listener.
 */
export type Topic = string;

/** The topics of one notification; `null` means everything changed. */
export type Topics = ReadonlySet<Topic> | null;

export interface Emitter {
  /** `reads` (when given) says whether this listener's snapshot can depend on any of the topics. */
  subscribe(listener: () => void, reads?: (topics: ReadonlySet<Topic>) => boolean): () => void;
  /** Notify now, or at the end of the current `batch`. No topics: every listener. */
  emit(...topics: Topic[]): void;
  /** Run `fn`, then notify once if anything inside emitted. */
  batch<T>(fn: () => T): T;
  /** Bumped on every change, so snapshot caches know when to recompute. */
  readonly version: number;
}

export const OVERLAY_TOPIC = 'overlay';
export const FAILURES_TOPIC = 'failures';
export const UNDO_TOPIC = 'undo';
export const SESSION_TOPIC = 'session';
export const BODY_TOPIC = 'body';

export const rowTopic = (type: string, id: string): Topic => `row:${type}:${id}`;
export const windowTopic = (key: string): Topic => `window:${key}`;
export const opTopic = (opId: string): Topic => `op:${opId}`;

/** True when the topics name a row of `type` whose id `has` accepts. */
export function readsRows(
  topics: ReadonlySet<Topic>,
  type: string,
  has: (id: string) => boolean,
): boolean {
  const prefix = `row:${type}:`;
  for (const topic of topics)
    if (topic.startsWith(prefix) && has(topic.slice(prefix.length))) return true;
  return false;
}

export function createEmitter(): Emitter {
  const listeners = new Map<() => void, ((topics: ReadonlySet<Topic>) => boolean) | undefined>();
  let version = 0;
  let depth = 0;
  let dirty = false;
  let pending: Set<Topic> | null = new Set();
  const notify = () => {
    const topics = pending;
    pending = new Set();
    for (const [listener, reads] of [...listeners])
      if (!topics || !reads || reads(topics)) listener();
  };
  const note = (topics: Topic[]) => {
    if (!topics.length) pending = null;
    else if (pending) for (const topic of topics) pending.add(topic);
  };
  return {
    subscribe(listener, reads) {
      const own = () => listener();
      listeners.set(own, reads);
      return () => {
        listeners.delete(own);
      };
    },
    emit(...topics) {
      version++;
      note(topics);
      if (depth > 0) dirty = true;
      else notify();
    },
    batch(fn) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0 && dirty) {
          dirty = false;
          notify();
        }
      }
    },
    get version() {
      return version;
    },
  };
}

/** Recomputes `compute()` only when the emitter's version moved, and keeps the previous value when `same` says so (identity for React). */
export function memoSnapshot<T>(
  emitter: Emitter,
  compute: () => T,
  same: (a: T, b: T) => boolean = Object.is,
): () => T {
  let seen = -1;
  let value: T;
  return () => {
    if (seen !== emitter.version) {
      seen = emitter.version;
      const next = compute();
      if (!(value !== undefined && same(value, next))) value = next;
    }
    return value;
  };
}

/** Shallow equality for arrays of primitives or objects compared by identity. */
export function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Shallow equality for maps whose values are compared by identity. */
export function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (!b.has(key) || !Object.is(b.get(key), value)) return false;
  return true;
}

/** Structural equality for small plain values (frames, sections, settings). */
export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
