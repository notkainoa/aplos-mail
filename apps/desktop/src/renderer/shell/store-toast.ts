/**
 * The toast stack's state (DESIGN 7.13; F9).
 *
 * Rules the store keeps: one operation, one notice (a push with a live id updates that toast in
 * place); triage feedback is one slot (a new Done, Later or Trash toast replaces the previous triage toast, whose
 * operation stays on the undo stack, so Z still undoes it);
 * the stack holds three; when a fourth arrives the oldest toast that is neither an Undo
 * toast, an `error` toast nor `persistent` goes. An Undo toast is never replaced or evicted: a toast is an Undo toast
 * when `undoable` is true or one of its actions runs `app.undo`. A persistent toast (a held send or a
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

/** Most toasts the stack keeps (Undo, error and persistent toasts may exceed it; plain ones never do). */
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
let undoOperation: ((opId: string) => boolean) | null = null;
let undoRefusal: ((opId: string, error: unknown) => void) | null = null;

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

/** A mail triage toast (Done, Later, Trash) with an Undo: the toasts that share the one triage slot. */
export function isTriageToast(toast: ToastData): boolean {
  return toast.slot === 'triage' && isUndoToast(toast);
}

function evictable(toast: PushedToast): boolean {
  return !toast.persistent && toast.kind !== 'error' && !isUndoToast(toast);
}

/** Makes room for the toast just pushed (`keep`): it is never the one that goes, as in `planToasts`. */
function evictOldest(keep: string): void {
  while (live.size > TOAST_LIMIT) {
    const victim = [...live].find(([id, toast]) => id !== keep && evictable(toast));
    if (!victim) return;
    live.delete(victim[0]);
  }
}

/** The new triage toast takes the slot: earlier ones go; their operations stay on the undo stack. */
function dropOtherTriage(keep: string): void {
  for (const [id, toast] of [...live]) {
    if (id !== keep && isTriageToast(viewOf(toast))) live.delete(id);
  }
}

/** Pushes a toast, or updates the live one with the same id in place; returns the id. A live Undo toast is never replaced by a plain one: the push is refused and the Undo stays. */
export function addToast(toast: PushedToast): string {
  const existing = live.get(toast.id);
  if (existing && isUndoToast(existing) && !isUndoToast(toast)) return toast.id;
  if (isTriageToast(viewOf(toast))) dropOtherTriage(toast.id);
  live.set(toast.id, toast);
  evictOldest(toast.id);
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

/** Wires the targeted undo: `undo(opId)` undoes that one operation and returns true when it was accepted. A toast's id is its operation's id. */
export function setToastUndoRunner(runner: ((opId: string) => boolean) | null): void {
  undoOperation = runner;
}

/** Wires the surface a refused toast Undo reports to (a lane registers; nothing registered means a refusal stays silent, as before). */
export function setToastUndoRefusal(
  refusal: ((opId: string, error: unknown) => void) | null,
): void {
  undoRefusal = refusal;
}

/** Hands a refused toast Undo to the registered lane; KeysProviders' undo runner calls it. */
export function toastUndoRefused(opId: string, error: unknown): void {
  undoRefusal?.(opId, error);
}

/** True when the registry's result says the command ran. */
function commandRan(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'ran'
  );
}

/** Runs the chosen action. An Undo action with no callback of its own undoes this toast's operation (never the newest change, which is Z's), and the toast closes only when that undo was accepted. A command action closes the toast only when the registry says the command ran (a refused or failed Undo keeps it); an `onAction` callback closes it after it returns. */
export function runToastAction(id: string, actionId: string): void {
  const toast = live.get(id);
  if (!toast) return;
  const action = toast.actions?.find(a => a.id === actionId);
  if (action?.commandId === UNDO_COMMAND && !toast.onAction && undoOperation) {
    if (undoOperation(id)) dismissToastNow(id);
    return;
  }
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
  undoOperation = null;
  undoRefusal = null;
  publish();
}

/** The live stack now, oldest first. */
export const getToasts = toastStore.get;

/** Subscribes to stack changes (for `useSyncExternalStore`). */
export const subscribeToasts = toastStore.subscribe;
