import { isAbsent } from '../runtime/engine';
import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { createTimerLoop, type TimerLoop } from './loop';

export { fakeClock, type FakeClock } from './fake';
export {
  createTimerLoop,
  FIRE_TIMEOUT_MS,
  MAX_WAKES_PER_HOUR,
  MIN_FIRE_GAP_MS,
  NEXT_TIMEOUT_MS,
  STOP_GRACE_MS,
  type TimerLoop,
} from './loop';
export { MAX_SYSTEM_WAIT_MS, systemClock } from './system';

/**
 * Seam 1: lane `eng-time`'s clock module, imported by the composition root (`src/index.ts`) from this fixed path. It
 * builds the one timer loop over the injected `Clock` and provides `services.deadlines`; later modules register their
 * sources with it, `start` runs after every lane is composed, and the host's wake becomes `deadlines.wake()`.
 */
export const lane = 'eng-time';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [];

/** Builds the timer loop once the core services exist; runs first in the root's fixed order. */
export function createModule(services: EngineServices): LaneModule {
  // A host that injects `deadlines` (a test's own registry) owns it entirely: its lifecycle too.
  if (!isAbsent(services.deadlines)) return {};
  const deadlines: TimerLoop = createTimerLoop({ clock: services.clock, log: services.log });
  return {
    services: { deadlines },
    start: () => deadlines.start(),
    stop: () => deadlines.stop(),
  };
}
