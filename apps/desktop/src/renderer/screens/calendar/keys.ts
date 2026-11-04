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
  /** A DOM Element's descendant lookup; the popover shell needs it to be claimed as ours. */
  querySelector?(selector: string): ElementLike | null;
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

/** What an open invite's Y/M/N means, the registry's calendar.answer* commands word for word (DESIGN 8). */
export const INVITE_ANSWER_KEYS: Record<string, 'yes' | 'maybe' | 'no'> = {
  y: 'yes',
  m: 'maybe',
  n: 'no',
};

/** A focused element that types the letter: a field or a text-role widget. */
const TEXT_FIELD_OWNERS =
  'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="number"], textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]';

/**
 * The calendar's own portaled surfaces: the detail popover, the scope question and the editor's pickers carry the
 * screen's own classes; its menus carry a `cal-menu-` DOM id. Any other dialog, sheet, palette or menu in the app
 * is NOT ours — an open shortcut sheet over an invite must not answer it on y/m/n (review1 11).
 */
const CAL_OWN_CONTENT =
  '.cal-screen__popover, .cal-screen__rail, .cal-editor, .ui-scope-chooser, .cal-editor__month';
const CAL_OWN_MENU = '.ui-menu[id^="cal-menu-"]';
const CAL_POPOVER = '.ui-popover';

/** Focus is inside one of the calendar's own surfaces: its rail/popover content, its scope question or its menus. */
export function inCalendarSurface(active: ElementLike | null): boolean {
  if (active == null) return false;
  if (active.closest(CAL_OWN_CONTENT) != null || active.closest(CAL_OWN_MENU) != null) return true;
  const popover = active.closest(CAL_POPOVER);
  return (
    typeof popover?.querySelector === 'function' && popover.querySelector(CAL_OWN_CONTENT) != null
  );
}

/**
 * Whether the screen's answer-key listener may take this keydown: a bare y, m or n, not composing, not already taken,
 * never while typing in a field, and only while focus is on the screen or one of its own surfaces (`withinCalendar`,
 * computed by the container as `inScreen || inCalendarSurface`). The detail popover's role=dialog is a modal
 * context, so the registry's y/m/n end there and the screen answers from a capture listener instead.
 */
export function takesInviteAnswerKey(
  event: EscapeKeyInput,
  active: ElementLike | null,
  withinCalendar: boolean,
): boolean {
  if (INVITE_ANSWER_KEYS[event.key] === undefined) return false;
  if (event.isComposing || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (active?.closest(TEXT_FIELD_OWNERS)) return false;
  return withinCalendar;
}

/** Widgets that keep Return for themselves: every button and link, the grid's entries and "+N" stacks included. */
export const RETURN_OWNERS =
  'button, [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="tab"], [role="switch"], a[href]';

/** True when the focused element activates itself on Return, so the registry's calendar.open must defer (review1 13). */
export function ownsReturn(active: ElementLike | null | undefined): boolean {
  return active?.closest(RETURN_OWNERS) != null;
}

/** The DOM-id encoder `ui/calendar/eventText` keeps private: anything outside letters, digits and "-" becomes `_<hex>_`. */
const safeDomId = (id: string): string =>
  id.replace(/[^A-Za-z0-9-]/g, c => `_${(c.codePointAt(0) ?? 0).toString(16)}_`);

/**
 * The DOM id the "+N" stack button for `ids` renders, found among the stack ids present: `ui-stack-<first id>`
 * (day, week, agenda), or the month cell's `ui-stack-<day>:<first id>` form (review1 9).
 */
export function stackDomMatch(
  ids: readonly string[],
  candidates: readonly string[],
): string | null {
  const first = ids[0];
  if (first === undefined) return null;
  const direct = `ui-stack-${safeDomId(first)}`;
  const monthTail = `_3a_${safeDomId(first)}`;
  return candidates.find(c => c === direct || c.endsWith(monthTail)) ?? null;
}

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
 * the Calendar screen (or on nothing), and not inside a widget that closes itself on Esc. While a grid drag is under
 * way the ladder stays out: this listener was registered before TimeGrid's own Esc-cancel, so taking the key would
 * close a rung and leave the drag going (review1 2). Esc cancels the drag first; a second Esc walks the ladder.
 */
export function ladderTakesEscape(
  event: EscapeKeyInput,
  active: ElementLike | null,
  focusInScreen: boolean,
  dragInProgress = false,
): boolean {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (dragInProgress) return false;
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
