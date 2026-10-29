// Component defects the harness has found that belong to another lane. A listed state is expected to
// fail that one check (`test.fail`), so the run stays green and says why; when the component is fixed
// the test reports "expected to fail but passed" and the entry is deleted here.

export const KNOWN_DEFECTS = {
  /** States whose buttons still draw the browser's default chrome (none since ui/base.css resets buttons). */
  uaButtonChrome: {} as Record<string, string>,
} as const;

const LIST_BOX_REQUIRED_CHILDREN =
  'ui/list ListBox: role=listbox holds the section headers whose action button (Go one by one, Clear from Home) is not an option or group. REQUEST for ui-foundation.';
const FOCUS_LETTER_NESTED =
  'ui/list FocusLetter: the letter is role=option and holds focusable buttons (Suggested, Later, Done, More). REQUEST for ui-foundation.';

/**
 * Serious or critical axe violations (axe.spec.ts) that belong to another lane or that axe and the
 * design tokens disagree on: state id -> axe rule id -> reason. Only the named rule in the named
 * state is let through, in both themes and sizes; no rule is ever disabled for the whole run. Delete
 * the entry when the cause is fixed.
 */
export const axeKnownDefects: Record<string, Record<string, string>> = {
  ...homeListDefects(),
  'list-rows': {
    'nested-interactive':
      'ui/list ListRow (rejected): the row is role=option and holds the Retry button, which is focusable. REQUEST for ui-foundation.',
  },
  'search-operators': {
    'aria-valid-attr-value':
      'ui/ask SearchField: aria-controls="results" points at an id that the scene does not render while the combobox is expanded. REQUEST for ui-foundation.',
  },
  'menu-open': {
    'label-content-name-mismatch':
      'ui/surfaces Menu: role=menuitem is named by aria-labelledby on an inner label, so the keycap text is outside the accessible name. REQUEST for ui-foundation.',
  },
  'calendar-week': {
    'label-content-name-mismatch':
      'ui/calendar TimeGrid and EventBlock: aria-label on gridcells and event buttons does not contain the visible text (times, titles). REQUEST for ui-foundation.',
  },
  'onboarding-step': {
    'label-content-name-mismatch':
      'ui/onboarding ChoiceRow: aria-labelledby names only the label, not the visible detail text. REQUEST for ui-foundation.',
  },
  'settings-providers': {
    'label-content-name-mismatch':
      'ui/settings ProviderTable: the button reads "Add key" but aria-label is "Add a key for Claude" (label in name, WCAG 2.5.3). REQUEST for ui-foundation.',
  },
};

/** Every Home state that draws the focus letter in the listbox. The screen only wires ui/list; the cause is there. */
function homeListDefects(): Record<string, Record<string, string>> {
  const ids = [
    'home-focus',
    'home-full',
    'home-low-sheet',
    'home-do-now-from-later',
    'home-follow-up',
    'home-with-cursor-focusslot',
  ];
  const reasons = {
    'aria-required-children': LIST_BOX_REQUIRED_CHILDREN,
    'nested-interactive': FOCUS_LETTER_NESTED,
  };
  return Object.fromEntries(ids.map(id => [id, reasons]));
}
