// Component defects the harness has found that belong to another lane. A listed state is expected to
// fail that one check (`test.fail`), so the run stays green and says why; when the component is fixed
// the test reports "expected to fail but passed" and the entry is deleted here.

export const KNOWN_DEFECTS = {
  /** States whose buttons still draw the browser's default chrome (none since ui/base.css resets buttons). */
  uaButtonChrome: {} as Record<string, string>,
} as const;
