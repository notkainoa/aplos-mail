/**
 * The toast stack's state (DESIGN 7.13; F9).
 *
 * Rules the store keeps: one operation, one notice (a push with a live id updates that toast in
 * place); the stack holds three; when a fourth arrives the oldest toast that is neither an Undo
 * toast nor `persistent` goes. An Undo toast is never replaced or evicted: a toast is an Undo toast
 * when `undoable` is true or one of its actions runs `app.undo`. A persistent toast (a failure or a
 * pending operation) is never evicted either. If nothing else can go the stack exceeds the cap and
 * `ToastStack` shows the last three. The store runs no timers: the `Toast` component owns the
 * life (plain 4 s, Undo 8 s, `persistent` never), pauses it on hover and focus, fades out and then
 * calls `onDismiss`, which is `dismissToast`. `viewOf` sets `undoable` from `isUndoToast`, so a
 * toast with an `app.undo` action lasts 8 s. Navigation, saves and sync ticks never toast: callers
 * simply do not push for them.
 */
import { createStore } from './store-core';
import type { ToastData } from '../ui/props';
import type { PushedToast } from './index';

/** Most toasts the stack keeps (Undo toasts may exceed it; plain ones never do). */
export const TOAST_LIMIT = 3;
/** How long a plain toast lasts. */
export const PLAIN_TOAST_MS = 4_000;
/** How long an Undo toast lasts. */
export const UNDO_TOAST_MS = 8_000;
/** The command id of the shared Undo (`commands/catalog/global.ts`). */
const UNDO_COMMAND = 'app.undo';

type Patch = Partial<Omit<PushedToast, 'id'>>;

const toastStore = createStore<readonly ToastData[]>([]);
const live = new Map<string, PushedToast>();
let runCommand: ((commandId: string) => unknown) | null = null;

/** True for a toast that must never be silently replaced or evicted. */
export function isUndoToast(toast: ToastData): boolean {
  return toast.undoable || (toast.actions ?? []).some(a => a.commandId === UNDO_COMMAND);
}

/** The view the stack renders: the toast without its callback, with `undoable` true for any Undo toast. */
function viewOf(toast: PushedToast): ToastData {
  const { onAction, ...data } = toast;
  void onAction;
  return { ...data, undoable: isUndoToast(toast) };
}

function publish(): void {
  toastStore.set([...live.values()].map(viewOf));
}

function dismissToastNow(id: string): void {
  if (!live.delete(id)) return;
  publish();
}

function evictable(toast: PushedToast): boolean {
  return !toast.persistent && !isUndoToast(toast);
}

function evictOldest(): void {
  while (live.size > TOAST_LIMIT) {
    const victim = [...live].find(([, toast]) => evictable(toast));
    if (!victim) return;
    live.delete(victim[0]);
  }
}

/** Pushes a toast, or updates the live one with the same id in place; returns the id. A live Undo toast is never replaced by a plain one: the push is refused and the Undo stays. */
export function addToast(toast: PushedToast): string {
  const existing = live.get(toast.id);
  if (existing && isUndoToast(existing) && !isUndoToast(toast)) return toast.id;
  live.set(toast.id, toast);
  evictOldest();
  publish();
  return toast.id;
}

/** Rewords a live toast; a no-op once it has closed. Patching an Undo toast keeps it an Undo toast. */
export function patchToast(id: string, patch: Patch): void {
  const toast = live.get(id);
  if (!toast) return;
  const next: PushedToast = { ...toast, ...patch, id };
  live.set(id, isUndoToast(toast) && !isUndoToast(next) ? { ...next, undoable: true } : next);
  publish();
}

/** Closes a toast; a no-op once it has closed. */
export function removeToast(id: string): void {
  dismissToastNow(id);
}

/** Kept for the frozen surface: the `Toast` component pauses its own clock on hover and focus. */
export function holdToast(id: string): void {
  void id;
}

/** Kept for the frozen surface: see `holdToast`. */
export function releaseToast(id: string): void {
  void id;
}

/** Wires the command registry: `run` receives the action's `commandId` (the shell builds the `CommandContext`). */
export function setToastCommandRunner(runner: ((commandId: string) => unknown) | null): void {
  runCommand = runner;
}

/** True when the registry's result says the command ran. */
function commandRan(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'ran'
  );
}

/** Runs the chosen action. A command action closes the toast only when the registry says the command ran (a refused or failed Undo keeps it); an `onAction` callback closes it after it returns. */
export function runToastAction(id: string, actionId: string): void {
  const toast = live.get(id);
  if (!toast) return;
  const action = toast.actions?.find(a => a.id === actionId);
  if (action?.commandId && runCommand) {
    if (commandRan(runCommand(action.commandId))) dismissToastNow(id);
    return;
  }
  try {
    toast.onAction?.(actionId);
  } finally {
    dismissToastNow(id);
  }
}

/** Drops every toast and the command runner (tests). */
export function resetToasts(): void {
  live.clear();
  runCommand = null;
  publish();
}

/** The live stack now, oldest first. */
export const getToasts = toastStore.get;

/** Subscribes to stack changes (for `useSyncExternalStore`). */
export const subscribeToasts = toastStore.subscribe;
