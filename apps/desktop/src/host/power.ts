/**
 * Wake detection (host-2; plan 10 E1 item 4). `powerMonitor`'s `resume` and `unlock-screen` call `noteSystemEvent`;
 * a 1 s tick is the fallback for a wake Electron never reported: when wall time moves more than 30 s between two
 * ticks the machine slept, so it wakes the engine too. Wakes within `dedupeMs` of each other are one wake, so a real
 * resume plus the fallback (in either order) never produce two. Clock and timer come in through `PowerPorts`.
 */
export type WakeReason = 'resume' | 'unlock-screen' | 'clock-jump';

export interface PowerPorts {
  now(): number;
  /** A repeating timer (`setInterval`). */
  every(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Today `service.invoke('sync', {auto: true})`; later `engine.wake('wake')`. */
  wake(reason: WakeReason): void;
}

export const TICK_MS = 1000;
export const JUMP_MS = 30_000;
export const DEDUPE_MS = 5000;

export interface PowerWatch {
  start(): void;
  stop(): void;
  noteSystemEvent(reason: Exclude<WakeReason, 'clock-jump'>): void;
}

export function createPowerWatch(ports: PowerPorts): PowerWatch {
  let timer: unknown;
  let lastTick = 0;
  let lastWake = Number.NEGATIVE_INFINITY;

  function wake(reason: WakeReason) {
    const now = ports.now();
    if (now - lastWake < DEDUPE_MS) return;
    lastWake = now;
    ports.wake(reason);
  }

  function tick() {
    const now = ports.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > JUMP_MS) wake('clock-jump');
  }

  return {
    start() {
      if (timer !== undefined) return;
      lastTick = ports.now();
      timer = ports.every(tick, TICK_MS);
    },
    stop() {
      if (timer !== undefined) ports.cancel(timer);
      timer = undefined;
    },
    noteSystemEvent: wake,
  };
}
