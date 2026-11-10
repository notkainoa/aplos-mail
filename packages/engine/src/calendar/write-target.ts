import type { AccountId } from '../ports/base';
import type {
  CalendarPort,
  CalendarWriteResult,
  EditScope,
  EventChange,
  EventRef,
  StorePort,
} from '../ports';
import type { AdapterContext, ProviderAdapter } from '../ports/provider';

/**
 * The always-loaded half of the calendar write port: how a started account becomes a write target, and a port whose
 * methods load the working half (`write-port.ts`) on the first write. Calendar writes are rare, so the engine's
 * startup bundle carries only this (bundle budget).
 */

/** What a calendar write needs from a started account. */
export interface CalendarTarget {
  adapter: ProviderAdapter;
  store: StorePort;
  newId(): string;
  context(): AdapterContext;
  /** Records the gap on the actor (`Account.missingPermissions` `calendarWrite`); false when the grant has the scope. */
  writeRefused(): boolean;
}

/** A started account's entry as a write target; undefined when the account is not started. */
export function calendarTargetOf(
  entry:
    | {
        adapter: ProviderAdapter;
        actor: {
          deps: { store: StorePort; newId(): string };
          context(): AdapterContext;
          calendarWriteRefused(): boolean;
        };
      }
    | undefined,
): CalendarTarget | undefined {
  if (!entry) return undefined;
  return {
    adapter: entry.adapter,
    store: entry.actor.deps.store,
    newId: () => entry.actor.deps.newId(),
    context: () => entry.actor.context(),
    writeRefused: () => entry.actor.calendarWriteRefused(),
  };
}

export function lazyCalendarPort(
  targetFor: (account: AccountId) => CalendarTarget | undefined,
): CalendarPort {
  let working: Promise<CalendarPort> | undefined;
  const port = () =>
    (working ??= import('./write-port').then(m => m.createCalendarPort(targetFor)));
  return {
    put: async (account: AccountId, change: EventChange): Promise<CalendarWriteResult> =>
      (await port()).put(account, change),
    remove: async (
      account: AccountId,
      ref: EventRef & { scope: EditScope; notify?: boolean },
    ): Promise<CalendarWriteResult> => (await port()).remove(account, ref),
    rsvp: async (
      account: AccountId,
      ref: EventRef & { scope: EditScope },
      response: 'accepted' | 'declined' | 'tentative',
      opts: { notify: boolean },
    ): Promise<CalendarWriteResult> => (await port()).rsvp(account, ref, response, opts),
  };
}
