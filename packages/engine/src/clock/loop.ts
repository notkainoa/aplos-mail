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
/**
 * Fires allowed per source per rolling hour before the loop spaces that source out. A runaway guard, not a pacer: it
 * must admit eng-views' 50 ms tick (72,000 an hour), so only a source firing faster than that is ever held back.
 */
export const MAX_WAKES_PER_HOUR = 100_000;
/** How long `stop` waits for a fire already running before it lets the engine close anyway. */
export const STOP_GRACE_MS = 10_000;
/** How long one `fire` may run before the loop stops waiting for it and serves the other sources (it is logged). */
export const FIRE_TIMEOUT_MS = 30_000;
/** How long one `next` read may run before the loop stops waiting for it; a read is a local query, so far shorter. */
export const NEXT_TIMEOUT_MS = 5_000;
const HOUR_MS = 3_600_000;
const TIMED_OUT = Symbol('timed out');

/** The one engine timer loop (ARCH 7.5, F3 `DeadlineRegistry`). The engine runtime starts it and forwards host wakes. */
export interface TimerLoop extends DeadlineRegistry {
  /** Reads every source and arms the timer (launch). */
  start(): void;
  /** Re-reads every source: the Mac woke, the network returned, or the wall clock jumped. */
  wake(): void;
  /** Stops arming at once; resolves when a fire already running has finished, or after `STOP_GRACE_MS`. */
  stop(): Promise<void>;
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
  /**
   * A `fire` or `next` call the loop gave up waiting for has not settled yet. The slot is skipped (never read or fired
   * again) until it settles, so a source never runs concurrently with itself; the settle marks it dirty and kicks.
   */
  inflight: boolean;
  /** The real call behind `inflight`; a source registered over this id waits on it too. */
  pending?: Promise<unknown>;
  /** Fire times in the last hour, oldest first from `head`: this source's own wake budget. */
  fires: number[];
  head: number;
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
  const cap = Math.max(1, maxWakesPerHour);
  let armed: { at: number; timer: Timer } | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let started = false;

  /** A log port that throws must not change what the loop does next: every loop log line goes through here. */
  const note = (kind: 'timer_drift', lagMs: number) => {
    try {
      log.event('engine.watchdog', { kind, lagMs });
    } catch {
      // Diagnostics only.
    }
  };

  /**
   * Waits for `work` at most `ms` on the injected clock. The caller keeps `work` and decides what an abandoned call
   * means; its late rejection is already handled here, so abandoning it never raises an unhandled rejection.
   */
  const within = async <T>(
    work: Promise<T>,
    ms: number,
  ): Promise<Awaited<T> | typeof TIMED_OUT> => {
    work.catch(() => {});
    const abort = new AbortController();
    const timedOut = (): typeof TIMED_OUT => TIMED_OUT;
    const timeout = clock.sleep(ms, abort.signal).then(timedOut, timedOut);
    try {
      return await Promise.race([work, timeout]);
    } finally {
      abort.abort();
    }
  };

  /**
   * Waits for a call on `slot` (`inflight` until it is over). When the loop gives up on it, because it timed out or
   * because the race itself threw, the call may still be running: the slot stays inflight until it really settles.
   */
  const waitFor = async <T>(slot: Slot, work: Promise<T>, ms: number) => {
    slot.inflight = true;
    slot.pending = work;
    // The call's own rejection is its result, not a failure of the race: only the race helper throwing is abandoned.
    const outcome = work.then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let result: Awaited<typeof outcome> | typeof TIMED_OUT;
    try {
      result = await within(outcome, ms);
    } catch {
      result = TIMED_OUT;
    }
    if (result === TIMED_OUT) {
      abandon(slot, work);
      return TIMED_OUT;
    }
    if (!result.ok) throw result.error;
    return result.value;
  };

  /** The call the loop gave up on settled (either way): the slot is free again, and its deadline is re-read. */
  const abandon = (slot: Slot, work: Promise<unknown>) => {
    work.then(
      () => settle(slot),
      () => settle(slot),
    );
  };
  const release = (slot: Slot) => {
    slot.inflight = false;
    slot.pending = undefined;
  };
  const settle = (slot: Slot) => {
    release(slot);
    if (slots.get(slot.source.id) !== slot) return;
    slot.dirty = true;
    if (started) kick();
  };

  const due = (slot: Slot, now: number) => {
    if (slot.next === undefined) return undefined;
    // A backoff written before a wall-clock jump backwards sits in the future. Clamping the stamp
    // itself, once, keeps the hold a fixed absolute time; clamping the arithmetic would slide it
    // forward with every read and the deadline would never arrive.
    if (slot.backoffUntil !== undefined && slot.backoffUntil > now + MIN_FIRE_GAP_MS)
      slot.backoffUntil = now + MIN_FIRE_GAP_MS;
    let at = slot.next;
    if (slot.backoffUntil !== undefined) at = Math.max(at, slot.backoffUntil);
    return Math.max(at, wakeFloor(slot, now));
  };

  /** The wake budget: the earliest time this source may fire again. One runaway source never delays another. */
  const wakeFloor = (slot: Slot, now: number) => {
    const { fires } = slot;
    while (slot.head < fires.length && fires[slot.head] <= now - HOUR_MS) slot.head++;
    // Stamps written before a wall-clock jump backwards sit in the future; they would freeze the budget.
    while (fires.length > slot.head && fires[fires.length - 1] > now) fires.pop();
    if (slot.head > 1024 && slot.head * 2 > fires.length) {
      fires.splice(0, slot.head);
      slot.head = 0;
    }
    return fires.length - slot.head < cap ? 0 : fires[slot.head] + HOUR_MS;
  };

  const earliest = (now: number, skip?: ReadonlySet<Slot>) => {
    let best: { slot: Slot; at: number } | undefined;
    for (const slot of slots.values()) {
      if (skip?.has(slot) || slot.inflight) continue;
      const at = due(slot, now);
      if (at !== undefined && (!best || at < best.at)) best = { slot, at };
    }
    return best;
  };

  /** Returns false when the source was unreadable (it is then already backed off). */
  const read = async (slot: Slot) => {
    slot.dirty = false;
    let abandoned = false;
    try {
      const work = (async () => slot.source.next())();
      const next = await waitFor(slot, work, NEXT_TIMEOUT_MS);
      if (next === TIMED_OUT) {
        abandoned = true;
        throw new Error('next timed out');
      }
      // A deadline the loop cannot order (NaN, ±Infinity, a non-number) fails `<= now` and `> now`
      // alike, so it would fire every pass with no backoff: it is unreadable, like a throw.
      if (next !== undefined && !Number.isFinite(next)) throw new Error('non-finite deadline');
      slot.next = next;
      return true;
    } catch {
      // An unreadable source retries like a stuck one, never silently drops its deadlines.
      slot.next = clock.now();
      slot.backoffUntil = clock.now() + MIN_FIRE_GAP_MS;
      note('timer_drift', abandoned ? NEXT_TIMEOUT_MS : MIN_FIRE_GAP_MS);
      return false;
    } finally {
      if (!abandoned) release(slot);
    }
  };

  const fire = async (slot: Slot) => {
    const now = clock.now();
    const deadline = slot.next ?? now;
    slot.fires.push(now);
    try {
      log.event('timer.fired', { kind: 'deadline', lateMs: Math.max(0, now - deadline) });
    } catch {
      // Diagnostics only.
    }
    // A failing fire is the source's bug; the backoff below keeps it from spinning.
    const work = (async () => slot.source.fire(now))().catch(() => {});
    if ((await waitFor(slot, work, FIRE_TIMEOUT_MS)) === TIMED_OUT) {
      // Hung: serve the other sources. The slot stays out of play until the call really settles.
      slot.backoffUntil = clock.now() + MIN_FIRE_GAP_MS;
      note('timer_drift', FIRE_TIMEOUT_MS);
      return;
    }
    release(slot);
    // Unregistered or replaced while its fire ran: the slot is orphaned and the source is not read again.
    if (slots.get(slot.source.id) !== slot) return;
    // An unreadable source keeps the backoff `read` just gave it, however much time the fire took.
    if (!(await read(slot))) return;
    if (slot.next !== undefined && slot.next <= now) {
      // The hold is set before the log line: a log that throws must not turn the backoff into an immediate re-fire.
      slot.backoffUntil = now + MIN_FIRE_GAP_MS;
      note('timer_drift', MIN_FIRE_GAP_MS);
    } else slot.backoffUntil = undefined;
  };

  const arm = (at: number) => {
    if (armed?.at === at) return;
    armed?.timer.cancel();
    // Clear before creating: a `clock.timer` throw must not leave a cancelled timer looking armed.
    armed = undefined;
    const timer = clock.timer(at, () => {
      if (armed?.timer !== timer) return;
      armed = undefined;
      kick();
    });
    armed = { at, timer };
  };

  /**
   * One source fires at most once per pass: if its new deadline is already due again (time passed while it worked) it
   * waits for a timer turn, so a source that only inches `next()` forward yields to the event loop and meets its budget.
   */
  const pass = async () => {
    const fired = new Set<Slot>();
    for (;;) {
      for (const slot of slots.values()) if (slot.dirty && !slot.inflight) await read(slot);
      if (!started) return;
      const now = clock.now();
      const ready = earliest(now, fired);
      if (ready && ready.at <= now) {
        // Marked dirty while another source ran: its deadline is stale, so read it again before any fire.
        if (ready.slot.dirty) continue;
        fired.add(ready.slot);
        await fire(ready.slot);
        continue;
      }
      const next = earliest(now);
      if (!next) {
        armed?.timer.cancel();
        armed = undefined;
      } else arm(next.at);
      return;
    }
  };

  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      let failed = false;
      try {
        do {
          again = false;
          try {
            await pass();
          } catch {
            // A pass dying on a port throw (clock, log) must not reject `idle()` or stall the loop:
            // log it and give this kick one retry; a persistent failure waits for the next kick.
            note('timer_drift', 0);
            if (!failed) {
              failed = true;
              again = true;
            }
          }
        } while (again && started);
      } finally {
        // Cleared in the same turn the last `again` is read: a `changed()` landing a microtask later starts a new run.
        running = undefined;
      }
    })();
  };

  const idle = async () => {
    while (running) await running;
  };

  const markAll = () => {
    for (const slot of slots.values()) slot.dirty = true;
  };

  return {
    /**
     * Registering an id that is already registered replaces the first source. The replaced slot is orphaned: a fire
     * already running is not read again. The new slot inherits the unsettled call, so one id never runs twice at once;
     * when that call settles the new slot is marked dirty and kicked.
     */
    register(source) {
      const slot: Slot = { source, dirty: true, inflight: false, fires: [], head: 0 };
      const old = slots.get(source.id);
      if (old?.inflight && old.pending) {
        slot.inflight = true;
        slot.pending = old.pending;
        abandon(slot, old.pending);
      }
      slots.set(source.id, slot);
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
    async stop() {
      started = false;
      armed?.timer.cancel();
      armed = undefined;
      if (!running) return;
      // A send mid-fire must settle before the host closes the store under it, but a hung one cannot block quit.
      const abort = new AbortController();
      const grace = clock.sleep(STOP_GRACE_MS, abort.signal).catch(() => {});
      await Promise.race([idle(), grace]);
      abort.abort();
    },
    idle,
  };
}
