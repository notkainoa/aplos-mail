/**
 * The reader's "no blank sheet" double buffer (DESIGN §5 rules 9-10). J/K changes the wanted letter at once, but a
 * body arrives after a latency, so the previous letter stays on paper until the next one reports ready — never an
 * empty sheet. A 12 px loading line shows only after a 1.5 s wait on the same letter, and a body that reports
 * ready late (for a letter no longer wanted) is remembered, so coming back to it is instant. Bodies are held in a
 * small LRU and can be evicted. No React, no DOM, no timers: `now` is milliseconds, passed in.
 */

/** How long a wanted letter may stay unready before the 12 px line shows (the 1.5 s deadline). */
export const LOAD_LINE_MS = 1500;

/** Rows on each side of the cursor whose bodies are worth prefetching. */
export const PREFETCH_RADIUS = 2;

/**
 * The buffer: the letter on paper, the letter asked for, when the ask started, and the bodies held ready.
 * `wantedSince` restarts only when the wanted id changes, so the deadline measures one continuous wait.
 */
export interface LetterState {
  readonly shown: string | null;
  readonly wanted: string | null;
  readonly wantedSince: number | null;
  readonly ready: ReadonlySet<string>;
}

/** What can happen to the buffer; `now` is the event's time in milliseconds. */
export type LetterEvent =
  | {
      readonly type: 'want';
      readonly id: string;
      readonly now: number;
      /** Nothing worth keeping is on paper (no letter yet, or the one there was sent away): the wanted letter replaces it at once. */
      readonly immediate?: boolean;
    }
  | { readonly type: 'ready'; readonly id: string; readonly now: number }
  | { readonly type: 'evict'; readonly id: string };

/** What the reader draws for the buffer at `now`. */
export interface LetterView {
  /** The letter on paper; null only before the very first one. */
  readonly letter: string | null;
  /** The 12 px line: wanted is not on paper and the wait has run the full deadline. */
  readonly loadingLine: boolean;
  /** Nothing was ever shown: the caller waits, then shows the line. */
  readonly blank: boolean;
}

const NO_BODIES: ReadonlySet<string> = new Set();

/** An empty reader: nothing on paper, nothing wanted, nothing held. */
export const EMPTY_BUFFER: LetterState = {
  shown: null,
  wanted: null,
  wantedSince: null,
  ready: NO_BODIES,
};

/**
 * A `want` asks for a letter. One already held shows in the same event, and so does any when `immediate` says the letter
 * on paper is not worth keeping (nothing shown yet, or it was sent away by Done, Later or Trash); any other keeps the
 * letter on paper and waits. The deadline belongs to the wanted id, so asking for the same letter again does not restart the wait.
 */
function want(state: LetterState, id: string, now: number, immediate: boolean): LetterState {
  const wantedSince = state.wanted === id ? state.wantedSince : now;
  const shown = state.ready.has(id) || immediate ? id : state.shown;
  return { ...state, wanted: id, wantedSince, shown };
}

/**
 * A body reports ready. It is remembered even when its letter is no longer wanted — a later `want` of it shows at
 * once — but it goes on paper only while it is wanted.
 */
function markReady(state: LetterState, id: string): LetterState {
  if (state.ready.has(id)) return state;
  const ready = new Set(state.ready);
  ready.add(id);
  return { ...state, ready, shown: state.wanted === id ? id : state.shown };
}

/** Forgets a held body (the LRU dropped it). The letter on paper stays: evicting what is shown is not a blank. */
function evict(state: LetterState, id: string): LetterState {
  if (!state.ready.has(id)) return state;
  const ready = new Set(state.ready);
  ready.delete(id);
  return { ...state, ready };
}

/** One event. Pure: the `ready` set it was given is never mutated. */
export function reduce(state: LetterState, event: LetterEvent): LetterState {
  switch (event.type) {
    case 'want':
      return want(state, event.id, event.now, event.immediate === true);
    case 'ready':
      return markReady(state, event.id);
    case 'evict':
      return evict(state, event.id);
  }
}

/** The paper, the line and the blank flag for the buffer at `now`. */
export function view(state: LetterState, now: number): LetterView {
  const waiting = state.wanted !== state.shown && state.wantedSince !== null;
  const loadingLine = waiting && now - (state.wantedSince ?? now) >= LOAD_LINE_MS;
  return { letter: state.shown, loadingLine, blank: state.shown === null };
}

/**
 * The bodies worth fetching around the cursor (DESIGN §5 rule 9): ids within `radius` rows, nearest first — the
 * row after before the row before at each step, since J outnumbers K. The cursor itself and bodies `ready`
 * already holds are excluded. Empty for an empty list or a cursor off the list.
 */
export function prefetchTargets(
  cursorIds: readonly string[],
  current: string | null,
  radius: number = PREFETCH_RADIUS,
  ready: ReadonlySet<string> = NO_BODIES,
): string[] {
  if (current === null) return [];
  const at = cursorIds.indexOf(current);
  if (at < 0) return [];
  const seen = new Set<string>([current]);
  const targets: string[] = [];
  for (let distance = 1; distance <= radius; distance++) {
    for (const row of [at + distance, at - distance]) {
      const id = cursorIds[row];
      if (id === undefined || seen.has(id) || ready.has(id)) continue;
      seen.add(id);
      targets.push(id);
    }
  }
  return targets;
}
