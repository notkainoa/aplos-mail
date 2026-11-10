import { ContractError } from '@aplos/contract/contract-error';
import { NotSentError, ProviderError } from '../ports/base';
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
import type { StorePort } from '../ports';
import { eventFactWrites } from '../sync/calendar-facts';
import { writeFailure } from './write-errors';

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

/**
 * Every grant that satisfies a write: the narrow `calendar.events` scope OR the `calendar` umbrella an older
 * grant may already hold. One list for every gate (`prepare` here, the actor's `calendarWriteRefused`) so a
 * holder of the umbrella is never refused a write it can make; the gap still reports `calendar.events`,
 * the least the owner can add.
 */
export const CALENDAR_WRITE_SCOPES = [
  GOOGLE_CALENDAR_WRITE_SCOPE,
  'https://www.googleapis.com/auth/calendar',
] as const;

/** True when the grant covers calendar writes (any scope in `CALENDAR_WRITE_SCOPES`). */
export const hasCalendarWrite = (grantedScopes: readonly string[]) =>
  CALENDAR_WRITE_SCOPES.some(s => grantedScopes.includes(s));

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
  // A non-Google calendar half may exist without write support; refuse cleanly, never a TypeError.
  if (calendar && typeof calendar.put === 'function') return calendar;
  throw new ContractError({
    type: 'unsupported',
    message: 'This account has no calendar Aplos can change.',
    reasonCode: `${method}.unsupported`,
  });
}

/** What `prepare` resolved: the adapter's calendar half, the account's context and the target it came from. */
interface Prepared {
  calendar: CalendarAdapter;
  ctx: AdapterContext;
  target: CalendarTarget;
}

/** Resolves the checks every write shares; throws before any request when one fails. */
function prepare(account: AccountId, target: CalendarTarget | undefined, method: string): Prepared {
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
  if (!hasCalendarWrite(ctx.account.grantedScopes) && target.writeRefused())
    throw writePermissionError();
  return { calendar, ctx, target };
}

/** Google keeps each exception of a series under its own id; deleting the series takes them with it. */
function overridesOf(
  store: StorePort,
  accountId: string,
  calendarRemoteId: string,
  masters: readonly string[],
): string[] {
  if (!masters.length) return [];
  return store.read(q =>
    q
      .all<{ remote_id: string }>(
        `SELECT DISTINCT e.remote_id FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE c.account_id = ? AND c.remote_id = ? AND e.master_remote_id IN (SELECT value FROM json_each(?))`,
        accountId,
        calendarRemoteId,
        JSON.stringify(masters),
      )
      .map(r => r.remote_id),
  );
}

/**
 * Commits what the provider confirmed (its event rows, or the removal), in the same shape a sync step would, so the
 * local calendar shows the saved event at once. A conflict also commits the event as it is now: the caller is told the
 * event changed elsewhere and the screen already holds the newer version.
 */
function commitFacts(
  { target, ctx }: Prepared,
  calendarRemoteId: string,
  result: CalendarWriteResult,
): void {
  const facts =
    result.kind === 'saved'
      ? result
      : { upserts: result.current ? [result.current] : [], removals: [] };
  const writes = eventFactWrites(ctx.account.id, calendarRemoteId, {
    upserts: facts.upserts,
    removals: [
      ...facts.removals,
      ...overridesOf(target.store, ctx.account.id, calendarRemoteId, facts.removals),
    ],
  });
  if (writes.length)
    target.store.commit({ opId: target.newId(), origin: 'local', changes: 'fine', writes });
}

/** Runs one adapter write: scope-gated, committed on a result, and every failure turned into an honest answer. */
async function run(
  account: AccountId,
  target: CalendarTarget | undefined,
  method: string,
  calendarRemoteId: string,
  write: (calendar: CalendarAdapter, ctx: AdapterContext) => Promise<CalendarWriteResult>,
): Promise<CalendarWriteResult> {
  const prepared = prepare(account, target, method);
  let result: CalendarWriteResult;
  try {
    result = await write(prepared.calendar, prepared.ctx);
  } catch (error) {
    // The grant lost the scope after the check (revoked, or a stale account row): same answer as the check.
    if (error instanceof ProviderError && error.error.class === 'permission') {
      target?.writeRefused();
      throw writePermissionError();
    }
    throw writeFailure(error);
  }
  commitFacts(prepared, calendarRemoteId, result);
  return result;
}

export function createCalendarPort(
  targetFor: (account: AccountId) => CalendarTarget | undefined,
): CalendarPort {
  return {
    put(account: AccountId, change: EventChange): Promise<CalendarWriteResult> {
      return run(account, targetFor(account), 'calendar.put', change.calendarRemoteId, (c, ctx) =>
        c.put(change, ctx),
      );
    },
    remove(
      account: AccountId,
      ref: EventRef & { scope: EditScope; notify?: boolean },
    ): Promise<CalendarWriteResult> {
      return run(account, targetFor(account), 'calendar.remove', ref.calendarRemoteId, (c, ctx) =>
        c.remove(ref, ctx),
      );
    },
    rsvp(
      account: AccountId,
      ref: EventRef & { scope: EditScope },
      response: 'accepted' | 'declined' | 'tentative',
      opts: { notify: boolean },
    ): Promise<CalendarWriteResult> {
      return run(account, targetFor(account), 'calendar.rsvp', ref.calendarRemoteId, (c, ctx) =>
        c.rsvp(ref, response, opts, ctx),
      );
    },
  };
}
