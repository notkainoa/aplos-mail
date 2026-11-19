/**
 * The sheet host's state (F9; DESIGN 7.1): the one open sheet, the hooks that cancel a replaced
 * sheet, and the focus return to whoever opened it. `index.ts` wraps these with the typed API.
 *
 * The key stack: `renderer/commands` has no helper that pushes the modal `sheet` context (it only
 * defines the context and the `sheet.default` / `sheet.cancel` keys), so the shell reads
 * `useSheetContextActive()` and adds 'sheet' to the stack it passes to `buildStack`.
 */
import { createStore, deepEqual } from './store-core';
import type { OpenSheet } from './index';

const sheetStore = createStore<OpenSheet | null>(null);
const cancelHooks = new Set<(replaced: OpenSheet) => void>();

/** The element to refocus on close: the one focused when the first sheet opened. */
type Opener = { focus(): void; isConnected?: boolean } | null;
let opener: Opener = null;

/** Set by `setSheetOpener` for the next sheet that opens from nothing; consumed there. */
let pendingOpener: Opener = null;

/** Names the element to refocus when the sheet about to open closes (use when the focused element is about to unmount, like a menu item). The next `showSheet` from no sheet takes it; null clears. */
export function setSheetOpener(element: Opener): void {
  pendingOpener = element;
}

function focusedElement(): Opener {
  if (typeof document === 'undefined') return null;
  const active: unknown = document.activeElement;
  if (typeof active !== 'object' || active === null) return null;
  if (active === document.body) return null;
  return typeof (active as { focus?: unknown }).focus === 'function'
    ? (active as NonNullable<Opener>)
    : null;
}

/** Where focus goes when the opener has unmounted: the account switcher's trigger, else the main pane. */
function fallbackFocus(): Opener {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  const switcher = document.querySelector<HTMLElement>('.ui-account-switcher');
  if (switcher) return switcher;
  const pane = document.querySelector<HTMLElement>('.ui-pane[data-kind="main"]');
  if (pane && !pane.hasAttribute('tabindex')) pane.setAttribute('tabindex', '-1');
  return pane;
}

function restoreFocus(): void {
  const target = opener;
  opener = null;
  if (target && target.isConnected !== false) target.focus();
  else fallbackFocus()?.focus();
}

/** The error's `name` (or its wire `type`): enough to see what failed, nothing a provider or a message could carry. */
function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name;
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : typeof error;
}

function runCancelHooks(replaced: OpenSheet): void {
  for (const hook of [...cancelHooks]) {
    try {
      hook(replaced);
    } catch (error) {
      // A failing cancel must not leave the old sheet open over the new one.
      console.error(`sheet ${replaced.name} cancel hook failed (${errorKind(error)})`);
    }
  }
}

/** Registers a hook called with a sheet that another sheet replaced (not on `closeSheet`). Returns an unregister. */
export function registerSheetCancel(hook: (replaced: OpenSheet) => void): () => void {
  cancelHooks.add(hook);
  return () => {
    cancelHooks.delete(hook);
  };
}

/** Shows `next`: the same sheet with equal arguments stays; any other replaces (and cancels) the open one. */
export function showSheet(next: OpenSheet): void {
  const current = sheetStore.get();
  if (current && current.name === next.name && deepEqual(current.args, next.args)) return;
  if (!current) opener = pendingOpener ?? focusedElement();
  pendingOpener = null;
  sheetStore.set(next);
  if (current) runCancelHooks(current);
}

/** Hides the open sheet and returns focus to the opener; a no-op when none is open. */
export function hideSheet(): void {
  if (!sheetStore.get()) return;
  sheetStore.set(null);
  restoreFocus();
}

/** The open sheet now. */
export const getSheet = sheetStore.get;

/** Subscribes to sheet changes (for `useSyncExternalStore`). */
export const subscribeSheet = sheetStore.subscribe;
