/**
 * One notice per send (DESIGN 7.6, 7.13): a send's tray is shown by exactly one place. While a composer showing the
 * send is mounted (the inline reply under its thread) it claims the submission; when it goes away during the send (J to
 * the next thread, the compose page closing on Send) it hands the submission to the shell's toast stack, which shows
 * the same tray with placement 'toast'. Coming back to the thread claims it again and the toast goes. A submission is
 * therefore claimed or handed off, never both, so no send ever has two trays.
 */

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
}

const EMPTY: HandoffState = { handedOff: [], claims: new Map() };

/** A composer shows `id`: it leaves the toast stack. */
export function claim(state: HandoffState, id: string): HandoffState {
  const claims = new Map(state.claims);
  claims.set(id, (claims.get(id) ?? 0) + 1);
  return { handedOff: state.handedOff.filter(other => other !== id), claims };
}

/** A composer no longer shows `id`; when it was the last and the send is still live, the toast stack takes it. */
export function release(state: HandoffState, id: string, live: boolean): HandoffState {
  const claims = new Map(state.claims);
  const left = Math.max(0, (claims.get(id) ?? 1) - 1);
  if (left > 0) claims.set(id, left);
  else claims.delete(id);
  const handOff = live && left <= 0 && !state.handedOff.includes(id);
  return { handedOff: handOff ? [...state.handedOff, id] : state.handedOff, claims };
}

/** The send settled (sent, cancelled) or its notice was dealt with: it leaves the toast stack. */
export function settle(state: HandoffState, id: string): HandoffState {
  if (!state.handedOff.includes(id)) return state;
  return { ...state, handedOff: state.handedOff.filter(other => other !== id) };
}

/** The one the toast stack shows: the newest handed-off send. */
export function shownByToast(state: HandoffState): string | null {
  return state.handedOff[state.handedOff.length - 1] ?? null;
}

/** The app's one hand-off store. */
export const handoffStore: HandoffStore = createHandoffStore(EMPTY);

export function claimSend(id: string): void {
  handoffStore.set(claim(handoffStore.get(), id));
}

export function releaseSend(id: string, live: boolean): void {
  handoffStore.set(release(handoffStore.get(), id, live));
}

export function settleSend(id: string): void {
  handoffStore.set(settle(handoffStore.get(), id));
}
