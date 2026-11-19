// LoadingLine (DESIGN §5 rules 10 and 12, §7.5). Mockups: none drawn.
// The 12 px line shown when a body takes past 1.5 s while the previous letter stays: a small spinner and
// "Loading Maple Library…". One quiet indicator in place, never a modal, never a skeleton.

import type { LoadingLineProps } from '../props';

/** The quiet loading line in the reader column. */
export function LoadingLine({ label }: LoadingLineProps) {
  return (
    <p className="ui-loading-line" role="status">
      <span className="ui-loading-line__spinner" aria-hidden="true" />
      <span className="ui-loading-line__label">{label}</span>
    </p>
  );
}
