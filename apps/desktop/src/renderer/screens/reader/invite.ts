/**
 * The invitation card's words (DESIGN 7.5, 7.8): an invite email's event as the reader shows it inside the message.
 * The title, the when line in the calendar's own wording ("Thursday, November 5 · 2:00 – 2:45 PM"), the place, the
 * meeting link, "Invite from Noor" and the other guests. Answering lives in the calendar; the card only says what it
 * is. Pure: the screen reads the `Event` row and draws `InviteCard`.
 */
import { toIsoDateTime, type Event } from '../../data';
import { dayOf, longDay, rangeOf, shortDay, timeOf } from '../../ui/calendar/dates';
import { firstNameOf, joinRecipients, nameOf } from './readerRows';

/** What the invitation card says. */
export interface InviteView {
  readonly title: string;
  /** "Thursday, November 5 · 2:00 – 2:45 PM", "Thursday, November 5 · All day". */
  readonly when: string;
  readonly place?: string;
  /** The meeting link's label, else its address. */
  readonly video?: string;
  /** "Invite from Noor"; absent when no organiser is named. */
  readonly from?: string;
  /** The guests other than the organiser, the owner first as "you": "you, Jordan Park and Tomas Reyes". */
  readonly guests?: string;
}

type EventTime = Event['start'];

/** The time as a local ISO date-time; a date (all day) is its local midnight. */
function isoOf(time: EventTime): string {
  if (time.type === 'utc') return toIsoDateTime(time.utc);
  if (time.type === 'date') return `${time.date}T00:00:00`;
  return time.local;
}

/** The last day an entry touches: its end is exclusive, so an end at midnight belongs to the day before. */
function lastDay(start: string, end: string): string {
  const last = Math.max(new Date(start).getTime(), new Date(end).getTime() - 60_000);
  return dayOf(toIsoDateTime(last));
}

/** The when line, worded as the calendar's event detail words it. */
export function inviteWhen(event: Pick<Event, 'start' | 'end' | 'allDay'>): string {
  const start = isoOf(event.start);
  const end = isoOf(event.end);
  const first = dayOf(start);
  const last = lastDay(start, end);
  if (first === last)
    return event.allDay
      ? `${longDay(first)} · All day`
      : `${longDay(first)} · ${rangeOf(start, end)}`;
  if (event.allDay) return `${shortDay(first)} – ${shortDay(last)} · All day`;
  return `${shortDay(first)}, ${timeOf(start)} – ${shortDay(dayOf(end))}, ${timeOf(end)}`;
}

function guestsOf(event: Event, me: ReadonlySet<string>): string | undefined {
  const others = event.attendees.filter(a => !a.organizer);
  if (others.length === 0) return undefined;
  const isMe = (address: string) => me.has(address.toLowerCase());
  const mine = others.filter(a => a.self || isMe(a.address));
  const rest = others.filter(a => !(a.self || isMe(a.address)));
  const names = [
    ...mine.map(() => 'you'),
    ...rest.map(a => nameOf({ name: a.name, address: a.address })),
  ];
  return joinRecipients(names);
}

function fromOf(event: Event): string | undefined {
  const organizer = event.organizer ?? event.attendees.find(a => a.organizer);
  const name = event.invite?.fromName?.trim() || organizer?.name?.trim() || organizer?.address;
  return name ? `Invite from ${firstNameOf(name)}` : undefined;
}

/** The card's words for an invitation event; an event with no title takes the email's subject. */
export function inviteOf(event: Event, me: ReadonlySet<string>, subject: string): InviteView {
  const place = event.location?.trim();
  const video = event.conference?.label?.trim() || event.conference?.url.trim();
  const from = fromOf(event);
  const guests = guestsOf(event, me);
  return {
    title: event.title.trim() || subject,
    when: inviteWhen(event),
    ...(place ? { place } : {}),
    ...(video ? { video } : {}),
    ...(from ? { from } : {}),
    ...(guests ? { guests } : {}),
  };
}
