import type { Input, Operation, Receipt } from '@aplos/contract';
import type { Caller } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import type { CalendarHolds, HoldSpec } from './holds-types';

/**
 * The always-loaded half of the calendar holds: `has`, the deadline source that wakes the holds, and a service whose
 * methods load the working half (`holds.ts`) on first use. Held writes are rare, so startup carries only this.
 */

const PREFIX = 'calendar.hold.';

interface Stored {
  state: string;
  undoUntil: number;
}

export function createCalendarHolds(services: EngineServices): CalendarHolds {
  const { store, clock, log } = services;
  let working: ReturnType<typeof load> | undefined;
  const changed = () => services.deadlines.changed('calendarHolds');
  function load() {
    return import('./holds').then(m =>
      m.createHolds({ store, clock, log, calendar: services.calendar, changed }),
    );
  }
  const holds = () => (working ??= load());

  services.deadlines.register({
    id: 'calendarHolds',
    // The earliest window that ends, or a restart-time record that was mid-send (due now).
    next: async () => {
      const rows = store.read(q =>
        q.all<{ value: string }>('SELECT value FROM meta WHERE key LIKE ?', `${PREFIX}%`),
      );
      let next: number | undefined;
      for (const row of rows) {
        const r = JSON.parse(row.value) as Stored;
        const due = r.state === 'queued' ? r.undoUntil : r.state === 'syncing' ? 0 : undefined;
        if (due !== undefined) next = next === undefined ? due : Math.min(next, due);
      }
      return next;
    },
    fire: async now => (await holds()).runDue(now),
  });

  return {
    has: opId =>
      store.read(q => q.get('SELECT 1 FROM meta WHERE key = ?', `${PREFIX}${opId}`) !== undefined),
    hold: async (spec: HoldSpec): Promise<Receipt> => (await holds()).hold(spec),
    get: async (opIds: readonly string[]): Promise<Operation[]> => (await holds()).get(opIds),
    undo: async (args: Input<'Operation/undo'>, caller: Caller): Promise<Receipt> =>
      (await holds()).undo(args, caller),
    retry: async (args: Input<'Operation/retry'>, caller: Caller): Promise<Receipt> =>
      (await holds()).retry(args, caller),
  };
}
