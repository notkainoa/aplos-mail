/**
 * Time for emulators and the code under test. Everything that waits in a test waits on one of these,
 * so a 60 s cooldown or a 1 h pause runs in milliseconds.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms` of this clock's time; rejects with the signal's reason if aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(
        () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
        Math.max(0, ms),
      );
      const abort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
    }),
};

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/** 2026-10-27 09:00 Pacific, a fixed start so runs are reproducible. */
export const FAKE_EPOCH = Date.UTC(2026, 9, 27, 16, 0, 0);

/**
 * A deterministic clock. Time moves only through `advance`, `runUntilIdle`, or automatically when
 * `auto` is on and every piece of work in flight is waiting on this clock.
 *
 * Before firing the next timer, both auto mode and `advanceTo` wait for the process to go quiet:
 * two settles in a row with no new timer, and no file or DNS request still pending. So a worker
 * that writes a file (a token store, a page commit) between two sleeps registers its next sleep
 * before time moves, instead of being stamped one timer late. Code under test must never use the
 * real `setTimeout` for waits it expects to be fast-forwarded.
 */
export class FakeClock implements Clock {
  private time: number;
  private seq = 0;
  private timers: Timer[] = [];
  private autoScheduled = false;
  private autoOn: boolean;
  /** Every jump the clock made, for tests that assert how long something waited. */
  readonly jumps: { from: number; to: number }[] = [];

  constructor(options: { start?: number; auto?: boolean } = {}) {
    this.time = options.start ?? FAKE_EPOCH;
    this.autoOn = options.auto ?? true;
  }

  now(): number {
    return this.time;
  }

  /** Pending timers, for idle checks and debugging. */
  get pending(): number {
    return this.timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const timer: Timer = {
        at: this.time + Math.max(0, ms),
        seq: this.seq++,
        resolve: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
      };
      const abort = () => {
        this.timers = this.timers.filter(t => t !== timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.timers.push(timer);
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      this.scheduleAuto();
    });
  }

  /** Turn automatic advancing on or off. */
  auto(on: boolean): void {
    this.autoOn = on;
    if (on) this.scheduleAuto();
  }

  /** Move time forward by `ms`, firing every timer due on the way in order and letting each wake-up run. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.time + ms);
  }

  async advanceTo(target: number): Promise<void> {
    while (this.timers.length && this.timers[0].at <= target) {
      const next = this.timers.shift()!;
      this.jump(next.at);
      next.resolve();
      await this.quiet();
    }
    this.jump(Math.max(this.time, target));
    await this.quiet();
  }

  /** Fire timers until none are left or `limitMs` of clock time has passed. Returns the time spent. */
  async runUntilIdle(limitMs = 7 * 24 * 3600_000): Promise<number> {
    const start = this.time;
    await settle();
    while (this.timers.length && this.timers[0].at - start <= limitMs) {
      await this.advanceTo(this.timers[0].at);
    }
    return this.time - start;
  }

  private jump(to: number): void {
    if (to > this.time) {
      this.jumps.push({ from: this.time, to });
      this.time = to;
    }
  }

  private scheduleAuto(): void {
    if (!this.autoOn || this.autoScheduled) return;
    this.autoScheduled = true;
    void (async () => {
      try {
        // Wait until the process is quiet, then fire the earliest timer.
        for (;;) {
          await this.quiet();
          if (!this.autoOn || !this.timers.length) return;
          const next = this.timers.shift()!;
          this.jump(next.at);
          next.resolve();
        }
      } finally {
        this.autoScheduled = false;
        if (this.autoOn && this.timers.length) this.scheduleAuto();
      }
    })();
  }

  /**
   * Returns once two settles in a row registered no new timer and no I/O request is pending.
   * Pending I/O is waited for at most IO_WAIT_LIMIT_MS of real time, so a request that never
   * completes cannot stall the clock.
   */
  private async quiet(): Promise<void> {
    const ioDeadline = Date.now() + IO_WAIT_LIMIT_MS;
    let calm = 0;
    while (calm < 2) {
      const before = this.seq;
      await settle();
      const ioPending = pendingIo() && Date.now() < ioDeadline;
      calm = this.seq === before && !ioPending ? calm + 1 : 0;
    }
  }
}

/** Real milliseconds the clock waits for outstanding file or DNS requests before moving anyway. */
const IO_WAIT_LIMIT_MS = 250;

/** True while libuv has a file-system or DNS request in progress (FSReqCallback, FSReqPromise, CloseReq, GetAddrInfoReqWrap). */
function pendingIo(): boolean {
  return process.getActiveResourcesInfo().some(name => name.includes('Req'));
}

/** Let queued promise callbacks and a few macrotask turns run. */
async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
