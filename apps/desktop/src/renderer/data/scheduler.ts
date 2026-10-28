/**
 * Time and frame scheduling for the data layer, injected so tests drive it by hand. Frames from the engine are
 * batched once per animation frame (DESIGN 5 rule 13); timers (holds, prefetch, slow bodies) go through `Timers`
 * so a test clock can step them.
 */

/** Runs a callback on the next animation frame; returns a cancel function. */
export interface FrameScheduler {
  request(callback: () => void): () => void;
}

/**
 * A timer source and its notion of now. The data layer's are epoch ms; the motion `Scheduler` is one too, on visible
 * time (paused while hidden), so the hold gate runs on either.
 */
export interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
  /** Called when the window hides (holds release then); absent where there is no window. Returns an unsubscribe. */
  onHide?(listener: () => void): () => void;
}

/** `requestAnimationFrame` where it exists, else the next macrotask (node, a hidden window's fallback). */
export const animationFrameScheduler: FrameScheduler = {
  request(callback) {
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(() => callback());
      return () => cancelAnimationFrame(handle);
    }
    const handle = setTimeout(callback, 0);
    return () => clearTimeout(handle);
  },
};

/** Wall-clock timers; hides come from `document.visibilityState` where there is a document. */
export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  onHide(listener) {
    if (typeof document === 'undefined') return () => {};
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') listener();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  },
};

/** A scheduler that only runs when `flush()` is called: tests decide when a frame happens. */
export interface ManualScheduler extends FrameScheduler {
  flush(): void;
  readonly pending: number;
}

export function createManualScheduler(): ManualScheduler {
  let queue: Array<{ callback: () => void; live: boolean }> = [];
  return {
    request(callback) {
      const item = { callback, live: true };
      queue.push(item);
      return () => {
        item.live = false;
      };
    },
    flush() {
      const run = queue;
      queue = [];
      for (const item of run) if (item.live) item.callback();
    },
    get pending() {
      return queue.filter(item => item.live).length;
    },
  };
}

/** Timers on a fake clock that `advance(ms)` steps, firing due callbacks in time order. */
export interface ManualTimers extends Timers {
  advance(ms: number): void;
  set(now: number): void;
  onHide(listener: () => void): () => void;
  /** Show or hide the fake window; hiding tells `onHide` listeners. */
  setHidden(hidden: boolean): void;
  readonly hidden: boolean;
  /** Timers still waiting. */
  readonly pending: number;
}

export function createManualTimers(start = 0): ManualTimers {
  let now = start;
  let seq = 0;
  let hidden = false;
  const hideListeners = new Set<() => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const runUntil = (target: number) => {
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > target) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].callback();
    }
    now = target;
  };
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      runUntil(now + ms);
    },
    set(target) {
      runUntil(target);
    },
    onHide(listener) {
      hideListeners.add(listener);
      return () => {
        hideListeners.delete(listener);
      };
    },
    setHidden(next) {
      if (next === hidden) return;
      hidden = next;
      if (hidden) for (const listener of [...hideListeners]) listener();
    },
    get hidden() {
      return hidden;
    },
    get pending() {
      return timers.size;
    },
  };
}
