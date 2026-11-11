import type { Input, Operation, Receipt } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import type { CalendarHolds, HoldSpec } from './holds-types';

/**
 * The always-loaded half of the calendar holds: `has`, the deadline source that wakes the holds, and a service whose
 * methods load the working half (`holds.ts`) on first use. Held writes are rare, so startup carries only this.
 */

const PREFIX = 'calendar.hold.';

export function createCalendarHolds(services: EngineServices): CalendarHolds {
  const { store, clock, log } = services;
  let working: ReturnType<typeof load> | undefined;
  const changed = () => services.deadlines.changed('calendarHolds');
  function load() {
    return import('./holds').then(m =>
      m.createHolds({
        store,
        clock,
        log,
        calendar: services.calendar,
        frames: services.frames,
        changed,
      }),
    );
  }
  const holds = () => {
    if (!working) {
      // A failed load must not cache its rejection (the next call retries) and surfaces as a plain typed error.
      const loading = load().catch(() => {
        throw new ContractError({
          type: 'unavailable',
          message: 'Calendar undo could not start. Nothing was changed. Try again.',
          reasonCode: 'calendar.unavailable',
        });
      });
      working = loading;
      loading.catch(() => {
        if (working === loading) working = undefined;
      });
    }
    return working;
  };

  services.deadlines.register({
    id: 'calendarHolds',
    // The earliest window that ends, or a restart-time record that was mid-send (due now).
    next: async () => {
      const rows = store.read(q =>
        q.all<{ value: string }>('SELECT value FROM meta WHERE key LIKE ?', `${PREFIX}%`),
      );
      // No holds (the usual case): nothing to wake for, and the working half stays unloaded.
      if (!rows.length) return undefined;
      return (await holds()).nextDue(rows.map(r => r.value));
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
    // Nothing stored, nothing to list: the common case never loads the working half.
    list: async () =>
      store.read(q => q.get('SELECT 1 FROM meta WHERE key LIKE ?', `${PREFIX}%`))
        ? (await holds()).list()
        : [],
    dismiss: async (opId: string, caller: Caller): Promise<void> =>
      (await holds()).dismiss(opId, caller),
  };
}
