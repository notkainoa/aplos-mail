import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CitationProps } from '../props';
import { formatSource } from './format';

/** What a click opens: the event for an 'event' source that has a handler and an id, else the thread; both get the number. */
export function openCitation(source: {
  kind?: 'message' | 'event';
  eventId?: string;
  threadId: string;
  index: number;
  onOpen: (threadId: string, index: number) => void;
  onOpenEvent?: (eventId: string, index: number) => void;
}): void {
  const { kind, eventId, threadId, index, onOpen, onOpenEvent } = source;
  if (kind === 'event' && onOpenEvent && eventId) onOpenEvent(eventId, index);
  // An event source has no thread (threadId ''): without an event handler the chip does nothing rather than open ''.
  else if (threadId !== '') onOpen(threadId, index);
}

/**
 * A mono "[1]" chip. Hover or keyboard focus shows the quoted sentence with its source in the serif; a click opens the
 * thread (DESIGN §6 Citation, §7.7). The quote is a tooltip named by `aria-describedby`, so screen readers hear it on
 * focus. Showing it is `opacity` and `visibility` only: hover never moves anything. It opens above the chip, anchored
 * to it with CSS anchor positioning so it flips away from the dock edge; without that support it sits above the chip.
 */
export function Citation({
  index,
  quote,
  from,
  date,
  subject,
  threadId,
  kind,
  eventId,
  onOpen,
  onOpenEvent,
}: CitationProps) {
  const quoteId = useId();
  const [hover, setHover] = useState(false);
  // A unique dashed ident per chip lets the stylesheet anchor the quote to its own chip (CSS anchor positioning).
  const anchor = {
    '--cite-anchor': `--cite-${quoteId.replace(/[^a-zA-Z0-9]/g, '')}`,
  } as CSSProperties;
  // A missing field leaves no dangling separator: only the parts that exist are joined.
  const parts = [from, date ? formatSource(date) : '', subject]
    .map(part => part.trim())
    .filter(part => part !== '');
  const who = [from, subject].map(part => part.trim()).filter(part => part !== '');
  const label = who.length > 0 ? `Source ${index}: ${who.join(', ')}` : `Source ${index}`;
  const quoted = quote.trim();
  const open = () => openCitation({ kind, eventId, threadId, index, onOpen, onOpenEvent });
  return (
    <span
      className="ui-citation"
      // An empty title stops the answer's provenance title from showing over the quote tooltip (HTML title inheritance).
      title=""
      style={anchor}
      data-hover={hover ? 'true' : undefined}
      onPointerEnter={event => setHover(event.pointerType !== 'touch')}
      onPointerLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="ui-citation__chip"
        aria-label={label}
        aria-describedby={quoted || parts.length > 0 ? quoteId : undefined}
        onClick={open}
      >
        {`[${index}]`}
      </button>
      {quoted || parts.length > 0 ? (
        <span id={quoteId} role="tooltip" className="ui-citation__quote">
          {quoted ? <span className="ui-citation__text" dir="auto">{`“${quoted}”`}</span> : null}
          {parts.length > 0 ? (
            <span className="ui-citation__source" dir="auto">
              {parts.join(' · ')}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
