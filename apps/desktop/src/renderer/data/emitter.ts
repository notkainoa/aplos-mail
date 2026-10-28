/** The one change signal every store in the data layer shares; hooks read it through `useSyncExternalStore`. */
export interface Emitter {
  subscribe(listener: () => void): () => void;
  /** Notify now, or at the end of the current `batch`. */
  emit(): void;
  /** Run `fn`, then notify once if anything inside emitted. */
  batch<T>(fn: () => T): T;
  /** Bumped on every change, so snapshot caches know when to recompute. */
  readonly version: number;
}

export function createEmitter(): Emitter {
  const listeners = new Set<() => void>();
  let version = 0;
  let depth = 0;
  let dirty = false;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      version++;
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
