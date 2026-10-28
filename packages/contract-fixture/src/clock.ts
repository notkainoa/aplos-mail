/**
 * The stand-in engine's clock. Fake by default (an `APLOS_NOW`-style fixed time that moves only when a test or the
 * control channel advances it), so every timer, coalescing interval and delay is deterministic. `realClock` ticks with
 * the wall clock from a chosen start, for the browser preview where nobody advances time by hand.
 */
export interface FixtureClock {
  now(): number;
  /** Runs `fn` once the clock reaches `now() + ms`. Returns the cancel function. */
  after(ms: number, fn: () => void): () => void;
  /** Jumps to `ms` (never backwards for a fake clock's timers: due timers fire in order on the way). */
  set(ms: number): void;
  /** Moves the clock forward, firing due timers in order. A real clock only shifts its offset; its timers keep wall time. */
  advance(ms: number): void;
  /**
   * The Mac sleeps for `ms`: time jumps with no timer firing on the way, then every due timer fires at once at wake, late
   * (ARCH 7.3's overdue case). A real clock only shifts its offset.
   */
  sleep(ms: number): void;
  readonly kind: 'fake' | 'real';
}

/** 2026-10-27 16:00 UTC, a Tuesday morning on the US west coast: the default `APLOS_NOW`. */
export const defaultNow = Date.UTC(2026, 9, 27, 16, 0, 0);

export function fakeClock(start = defaultNow): FixtureClock {
  let now = start,
    nextId = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const runUntil = (target: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
    }
    now = Math.max(now, target);
  };
  return {
    kind: 'fake',
    now: () => now,
    after(ms, fn) {
      const timer = { id: nextId++, at: now + Math.max(0, ms), fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    set(ms) {
      if (ms >= now) runUntil(ms);
      else now = ms;
    },
    advance(ms) {
      runUntil(now + Math.max(0, ms));
    },
    sleep(ms) {
      now += Math.max(0, ms);
      runUntil(now);
    },
  };
}

export function realClock(start = Date.now()): FixtureClock {
  let offset = start - Date.now();
  return {
    kind: 'real',
    now: () => Date.now() + offset,
    after(ms, fn) {
      const handle = setTimeout(fn, Math.max(0, ms));
      return () => clearTimeout(handle);
    },
    set(ms) {
      offset = ms - Date.now();
    },
    advance(ms) {
      offset += Math.max(0, ms);
    },
    sleep(ms) {
      offset += Math.max(0, ms);
    },
  };
}

/** A small seeded generator (mulberry32), so a scenario and its ids are the same for the same seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
