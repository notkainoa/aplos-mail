/**
 * The shell surface other lanes call (F9, frozen on day 3; DESIGN 6, 7.1, 7.9; plan 30 4.2, 4.5).
 *
 * Signatures only. Lane `ui-shell` implements them on days 4-11; until then every function
 * throws `NotImplementedError` naming that lane. After the freeze, changes are additive only.
 *
 * What lives here: the sheet host (one reconnect or consent sheet at a time, opened from the
 * status slot, Settings or Ask), the command target screens set for the palette's context
 * line, and the route opener the palette uses for Settings deep links. Data reads and writes
 * stay in `renderer/data`; keys and the palette's entries stay in `renderer/commands`.
 */

import type { SettingRoute, TargetSummary } from '../commands';
import type { AccountId } from '../data';

// ---------------------------------------------------------------------------
// Lane marker and the not-implemented error
// ---------------------------------------------------------------------------

/** The lane that implements this surface (roadmap 2.3). */
export const SHELL_LANE = 'ui-shell' as const;

/** Thrown by every stub until `ui-shell` builds the shell; names the member and the lane. */
export class NotImplementedError extends Error {
  /** Stable code for tests and logs. */
  readonly code = 'NOT_IMPLEMENTED' as const;
  /** Owning lane, always `ui-shell`. */
  readonly lane = SHELL_LANE;
  /** The member that was called, for example `openSheet`. */
  readonly member: string;

  constructor(member: string) {
    super(
      `renderer/shell: ${member} is not implemented yet. Lane ${SHELL_LANE} builds it on days 4-11.`,
    );
    this.name = 'NotImplementedError';
    this.member = member;
  }
}

function notImplemented(member: string): never {
  throw new NotImplementedError(member);
}

// ---------------------------------------------------------------------------
// The sheet host (gap list U5, S16): ui-onboard builds the sheets, the shell hosts them
// ---------------------------------------------------------------------------

/** Arguments for each sheet the shell can host. */
export interface SheetArgs {
  /**
   * The weekly Gmail reconnect (DESIGN 7.1, ReconnectSheet): 'reconnect' for `needsReauth`
   * and `reconnectBy` within 24 hours, 'grant' for `needsPermission`. Either way the sheet
   * calls `api.account.reconnect` and follows its `connect` frames (where 'grant' is F1's
   * `grantPermissions`); the shell passes `mode` on as `ReconnectSheetProps.mode` for the copy.
   */
  reconnect: { readonly accountId: AccountId; readonly mode: 'reconnect' | 'grant' };
  /**
   * The AI consent card as a sheet (plan 30 4.5 #1: Settings → AI "Review" after a provider
   * change). Provider and model default to the Summaries choice in `Settings.ai.features`.
   */
  consent: { readonly providerId?: string; readonly model?: string };
}

/** A sheet name. */
export type SheetName = keyof SheetArgs;

/** The open sheet with its arguments. */
export type OpenSheet = {
  [K in SheetName]: { readonly name: K; readonly args: SheetArgs[K] };
}[SheetName];

/** `openSheet`'s argument list: optional when every argument of that sheet is optional ('consent'), required otherwise ('reconnect'). */
export type SheetArgsParam<K extends SheetName> =
  Record<string, never> extends SheetArgs[K] ? [args?: SheetArgs[K]] : [args: SheetArgs[K]];

/**
 * Opens a sheet over the current window (`--elev-dialog`, `settle`). One sheet at a time:
 * opening the sheet that is already open with equal arguments keeps it; any other sheet
 * replaces it, cancelling the first (a reconnect's `AccountFlow.cancel()`). While it is open
 * the shell adds the modal `sheet` context to the key stack, so Esc runs `sheet.cancel` and
 * nothing behind it answers. Focus returns to the opener when it closes.
 */
export function openSheet<K extends SheetName>(name: K, ...args: SheetArgsParam<K>): void {
  void name;
  void args;
  notImplemented('openSheet');
}

/** Closes the open sheet (Cancel, Esc, or the flow finished: "Reconnected" toast); a no-op when none is open. */
export function closeSheet(): void {
  notImplemented('closeSheet');
}

/** The open sheet, live; null when none. The shell's sheet slot renders ui-onboard's sheet for it. */
export function useSheet(): OpenSheet | null {
  return notImplemented('useSheet');
}

// ---------------------------------------------------------------------------
// The command target (gap list U1, A12): what the palette's context line names
// ---------------------------------------------------------------------------

/**
 * Sets the command target while the calling component is mounted and its region has focus:
 * the reader sets its thread ("Drew Bell · October illustrations"), the calendar the open
 * event, Settings the focused account row. The innermost focused setter wins; null clears.
 * Compared by value (kind, id, title, detail), so an inline object never re-renders the shell.
 */
export function useCommandTarget(target: TargetSummary | null): void {
  void target;
  notImplemented('useCommandTarget');
}

/** The current command target, live; the shell puts it in every `CommandContext` and the palette's context line (`contextLine`). */
export function useCurrentTarget(): TargetSummary | null {
  return notImplemented('useCurrentTarget');
}

// ---------------------------------------------------------------------------
// Routes (gap list U3, S15): Settings deep links from the palette and from Ask
// ---------------------------------------------------------------------------

/** A route the shell can open; today only Settings deep links are frozen ("settings/mail#undoSeconds"). */
export type ShellRoute = SettingRoute;

/** Opens a route: for a setting entry's route, Settings on that section with the row scrolled into view and its control focused. The palette calls it for a `navigate` run result; Ask's "Use another provider" for `settings/ai`. */
export function openRoute(route: ShellRoute): void {
  void route;
  notImplemented('openRoute');
}
