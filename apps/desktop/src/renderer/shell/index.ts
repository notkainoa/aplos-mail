/**
 * The shell surface other lanes call (F9, frozen on day 3; DESIGN 6, 7.1, 7.9; plan 30 4.2, 4.5).
 *
 * Lane `ui-shell` implements them on module-level stores (`store-*.ts`); React reads them with
 * `useSyncExternalStore`. After the freeze, changes are additive only.
 *
 * What lives here: the sheet host (one reconnect or consent sheet at a time, opened from the
 * status slot, Settings or Ask), the command target screens set for the palette's context
 * line, and the route opener the palette uses for Settings deep links. Data reads and writes
 * stay in `renderer/data`; keys and the palette's entries stay in `renderer/commands`.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { addTargetSlot, getTarget, subscribeTarget } from './store-target';
import type { TargetSlot } from './store-target';
import { getSheet, hideSheet, registerSheetCancel, showSheet, subscribeSheet } from './store-sheet';
import { addToast, getToasts, patchToast, removeToast, subscribeToasts } from './store-toast';
import {
  getRoute,
  getScreen,
  setRoute,
  setScreen,
  subscribeRoute,
  subscribeScreen,
} from './store-route';
import type { Screen } from './store-route';
import type { RouteTarget } from './store-route';
import type { SettingRoute, TargetSummary } from '../commands';
import type { AccountId, AiProviderId } from '../data';
import type { ToastData } from '../ui/props';

// ---------------------------------------------------------------------------
// Lane marker and the not-implemented error (kept for the frozen surface; nothing throws it now)
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

// ---------------------------------------------------------------------------
// The sheet host (gap list U5, S16): ui-onboard builds the sheets, the shell hosts them
// ---------------------------------------------------------------------------

/** Arguments for each sheet the shell can host. */
export interface SheetArgs {
  /**
   * The weekly Gmail reconnect (DESIGN 7.1, ReconnectSheet): 'reconnect' for `needsReauth`
   * and `health.reconnectBy` within 24 hours, 'grant' for `needsPermission`. The sheet calls
   * `api.account.reconnect` ('reconnect') or `api.account.grantPermissions` ('grant') and
   * follows that flow's `connect` frames by `connectId` (the frame's `mode` is
   * `reconnect` or `grantPermissions`); the shell passes `mode` on as
   * `ReconnectSheetProps.mode` for the copy.
   */
  reconnect: { readonly accountId: AccountId; readonly mode: 'reconnect' | 'grant' };
  /**
   * The AI consent card as a sheet (plan 30 4.5 #1: Settings → AI "Review" after a provider
   * change, or `Consent.needsReconsent`). Provider and model default to the Summaries choice in
   * `Settings.ai.features`; Allow sends `api.consent.grant` with `Consent.currentVersion`.
   */
  consent: { readonly provider?: AiProviderId; readonly model?: string };
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
 * replaces it, cancelling the first (a waiting reconnect's `api.account.cancelConnect`). While it is open
 * the shell adds the modal `sheet` context to the key stack, so Esc runs `sheet.cancel` and
 * nothing behind it answers. Focus returns to the opener when it closes.
 */
export function openSheet<K extends SheetName>(name: K, ...args: SheetArgsParam<K>): void {
  showSheet({ name, args: args[0] ?? {} } as OpenSheet);
}

/** Closes the open sheet (Cancel, Esc, or the flow finished: "Reconnected" toast); a no-op when none is open. */
export function closeSheet(): void {
  hideSheet();
}

/** The open sheet, live; null when none. The shell's sheet slot renders ui-onboard's sheet for it. */
export function useSheet(): OpenSheet | null {
  return useSyncExternalStore(subscribeSheet, getSheet, getSheet);
}

/** True while a sheet is open: the shell adds the modal `sheet` context to its key stack (`buildStack`) then. Additive. */
export function useSheetContextActive(): boolean {
  return useSheet() !== null;
}

export { registerSheetCancel };

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
  const slot = useRef<TargetSlot | null>(null);
  useEffect(() => {
    slot.current = addTargetSlot();
    return () => {
      slot.current?.remove();
      slot.current = null;
    };
  }, []);
  const { kind, id, title, detail } = target ?? {};
  useEffect(() => {
    slot.current?.set(
      kind && id !== undefined && title !== undefined ? { kind, id, title, detail } : null,
    );
  }, [kind, id, title, detail]);
}

/** The current command target, live; the shell puts it in every `CommandContext` and the palette's context line (`contextLine`). */
export function useCurrentTarget(): TargetSummary | null {
  return useSyncExternalStore(subscribeTarget, getTarget, getTarget);
}

// ---------------------------------------------------------------------------
// Toasts (DESIGN 7.13): the shell mounts the one ToastStack; screens push data
// ---------------------------------------------------------------------------

/** A toast a screen or command handler pushes. A chosen action runs its `commandId` through the registry; `onAction` covers actions with no command. */
export interface PushedToast extends ToastData {
  /** Called when an action without a `commandId` is chosen (rare; prefer a command so keys, palette and toast agree). */
  onAction?: (actionId: string) => void;
}

/** Pushes a toast onto the shell's stack and returns its id. One operation, one notice: use the operation's opId as the id. Undo toasts are never silently replaced; the stack shows three. Navigation, saves and sync ticks never toast. */
export function pushToast(toast: PushedToast): string {
  return addToast(toast);
}

/** Rewords a toast in place as its operation moves on ("Archiving…" → "Done · Undo Z", DESIGN 7.13); a no-op when it has already closed. */
export function updateToast(id: string, patch: Partial<Omit<PushedToast, 'id'>>): void {
  patchToast(id, patch);
}

/** Closes a toast early (its operation failed and an inline error took over, or Undo ran). */
export function dismissToast(id: string): void {
  removeToast(id);
}

/** The live stack, newest last, for the shell's own ToastStack. Screens don't render toasts themselves. */
export function useToasts(): readonly ToastData[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}

export {
  holdToast,
  isUndoToast,
  PLAIN_TOAST_MS,
  releaseToast,
  runToastAction,
  setToastCommandRunner,
  TOAST_LIMIT,
  UNDO_TOAST_MS,
} from './store-toast';

// ---------------------------------------------------------------------------
// Routes (gap list U3, S15): Settings deep links from the palette and from Ask
// ---------------------------------------------------------------------------

/** A route the shell can open; today only Settings deep links are frozen ("settings/mail#undoSeconds"). */
export type ShellRoute = SettingRoute;

/** Opens a route: for a setting entry's route, Settings on that section with the row scrolled into view and its control focused. The palette calls it for a `navigate` run result; Ask's "Use another provider" for `settings/ai`. */
export function openRoute(route: ShellRoute): void {
  setRoute(route);
}

/** The pending Settings deep link, live; null when none. Settings opens the section, scrolls the row in, focuses its control, then calls `consumeRoute(seq)`. Additive. */
export function useSettingsTarget(): RouteTarget | null {
  return useSyncExternalStore(subscribeRoute, getRoute, getRoute);
}

/** The pending route, live (same value as `useSettingsTarget`). Additive. */
export function useRoute(): RouteTarget | null {
  return useSettingsTarget();
}

/** The shell's current screen, live (default 'home'). Additive. */
export function useAppRoute(): Screen {
  return useSyncExternalStore(subscribeScreen, getScreen, getScreen);
}

/** Shows a screen. Additive. */
export function navigate(screen: Screen): void {
  setScreen(screen);
}

export { consumeRoute } from './store-route';
export type { RouteTarget, Screen } from './store-route';
