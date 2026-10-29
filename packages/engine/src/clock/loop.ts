import type { Logger } from '../diag/log';
import type {
  Clock,
  DeadlineRegistry,
  DeadlineSource,
  DeadlineSourceId,
  Timer,
} from '../ports/time';

/** The backoff a source that does not move `next()` past the fire's `now` waits before firing again. */
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

  const due = (slot: Slot, now: number) => {
    if (slot.next === undefined) return undefined;
    // A backoff written before a wall-clock jump backwards sits in the future. Clamping the stamp
    // itself, once, keeps the hold a fixed absolute time; clamping the arithmetic would slide it
    // forward with every read and the deadline would never arrive.
    if (slot.backoffUntil !== undefined && slot.backoffUntil > now + MIN_FIRE_GAP_MS)
      slot.backoffUntil = now + MIN_FIRE_GAP_MS;
    let at = slot.next;
    if (slot.backoffUntil !== undefined) at = Math.max(at, slot.backoffUntil);
    return at;
  };

  const earliest = (now: number) => {
    let best: { slot: Slot; at: number } | undefined;
    for (const slot of slots.values()) {
      const at = due(slot, now);
      if (at !== undefined && (!best || at < best.at)) best = { slot, at };
    }
    return best;
  };

  const read = async (slot: Slot) => {
    slot.dirty = false;
    try {
      const next = await slot.source.next();
      // A deadline the loop cannot order (NaN, ±Infinity, a non-number) fails `<= now` and `> now`
      // alike, so it would fire every pass with no backoff: it is unreadable, like a throw.
      if (next !== undefined && !Number.isFinite(next)) throw new Error('non-finite deadline');
      slot.next = next;
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
    log.event('timer.fired', { kind: 'deadline', lateMs: Math.max(0, now - deadline) });
    try {
      await slot.source.fire(now);
    } catch {
      // A failing fire is the source's bug; the backoff below keeps it from spinning.
    }
    // Unregistered or replaced while its fire ran: the slot is orphaned and the source is not read again.
    if (slots.get(slot.source.id) !== slot) return;
    await read(slot);
    if (slot.next !== undefined && slot.next <= now) {
      slot.backoffUntil = now + MIN_FIRE_GAP_MS;
      log.event('engine.watchdog', { kind: 'timer_drift', lagMs: MIN_FIRE_GAP_MS });
    } else slot.backoffUntil = undefined;
  };

  /** The wake budget: the earliest time another timer wake-up is allowed. */
  const cap = Math.max(1, maxWakesPerHour);
  const wakeFloor = (now: number) => {
    while (wakes.length && wakes[0] <= now - HOUR_MS) wakes.shift();
    // Stamps written before a wall-clock jump backwards sit in the future; they would freeze the budget.
    while (wakes.length && wakes[wakes.length - 1] > now) wakes.pop();
    return wakes.length < cap ? now : wakes[0] + HOUR_MS;
  };

  const arm = (at: number) => {
    if (armed?.at === at) return;
    armed?.timer.cancel();
    // Clear before creating: a `clock.timer` throw must not leave a cancelled timer looking armed.
    armed = undefined;
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
      const now = clock.now();
      const next = earliest(now);
      if (!next) {
        armed?.timer.cancel();
        armed = undefined;
        return;
      }
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
      let failed = false;
      do {
        again = false;
        try {
          await pass();
        } catch {
          // A pass dying on a port throw (clock, log) must not reject `idle()` or stall the loop:
          // log it and give this kick one retry; a persistent failure waits for the next kick.
          log.event('engine.watchdog', { kind: 'timer_drift', lagMs: 0 });
          if (!failed) {
            failed = true;
            again = true;
          }
        }
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
