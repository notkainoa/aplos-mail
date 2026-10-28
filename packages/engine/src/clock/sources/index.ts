import type { Clock, DeadlineRegistry } from '../../ports/time';
import type { StorePort } from '../../store/port';
import { createLater, type LaterDeps, type LaterService } from './later';
import { createReminders, type ReminderDeps, type ReminderService } from './reminders';

export { createLater, resolvePresets, LATER_QUERIES } from './later';
export type { LaterDeps, LaterEvent, LaterPreset, LaterService } from './later';
export { createReminders, REMINDER_QUERIES } from './reminders';
export type { ReminderDeps, ReminderEvent, ReminderItem, ReminderService } from './reminders';

declare module '../../methods/types' {
  interface EngineServices {
    reminders: ReminderService;
    later: LaterService;
  }
}

export interface TimeSourcesDeps {
  store: StorePort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  emit: ReminderDeps['emit'];
  emitLater?: LaterDeps['emit'];
  timeZone?: LaterDeps['timeZone'];
}

/** Builds the `reminders` and `later` services and registers their deadline sources with the one timer loop. */
export function createTimeSources(deps: TimeSourcesDeps): {
  reminders: ReminderService;
  later: LaterService;
} {
  const reminders = createReminders({ store: deps.store, emit: deps.emit });
  const later = createLater({
    store: deps.store,
    clock: deps.clock,
    timeZone: deps.timeZone,
    emit: deps.emitLater,
  });
  deps.deadlines.register(reminders.source);
  deps.deadlines.register(later.source);
  return { reminders, later };
}
