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

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { addTargetSlot, getTarget, subscribeTarget } from './store-target';
import type { TargetSlot } from './store-target';
import type { RefObject } from 'react';
import {
  getSheet,
  hideSheet,
  registerSheetCancel,
  setSheetOpener,
  showSheet,
  subscribeSheet,
} from './store-sheet';
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
import { addKeyLayer, type KeyLayer } from './store-keys';
import { addPaneHeaderPart, getPaneHeaderPart, subscribePaneHeaderPart } from './store-pane';
import type { PaneHeaderPart } from './store-pane';
import { getScope, setScope, subscribeScope } from './store-scope';
import {
  getOpenThread,
  OPEN_THREAD_SCREEN,
  setOpenThread,
  subscribeOpenThread,
} from './store-thread';
import type { ContextName, SettingRoute, TargetSummary } from '../commands';
import type { AccountId, AiProviderId, ThreadId } from '../data';
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

export { registerSheetCancel, setSheetOpener };

// ---------------------------------------------------------------------------
// The command target (gap list U1, A12): what the palette's context line names
// ---------------------------------------------------------------------------

/**
 * Sets the command target while the calling component is mounted and its region has focus:
 * the reader sets its thread ("Drew Bell · October illustrations"), the calendar the open
 * event, Settings the focused account row. The innermost focused setter wins; null clears.
 * Compared by value (kind, id, title, detail), so an inline object never re-renders the shell.
 *
 * `options.region` (additive) is the ref of the element the component draws. Of the setters, the one whose region
 * is the deepest to contain the focused element wins; without a region (or with focus outside every region) the
 * latest-mounted setter wins.
 */
export function useCommandTarget(
  target: TargetSummary | null,
  options?: { readonly region?: RefObject<HTMLElement | null> },
): void {
  const slot = useRef<TargetSlot | null>(null);
  const region = options?.region;
  useEffect(() => {
    slot.current = addTargetSlot(region);
    return () => {
      slot.current?.remove();
      slot.current = null;
    };
  }, [region]);
  const { kind, id, title, detail } = target ?? {};
  useEffect(() => {
    slot.current?.set(
      kind && id !== undefined && title !== undefined ? { kind, id, title, detail } : null,
    );
  }, [region, kind, id, title, detail]);
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
  setToastUndoRunner,
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

// ---------------------------------------------------------------------------
// The shared registry and key layers (additive): one CommandRegistry and one key listener for the app
// ---------------------------------------------------------------------------

export { useRegisterCommands, useShellRegistry } from './ShellRegistry';
export type { CommandHandlerTable, ShellRegistry } from './ShellRegistry';
export type { KeyLayer } from './store-keys';

/**
 * Adds contexts (such as Home's `lowImportance` sheet) and conditions (`remindOffer`) to the key stack while the calling
 * component is mounted, on top of the shell's own (global, the screen, the open sheet). Later layers win a condition.
 * The `sheet` context always stays last. Compared by value, so an inline object is fine.
 */
export function useShellKeyLayer(layer: KeyLayer): void {
  const contexts = (layer.contexts ?? []).join(',');
  const conditions = JSON.stringify(layer.conditions ?? {});
  useEffect(
    () =>
      addKeyLayer({
        contexts: contexts ? (contexts.split(',') as ContextName[]) : [],
        conditions: JSON.parse(conditions) as KeyLayer['conditions'],
      }),
    [contexts, conditions],
  );
}

// ---------------------------------------------------------------------------
// The pane header's screen parts (additive): back and crumb, and the bulk bar
// ---------------------------------------------------------------------------

export type { PaneHeaderPart } from './store-pane';

/** Sets the header's lead, crumb or bulk bar while the calling screen is mounted. Pass a memoised object: it compares by reference. Null clears it. */
export function usePaneHeaderPart(part: PaneHeaderPart | null): void {
  useEffect(() => (part ? addPaneHeaderPart(part) : undefined), [part]);
}

/** The latest mounted screen's header parts, live. */
export function usePaneHeaderParts(): PaneHeaderPart {
  return useSyncExternalStore(subscribePaneHeaderPart, getPaneHeaderPart, getPaneHeaderPart);
}

// ---------------------------------------------------------------------------
// The account scope (additive): what the sidebar's switcher selects
// ---------------------------------------------------------------------------

/** The account the switcher selects; null is All accounts. Counts in the sidebar and screens that scope their data follow it. */
export function useAccountScope(): AccountId | null {
  return useSyncExternalStore(subscribeScope, getScope, getScope);
}

/** Selects one account, or null for All accounts (what the AccountSwitcher's menu calls). */
export function setAccountScope(accountId: AccountId | null): void {
  setScope(accountId);
}

// ---------------------------------------------------------------------------
// The open thread (additive): the reader lane renders it on the `{ label: 'thread' }` screen
// ---------------------------------------------------------------------------

/** Records `id` as the open thread and shows the `{ label: 'thread' }` screen (a placeholder until the reader lane renders it). */
export function openThread(id: ThreadId): void {
  setOpenThread(id);
  setScreen(OPEN_THREAD_SCREEN);
}

/** Clears the open thread; the reader calls it when it closes. Does not navigate. */
export function closeThread(): void {
  setOpenThread(null);
}

/** The open thread's id, live; null when none. */
export function useOpenThread(): ThreadId | null {
  return useSyncExternalStore(subscribeOpenThread, getOpenThread, getOpenThread);
}

/** What Home takes from the shell: the scope's account (undefined for All accounts), and the two openers. */
export interface HomeShellProps {
  readonly accountId: AccountId | undefined;
  readonly onOpen: (id: ThreadId) => void;
  readonly onOneByOne: () => void;
}

const ONE_BY_ONE_SCREEN = { label: 'one by one' } as const;

/** The props Home needs from the shell: `<HomeScreen {...useHomeShellProps()} />`. Stable between scope changes. */
export function useHomeShellProps(): HomeShellProps {
  const scope = useAccountScope();
  return useMemo(
    () => ({
      accountId: scope ?? undefined,
      onOpen: openThread,
      onOneByOne: () => navigate(ONE_BY_ONE_SCREEN),
    }),
    [scope],
  );
}
