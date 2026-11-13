/**
 * The card header's recipients (owner request 2026-11-10, image B; owner's hands-on pass 2026-11-12: the one-letter
 * circles meant nothing): "to me" or the name or address, and a chevron. The whole group is one button that opens the message's details in a Popover (image C): From
 * with name and address, To, Cc, Bcc, Reply-to when it differs, Date. Esc closes it and focus returns to the button.
 * No avatar of any kind is drawn, and none is ever loaded by the renderer.
 */
import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../data';
import { Icon } from '../../ui/buttons-keys';
import { Popover } from '../../ui/surfaces';
import {
  detailRows,
  recipientPeople,
  recipientLabel,
  type DetailRow,
  type Person,
} from './readerPeople';

/** Props for `RecipientsLine`. */
export interface RecipientsLineProps {
  readonly message: Message;
  readonly me: ReadonlySet<string>;
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

/** "to me" (or the names), the chevron and the details popover they open. */
export function RecipientsLine({ message, me }: RecipientsLineProps) {
  const label = recipientLabel(recipientPeople(message, me));
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
        aria-label={`${label}, show details`}
        onClick={() => setOpen(value => !value)}
      >
        <span className="aplos-recipients__to" aria-hidden="true">
          {label}
        </span>
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
