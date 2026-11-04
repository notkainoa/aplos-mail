// Component defects the harness has found that belong to another lane. A listed state is expected to
// fail that one check (`test.fail`), so the run stays green and says why; when the component is fixed
// the test reports "expected to fail but passed" and the entry is deleted here.

export const KNOWN_DEFECTS = {
  /** States whose buttons still draw the browser's default chrome (none since ui/base.css resets buttons). */
  uaButtonChrome: {} as Record<string, string>,
} as const;

/**
 * Serious or critical axe violations (axe.spec.ts) that belong to another lane or that axe and the
 * design tokens disagree on: state id -> axe rule id -> reason. Only the named rule in the named
 * state is let through, in both themes and sizes; no rule is ever disabled for the whole run. Delete
 * the entry when the cause is fixed.
 */
/** The ui/calendar defect behind the calendar states' mismatches (REQUEST for ui-foundation). */
const LABEL_MISMATCH =
  'ui/calendar eventLabel (EventBlock, AgendaView): the accessible name joins title, time and calendar with ", " while the entry draws "title time", so the visible text is not a substring of the name (WCAG 2.5.3). Clears when the name carries the drawn words verbatim.';

export const axeKnownDefects: Record<string, Record<string, string>> = {
  'list-rows': {
    'nested-interactive':
      'ui/list ListRow (rejected): the row is role=option and holds the Retry button. Retry has no registry key yet, so it must stay Tab-reachable and cannot become a hidden pointer duplicate. Clears when a retry command (key) exists and ErrorLine passes duplicate for it. REQUEST for commands + ui-home.',
  },
  'agenda-narrow': {
    'label-content-name-mismatch': LABEL_MISMATCH,
  },
  'day-default': {
    'label-content-name-mismatch': LABEL_MISMATCH,
  },
  'worst-case-day': {
    'label-content-name-mismatch': LABEL_MISMATCH,
  },
};
