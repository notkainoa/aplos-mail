import { ContractError } from '@aplos/contract/contract-error';
import { NotSentError } from '../ports/base';
import type { AccountId } from '../ports/base';
import type {
  CalendarAdapter,
  CalendarPort,
  CalendarWriteResult,
  EditScope,
  EventChange,
  EventRef,
} from '../ports';
import type { AdapterContext, ProviderAdapter } from '../ports/provider';

/**
 * `CalendarPort`: event writes, addressed by account. The host looks up the started account's entry for exactly the
 * account the caller named (`calendarTarget`), so one account's edit can never reach another account's calendar.
 *
 * Writing needs a permission that reading does not (Google's `calendar.events` scope). Read-only is the default
 * and still works; a write on a read-only grant is refused HERE, before any request, with `permission` and the reason
 * code the UI turns into "Enable editing". The scope is never requested by a write: only the owner's explicit
 * `Account/grantPermissions` with `enable: 'calendarWrite'` adds it.
 */

/** Google's event write scope (`oauth/scopes.ts` `calendarEventsWrite`; pinned by a test). */
export const GOOGLE_CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** What a calendar write needs from a started account. */
export interface CalendarTarget {
  adapter: ProviderAdapter;
  context(): AdapterContext;
  /** Records the gap on the actor (`Account.missingPermissions` `calendarWrite`); false when the grant has the scope. */
  writeRefused(): boolean;
}

/** A started account's entry as a write target; undefined when the account is not started. */
export function calendarTargetOf(
  entry:
    | {
        adapter: ProviderAdapter;
        actor: { context(): AdapterContext; calendarWriteRefused(): boolean };
      }
    | undefined,
): CalendarTarget | undefined {
  if (!entry) return undefined;
  return {
    adapter: entry.adapter,
    context: () => entry.actor.context(),
    writeRefused: () => entry.actor.calendarWriteRefused(),
  };
}

/** The reason the caller sees when the grant only reads. Plain words: no scope URL, no provider text. */
const READ_ONLY_MESSAGE =
  'Aplos can only read this calendar. Turn on editing in Settings → Calendar, then try again.';

export function writePermissionError(): ContractError {
  return new ContractError({
    type: 'permission',
    message: READ_ONLY_MESSAGE,
    reasonCode: 'permission.calendarWrite',
  });
}

/** An account that is not started: nothing was sent, the caller may try again. */
function notStarted(method: string): NotSentError {
  return new NotSentError({
    class: 'transient',
    provider: 'engine',
    method,
    reason: 'accountNotStarted',
  });
}

function calendarOf(target: CalendarTarget, method: string): CalendarAdapter {
  const calendar = target.adapter.calendar;
  if (calendar) return calendar;
  throw new ContractError({
    type: 'unsupported',
    message: 'This account has no calendar Aplos can change.',
    reasonCode: `${method}.unsupported`,
  });
}

/** Resolves the checks every write shares; throws before any request when one fails. */
function prepare(
  account: AccountId,
  target: CalendarTarget | undefined,
  method: string,
): { calendar: CalendarAdapter; ctx: AdapterContext } {
  if (!target) throw notStarted(method);
  const calendar = calendarOf(target, method);
  const ctx = target.context();
  // The host keys entries by account, so a mismatch is a bug: refuse rather than write to the wrong calendar.
  if (ctx.account.id !== account) {
    throw new ContractError({
      type: 'internal',
      message: 'Aplos could not tell which account to change.',
    });
  }
  if (!ctx.account.grantedScopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE) && target.writeRefused())
    throw writePermissionError();
  return { calendar, ctx };
}

export function createCalendarPort(
  targetFor: (account: AccountId) => CalendarTarget | undefined,
): CalendarPort {
  return {
    async put(account: AccountId, change: EventChange): Promise<CalendarWriteResult> {
      const { calendar, ctx } = prepare(account, targetFor(account), 'calendar.put');
      return calendar.put(change, ctx);
    },
    async remove(
      account: AccountId,
      ref: EventRef & { scope: EditScope; notify?: boolean },
    ): Promise<CalendarWriteResult> {
      const { calendar, ctx } = prepare(account, targetFor(account), 'calendar.remove');
      return calendar.remove(ref, ctx);
    },
    async rsvp(
      account: AccountId,
      ref: EventRef & { scope: EditScope },
      response: 'accepted' | 'declined' | 'tentative',
      opts: { notify: boolean },
    ): Promise<CalendarWriteResult> {
      const { calendar, ctx } = prepare(account, targetFor(account), 'calendar.rsvp');
      return calendar.rsvp(ref, response, opts, ctx);
    },
  };
}
