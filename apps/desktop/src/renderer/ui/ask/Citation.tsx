import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { CitationProps } from '../props';
import { formatSource } from './format';

/**
 * A mono "[1]" chip. Hover or keyboard focus shows the quoted sentence with its source in the serif; a click opens the
 * thread (DESIGN §6 Citation, §7.7). The quote is a tooltip named by `aria-describedby`, so screen readers hear it on
 * focus. Showing it is `opacity` and `visibility` only: hover never moves anything. It opens above the chip, anchored
 * to it with CSS anchor positioning so it flips away from the dock edge; without that support it sits above the chip.
 */
export function Citation({ index, quote, from, date, subject, threadId, onOpen }: CitationProps) {
  const quoteId = useId();
  // A unique dashed ident per chip lets the stylesheet anchor the quote to its own chip (CSS anchor positioning).
  const anchor = { '--cite-anchor': `--cite-${quoteId.replace(/[^a-zA-Z0-9]/g, '')}` } as CSSProperties;
  return (
    <span className="ui-citation" style={anchor}>
      <button
        type="button"
        className="ui-citation__chip"
        aria-label={`Source ${index}: ${from}, ${subject}`}
        aria-describedby={quoteId}
        onClick={() => onOpen(threadId)}
      >
        {`[${index}]`}
      </button>
      <span id={quoteId} role="tooltip" className="ui-citation__quote">
        <span className="ui-citation__text" dir="auto">{`“${quote}”`}</span>
        <span className="ui-citation__source" dir="auto">{`${from} · ${formatSource(date)} · ${subject}`}</span>
      </span>
    </span>
  );
}
