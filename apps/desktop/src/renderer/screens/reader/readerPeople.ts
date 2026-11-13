/**
 * Who a message went to, as the card header and its details popover want it (owner request 2026-11-10): the pure
 * mapping from a `Message` and the owner's addresses to the recipient list and the From/To/Cc/Bcc/Reply-to/Date rows.
 * It reads only what the message carries; there are no photos, mailed-by or signed-by facts to show, so nothing is made up.
 */
import type { Address, Message } from '../../data';
import { nameOf } from './readerRows';

/** One person on a message, as the circles and the popover show them. */
export interface Person {
  /** Unique within a message's list: the lower-cased address, else the name. */
  readonly key: string;
  /** "You" for the owner, else the display name, else the address. */
  readonly name: string;
  /** The address, or '' when the header had none. */
  readonly address: string;
  /** One uppercase character for the monogram circle. */
  readonly initial: string;
  readonly me: boolean;
}

/** One labelled row of the details popover. */
export type DetailRow =
  | { readonly kind: 'people'; readonly label: string; readonly people: readonly Person[] }
  | { readonly kind: 'text'; readonly label: string; readonly text: string; readonly iso: string };

/** The most names the header's "to …" shows before the rest become "and N more". */
export const MAX_NAMED = 2;

function initialOf(text: string): string {
  const first = Array.from(text.trim().replace(/^[^\p{L}\p{N}]+/u, ''))[0];
  return first ? first.toUpperCase() : '?';
}

/** One address as a person; the owner's own addresses read "You". */
export function personOf(address: Address, me: ReadonlySet<string>): Person {
  const mine = me.has(address.address.toLowerCase());
  const name = mine ? 'You' : nameOf(address);
  return {
    // Every address of the owner is one person.
    key: mine ? 'you' : (address.address || name).toLowerCase(),
    name,
    address: address.address,
    // The owner's circle carries the first letter of the name their own header gives them, else of "You".
    initial: initialOf(mine ? address.name?.trim() || 'You' : name),
    me: mine,
  };
}

function unique(people: readonly Person[]): readonly Person[] {
  const seen = new Set<string>();
  return people.filter(person => !seen.has(person.key) && seen.add(person.key));
}

/** The owner first when they are in the list, then the rest in header order. */
function meFirst(people: readonly Person[]): readonly Person[] {
  return [...people.filter(p => p.me), ...people.filter(p => !p.me)];
}

/**
 * The people the circles stand for: To and Cc, the owner first. A message that arrived in the owner's mailbox without
 * their address in either (Bcc, a list) still went to them, so "You" is added; a message the owner sent is not.
 */
export function recipientCircles(message: Message, me: ReadonlySet<string>): readonly Person[] {
  const listed = unique([...message.to, ...message.cc].map(a => personOf(a, me)));
  const arrived = !message.fromMe && !listed.some(p => p.me);
  const youAddress = arrived ? ([...me][0] ?? '') : '';
  const you: Person = { key: 'you', name: 'You', address: youAddress, initial: 'Y', me: true };
  return meFirst(arrived ? [...listed, you] : listed);
}

/**
 * The header's recipients, in plain words: "to me", "to Mina Cho", "to me, Mina Cho and 4 more". A recipient without a
 * display name shows as the address, so the line always says who it went to. It is also the button's accessible name.
 */
export function recipientLabel(people: readonly Person[]): string {
  const shown = people.slice(0, MAX_NAMED).map(p => (p.me ? 'me' : p.name));
  if (shown.length === 0) return 'to undisclosed recipients';
  const rest = people.length - shown.length;
  return `to ${rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')}`;
}

function sameAddresses(a: readonly Address[], b: readonly Address[]): boolean {
  const key = (list: readonly Address[]) =>
    list
      .map(x => x.address.toLowerCase())
      .sort()
      .join(',');
  return key(a) === key(b);
}

function people(label: string, list: readonly Address[], me: ReadonlySet<string>): DetailRow[] {
  return list.length === 0
    ? []
    : [{ kind: 'people', label, people: unique(list.map(a => personOf(a, me))) }];
}

/** "Nov 10, 9:10 AM"; the year joins it for a message from another year. */
export function detailDate(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/\u202f/g, ' ')
    .replace(' at ', ', ');
}

/**
 * The popover's rows (image C): From, Reply-to (only when it differs from the sender), Date, then To, Cc and Bcc (only when
 * present), the long ones last. Rows for facts the message does not carry are left out, never shown empty.
 */
export function detailRows(message: Message, me: ReadonlySet<string>): readonly DetailRow[] {
  const from = message.from ? people('From', [message.from], me) : [];
  const replyTo = message.replyTo ?? [];
  const differs = replyTo.length > 0 && !(message.from && sameAddresses(replyTo, [message.from]));
  // The short facts first (who, who replies, when), then the lists that can run to hundreds of people: with a long To or Cc the
  // Date must not be the last row of a long scroll.
  return [
    ...from,
    ...(differs ? people('Reply-to', replyTo, me) : []),
    {
      kind: 'text',
      label: 'Date',
      text: detailDate(message.date),
      iso: new Date(message.date).toISOString(),
    },
    ...people('To', message.to, me),
    ...people('Cc', message.cc, me),
    ...people('Bcc', message.bcc ?? [], me),
  ];
}
