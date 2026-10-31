/** The part of Electron's `powerMonitor` this module needs; no electron import, so tests drive it with an EventEmitter. */
export interface PowerSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** What the host needs from the engine: `Engine.wake()` re-reads every deadline source. */
export interface Wakeable {
  wake(): void | Promise<unknown>;
}

/** Power events after which the wall clock or the network may have moved: the Mac woke or was unlocked. */
const WAKE_EVENTS = ['resume', 'unlock-screen'] as const;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/** The clock and timer the wall-clock-jump fallback needs; tests drive them with a fake clock. */
export interface WakeClock {
  now(): number;
  /** A repeating timer (`setInterval`). */
  every(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export const TICK_MS = 1000;
/** A gap this long between two 1 s ticks means the Mac slept (ARCH 7.5). */
export const JUMP_MS = 30_000;
/** Wakes closer together than this are one wake, so `resume`, `unlock-screen` and the fallback never stack up. */
export const DEDUPE_MS = 5000;

/**
 * Forwards the Mac waking (`resume`) and the screen unlocking (`unlock-screen`) to `engine.wake()`, so the timer loop
 * re-reads its deadlines instead of waiting for a monotonic timer that slept with the machine (ARCH 7.5). A throwing or
 * rejecting `wake` is swallowed: a power event must never take the main process down. Returns the unsubscribe function.
 *
 * With a `clock`, two things are added (host-2): a 1 s tick that wakes the engine when wall time moved more than 30 s
 * between two ticks (a wake Electron never reported), and a dedupe so wakes within 5 s of each other call `wake()`
 * once, whichever of `resume`, `unlock-screen` and the fallback came first.
 *
 * Not wired to the new engine yet: main still runs the legacy engine, whose `wake()` is `sync {auto: true}`.
 */
export function watchPowerResume(
  power: PowerSource,
  engine: Wakeable,
  clock?: WakeClock,
): () => void {
  let lastWake = Number.NEGATIVE_INFINITY;
  let lastTick = clock?.now() ?? 0;
  const callWake = () => {
    try {
      const result = engine.wake();
      // A real `wake` may be async: its rejection must not escape as an unhandled rejection.
      if (isThenable(result)) result.then(undefined, () => {});
    } catch {
      // Nothing to log that is safe and useful: the next wake or timer turn re-reads the deadlines anyway.
    }
  };
  const wake = () => {
    if (clock) {
      const now = clock.now();
      // A clock that moved backwards (now < lastWake) is not "just woke": it must not suppress wakes.
      if (now >= lastWake && now - lastWake < DEDUPE_MS) return;
      lastWake = now;
    }
    callWake();
  };
  const tick = () => {
    if (!clock) return;
    const now = clock.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > JUMP_MS) wake();
  };
  const timer = clock?.every(tick, TICK_MS);
  for (const event of WAKE_EVENTS) power.on(event, wake);
  return () => {
    for (const event of WAKE_EVENTS) power.off(event, wake);
    if (clock && timer !== undefined) clock.cancel(timer);
  };
}
