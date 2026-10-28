export interface GateOptions {
  now?: () => number;
  /** Minimum time between automatic runs for one key. */
  minIntervalMs?: number;
  /** First retry delay after a failure; doubles per consecutive failure. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Per-account pacing for provider syncs: one run at a time per key, automatic runs spaced out,
 * and exponential backoff after failures so a broken account cannot hammer its host.
 */
export function createGate(options: GateOptions = {}) {
  const now = options.now ?? Date.now,
    min = options.minIntervalMs ?? 15_000,
    base = options.backoffMs ?? 30_000,
    cap = options.maxBackoffMs ?? 900_000;
  const entries = new Map<
    string,
    { running?: Promise<unknown>; lastStart: number; failures: number; retryAt: number }
  >();
  const entry = (key: string) => {
    let e = entries.get(key);
    if (!e) {
      e = { lastStart: -Infinity, failures: 0, retryAt: -Infinity };
      entries.set(key, e);
    }
    return e;
  };
  return {
    /** Whether an automatic run may start now. Manual runs only wait for a running one. */
    ready(key: string, manual = false): boolean {
      const e = entry(key);
      if (e.running) return false;
      if (manual) return true;
      const t = now();
      return t - e.lastStart >= min && t >= e.retryAt;
    },
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const e = entry(key);
      if (e.running) return e.running as Promise<T>;
      e.lastStart = now();
      const job = (async () => {
        try {
          const value = await fn();
          e.failures = 0;
          e.retryAt = -Infinity;
          return value;
        } catch (error) {
          e.failures++;
          e.retryAt = now() + Math.min(cap, base * 2 ** (e.failures - 1));
          throw error;
        } finally {
          e.running = undefined;
        }
      })();
      e.running = job;
      return job;
    },
    failures: (key: string) => entry(key).failures,
    forget: (key: string) => {
      entries.delete(key);
    },
  };
}
export type Gate = ReturnType<typeof createGate>;
