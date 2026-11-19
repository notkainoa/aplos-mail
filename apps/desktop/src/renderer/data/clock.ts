/**
 * The one renderer clock (DESIGN 5 rule 15). Source, first that applies: a clock injected with `setClock` (the
 * harness's frozen 2026-10-29T10:00, unit tests); the engine's clock (`Session.now`, then `clock` host events, which
 * only jump under a test clock); the wall clock. Ticks land on second or minute boundaries, pause while the window is
 * hidden and catch up at once when it shows.
 */
import type { EpochMs } from './contract-shapes';
import { HARNESS_NOW_MS, type Clock, type NowGranularity } from './index';
import { realTimers, type Timers } from './scheduler';

/** The harness's frozen clock. */
export const harnessClock: Clock = { now: () => HARNESS_NOW_MS };

const STEP: Record<NowGranularity, number> = { second: 1_000, minute: 60_000 };

/** Epoch ms truncated to the granularity. */
export function truncateNow(ms: EpochMs, granularity: NowGranularity): EpochMs {
  return ms - (((ms % STEP[granularity]) + STEP[granularity]) % STEP[granularity]);
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export class ClockStore {
  private injected: Clock | null = null;
  private engineOffset: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly timers: Timers = realTimers) {}

  now(): EpochMs {
    if (this.injected) return this.injected.now();
    const wall = this.timers.now();
    return this.engineOffset === null ? wall : wall + this.engineOffset;
  }

  setClock(clock: Clock | null): void {
    this.injected = clock;
    this.notify();
  }

  /** The engine said what time it is (`Session.now`, a `clock` host event). */
  engineNow(now: EpochMs): void {
    this.engineOffset = now - this.timers.now();
    this.notify();
  }

  snapshot(granularity: NowGranularity): EpochMs {
    return truncateNow(this.now(), granularity);
  }

  /** Calls `listener` at each boundary of `granularity` and whenever the source changes. */
  subscribe(granularity: NowGranularity, listener: () => void): () => void {
    this.listeners.add(listener);
    let cancel: (() => void) | null = null;
    const schedule = () => {
      cancel?.();
      cancel = null;
      if (documentHidden()) return;
      const now = this.now();
      const wait = truncateNow(now, granularity) + STEP[granularity] - now;
      cancel = this.timers.setTimeout(() => {
        listener();
        schedule();
      }, wait);
    };
    const onVisibility = () => {
      if (!documentHidden()) listener();
      schedule();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancel?.();
      this.listeners.delete(listener);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
