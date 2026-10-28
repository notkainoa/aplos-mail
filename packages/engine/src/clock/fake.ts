import type { Clock, Timer } from '../ports/time';

/** The engine's test clock: time moves only through `advance` and `set`. Also used by the conformance runner. */
export interface FakeClock extends Clock {
  /** Moves time forward by `ms`, firing every timer due on the way in time order, each at its own `at`. */
  advance(ms: number): Promise<void>;
  /**
   * Jumps the wall clock to `at`, forward or back (sleep, NTP, a manual change). Timers due at `at` fire after the jump,
   * all at the new time, like a Mac waking; a backward jump fires nothing.
   */
  set(at: number): Promise<void>;
  /** Lets pending promise chains (a fire's commits and awaits) settle without moving time. */
  flush(): Promise<void>;
  /** Timers armed and not yet fired or cancelled. */
  pending(): number;
}

interface Entry {
  at: number;
  order: number;
  fire: () => void;
}

/** One macrotask turn drains every microtask queued before it, so awaited synchronous work settles. */
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function fakeClock(start = Date.UTC(2026, 9, 28, 9)): FakeClock {
  let now = start;
  let order = 0;
  const timers = new Set<Entry>();

  const earliestDue = (until: number) => {
    let first: Entry | undefined;
    for (const t of timers)
      if (
        t.at <= until &&
        (!first || t.at < first.at || (t.at === first.at && t.order < first.order))
      )
        first = t;
    return first;
  };
  const flush = async () => {
    for (let i = 0; i < 3; i++) await turn();
  };
  const runDue = async (until: number, stepTime: boolean) => {
    for (let t = earliestDue(until); t; t = earliestDue(until)) {
      timers.delete(t);
      if (stepTime) now = Math.max(now, t.at);
      t.fire();
      await flush();
    }
  };

  const timer = (at: number, fire: () => void): Timer => {
    const entry: Entry = { at, order: order++, fire };
    timers.add(entry);
    return { cancel: () => void timers.delete(entry) };
  };

  return {
    now: () => now,
    timer,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const t = timer(now + ms, () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
        function onAbort() {
          t.cancel();
          reject(signal!.reason);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    async advance(ms) {
      // Work already queued arms its timers at the current time before time moves.
      await flush();
      const target = now + ms;
      await runDue(target, true);
      now = target;
      await flush();
    },
    async set(at) {
      await flush();
      now = at;
      await runDue(at, false);
      await flush();
    },
    flush,
    pending: () => timers.size,
  };
}
