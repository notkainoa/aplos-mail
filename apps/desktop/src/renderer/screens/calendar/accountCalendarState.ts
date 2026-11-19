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
 *
 * Editing is a separate, additive answer (`calendarEditingOf` / `calendarWriteRefused` over `editingOn`):
 * `grantedScopes` holding the `calendar.events` scope — or the umbrella `calendar` scope — means the
 * account may write, and a `missingPermissions` row with `capability` 'calendarWrite' names a write the
 * engine refused — never the 'calendar' (read) gap above and never a reconnect of its own (Settings →
 * Calendar's "Enable editing" row is its only home).
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

/** "4 calendars", singular for one: the count alone, for an account with no access claim to make (demo, non-Google). */
export function calendarCountLine(count: number): string {
  return `${count} ${count === 1 ? 'calendar' : 'calendars'}`;
}

/** The sheet the action opens: 'grant' asks Google for the calendar scopes, 'reconnect' signs in again. */
export interface CalendarAccessAction {
  readonly label: string;
  readonly mode: 'reconnect' | 'grant';
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

/** The one place the write scope's wire string lives (providers' 2026-11-10 shape 1). */
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** The umbrella grant: `calendar` carries `calendar.events` inside it, so it is editing on too. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** The 'Turn on editing' line and its action, shared by the detail and the notice (DESIGN 10). */
export const EDITING_COPY = {
  notice: 'Turn on editing to change events on this calendar.',
  action: 'Enable editing',
} as const;

/**
 * Whether the account's grant carries the calendar write scope (`grantedScopes`, shape 1). An account
 * the screen cannot see claims nothing either way, so `undefined` reads as on: a write that should have
 * been gated still surfaces `permission.calendarWrite` through the failure path.
 */
export function editingOn(account: Pick<Account, 'grantedScopes'> | undefined): boolean {
  return (
    account === undefined ||
    account.grantedScopes.includes(CALENDAR_EVENTS_SCOPE) ||
    account.grantedScopes.includes(CALENDAR_SCOPE)
  );
}

/**
 * The account behind `accountId` when its grant lacks the write scope; undefined means editing is on.
 * Only a Google, non-demo account can even hold the scope — `calendarAccessOf`'s own exemption — so a
 * Microsoft, IMAP, JMAP, demo or stand-in account is never gated by this check (review7).
 */
export function editingOff(
  accounts: readonly Account[],
  accountId: string | undefined,
): Account | undefined {
  const account = accounts.find(a => a.id === accountId);
  if (account === undefined || account.demo || account.provider !== 'google') return undefined;
  return editingOn(account) ? undefined : account;
}

/** Whether this account may create, change and delete events, as Settings → Calendar's tri-state: 'on' when the grant carries the write scope (`editingOn`, so the umbrella grant counts too), 'off' while it reads only, `null` for accounts with no calendar claim (demo, non-Google). */
export function calendarEditingOf(account: Account): 'on' | 'off' | null {
  if (account.demo || account.provider !== 'google') return null;
  return editingOn(account) ? 'on' : 'off';
}

/** A write was refused for lack of the events scope (`permission.calendarWrite`): the only `missingPermissions` row that asks for editing, and only until the grant lands — never a standing nag and never the 'calendar' (read) gap. */
export function calendarWriteRefused(account: Account): boolean {
  return account.missingPermissions?.some(m => m.capability === 'calendarWrite') === true;
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
