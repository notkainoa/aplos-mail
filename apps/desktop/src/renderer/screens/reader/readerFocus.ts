/**
 * Where keyboard focus goes when the element that held it leaves the reader (the find field closing, the letter on paper
 * changing after J or Done). A removed element drops focus to the document body and the next key press then goes
 * nowhere a screen reader or a Tab can follow, so the reader moves focus to its own root, which is a `tabIndex -1`
 * container. The decision is pure; `settleFocus` is the one DOM touch.
 */

/** Where the focused element is, relative to the reader. */
export type FocusPlace =
  /** Nothing is focused, or the document body is (what a removed element leaves behind). */
  | 'dropped'
  /** Inside the letter on paper (a button, the reply, the find field). */
  | 'paper'
  /** Inside a letter that is off paper: inert, about to be unmounted. */
  | 'offPaper'
  /** Inside the reader but outside any letter (the loading line, the root itself). */
  | 'reader'
  /** Somewhere else in the app (the sidebar, the palette's field, a dialog). */
  | 'elsewhere';

/** Whether the reader takes focus or leaves it where it is. */
export type FocusDecision = 'root' | 'keep';

/** The reader takes focus only when it was dropped or sits on a letter that left the paper; it never pulls it back from elsewhere. */
export function focusDecision(place: FocusPlace): FocusDecision {
  return place === 'dropped' || place === 'offPaper' ? 'root' : 'keep';
}

/** The slice of an element the placement needs. */
export interface FocusProbe {
  readonly active: Element | null;
  readonly body: Element | null;
  readonly root: Element | null;
}

/** Classifies the focused element against the reader's root. */
export function placeOf({ active, body, root }: FocusProbe): FocusPlace {
  if (active === null || active === body) return 'dropped';
  if (root === null || !root.contains(active)) return 'elsewhere';
  const letter = active.closest('.aplos-reader__letter');
  if (letter === null || !root.contains(letter)) return 'reader';
  return letter.getAttribute('data-paper') === 'true' ? 'paper' : 'offPaper';
}

/** Moves focus to the reader's root when `focusDecision` says so. Returns the decision, for tests and callers. */
export function settleFocus(root: HTMLElement | null, doc: Document = document): FocusDecision {
  const decision = focusDecision(placeOf({ active: doc.activeElement, body: doc.body, root }));
  if (decision === 'root') root?.focus({ preventScroll: true });
  return decision;
}
