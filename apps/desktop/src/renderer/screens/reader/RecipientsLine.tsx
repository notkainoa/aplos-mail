/**
 * The card header's "To" (owner request 2026-11-10, image B): the word, one overlapping circle per recipient (the owner
 * included) and a chevron. The whole group is one button that opens the message's details in a Popover (image C): From
 * with name and address, To, Cc, Bcc, Reply-to when it differs, Date. Esc closes it and focus returns to the button.
 * Circles are monograms drawn from a data attribute by CSS (so the button's visible text is just "To", and its name starts
 * with it); no remote avatar is ever loaded by the renderer.
 */
import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../data';
import { Icon } from '../../ui/buttons-keys';
import { Popover } from '../../ui/surfaces';
import {
  MAX_CIRCLES,
  detailRows,
  recipientCircles,
  recipientsPhrase,
  type DetailRow,
  type Person,
} from './readerPeople';

/** Props for `RecipientsLine`. */
export interface RecipientsLineProps {
  readonly message: Message;
  readonly me: ReadonlySet<string>;
}

function Circle({ person }: { readonly person: Person }) {
  return (
    <span
      className="aplos-circle"
      data-me={person.me ? 'true' : undefined}
      data-mark={person.initial}
      aria-hidden="true"
    />
  );
}

/**
 * Up to three circles, then one "+N" circle for the rest. They overlap with the first on top, so each monogram stays
 * readable: the DOM runs last to first and the row is laid out in reverse.
 */
function Circles({ people }: { readonly people: readonly Person[] }) {
  const shown = people.slice(0, MAX_CIRCLES);
  const rest = people.length - shown.length;
  return (
    <span className="aplos-circles" aria-hidden="true">
      {rest > 0 ? (
        <span className="aplos-circle" data-more="true" data-mark={`+${rest}`} aria-hidden="true" />
      ) : null}
      {[...shown].reverse().map(person => (
        <Circle key={person.key} person={person} />
      ))}
    </span>
  );
}

function PersonLine({ person }: { readonly person: Person }) {
  const showAddress = person.address !== '' && person.address !== person.name;
  return (
    <span className="aplos-details__person" dir="auto">
      <span className="aplos-details__name">{person.name}</span>
      {showAddress ? <span className="aplos-details__address">{person.address}</span> : null}
    </span>
  );
}

function Row({ row }: { readonly row: DetailRow }) {
  return (
    <div className="aplos-details__row" role="group" aria-label={row.label}>
      <span className="aplos-details__label" aria-hidden="true">
        {row.label}
      </span>
      <span className="aplos-details__value">
        {row.kind === 'people' ? (
          row.people.map(person => <PersonLine key={person.key} person={person} />)
        ) : (
          <time className="aplos-details__name" dateTime={row.iso}>
            {row.text}
          </time>
        )}
      </span>
    </div>
  );
}

/** The popover's content: one row per fact the message carries. */
export function MessageDetails({ message, me }: RecipientsLineProps) {
  return (
    // A long list scrolls (reader.css), so the region takes focus: the keyboard can scroll it (axe scrollable-region-focusable).
    <div className="aplos-details" role="group" aria-label="People on this message" tabIndex={0}>
      {detailRows(message, me).map(row => (
        <Row key={row.label} row={row} />
      ))}
    </div>
  );
}

/**
 * The popover is placed once, so it closes when the reader scrolls the letter under it by wheel or touch (a scroll inside
 * the popover is its own). Layout settling (a frame growing) also fires scroll events, so only the user's gesture counts.
 */
function useCloseOnScroll(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onGesture = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('.aplos-details')) close();
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('wheel', onGesture, options);
    window.addEventListener('touchmove', onGesture, options);
    return () => {
      window.removeEventListener('wheel', onGesture, options);
      window.removeEventListener('touchmove', onGesture, options);
    };
  }, [open, close]);
}

/** "To", the circles and the chevron, with the details popover they open. */
export function RecipientsLine({ message, me }: RecipientsLineProps) {
  const people = recipientCircles(message, me);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useCloseOnScroll(open, () => setOpen(false));
  return (
    <span className="aplos-recipients">
      <button
        ref={button}
        type="button"
        className="aplos-recipients__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`To ${recipientsPhrase(people)}, show details`}
        onClick={() => setOpen(value => !value)}
      >
        <span className="aplos-recipients__to" aria-hidden="true">
          To
        </span>
        <Circles people={people} />
        <Icon name="chevron-down" size="sm" />
      </button>
      <Popover
        open={open}
        anchor={button.current}
        label="Message details"
        role="dialog"
        placement="below-start"
        onClose={() => setOpen(false)}
      >
        <MessageDetails message={message} me={me} />
      </Popover>
    </span>
  );
}
