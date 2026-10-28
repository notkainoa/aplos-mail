// Component defects the harness has found that belong to another lane. A listed state is expected to
// fail that one check (`test.fail`), so the run stays green and says why; when the component is fixed
// the test reports "expected to fail but passed" and the entry is deleted here.

export const KNOWN_DEFECTS = {
  /**
   * Buttons that draw the browser's default 2px outset border and grey face because their family CSS
   * sets no `border` or `background`. The legacy sheet used to reset every button globally; ui/base.css
   * has no such reset. Reported to ui-foundation (base.css) and each family owner.
   */
  uaButtonChrome: {
    'calendar-week':
      '.ui-event-block and .ui-plan-outline (calendar.css) have no border or background reset',
    'onboarding-step':
      '.ui-onb-button and .ui-choice-row (onboarding.css) have no border or background reset',
    'progress-first-sync': '.ui-onb-button (onboarding.css) has no border or background reset',
    'settings-providers':
      '.ui-provider-table__button (settings.css) has no border or background reset',
  } as Record<string, string>,
} as const;
