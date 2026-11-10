/**
 * One shared answer to "where does this account's calendar stand" (DESIGN 7.8, 7.10, 7.15): the `Account` from
 * `Account/get` plus the `Calendar/get` list, to one of five states, its one-line copy and the action that moves
 * it — `grant` (the #345 re-consent: `Account/grantPermissions` via the reconnect sheet's grant mode) or
 * `reconnect`. Demo accounts and non-Google providers claim nothing (`null`): only Google carries a calendar
 * grant question, and the settings model's demo rule ("sample, nothing real") stays the account row's own.
 *
 * Everything here is derived from fields the engine already produces; nothing is invented:
 * - `Account.missingPermissions` entries with `capability` 'calendar' (the actor's own gap, at start, on
 *   reconnect and on a refused calendar scope);
 * - `Account.capabilities.calendar` (the grant's calendar half);
 * - `Account.health.status` (`needsReauth` signs in again; `needsPermission` naming calendar scopes is the same
 *   not-allowed gap; a halted status says nothing here — the status slot already does);
 * - `Account.calendarListedAt` (stamped when the account's calendar list was first read, even an empty one;
 *   absent until then, so accounts predating the field read "Syncing…" until their next list);
 * - `Calendar/get`'s list, undefined until it answers (that is honestly "Syncing…", not "No calendars").
 */
import type { Account, Calendar } from '../../data';
import type { TagColor } from '../../ui/props';

/** The copy, in one place (DESIGN 10): plain words, no trailing periods on the quiet states. */
export const CALENDAR_ACCESS_COPY = {
  notAllowed: 'Calendar not allowed yet',
  needsSignIn: 'Needs sign-in again',
  syncing: 'Syncing…',
  none: 'No calendars',
  noAccounts: 'No accounts yet',
  grant: 'Allow calendar access',
  signIn: 'Sign in again',
} as const;

/** "Calendar on · 4 calendars", singular for one. */
export function calendarOnLine(count: number): string {
  return `Calendar on · ${count} ${count === 1 ? 'calendar' : 'calendars'}`;
}

/** The sheet the action opens: 'grant' asks Google for the calendar scopes, 'reconnect' signs in again. */
export interface CalendarAccessAction {
  readonly label: string;
  readonly mode: 'reconnect' | 'grant';
  /** 'calendarWrite' on a grant asks the Enable-editing consent; absent for the read grant. */
  readonly enable?: 'calendarWrite';
}

export type CalendarAccess =
  | { readonly kind: 'on'; readonly count: number; readonly line: string; readonly action: null }
  | {
      readonly kind: 'not-allowed';
      readonly line: string;
      readonly action: CalendarAccessAction;
    }
  | {
      readonly kind: 'needs-signin';
      readonly line: string;
      readonly action: CalendarAccessAction;
    }
  | { readonly kind: 'syncing'; readonly line: string; readonly action: null }
  | { readonly kind: 'none'; readonly line: string; readonly action: null }
  /** A halted account says nothing about its calendar: the status slot and the account row already do. */
  | { readonly kind: 'unknown'; readonly line: null; readonly action: null };

const SYNCING: CalendarAccess = {
  kind: 'syncing',
  line: CALENDAR_ACCESS_COPY.syncing,
  action: null,
};

const UNKNOWN: CalendarAccess = { kind: 'unknown', line: null, action: null };

/** Halted states: nothing is moving, so no sync claim and no grant (an admin/API halt cannot be granted away). */
const HALTED: ReadonlySet<string> = new Set([
  'paused',
  'error',
  'offline',
  'needsAdmin',
  'misconfigured',
]);

/** A needsPermission status whose missingScopes name the calendar half: re-consent can add them. */
function needsPermissionCalendar(account: Account): boolean {
  const status = account.health?.status;
  return (
    status?.state === 'needsPermission' &&
    status.missingScopes?.some(scope => scope.toLowerCase().includes('calendar')) === true
  );
}

/** The account's grant lacks the calendar half, however the engine says so. */
function calendarMissing(account: Account): boolean {
  if (account.missingPermissions?.some(m => m.capability === 'calendar')) return true;
  if (account.capabilities?.calendar !== true) return true;
  return needsPermissionCalendar(account);
}

/**
 * The account's calendar state, or `null` when there is no calendar claim to make (demo, non-Google). Order:
 * sign-in first (nothing can be granted while the grant is dead), then the permission gap, then what the
 * calendar list itself says — still arriving, on, or honestly empty. The last step reads the list and
 * `calendarListedAt`, never the mail status: calendars that exist show as on while mail still syncs, a list
 * that answered empty is "No calendars" once `calendarListedAt` says it was read, and an unlisted account
 * stays "Syncing…" (accounts predating the field read so until their next list).
 */
export function calendarAccessOf(
  account: Account,
  calendars: readonly Calendar[] | undefined,
): CalendarAccess | null {
  if (account.demo || account.provider !== 'google') return null;
  const state = account.health?.status?.state;
  if (state === 'needsReauth') {
    return {
      kind: 'needs-signin',
      line: CALENDAR_ACCESS_COPY.needsSignIn,
      action: { label: CALENDAR_ACCESS_COPY.signIn, mode: 'reconnect' },
    };
  }
  if (needsPermissionCalendar(account)) {
    return {
      kind: 'not-allowed',
      line: CALENDAR_ACCESS_COPY.notAllowed,
      action: { label: CALENDAR_ACCESS_COPY.grant, mode: 'grant' },
    };
  }
  // Halted: the status slot and the account row already say so; only a needsPermission naming the
  // calendar scopes can take the grant path above — an admin/API halt cannot be granted away.
  if (HALTED.has(state ?? '') || state === 'needsPermission') return UNKNOWN;
  if (calendarMissing(account)) {
    return {
      kind: 'not-allowed',
      line: CALENDAR_ACCESS_COPY.notAllowed,
      action: { label: CALENDAR_ACCESS_COPY.grant, mode: 'grant' },
    };
  }
  if (calendars === undefined) return SYNCING;
  const count = calendars.filter(c => c.accountId === account.id).length;
  if (count > 0) return { kind: 'on', count, line: calendarOnLine(count), action: null };
  return account.calendarListedAt === undefined
    ? SYNCING
    : { kind: 'none', line: CALENDAR_ACCESS_COPY.none, action: null };
}

const ACCOUNT_TAGS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

/** The account's colour dot: its own colour tag, else the same stable pick the Accounts rows use. */
export function accountTag(account: Pick<Account, 'colorTag'>, index: number): TagColor {
  const own = account.colorTag as TagColor | undefined;
  return own !== undefined && ACCOUNT_TAGS.includes(own)
    ? own
    : ACCOUNT_TAGS[index % ACCOUNT_TAGS.length];
}

/**
 * Every Google account's `calendarListedAt` stamp as one sorted `id:stamp` string: it changes only when a
 * stamp lands or moves, or a Google account joins or leaves — never on colour, name or health flicker. The
 * stamp arrives live through `useAccounts` while `Calendar/get` answers once, so the fetch effects that keep
 * a copy of the list depend on this key and re-read it when an account's first list commits.
 */
export function calendarListedKey(accounts: readonly Account[]): string {
  return accounts
    .filter(a => a.provider === 'google')
    .map(a => `${a.id}:${a.calendarListedAt ?? ''}`)
    .sort()
    .join('|');
}
