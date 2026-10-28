import type { Logger } from '../diag/log';
import type {
  Clock,
  DeadlineRegistry,
  DeadlineSource,
  DeadlineSourceId,
  Timer,
} from '../ports/time';

/** A source fires at most once a second, however its deadline moves, so none can spin the loop. */
export const MIN_FIRE_GAP_MS = 1_000;
/** Timer wake-ups allowed per rolling hour before the loop spaces them out. */
export const MAX_WAKES_PER_HOUR = 3_600;
const HOUR_MS = 3_600_000;

/** The one engine timer loop (ARCH 7.5, F3 `DeadlineRegistry`). The engine runtime starts it and forwards host wakes. */
export interface TimerLoop extends DeadlineRegistry {
  /** Reads every source and arms the timer (launch). */
  start(): void;
  /** Re-reads every source: the Mac woke, the network returned, or the wall clock jumped. */
  wake(): void;
  stop(): void;
  /** Resolves once no pass is running or queued (tests and quit). */
  idle(): Promise<void>;
}

export interface TimerLoopOptions {
  clock: Clock;
  log: Logger;
  maxWakesPerHour?: number;
}

interface Slot {
  source: DeadlineSource;
  /** The source's own `next()` at the last read. */
  next?: number;
  lastFire?: number;
  /** Set when a fire left `next()` at or before its `now`: no earlier fire than this. */
  backoffUntil?: number;
  dirty: boolean;
}

/**
 * Sleeps until the earliest deadline across the registered sources, fires that source, and repeats. Sources run one at
 * a time, earliest deadline first, so a slow source delays another only by its own run time, and overdue deadlines
 * catch up in deadline order. A source that does not move its deadline past `now` backs off 1 s and is logged.
 */
export function createTimerLoop({
  clock,
  log,
  maxWakesPerHour = MAX_WAKES_PER_HOUR,
}: TimerLoopOptions): TimerLoop {
  const slots = new Map<DeadlineSourceId, Slot>();
  const wakes: number[] = [];
  let armed: { at: number; timer: Timer } | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let started = false;

  const due = (slot: Slot) => {
    if (slot.next === undefined) return undefined;
    let at = slot.next;
    if (slot.lastFire !== undefined) at = Math.max(at, slot.lastFire + MIN_FIRE_GAP_MS);
    if (slot.backoffUntil !== undefined) at = Math.max(at, slot.backoffUntil);
    return at;
  };

  const earliest = () => {
    let best: { slot: Slot; at: number } | undefined;
    for (const slot of slots.values()) {
      const at = due(slot);
      if (at !== undefined && (!best || at < best.at)) best = { slot, at };
    }
    return best;
  };

  const read = async (slot: Slot) => {
    slot.dirty = false;
    try {
      slot.next = await slot.source.next();
    } catch {
      // An unreadable source retries like a stuck one, never silently drops its deadlines.
      slot.next = clock.now();
      slot.backoffUntil = clock.now() + MIN_FIRE_GAP_MS;
      log.event('engine.watchdog', { kind: 'timer_drift', lagMs: MIN_FIRE_GAP_MS });
    }
  };

  const fire = async (slot: Slot) => {
    const now = clock.now();
    const deadline = slot.next ?? now;
    slot.lastFire = now;
    log.event('timer.fired', { kind: 'deadline', lateMs: Math.max(0, now - deadline) });
    try {
      await slot.source.fire(now);
    } catch {
      // A failing fire is the source's bug; the backoff below keeps it from spinning.
    }
    await read(slot);
    if (slot.next !== undefined && slot.next <= now) {
      slot.backoffUntil = now + MIN_FIRE_GAP_MS;
      log.event('engine.watchdog', { kind: 'timer_drift', lagMs: MIN_FIRE_GAP_MS });
    } else slot.backoffUntil = undefined;
  };

  /** The wake budget: the earliest time another timer wake-up is allowed. */
  const wakeFloor = (now: number) => {
    while (wakes.length && wakes[0] <= now - HOUR_MS) wakes.shift();
    return wakes.length < maxWakesPerHour ? now : wakes[0] + HOUR_MS;
  };

  const arm = (at: number) => {
    if (armed?.at === at) return;
    armed?.timer.cancel();
    const timer = clock.timer(at, () => {
      if (armed?.timer !== timer) return;
      armed = undefined;
      wakes.push(clock.now());
      kick();
    });
    armed = { at, timer };
  };

  const pass = async () => {
    for (;;) {
      for (const slot of slots.values()) if (slot.dirty) await read(slot);
      if (!started) return;
      const next = earliest();
      if (!next) {
        armed?.timer.cancel();
        armed = undefined;
        return;
      }
      const now = clock.now();
      if (next.at > now) {
        arm(Math.max(next.at, wakeFloor(now)));
        return;
      }
      await fire(next.slot);
    }
  };

  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again && started);
    })().finally(() => {
      running = undefined;
    });
  };

  const markAll = () => {
    for (const slot of slots.values()) slot.dirty = true;
  };

  return {
    register(source) {
      slots.set(source.id, { source, dirty: true });
      if (started) kick();
      return () => {
        if (slots.get(source.id)?.source !== source) return;
        slots.delete(source.id);
        if (started) kick();
      };
    },
    changed(id) {
      const slot = slots.get(id);
      if (!slot) return;
      slot.dirty = true;
      if (started) kick();
    },
    start() {
      started = true;
      markAll();
      kick();
    },
    wake() {
      if (!started) return;
      markAll();
      kick();
    },
    stop() {
      started = false;
      armed?.timer.cancel();
      armed = undefined;
    },
    async idle() {
      while (running) await running;
    },
  };
}
