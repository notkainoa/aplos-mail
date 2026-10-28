import type { Logger } from '../diag/log';
import type { Clock } from '../ports/time';
import { createTimerLoop, type TimerLoop } from './loop';
import { systemClock } from './system';

export { fakeClock, type FakeClock } from './fake';
export { createTimerLoop, MAX_WAKES_PER_HOUR, MIN_FIRE_GAP_MS, type TimerLoop } from './loop';
export { systemClock } from './system';

/** What the engine runtime gets from `eng-time`'s clock lane: `EngineServices.clock` and `.deadlines`. */
export interface ClockModule {
  clock: Clock;
  deadlines: TimerLoop;
}

/**
 * Builds the clock and the one timer loop. The runtime passes `clock` (a fake one in tests and the conformance
 * runner), calls `deadlines.start()` once every lane has registered, and `deadlines.wake()` on the host's wake.
 */
export function createClockModule(deps: { log: Logger; clock?: Clock }): ClockModule {
  const clock = deps.clock ?? systemClock();
  return { clock, deadlines: createTimerLoop({ clock, log: deps.log }) };
}
