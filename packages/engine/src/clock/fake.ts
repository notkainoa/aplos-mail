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
  /** Bumped by every clock call; a `flush` turn with no bump means every pending chain is asleep. */
  let activity = 0;
  /** `flush` calls still suspended, oldest first; the youngest waits for the rest to drain. */
  const pending = new Set<number>();
  let seq = 0;
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
  /**
   * Lets pending promise chains settle: turns until a full turn passes with no clock call, and, for
   * overlapping flushes, until the older ones have drained, so a fire that awaits real work before
   * re-arming is not missed by the next scan.
   */
  const flush = async () => {
    const me = ++seq;
    activity++;
    pending.add(me);
    try {
      for (;;) {
        const seen = activity;
        await turn();
        if (activity === seen && pending.values().next().value === me) return;
      }
    } finally {
      pending.delete(me);
    }
  };
  /** Fires every timer due at or before `until`; returns the first error a `fire` threw. */
  const runDue = async (until: number, stepTime: boolean) => {
    let failure: unknown;
    for (;;) {
      let t = earliestDue(until);
      if (!t) {
        // Nothing due yet: chains still settling may arm a late timer, so give them a turn first.
        await flush();
        t = earliestDue(until);
        if (!t) return failure;
      }
      timers.delete(t);
      if (stepTime) now = Math.max(now, t.at);
      try {
        t.fire();
      } catch (error) {
        // One throwing timer must not skip the rest: fire them all, then report the first error.
        failure ??= error;
      }
      await flush();
    }
  };

  const timer = (at: number, fire: () => void): Timer => {
    activity++;
    // A NaN target is already due on the real clock: it fires rather than comparing forever.
    const entry: Entry = { at: Number.isNaN(at) ? now : at, order: order++, fire };
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
      // Advance only ever moves forward; a backward jump is `set`'s job.
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance() needs a finite ms >= 0');
      // Work already queued arms its timers at the current time before time moves.
      await flush();
      const target = now + ms;
      const failure = await runDue(target, true);
      now = target;
      await flush();
      if (failure !== undefined) throw failure;
    },
    async set(at) {
      if (!Number.isFinite(at)) throw new RangeError('set() needs a finite epoch ms');
      await flush();
      now = at;
      const failure = await runDue(at, false);
      await flush();
      if (failure !== undefined) throw failure;
    },
    flush,
    pending: () => timers.size,
  };
}
