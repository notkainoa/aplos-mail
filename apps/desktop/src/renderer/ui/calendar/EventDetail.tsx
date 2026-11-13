import { useId, useRef } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { CalendarEventData, EventDetailProps, EventGuest, RsvpAnswer } from '../props';
import { dayOf, isoOf, longDay, rangeOf, shortDay, timeOf } from './dates';
import { displayChord } from '../buttons-keys/keyHints';
import { calVar } from './eventText';
import { CalIcon } from './icons';
import { keycapOf } from './keycaps';

const GUEST_STATUS = {
  going: { icon: 'check', word: 'Going' },
  maybe: { icon: 'help', word: 'Maybe' },
  declined: { icon: 'close', word: 'Declined' },
  none: { icon: 'circle', word: 'Not answered' },
} as const;

const ANSWERS: ReadonlyArray<{ id: RsvpAnswer; label: string; command: 'yes' | 'maybe' | 'no' }> = [
  { id: 'yes', label: 'Yes', command: 'yes' },
  { id: 'maybe', label: 'Maybe', command: 'maybe' },
  { id: 'no', label: 'No', command: 'no' },
];

/** The last day an entry touches: its end is exclusive, so an end at midnight belongs to the day before. */
function lastDayOf(event: CalendarEventData): string {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  return isoOf(new Date(Math.max(start, end - 60000)));
}

/**
 * The when line. One day: "Thursday, October 29 · 10:30 – 11:30 AM" (or "· All day"). Several days: the times
 * with their days, "Mon, Oct 26, 9:00 AM – Wed, Oct 28, 5:00 PM"; all-day as a date range, "Mon, Oct 26 – Wed,
 * Oct 28 · All day".
 */
export function whenLine(event: CalendarEventData): string {
  const first = dayOf(event.start);
  const last = lastDayOf(event);
  if (last === first) {
    const day = longDay(first);
    return event.allDay ? `${day} · All day` : `${day} · ${rangeOf(event.start, event.end)}`;
  }
  if (event.allDay) return `${shortDay(first)} – ${shortDay(last)} · All day`;
  return `${shortDay(first)}, ${timeOf(event.start)} – ${shortDay(dayOf(event.end))}, ${timeOf(event.end)}`;
}

/** What the ⋯ button names in its tooltip: Delete exists only on a saved event you organise (DESIGN 7.8 Fixes). */
function moreLabel(event: CalendarEventData): string {
  if (event.kind === 'plan') return 'More: hide';
  if (event.isOrganizer) return event.persisted ? 'More: edit, delete' : 'More: edit';
  if (event.invite || event.myReply !== undefined) return 'More: change your reply, hide';
  return 'More: hide, copy link';
}

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'prof', 'sir', 'dame']);

/** The sender's first name for "Invite from …": skips titles ("Dr. Priya Raman" is Priya), falls back to the whole name. */
export function firstNameOf(from: string): string {
  const whole = from.trim();
  if (whole === '' || whole.includes('@')) return whole;
  const words = whole.split(/\s+/);
  const name = words.find(w => !TITLES.has(w.replace(/\.$/, '').toLowerCase()));
  return name ?? whole;
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
  const answerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The radiogroup pattern: one tab stop (the chosen answer, or the first), arrows move to and choose the next.
  const onAnswerKey = (e: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    if (e.nativeEvent.isComposing) return;
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (at + step + ANSWERS.length) % ANSWERS.length;
    answerRefs.current[next]?.focus();
    reply?.onAnswer(ANSWERS[next].id);
  };

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
          onClick={e => onMore(e.currentTarget)}
        >
          <CalIcon name="more" />
        </button>
        {onClose ? (
          <button
            type="button"
            className="ui-cal-icon-button"
            aria-label="Close"
            title="Close · Esc"
            onClick={onClose}
          >
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
              {firstNameOf(event.invite.from)
                ? `Invite from ${firstNameOf(event.invite.from)}`
                : 'Invite'}
            </button>
          </li>
        ) : null}
        {isPlan && event.source ? (
          <li>
            <CalIcon name="mail" />
            <button
              type="button"
              className="ui-cal-link"
              onClick={() => onOpenSource?.(event.source!.threadId)}
            >
              {`From ${event.source.from}: ${event.source.subject}`}
            </button>
          </li>
        ) : null}
      </ul>

      {isPlan ? (
        <div className="ui-event-detail__plan">
          <p className="ui-event-detail__note">
            Found in your mail. Nothing is added until you confirm.
          </p>
          <button
            type="button"
            className="ui-cal-button"
            data-variant="filled"
            onClick={onConfirmPlan}
          >
            Add to Calendar
          </button>
        </div>
      ) : null}

      {reply ? (
        <div className="ui-event-detail__rsvp">
          <h3 className="ui-event-detail__label" id={rsvpLabelId}>
            Going?
          </h3>
          <div className="ui-event-detail__rsvp-row">
            <div
              className="ui-event-detail__answers"
              role="radiogroup"
              aria-labelledby={rsvpLabelId}
            >
              {ANSWERS.map((a, i) => {
                const key = keycapOf(reply.commands[a.command]);
                const checked = reply.answer === a.id;
                return (
                  <button
                    key={a.id}
                    ref={el => {
                      answerRefs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    tabIndex={checked || (reply.answer === null && i === 0) ? 0 : -1}
                    onKeyDown={e => onAnswerKey(e, i)}
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
              onClick={() => reply.onSend()}
            >
              Send reply
              <kbd className="ui-cal-kbd">{displayChord('Return')}</kbd>
            </button>
          </div>
        </div>
      ) : null}

      {guests.length > 0 ? (
        <>
          <h3 className="ui-event-detail__label">Guests</h3>
          <ul className="ui-event-detail__guests">
            {guests.map(guest => {
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

      {event.description ? (
        <p className="ui-event-detail__description">{event.description}</p>
      ) : null}
    </section>
  );
}
