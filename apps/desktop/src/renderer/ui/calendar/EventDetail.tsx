import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { CalendarEventData, EventDetailProps, EventGuest, RsvpAnswer } from '../props';
import { dayOf, longDay, rangeOf } from './dates';
import { calVar } from './eventText';
import { CalIcon } from './icons';
import { keycapOf } from './keycaps';

const GUEST_STATUS = {
  going: { icon: 'check', word: 'Going' },
  maybe: { icon: 'help', word: 'Maybe' },
  declined: { icon: 'close', word: 'Declined' },
  none: { icon: 'circle', word: 'No reply yet' },
} as const;

const ANSWERS: ReadonlyArray<{ id: RsvpAnswer; label: string; command: 'yes' | 'maybe' | 'no' }> = [
  { id: 'yes', label: 'Yes', command: 'yes' },
  { id: 'maybe', label: 'Maybe', command: 'maybe' },
  { id: 'no', label: 'No', command: 'no' },
];

function whenLine(event: CalendarEventData): string {
  const day = longDay(dayOf(event.start));
  return event.allDay ? `${day} · All day` : `${day} · ${rangeOf(event.start, event.end)}`;
}

/** What the ⋯ button names in its tooltip: Delete exists only on a saved event you organise (DESIGN 7.8 Fixes). */
function moreLabel(event: CalendarEventData): string {
  if (event.kind === 'plan') return 'More: hide';
  if (event.isOrganizer) return event.persisted ? 'More: edit, delete' : 'More: edit';
  if (event.invite || event.myReply !== undefined) return 'More: change your reply, hide';
  return 'More: hide, copy link';
}

function guestRole(guest: EventGuest): string | undefined {
  if (guest.isYou && guest.isOrganizer) return 'you, organizer';
  if (guest.isYou) return 'you';
  if (guest.isOrganizer) return 'organizer';
  return undefined;
}

/**
 * The event detail, shared by the Popover from the grid and the day view's side rail: title with ⋯ and an optional
 * close, the when line, the calendar swatch, video link, place, "Invite from Priya", the "Going?" RSVP with
 * nothing chosen and "Send reply" disabled until you choose, Guests, description. A plan adds a confirm button and
 * its source email (DESIGN 6 EventDetail, 7.8).
 */
export function EventDetail({
  event,
  presentation,
  reply,
  onOpenInvite,
  onOpenVideo,
  onConfirmPlan,
  onOpenSource,
  onMore,
  onClose,
}: EventDetailProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const rsvpLabelId = `${uid}-going`;
  const isPlan = event.kind === 'plan';
  const guests = event.guests ?? [];
  const more = moreLabel(event);

  return (
    <section
      className="ui-event-detail"
      data-presentation={presentation}
      data-kind={event.kind}
      aria-labelledby={titleId}
    >
      <div className="ui-event-detail__head">
        <h2 className="ui-event-detail__title" id={titleId} dir="auto">
          {event.title}
        </h2>
        <button
          type="button"
          className="ui-cal-icon-button"
          aria-label="More"
          aria-haspopup="menu"
          title={more}
          onClick={(e) => onMore(e.currentTarget)}
        >
          <CalIcon name="more" />
        </button>
        {onClose ? (
          <button type="button" className="ui-cal-icon-button" aria-label="Close" title="Close · Esc" onClick={onClose}>
            <CalIcon name="close" />
          </button>
        ) : null}
      </div>
      <p className="ui-event-detail__when">{whenLine(event)}</p>

      <ul className="ui-event-detail__rows">
        <li>
          <span className="ui-event-detail__mark" aria-hidden="true">
            <i style={{ '--swatch': calVar(event.calendar.color) } as CSSProperties} />
          </span>
          <span className="ui-event-detail__ellipsis">{event.calendar.name}</span>
        </li>
        {event.video ? (
          <li>
            <CalIcon name="video" />
            <button type="button" className="ui-cal-link" onClick={onOpenVideo}>
              {event.video}
            </button>
          </li>
        ) : null}
        {event.place ? (
          <li>
            <CalIcon name="pin" />
            <span className="ui-event-detail__ellipsis">{event.place}</span>
          </li>
        ) : null}
        {event.invite ? (
          <li>
            <CalIcon name="mail" />
            <button
              type="button"
              className="ui-cal-link"
              title="Open the invite email · O"
              onClick={() => onOpenInvite?.(event.invite!.threadId)}
            >
              {`Invite from ${event.invite.from.split(' ')[0]}`}
            </button>
          </li>
        ) : null}
        {isPlan && event.source ? (
          <li>
            <CalIcon name="mail" />
            <button type="button" className="ui-cal-link" onClick={() => onOpenSource?.(event.source!.threadId)}>
              {`From ${event.source.from}: ${event.source.subject}`}
            </button>
          </li>
        ) : null}
      </ul>

      {isPlan ? (
        <div className="ui-event-detail__plan">
          <p className="ui-event-detail__note">Found in your mail. Nothing is added until you confirm.</p>
          <button type="button" className="ui-cal-button" data-variant="filled" onClick={onConfirmPlan}>
            Add to calendar
          </button>
        </div>
      ) : null}

      {reply ? (
        <div className="ui-event-detail__rsvp">
          <h3 className="ui-event-detail__label" id={rsvpLabelId}>
            Going?
          </h3>
          <div className="ui-event-detail__rsvp-row">
            <div className="ui-event-detail__answers" role="radiogroup" aria-labelledby={rsvpLabelId}>
              {ANSWERS.map((a) => {
                const key = keycapOf(reply.commands[a.command]);
                const checked = reply.answer === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    className="ui-event-detail__answer"
                    aria-checked={checked}
                    data-checked={checked ? 'true' : 'false'}
                    title={key ? `${a.label} · ${key}` : a.label}
                    onClick={() => reply.onAnswer(a.id)}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="ui-cal-button"
              data-variant="filled"
              disabled={reply.answer === null}
              onClick={reply.onSend}
            >
              Send reply
              <kbd className="ui-cal-kbd">Return</kbd>
            </button>
          </div>
        </div>
      ) : null}

      {guests.length > 0 ? (
        <>
          <h3 className="ui-event-detail__label">Guests</h3>
          <ul className="ui-event-detail__guests">
            {guests.map((guest) => {
              const status = GUEST_STATUS[guest.status];
              const role = guestRole(guest);
              return (
                <li key={guest.name} data-status={guest.status}>
                  <span className="ui-event-detail__guest" dir="auto">
                    {guest.name}
                    {role ? <span className="ui-event-detail__role">{role}</span> : null}
                  </span>
                  <span className="ui-event-detail__status">
                    <CalIcon name={status.icon} />
                    {status.word}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {event.description ? <p className="ui-event-detail__description">{event.description}</p> : null}
    </section>
  );
}
