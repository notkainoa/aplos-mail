// CommitEdge (DESIGN §4.9, §6). Mockups: home.html. The 3 px edge on the leaving side: right for Done and
// Trash, left for Later. Static here; ui-shell animates scaleY 0 → 1 (`commit`).

import type { Ref } from 'react';
import type { CommitEdgeProps } from '../props';

/** The 3 px commit edge on a leaving letter's ghost. */
export function CommitEdge({ kind, ref }: CommitEdgeProps) {
  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      className="ui-commit-edge"
      data-kind={kind}
      data-side={kind === 'later' ? 'left' : 'right'}
      aria-hidden="true"
    />
  );
}
