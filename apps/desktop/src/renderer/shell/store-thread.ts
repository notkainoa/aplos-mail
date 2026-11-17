/**
 * The thread the reader shows. `openThread` records its id (and, optionally, where it was opened from and the ids of the
 * list it was opened in) and the shell navigates to the thread screen; the reader reads them with `useOpenThread` and
 * `useOpenThreadContext`. Closing the thread goes back to the screen it was opened from.
 */
import { createStore } from './store-core';
import { getScreen, setScreen } from './store-route';
import { armReturn, followReturnCursor } from './store-return';
import type { Screen } from './store-route';
import type { ThreadId } from '../data';

const threadStore = createStore<ThreadId | null>(null);

export const OPEN_THREAD_SCREEN = { label: 'thread' } as const;

/** Where the open thread came from and the list it was opened in, for Esc and for J and K. */
export interface OpenThreadContext {
  readonly from: Screen | null;
  readonly listIds: readonly string[] | null;
}

/** How a thread asks to open straight into a reply (R, ⇧R, hold R, or the Follow up nudge on Space). */
export interface ThreadReply {
  readonly replyAll: boolean;
  readonly dictate: boolean;
  /** The Follow up nudge: the reply card starts with the dim nudge text. */
  readonly nudge: boolean;
  /** An Undo send put this draft back: the card opens on it, whatever the drafts window already holds. */
  readonly draftId?: string;
}

/** What a caller may say when it opens a thread. */
export interface OpenThreadOptions {
  readonly from?: Screen;
  readonly listIds?: readonly string[];
  /** Open the reader with its reply card already up (a triage key on Home or one by one). */
  readonly reply?: ThreadReply;
}

const NO_CONTEXT: OpenThreadContext = { from: null, listIds: null };
const contextStore = createStore<OpenThreadContext>(NO_CONTEXT);

/** The reply a thread was opened for; the reader takes it once the letter shows (`clearPendingReply`). */
export interface PendingReply {
  readonly id: ThreadId;
  readonly reply: ThreadReply;
}

const replyStore = createStore<PendingReply | null>(null);

function pendingFor(id: ThreadId | null, options: unknown): PendingReply | null {
  if (id === null || typeof options !== 'object' || options === null) return null;
  const { reply } = options as OpenThreadOptions;
  return reply ? { id, reply } : null;
}

function onThreadScreen(): boolean {
  const screen = getScreen();
  return typeof screen !== 'string' && screen.label === OPEN_THREAD_SCREEN.label;
}

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameScreen(a: Screen | null, b: Screen | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.label === b.label;
}

function contextFor(options: unknown, previous: OpenThreadContext): OpenThreadContext {
  // Opened again from the reader itself (J, K, the next thread after Done): the place and the list carry on.
  const kept = onThreadScreen() ? previous : NO_CONTEXT;
  if (typeof options !== 'object' || options === null) return kept;
  const { from, listIds } = options as OpenThreadOptions;
  return { from: from ?? kept.from, listIds: listIds ? [...listIds] : kept.listIds };
}

function publishContext(next: OpenThreadContext): void {
  const now = contextStore.get();
  if (sameScreen(now.from, next.from) && sameIds(now.listIds, next.listIds)) return;
  contextStore.set(next);
}

/** Records the open thread (null clears it). `options` is optional and is read only when it is an object. */
export function setOpenThread(id: ThreadId | null, options?: OpenThreadOptions): void {
  if (id === null) publishContext(NO_CONTEXT);
  else publishContext(contextFor(options, contextStore.get()));
  replyStore.set(pendingFor(id, options));
  threadStore.set(id);
}

/**
 * Leaves the thread screen for the screen the thread was opened from (Home when none was recorded), or for `to` when the
 * caller names one, and clears the thread. The return is armed for the screen actually shown, so its saved places survive.
 */
export function leaveOpenThread(to?: Screen): void {
  const from = to ?? contextStore.get().from ?? 'home';
  const wasOpen = onThreadScreen();
  const current = threadStore.get();
  setOpenThread(null);
  // A named screen is shown even when the thread screen is not (the old close-then-navigate did).
  if (!wasOpen && to === undefined) return;
  // The place comes back as it was left, on the thread last read (the one opened, or where J and K got to).
  followReturnCursor(current);
  armReturn(from);
  setScreen(from);
}

/** The reader took the reply it was asked to open (or the thread changed). */
export function clearPendingReply(): void {
  replyStore.set(null);
}

export const getPendingReply = replyStore.get;
export const subscribePendingReply = replyStore.subscribe;
export const getOpenThread = threadStore.get;
export const subscribeOpenThread = threadStore.subscribe;
export const getOpenThreadContext = contextStore.get;
export const subscribeOpenThreadContext = contextStore.subscribe;
