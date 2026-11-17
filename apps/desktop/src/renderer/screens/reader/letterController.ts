/**
 * The no-blank-sheet double buffer as a small store (DESIGN 5 rule 10). It owns a `letterBuffer` state, feeds it the
 * reader's `want` and `ready` events, and a timer that turns the 12 px loading line on once the wanted letter has been
 * awaited for 1.5 s. The previous letter stays on paper until the new one reports ready. A plain store so React reads
 * it with `useSyncExternalStore` and a test drives it with manual timers.
 */
import type { Timers } from '../../data/scheduler';
import {
  EMPTY_BUFFER,
  LOAD_LINE_MS,
  reduce,
  view,
  type LetterEvent,
  type LetterState,
} from './model/letterBuffer';
import { staleReady } from './readerModel';

/** What the reader draws. Referentially stable between changes. */
export interface LetterSnapshot {
  /** The letter on paper; null only before the very first one. */
  readonly letter: string | null;
  /** The 12 px line is showing. */
  readonly loadingLine: boolean;
  /** The ready letters held (never more than the letter on paper and the one asked for). */
  readonly held: readonly string[];
}

/** The store. */
export interface LetterController {
  /** Asks for a letter. Idempotent for the letter already asked for. */
  want(id: string | null, immediate?: boolean): void;
  /** A letter's body is laid out and measured. */
  ready(id: string): void;
  subscribe(listener: () => void): () => void;
  snapshot(): LetterSnapshot;
}

function snapshotOf(state: LetterState, now: number): LetterSnapshot {
  const shown = view(state, now);
  return {
    letter: shown.letter,
    loadingLine: shown.loadingLine,
    held: [...state.ready],
  };
}

function sameSnapshot(a: LetterSnapshot, b: LetterSnapshot): boolean {
  return (
    a.letter === b.letter &&
    a.loadingLine === b.loadingLine &&
    a.held.length === b.held.length &&
    a.held.every((id, at) => id === b.held[at])
  );
}

/**
 * Drops every held letter that is neither on paper nor asked for. A letter is mounted only while it is one of those two,
 * so a held one that is neither is unmounted and would come back as a fresh mount with no body. Two events do it: a
 * `want`, and a `ready` that put a new letter on paper (the one it replaced just unmounted). Any other `ready` must not:
 * a child reports ready before its parent has asked for it (effects run child first), and that early report has to
 * survive until the ask arrives.
 */
function evictStale(state: LetterState): LetterState {
  return staleReady(state).reduce((s, id) => reduce(s, { type: 'evict', id }), state);
}

export function createLetterController(timers: Timers): LetterController {
  let state: LetterState = EMPTY_BUFFER;
  let current = snapshotOf(state, timers.now());
  let cancelLine: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    const next = snapshotOf(state, timers.now());
    if (sameSnapshot(current, next)) return;
    current = next;
    listeners.forEach(listener => listener());
  };

  const armLine = () => {
    cancelLine?.();
    cancelLine = null;
    const waiting = state.wanted !== state.shown && state.wantedSince !== null;
    if (!waiting) return;
    const left = LOAD_LINE_MS - (timers.now() - (state.wantedSince ?? 0));
    if (left <= 0) return;
    cancelLine = timers.setTimeout(publish, left);
  };

  const apply = (event: LetterEvent) => {
    const next = reduce(state, event);
    if (next === state) return;
    const paperChanged = next.shown !== state.shown;
    state = next;
    if (event.type === 'want' || (event.type === 'ready' && paperChanged))
      state = evictStale(state);
    armLine();
    publish();
  };

  return {
    want: (id, immediate = false) => {
      if (id !== null) apply({ type: 'want', id, now: timers.now(), immediate });
    },
    ready: id => apply({ type: 'ready', id, now: timers.now() }),
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
  };
}
