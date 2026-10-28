// Keys are never dropped (DESIGN §5 rule 4). While a mount or transition runs,
// the shell's window-level capture listener offers each key here instead of
// dispatching it, then drains the queue in order on the next frame.
// Pure data structure: no listeners, no timers.

export interface KeyQueue<T> {
  /** A mount or transition starts. Nested calls stack. */
  begin(): void;
  /** One begin() is over. */
  end(): void;
  /** True while any begin() is open. */
  readonly busy: boolean;
  /**
   * Returns true when the key was queued (do not dispatch it now). Keys queue
   * while busy, and also while earlier keys still wait, so nothing overtakes.
   * Past `max` it returns false: dispatching now beats dropping.
   */
  offer(item: T): boolean;
  /** The waiting keys in arrival order, once nothing is busy; otherwise []. */
  drain(): T[];
  readonly size: number;
}

export function createKeyQueue<T>(max = 256): KeyQueue<T> {
  let depth = 0;
  let items: T[] = [];

  return {
    begin() {
      depth += 1;
    },
    end() {
      depth = Math.max(0, depth - 1);
    },
    get busy() {
      return depth > 0;
    },
    offer(item) {
      if (depth === 0 && items.length === 0) return false;
      if (items.length >= max) return false;
      items.push(item);
      return true;
    },
    drain() {
      if (depth > 0) return [];
      const out = items;
      items = [];
      return out;
    },
    get size() {
      return items.length;
    },
  };
}
