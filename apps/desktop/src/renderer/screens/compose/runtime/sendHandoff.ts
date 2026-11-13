/**
 * One notice per send (DESIGN 7.6, 7.13): a send's tray is shown by exactly one place. While a composer showing the
 * send is mounted (the inline reply under its thread) it claims the submission; when it goes away during the send (J to
 * the next thread, the compose page closing on Send) it hands the submission to the shell's toast stack, which shows
 * the same tray with placement 'toast'. Coming back to the thread claims it again and the toast goes. A submission is
 * therefore claimed or handed off, never both, so no send ever has two trays. Every handed-off send is followed until it
 * is over, however many there are: a fourth send inside thirty seconds never costs the first one its Undo.
 */
import type { Submission } from '../../../data';
import { dismissToast, removeOutboxNotice } from '../../../shell';

/** A value with subscribers, for `useSyncExternalStore`. */
export interface HandoffStore {
  get(): HandoffState;
  set(next: HandoffState): void;
  subscribe(listener: () => void): () => void;
}

function createHandoffStore(initial: HandoffState): HandoffStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface HandoffState {
  /** Submissions the toast stack shows, oldest first. */
  readonly handedOff: readonly string[];
  /** Submissions a mounted composer shows, with how many composers claim each. */
  readonly claims: ReadonlyMap<string, number>;
  /** The newest row the composer had when it handed a send off: shown until the live row is read. */
  readonly rows: ReadonlyMap<string, Submission>;
}

const EMPTY: HandoffState = { handedOff: [], claims: new Map(), rows: new Map() };

function without(
  rows: ReadonlyMap<string, Submission>,
  id: string,
): ReadonlyMap<string, Submission> {
  if (!rows.has(id)) return rows;
  const next = new Map(rows);
  next.delete(id);
  return next;
}

/** A composer shows `id`: it leaves the toast stack. */
export function claim(state: HandoffState, id: string): HandoffState {
  const claims = new Map(state.claims);
  claims.set(id, (claims.get(id) ?? 0) + 1);
  const handedOff = state.handedOff.filter(other => other !== id);
  return { handedOff, claims, rows: without(state.rows, id) };
}

/** A composer no longer shows `id`; when it was the last and the send is still live, the toast stack takes it. */
export function release(
  state: HandoffState,
  id: string,
  live: boolean,
  row?: Submission | null,
): HandoffState {
  const claims = new Map(state.claims);
  const left = Math.max(0, (claims.get(id) ?? 1) - 1);
  if (left > 0) claims.set(id, left);
  else claims.delete(id);
  const handOff = live && left <= 0 && !state.handedOff.includes(id);
  if (!handOff) return { ...state, claims };
  const rows = row ? new Map(state.rows).set(id, row) : state.rows;
  return { handedOff: [...state.handedOff, id], claims, rows };
}

/** The send settled (sent, cancelled) or its notice was dealt with: it leaves the toast stack. */
export function settle(state: HandoffState, id: string): HandoffState {
  if (!state.handedOff.includes(id)) return state;
  const handedOff = state.handedOff.filter(other => other !== id);
  return { ...state, handedOff, rows: without(state.rows, id) };
}

/** The newest handed-off send (its tray is the toast stack's UndoTray). */
export function shownByToast(state: HandoffState): string | null {
  return state.handedOff[state.handedOff.length - 1] ?? null;
}

/**
 * How many handed-off sends have a live row subscription at once (the oldest, which leave first). The rest show the
 * row they were handed off with (its countdown runs on the clock, its Undo works by id) until a slot frees.
 */
export const LIVE_ROW_SLOTS = 6;

/**
 * The handed-off sends the toast stack follows: every one, oldest first, newest last. A later send never silently
 * replaces or drops an earlier one's Undo (DESIGN 7.13); the stack shows three and keeps every Undo toast.
 */
export function watchedByToast(state: HandoffState): readonly string[] {
  return state.handedOff;
}

/** Each followed send with its row: the live one for the first `LIVE_ROW_SLOTS`, else the row it was handed off with. */
export function watchedSends(
  state: HandoffState,
  live: readonly (Submission | undefined)[],
): readonly { readonly id: string; readonly row: Submission | undefined }[] {
  return watchedByToast(state).map((id, index) => ({
    id,
    row: (index < LIVE_ROW_SLOTS ? live[index] : undefined) ?? state.rows.get(id),
  }));
}

/** The app's one hand-off store. */
export const handoffStore: HandoffStore = createHandoffStore(EMPTY);

export function claimSend(id: string): void {
  handoffStore.set(claim(handoffStore.get(), id));
}

/** The id a refused send's toast and sidebar notice share (`sendNotices.ts`). */
export function refusedNoticeId(draftId: string): string {
  return `send-refused-${draftId}`;
}

/** A send for this draft was accepted, so an earlier "Couldn’t send" about it is no longer true. */
function clearRefusal(draftId: string): void {
  dismissToast(refusedNoticeId(draftId));
  removeOutboxNotice(refusedNoticeId(draftId));
}

export function releaseSend(id: string, live: boolean, row?: Submission | null): void {
  if (row) clearRefusal(row.draftId);
  handoffStore.set(release(handoffStore.get(), id, live, row));
}

export function settleSend(id: string): void {
  handoffStore.set(settle(handoffStore.get(), id));
}
