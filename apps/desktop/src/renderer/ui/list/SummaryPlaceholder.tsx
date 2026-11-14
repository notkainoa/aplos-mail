// SummaryPlaceholder (owner decision 2026-11-13). The quiet stand-in on the Home focus card while a summary is being
// written: two soft lines (90 % and 65 % wide) and a muted "Summarizing…" label, in the space the summary will take
// (two lines of the `summary` role). It is replaced in place, so the action row never moves. No glyph, no shimmer.

import type { ReactNode } from 'react';

/** Two soft lines and a small label where the serif summary will land; a chip leads the first line, as it leads the summary. */
export function SummaryPlaceholder({
  subject,
  lead,
}: {
  readonly subject: string;
  readonly lead?: ReactNode;
}) {
  return (
    <div className="ui-summary-placeholder">
      <span className="ui-list-sr">{subject}</span>
      <span className="ui-summary-placeholder__row">
        {lead}
        <span className="ui-summary-placeholder__bar" data-width="long" aria-hidden="true" />
      </span>
      <span className="ui-summary-placeholder__row">
        <span className="ui-summary-placeholder__bar" data-width="short" aria-hidden="true" />
        <span className="ui-summary-placeholder__label">Summarizing…</span>
      </span>
    </div>
  );
}
