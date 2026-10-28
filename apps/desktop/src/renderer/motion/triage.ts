// One triage key, drawn (DESIGN 4.9). Call it from the command handler right
// after the store commit and focus move, in the same keydown: it classifies the
// key (rapid, burst), extends the hold, and flies or carries a ghost of the
// leaving element with the commit chip and edge drawn on the ghost. When the
// hold releases, the rows below close. While a hold lasts (keys or a resting
// pointer), every other change to the list's rows, such as an undo, must go
// through relayout() so the rows stay where they were drawn.
//
// With a cursor layer it also owns the cursor's drawn y: every focus change
// (commit's `focus`, or focus() for J/K and undo) puts the cursor on the row's
// drawn top, its layout top plus its hold pin, so during a hold the cursor
// walks down with the pinned rows instead of sitting over the gap. When the
// hold releases the cursor glides on close's duration and curve, landing with
// its row.
import type { Id } from '../data';
import type { HoldGate } from '../data/holds';
import { motionMs, motions, type MotionContext } from '../ui/generated/motion';
import type { CommitKind } from '../ui/props';
import { play, type Playing } from './animate';
import type { CursorCause, CursorLayer } from './cursor';
import type { Closer } from './flip';
import type { Ghost, GhostExtra, GhostLayer } from './ghost';
import type { RapidTracker } from './rapid';
import type { Scheduler } from './scheduler';
import {
  commitChipPlan,
  commitEdgePlan,
  dealPlan,
  departurePlan,
  type Surface,
  type TriageContext,
} from './signature';

/** The list's rendered order before and after a change. */
export interface ListChange {
  readonly before: readonly Id[];
  readonly after: readonly Id[];
}

export interface TriageCommit {
  readonly kind: CommitKind;
  readonly surface: Surface;
  /** The leaving element (row, focus letter or reader column); null when it is not rendered. */
  readonly element: HTMLElement | null;
  /** Rows around the cursor to keep still. */
  readonly holdIds?: readonly Id[];
  /** The list's rendered order before and after the commit, for the closer's pins. */
  readonly rows?: ListChange;
  readonly release?: 'remove' | 'hide';
  /** Adds the commit chip and edge to the ghost and returns them. */
  readonly decorate?: (clone: HTMLElement) => { chip?: HTMLElement; edge?: HTMLElement };
  /** The row focus moved to, in `rows.after`; the cursor follows it on this key's context. */
  readonly focus?: Id;
}

export interface FocusMove {
  readonly cause?: CursorCause;
  readonly context?: MotionContext;
}

export interface TriageMotion {
  /** Draws one committed triage key. Returns the context it used and the ghost, if any. */
  commit(commit: TriageCommit): { context: TriageContext; ghost: Ghost | null };
  /**
   * Any other change to the list's rows (undo, new mail, a row restored). While a hold lasts it
   * pins the rows at the tops they had when the hold first changed the list; otherwise React's
   * layout stands.
   */
  relayout(rows: ListChange): void;
  /** Focus moved to row `id` of `rows` (the rendered order): the cursor goes to its drawn top. */
  focus(rows: readonly Id[], id: Id, move?: FocusMove): void;
  /** Deals the next letter's content into the fixed Home slot. */
  deal(content: HTMLElement, context?: TriageContext): void;
  dispose(): void;
}

export interface TriageMotionOptions {
  readonly scheduler: Scheduler;
  readonly ghosts: GhostLayer;
  readonly hold: HoldGate;
  readonly rapid: RapidTracker;
  /** The list's closer; its rows close when the hold releases. */
  readonly closer?: Closer<Id>;
  /** The list's cursor layer; needs `closer` for row tops. */
  readonly cursor?: CursorLayer;
}

export function createTriageMotion(options: TriageMotionOptions): TriageMotion {
  const { scheduler, ghosts, hold, rapid, closer, cursor } = options;
  const reduced = () => scheduler.env.prefersReducedMotion();
  const dealing = new WeakMap<HTMLElement, Playing>();
  // The closer is anchored once per hold, at the first change it sees, whether
  // the hold began with a key or with the pointer resting on the list.
  let anchored = false;
  // The rendered order last seen and the focused row in it, for the cursor.
  let rowsNow: readonly Id[] = [];
  let focused: Id | null = null;

  const unsubscribe = hold.onRelease(() => {
    anchored = false;
    const context = { reduced: reduced() };
    const riding = focused !== null && closer?.pinned.has(focused);
    closer?.close(context);
    if (!riding || !cursor || !closer || focused === null) return;
    const top = closer.drawnTop(rowsNow, focused);
    if (top === null || top === cursor.target[1]) return;
    cursor.glide(
      { x: cursor.target[0], y: top },
      'close',
      motionMs('close', 'base', context),
      motions.close.curve,
    );
  });

  function pinRows(rows: ListChange | undefined) {
    if (!rows) return;
    rowsNow = rows.after;
    if (!closer || !hold.isHeld) return;
    if (!anchored) {
      closer.anchor(rows.before);
      anchored = true;
    }
    closer.pin(rows.after);
  }

  function focus(rows: readonly Id[], id: Id, move: FocusMove = {}) {
    rowsNow = rows;
    focused = id;
    if (!cursor || !closer) return;
    const top = closer.drawnTop(rows, id);
    if (top === null || top === cursor.target[1]) return;
    cursor.move({ x: cursor.target[0], y: top, cause: move.cause ?? 'key' }, move.context);
  }

  return {
    commit(commit) {
      const key = rapid.key(scheduler.now());
      const context: TriageContext = { ...key, reduced: reduced() };
      hold.extend(commit.holdIds);
      pinRows(commit.rows);
      if (commit.focus !== undefined && commit.rows)
        focus(commit.rows.after, commit.focus, { context });
      if (!commit.element) return { context, ghost: null };
      const decorate = commit.decorate;
      const ghost = ghosts.launch(
        commit.element,
        departurePlan(commit.kind, commit.surface, context),
        {
          release: commit.release,
          decorate: decorate
            ? clone => {
                const { chip, edge } = decorate(clone);
                const extras: GhostExtra[] = [];
                if (chip) extras.push({ element: chip, plan: commitChipPlan(context) });
                if (edge) extras.push({ element: edge, plan: commitEdgePlan(context) });
                return extras;
              }
            : undefined,
        },
      );
      return { context, ghost };
    },
    relayout(rows) {
      pinRows(rows);
      // A row the hold did not anchor (one restored mid-hold) can still move.
      if (focused !== null && rows.after.includes(focused)) focus(rows.after, focused);
    },
    focus,
    deal(content, context = {}) {
      dealing.get(content)?.stop();
      const plan = dealPlan({ ...context, reduced: context.reduced ?? reduced() });
      if (plan) dealing.set(content, play(content, plan));
    },
    dispose() {
      unsubscribe();
    },
  };
}
