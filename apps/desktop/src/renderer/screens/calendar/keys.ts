/**
 * Key guards the Calendar container applies until the registry can say them itself (REQUESTs to ui-foundation in the
 * lane report). Pure: they read an element through `ElementLike`, which a DOM `Element` satisfies, so node tests can
 * pass a stand-in.
 *
 * - ←/→ (review1 4c): `calendar.nextPeriod` and `calendar.previousPeriod` own ←/→ in the calendar context, but the
 *   answer radios, MiniMonth's day grid, the D | W | M tabs and menus move with the same keys. While focus is in one of
 *   them the period commands rest (`when` is false), so the key goes to the widget alone. CalendarGrid is the
 *   exception: it moves with ↑/↓ only, so ←/→ still change the period there. J and K share the commands and rest too.
 * - Esc (review1 4b): the catalog has no calendar Esc, so Esc resolves to `nav.back` and leaves Calendar. The container
 *   runs the model's Esc ladder from a capture listener, and consumes the key only when a rung handled it.
 * - Return (review1 plausible): CalendarGrid opens its selection on Return and the registry's `calendar.open` runs on the
 *   same key. `createTurnGate` lets the first of the two act in one turn of the event loop.
 */

/** An element as the guards read it. */
export interface ElementLike {
  closest(selector: string): ElementLike | null;
  matches(selector: string): boolean;
}

/** Widgets that move with ←/→ themselves (WAI-ARIA radio group, grid, tabs, menu, listbox, slider). */
export const SIDE_ARROW_OWNERS =
  '[role="radiogroup"], [role="grid"], [role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="slider"]';

/** CalendarGrid: a `grid` that walks with ↑/↓ only, so ←/→ stay the period keys inside it. */
const PERIOD_GRID = '.ui-calendar-grid';

/** True when the focused element sits in a widget that moves with ←/→ itself. */
export function ownsSideArrows(active: ElementLike | null | undefined): boolean {
  const owner = active?.closest(SIDE_ARROW_OWNERS);
  return owner !== null && owner !== undefined && !owner.matches(PERIOD_GRID);
}

/** Widgets that close themselves on Esc (the popover detail, the editor Dialog, menus). */
export const ESCAPE_OWNERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The parts of a keydown the Esc guard reads (a DOM KeyboardEvent satisfies it). */
export interface EscapeKeyInput {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
}

/**
 * Whether the calendar's Esc ladder may take this keydown: a bare Esc, not composing, not already taken, with focus on
 * the Calendar screen (or on nothing), and not inside a widget that closes itself on Esc.
 */
export function ladderTakesEscape(
  event: EscapeKeyInput,
  active: ElementLike | null,
  focusInScreen: boolean,
): boolean {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (!focusInScreen) return false;
  return active?.closest(ESCAPE_OWNERS) == null;
}

/** One action per turn of the event loop: the first `claim` in a turn wins, later ones in the same turn get false. */
export function createTurnGate(
  schedule: (release: () => void) => void = release => setTimeout(release, 0),
): {
  claim(): boolean;
} {
  let taken = false;
  return {
    claim() {
      if (taken) return false;
      taken = true;
      schedule(() => {
        taken = false;
      });
      return true;
    },
  };
}
