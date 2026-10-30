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

/**
 * Forwards the Mac waking (`resume`) and the screen unlocking (`unlock-screen`) to `engine.wake()`, so the timer loop
 * re-reads its deadlines instead of waiting for a monotonic timer that slept with the machine (ARCH 7.5). A throwing or
 * rejecting `wake` is swallowed: a power event must never take the main process down. Returns the unsubscribe function.
 *
 * Not wired into `src/main` yet: main still runs the legacy engine. The new engine's host calls this once it exists.
 */
export function watchPowerResume(power: PowerSource, engine: Wakeable): () => void {
  const onWake = () => {
    try {
      const result = engine.wake();
      // A real `wake` may be async: its rejection must not escape as an unhandled rejection.
      if (isThenable(result)) result.then(undefined, () => {});
    } catch {
      // Nothing to log that is safe and useful: the next wake or timer turn re-reads the deadlines anyway.
    }
  };
  for (const event of WAKE_EVENTS) power.on(event, onWake);
  return () => {
    for (const event of WAKE_EVENTS) power.off(event, onWake);
  };
}
