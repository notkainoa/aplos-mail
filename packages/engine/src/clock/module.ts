import { isAbsent } from '../runtime/engine';
import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { createTimerLoop } from './loop';
import { createLater, type LaterService } from './sources/later';
import { createReminders, type ReminderService } from './sources/reminders';
import { usableZone } from './zone';

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

declare module '../runtime/services' {
  interface EngineServices {
    /** `Reminder/list|ack` and the `reminders` deadline source (time-4). */
    reminders: ReminderService;
    /** `Later/presets` and the `later` deadline source (time-4). */
    later: LaterService;
  }
}

/**
 * Seam 1: lane `eng-time`'s clock module, imported by the composition root (`src/index.ts`) from this fixed path. It
 * builds the one timer loop over the injected `Clock` and provides `services.deadlines`; it registers the `reminders`
 * and `later` sources with it, `start` runs after every lane is composed, and the host's wake becomes `deadlines.wake()`.
 */
export const lane = 'eng-time';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [];

/** Builds the timer loop and the time sources once the core services exist; runs first in the root's fixed order. */
export function createModule(services: EngineServices): LaneModule {
  // A host that injects `deadlines` (a test's own registry) owns it entirely: its lifecycle too.
  const injected = !isAbsent(services.deadlines);
  const loop = injected ? undefined : createTimerLoop({ clock: services.clock, log: services.log });
  const deadlines = loop ?? services.deadlines;
  // The views lane holds the owner's zone (read when a call needs it: it is composed after this module).
  const zone = () => usableZone((services as Partial<EngineServices>).views?.zone);
  const deps = { store: services.store, clock: services.clock, frames: services.frames, zone };
  const reminders = createReminders(deps);
  const later = createLater(deps);
  const unregister = [deadlines.register(reminders.source), deadlines.register(later.source)];
  return {
    services: { ...(loop ? { deadlines: loop } : {}), reminders, later },
    start() {
      later.start();
      loop?.start();
    },
    stop() {
      for (const off of unregister) off();
      return loop?.stop();
    },
  };
}
