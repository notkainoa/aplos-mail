/**
 * The toast stack's state (DESIGN 7.13; F9).
 *
 * Rules the store keeps: one operation, one notice (a push with a live id updates that toast in
 * place); the stack holds three; when a fourth arrives the oldest toast that is not an Undo toast
 * goes. An Undo toast is never replaced or evicted: a toast is an Undo toast when `undoable` is
 * true or one of its actions runs `app.undo`. With three Undo toasts open a plain newcomer is the
 * oldest non-undo toast, so it is the one dropped; four Undo toasts can all stay (the cap only
 * ever drops plain ones), and `ToastStack` shows the last three. Timers: plain 4 s, Undo 8 s,
 * `persistent` never (a failure or a pending operation says so with `persistent`; ToastKind has no
 * error kind). The fade after the timer is the stack's exit motion, not the store's. Navigation,
 * saves and sync ticks never toast: callers simply do not push for them.
 */
import { realTimers } from '../data/scheduler';
import { createStore } from './store-core';
import type { Timers } from '../data/scheduler';
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

interface Live {
  toast: PushedToast;
  /** Cancels the running auto-dismiss, if any. */
  cancel: (() => void) | null;
  /** Time left while paused by hover or focus; null when running. */
  remaining: number | null;
  /** When the running timer started and how long it was for. */
  startedAt: number;
  duration: number;
}

const toastStore = createStore<readonly ToastData[]>([]);
const live = new Map<string, Live>();
let timers: Timers = realTimers;
let runCommand: ((commandId: string) => unknown) | null = null;

/** True for a toast that must never be silently replaced or evicted. */
export function isUndoToast(toast: ToastData): boolean {
  return toast.undoable || (toast.actions ?? []).some(a => a.commandId === UNDO_COMMAND);
}

function durationOf(toast: ToastData): number | null {
  if (toast.persistent) return null;
  return isUndoToast(toast) ? UNDO_TOAST_MS : PLAIN_TOAST_MS;
}

/** The view the stack renders: the toast without its callback. */
function viewOf(toast: PushedToast): ToastData {
  const { onAction, ...data } = toast;
  void onAction;
  return data;
}

function publish(): void {
  toastStore.set([...live.values()].map(entry => viewOf(entry.toast)));
}

function stop(entry: Live): void {
  entry.cancel?.();
  entry.cancel = null;
}

function start(id: string, entry: Live, ms: number | null): void {
  stop(entry);
  entry.remaining = null;
  if (ms === null) return;
  entry.duration = ms;
  entry.startedAt = timers.now();
  entry.cancel = timers.setTimeout(() => dismissToastNow(id), ms);
}

function dismissToastNow(id: string): void {
  const entry = live.get(id);
  if (!entry) return;
  stop(entry);
  live.delete(id);
  publish();
}

function evictOldestPlain(): void {
  while (live.size > TOAST_LIMIT) {
    const victim = [...live].find(([, entry]) => !isUndoToast(entry.toast));
    if (!victim) return;
    dismissToastNow(victim[0]);
  }
}

/** Pushes a toast, or updates the live one with the same id in place; returns the id. */
export function addToast(toast: PushedToast): string {
  const existing = live.get(toast.id);
  if (existing) {
    replaceToast(toast.id, existing, toast);
    return toast.id;
  }
  const entry: Live = { toast, cancel: null, remaining: null, startedAt: 0, duration: 0 };
  live.set(toast.id, entry);
  start(toast.id, entry, durationOf(toast));
  evictOldestPlain();
  publish();
  return toast.id;
}

function replaceToast(id: string, entry: Live, next: PushedToast): void {
  entry.toast = next;
  start(id, entry, durationOf(next));
  publish();
}

/** Rewords a live toast and restarts its timer; a no-op once it has closed. */
export function patchToast(id: string, patch: Patch): void {
  const entry = live.get(id);
  if (!entry) return;
  replaceToast(id, entry, { ...entry.toast, ...patch, id });
}

/** Closes a toast; a no-op once it has closed. */
export function removeToast(id: string): void {
  dismissToastNow(id);
}

/** Hover or focus: stops the clock and remembers what was left. */
export function holdToast(id: string): void {
  const entry = live.get(id);
  if (!entry?.cancel) return;
  const elapsed = timers.now() - entry.startedAt;
  stop(entry);
  entry.remaining = Math.max(0, entry.duration - elapsed);
}

/** Pointer or focus left: the toast carries on with the time it had left. */
export function releaseToast(id: string): void {
  const entry = live.get(id);
  if (entry?.remaining == null) return;
  start(id, entry, entry.remaining);
}

/** Wires the command registry: `run` receives the action's `commandId` (the shell builds the `CommandContext`). */
export function setToastCommandRunner(runner: ((commandId: string) => unknown) | null): void {
  runCommand = runner;
}

/** Runs the chosen action (its command, else the toast's `onAction`) and then closes the toast. */
export function runToastAction(id: string, actionId: string): void {
  const entry = live.get(id);
  if (!entry) return;
  const action = entry.toast.actions?.find(a => a.id === actionId);
  try {
    if (action?.commandId && runCommand) runCommand(action.commandId);
    else entry.toast.onAction?.(actionId);
  } finally {
    dismissToastNow(id);
  }
}

/** Swaps the timer source and drops every toast (tests drive time by hand). */
export function resetToasts(next: Timers = realTimers): void {
  for (const entry of live.values()) stop(entry);
  live.clear();
  timers = next;
  runCommand = null;
  publish();
}

/** The live stack now, oldest first. */
export const getToasts = toastStore.get;

/** Subscribes to stack changes (for `useSyncExternalStore`). */
export const subscribeToasts = toastStore.subscribe;
