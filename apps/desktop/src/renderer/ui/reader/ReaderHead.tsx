// ReaderHead (DESIGN §6, §7.5 items 1–2, §4.6). Mockups: reader.html, reply.html, errors.html (send-failed).
// The top of the one 640 px column: the big serif summary (with its due chip, if any) and a hairline under it.
// The sender and the time live in the message cards below; the actions are the pinned `ReaderActions` bar.

import type { Ref } from 'react';
import type { ReaderHeadProps } from '../props';
import { Chip } from '../list/Chip';
import { Summary } from './Summary';

/** The reader's summary and the hairline under it. */
export function ReaderHead({ due, summary, ref }: ReaderHeadProps) {
  return (
    <div ref={ref as Ref<HTMLDivElement>} className="ui-reader-head">
      <section className="ui-reader-head__summary" aria-label="Summary">
        <Summary {...summary} clamp="none" />
      </section>
      {due ? (
        <div className="ui-reader-head__due">
          <Chip kind="due" due={due} format="sentence" />
        </div>
      ) : null}
      <hr className="ui-reader-head__rule" />
    </div>
  );
}
